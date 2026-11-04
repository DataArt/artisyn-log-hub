# Implementation Plan: Workflow Agent Labels From .meta.json

## TL;DR

- **Hook (2.30.4 → 2.31.0):** `readParentAgentId` becomes `readAgentMeta(metaPath) → {parentAgentId, description, workflowPhase}`. Both sub-agent scans send the optional query params `agentDescription` / `workflowPhase` on `POST /api/v2/logs`, on the plain and the chunked paths. They are threaded as a new trailing `agentMeta` argument of `uploadFile` / `uploadFileChunked` / `uploadFileMaybeCompressed`.
- **DB:** migration `0085_agent_meta_labels.sql` adds nullable `agent_description varchar(255)` and `workflow_phase varchar(255)` to `sessions` and to `upload_queue`. There is no backfill.
- **API, ingest:** `POST /api/v2/logs` accepts two new optional query params, read only for `claude-subagent`. They are trimmed, dropped when empty, cut to 255 code points, and never cause a 4xx. `LogsService.upsert` gains a trailing `agentMeta` argument and never overwrites a stored value with an absent one.
- **API, read:**
  - `GET …/sessions/:sessionId/logs` `subagents[]` and `GET …/logs/delta` `newSubagents[]` / `subagentAppends[]` gain `agentDescription` / `workflowPhase` (`string | null`). The change is additive.
  - Meta that arrives later for a known agent reaches the open Session Map live: a re-upload with no new lines still produces an append entry with `lines: []` (DD-15).
- **Export/import:** `session.json` gains the optional fields `agentDescription` / `workflowPhase`. An archive from before this change imports with both `null`.
- **Client:**
  - A new helper `buildSubagentMeta(subagents)` in `log-parser.ts`.
  - `SubAgentNode` gains `agentDescription` / `workflowPhase`.
  - The description-first label rule (`agentDescriptionText` / `cutAgentLabel` in `workflow-agent-rows.ts`) applies in the Agents table and modal, the turn Sub-agents tree, `AgentActivationItem`, the Call Tree, the Charts and the Session Map.
  - A conditional Phase column in `WorkflowAgentsTable`.
- **New server file:** `server/src/logs/agent-meta-param.ts` holds the sanitiser (DD-1). The hook keeps its own copy.
- **Hook release:** the installer is rebuilt, the dogfooded `.artisyn/marketplace/plugins/log-hub-hooks/` install is refreshed, and the `update-install-instructions` skill is run.
- **Docs:**
  - KB articles: hook API versioning, hook system overview, upload queue, DB tables (plus a regenerated `db_state.sql`), session log view, session map, export/import, three algorithm docs.
  - Golden fixture READMEs: `tests/golden/README.md`, GS-05, GS-02.
  - `user-docs/data-collection.md` now lists the two newly collected fields. This is a privacy statement.
- **Tests:**
  - Algorithm rows in `workflow-agent-rows`, `session-map-delta-merge` and `session-map-model`.
  - Contract rows in `f15-ingest` and `f17-sessions`, plus a world-v1 seed change.
  - Scenario steps in `s-hook-01`, `s-compat-01`, `s-sess-03` and `s-sess-04`.
  - The GS-05 and GS-02 manifests are extended, so their other consumers (`tour-03`, `tour-05`, `s-slife-09`, corpus) must be re-checked and re-run.

## Reference

Requirements: [requirements.md](requirements.md). Research trail: [research/findings-1.md](research/findings-1.md).

## Design Decisions

1. **Sanitiser contract (hook and server share it).** `sanitizeAgentMeta(v)` works like this:
   - A value that is not a string gives `null`.
   - Otherwise the value is trimmed. An empty result gives `null`.
   - Otherwise the result is `Array.from(trimmed).slice(0, 255).join('')`.

   The cut counts code points, never UTF-16 units. That way the cut never splits a surrogate pair, and the result always fits `varchar(255)`, which counts characters. A repeated query param, which reaches Nest as `string[]`, is not a string, so it gives `null`.
2. **Server sanitiser location.** The server copy is a top-level exported function in a new file, `server/src/logs/agent-meta-param.ts`, so the controller and the import path share one implementation. The hook keeps its own plain-JS copy in `send-logs-hook.js`, because the hook has no shared packages.
3. **Sub-agents only.** The server applies `agentDescription` / `workflowPhase` only when `type === 'claude-subagent'`. For any other type, the controller drops both values to `undefined` without an error.
4. **No overwrite with absent.** In `LogsService.upsert`, each column is set only when its sanitised value is non-null. The `onConflictDoUpdate set` uses `excluded.agent_description` / `excluded.workflow_phase` only under that condition. The two columns are independent, and the rule mirrors `hasWorkflowRunId` (`logs.service.ts:329`).
5. **Hook threading.** The new argument `agentMeta: {agentDescription?: string, workflowPhase?: string} | null` is appended as the LAST positional parameter of:
   - `uploadFile` (`upload-logs.js:427`, after `snapshotQuery`)
   - `uploadFileChunked` (`:775`), which forwards it on every chunk, like `workflowRunId` at `:836`
   - `uploadFileMaybeCompressed` (`:947`), which forwards it at `:964` / `:973`

   `uploadFile` appends `&agentDescription=` / `&workflowPhase=` (each `encodeURIComponent`) only when the value is truthy. Existing callers that pass no new argument behave as today.
6. **Hook meta read.** `readAgentMeta(metaPath)` replaces `readParentAgentId` (`send-logs-hook.js:465`) and reads the file once. It returns `{parentAgentId: string|null, description: string|null, workflowPhase: string|null}` and is fail-open: any error gives all three as `null`. `parentAgentId` keeps today's rule: a non-empty string, not trimmed. The other two go through the sanitiser from DD-1. `agentType`, `spawnDepth`, `requestShape` and `requestNonInteractive` are ignored.
7. **Hook version.** Bump to `2.31.0`. The upload gains additive params, so this is a minor version.
8. **Client meta map.** The new helper is `buildSubagentMeta(subagents: {sessionId: string; agentDescription?: string | null; workflowPhase?: string | null}[]): SubagentMetaMap`, exported from `log-parser.ts` next to `buildAgentParentMap` (`:1454`):
   - `SubagentMetaMap` is `Map<string, {agentDescription: string | null; workflowPhase: string | null}>`.
   - It is keyed by `stripAgentPrefix(sessionId)`.
   - A missing field (old server) maps to `null`.
   - It is called wherever a component already derives `agentParentMap` from `logsData`: `useRepositoryData.ts`, `SessionLogView.tsx`, `CallTreeView.tsx` and `SessionChartsTab.tsx`. `SessionChartsTab` already receives `logsData`, so no new prop has to be threaded through `RepositoryView → RepositorySessionsPanel → SessionDetailPane → SessionTabContent`.
9. **Label helpers** in `workflow-agent-rows.ts`:
   - `agentDescriptionText(v: string | null | undefined): string | null` trims the value and returns `null` when it is empty.
   - `cutAgentLabel(text: string): string` holds the existing `AGENT_LABEL_LIMIT` "…" cut, extracted from `agentRowLabel`.
   - `agentRowLabel(node)` becomes `cutAgentLabel(agentDescriptionText(node.agentDescription) ?? (cleanText(node.prompt) || node.agentId))`.
10. **Label order everywhere** (FR-4a):
    1. The spawning Agent tool call's `description`, where the view has one.
    2. Otherwise `agentDescriptionText(meta.agentDescription)`.
    3. Otherwise today's fallback for that view.

    The views:
    - Agents table and its modal title: `agentRowLabel`.
    - `SubAgentNode.tsx`: the description cut by `cutAgentLabel`, or else `truncateAgentId(agentId)`. When the description is shown, the full agent id goes into the `title` attribute.
    - `AgentActivationItem.tsx:57` and `useCallTreeNodes.ts:252`: `activation.description ?? metaDesc ?? <today's fallback>`.
    - Charts `resolveAgent` (`chart-data.ts:349`): `activation.description ?? metaDesc ?? agent-<id>`.
    - Session Map: `agentRowLabel` with the looked-up description.
    - `ToolViewContext.tsx:86`, where "Open sub-agent →" opens the modal:
      - The caller's `label` stays first.
      - Otherwise, when the found node has a non-null `agentDescriptionText(node.agentDescription)`, the label is `agentRowLabel(node)`.
      - Otherwise `Agent ${agentId.slice(0, 8)}`, as today.

    Throughout, `metaDesc` means `agentDescriptionText(subagentMeta?.get(activation.agentId)?.agentDescription)`.
11. **Charts parameter.** `resolveAgent`, `buildWorkflowAgentNodes`, `assistantTimeline`, `toolHeatmap` and `agentTree` each gain a trailing optional `subagentMeta?: SubagentMetaMap`, which is passed to every `resolveAgent` call site (`chart-data.ts:453, 536, 689, 904, 951, 1006`). This deliberately reuses the one map type instead of a separate `Map<agentId, string>`.
12. **Session Map** keeps the FR-3 / FR-4a shape:
    - `SessionMapSubagent` gains `agentDescription` / `workflowPhase` (`string | null`). `mergeSubagents` sets them from `n.agentDescription ?? null` / `n.workflowPhase ?? null`.
    - `SessionMapParseInputs` gains `agentDescriptions: Map<string, string>`, filled in `toParseInputs` only for non-null `agentDescriptionText` values.
    - `session-map-model.ts:764` passes `agentDescription: inputs.agentDescriptions.get(d.agentId)` into `agentRowLabel`.
    - The Map's state is built only from `/logs/delta`. The initial load is a delta from cursor 0, whose sub-agents all arrive as `newSubagents`, so `mergeSubagents` is the single place the fields enter, for both the first load and live arrivals.
    - `session-map-delta-merge.ts:73` is the only `SessionMapSubagent` literal.
13. **Phase column.** `WorkflowAgentsTable` shows the column when `rows.some(r => agentDescriptionText(r.node.workflowPhase) !== null)`, counting the run's whole flattened row list, nested rows included:
    - Header `Phase`, placed between Task and Duration.
    - Cell text is `cutAgentLabel(phase)`, or `—` when the agent has no phase.
    - Row order and nesting are unchanged.
14. **Export/import scope.** The import path applies the same rule as DD-3: it stores the two fields only when the imported session id starts with `agent-`. `findMatchingSessions` (`repository-export-import.service.ts:1088-1121`) exports only root sessions (an `artisyn` log plus a `claude` log), so sub-agent sessions never reach a zip today. The `workflowRunId` round-trip has the same limit. This task adds the two fields to `SessionJson`, to the export select/write and to the import pass-through, symmetric with `workflowRunId`. This guarantees the format-level round-trip and the "old archive imports with `null`" rule. Exporting sub-agent sessions is out of scope. The acceptance criterion is verified by inspection plus the F23 contract rows staying green.
15. **Live metadata for known agents (FR-3a).**
    - **Server.** `subagentAppends` entries gain `agentDescription` / `workflowPhase`, read from `TreeMetaRow`. In `session-logs-delta.service.ts` (`:213-218`), the `lines.length === 0` skip is relaxed: an entry is pushed with `lines: []` when either value is non-null. A re-upload always sets `logs.updated_at = now()` (`logs.service.ts:420`), so a meta-only re-upload already lands in `classified.changed`.
    - **Client.** `SessionLogsDeltaUpdate.subagentAppends[]` gains the two optional fields. `mergeSubagents` copies a non-null value onto the known `SessionMapSubagent` and never clears a value with `null`. An entry with empty lines changes only the meta.
    - **Backward compatibility.** An old client already skips empty-line appends (`session-map-delta-merge.ts:66`).
    - **Logs and Charts tabs.** No change. They refetch `/logs` when the root `endTime` watermark moves (`useRepositoryData.ts:170-224`), so they receive the meta then. A sub-agent upload alone does not move that watermark. This is an existing limitation for all sub-agent data and is out of scope.
16. **Migration** `0085_agent_meta_labels.sql` follows the pattern of `0025_workflow_run_id.sql` / `0083_upload_queue_attempts.sql`:
    - Four `ALTER TABLE … ADD COLUMN IF NOT EXISTS … varchar(255)` statements, separated by `--> statement-breakpoint`.
    - `COMMENT ON COLUMN` statements in the style of `0084_schema_comments.sql:85`.
    - Journal `when` = 1791849600000, which is 0084's 1791763200000 + 86400000.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0085_agent_meta_labels.sql` | new migration | DD-16 |
| `server/drizzle/migrations/meta/_journal.json`, `meta/migrations.lock.json` | register 0085 | `when` 1791849600000 |
| `server/src/database/schema/index.ts` | `sessions` (near `:142`) and `upload_queue` (near `:1809`) columns `agentDescription`, `workflowPhase` | `varchar('…', {length: 255})`, nullable |
| `server/src/logs/agent-meta-param.ts` | **new** `sanitizeAgentMeta`, `AGENT_META_MAX_LENGTH = 255` | DD-1 |
| `server/src/logs/logs-v2.controller.ts` | two `@Query`s, sanitise, pass to `saveRawUpload` (`:141`) and `saveChunk` (`:255`) | DD-3 |
| `server/src/logs/upload-queue.service.ts` | `SaveRawUploadMeta` / `SaveChunkMeta` (`:12-44`), inserts (`:114-126`, `:183-197`) | — |
| `server/src/logs/upload-queue-scheduler.service.ts` | `UploadQueueRawRow` (`:28-46`), `upsert` call (`:403-411`) | — |
| `server/src/logs/logs.service.ts` | `upsert` trailing `agentMeta` (`:279-347`), `ImportSessionInput` (`:245-262`), `importSession` upsert (`:962-984`) | DD-4 |
| `server/src/logs/repositories.controller.ts` | `/logs` subagent select (`:1806-1813`) and map (`:1850-1856`) | FR-3 |
| `server/src/logs/dto/session-logs-delta.dto.ts` | `newSubagents` type (`:38-44`) | — |
| `server/src/logs/session-logs-delta.service.ts` | `TreeMetaRow` (`:86-91`), SQL (`:285`), mapping (`:297, 311`), push (`:225-231`) | — |
| `server/src/logs/export-import-zip.ts` | `SessionJson` (`:77-91`) optional fields | DD-14 |
| `server/src/logs/repository-export-import.service.ts` | `MatchingSessionRow` (`:72-81`), select (`:1088-1095`), write (`:904-907`), import (`:652-655`) | DD-14 |
| `hook/.claude/telemetry_tool/send-logs-hook.js` | `readAgentMeta` + sanitiser, scans (`:1132`, `:1165-1177`), destructure (`:1612`), upload calls (`:1720-1721`) | DD-5, DD-6 |
| `hook/.claude/telemetry_tool/upload-logs.js` | `uploadFile` / `uploadFileChunked` / `uploadFileMaybeCompressed` trailing `agentMeta`, JSDoc | DD-5 |
| `hook/.claude/telemetry_tool/version.json` | `2.31.0` | DD-7 |
| `.artisyn/marketplace/plugins/log-hub-hooks/**` | dogfooded install refresh | per `.claude/rules/hook.md` |
| `client/src/viewer/api.ts` | `SessionLogsData.subagents[]` (`:1558-1571`), `SessionLogsDeltaNewSubagent` (`:1649-1655`) | optional fields |
| `client/src/viewer/pages/repository/session-log/types.ts` | `SubAgentNode` (`:262-291`) optional `agentDescription?` / `workflowPhase?` (`string \| null`) | — |
| `…/session-log/log-parser.ts` | `buildSubagentMeta`, `SubagentMetaMap`, `parseSessionLogs` option `subagentMeta` (`:1664-1693`) → `buildSubAgentTree` (`:929`, node `:990`, call `:2199`), `buildAgentNodesForIds` trailing arg (`:1234`, node `:1300`) | DD-8 |
| `client/src/viewer/pages/repository/useRepositoryData.ts` | build `subagentMeta`, pass to `parseSessionLogs` (`:321-354`) | — |
| `…/session-log/SessionLogView.tsx` | build `subagentMeta` (`:59-94`), parse option, pass to `PromptTurnList` (`:210`) | — |
| `…/session-log/PromptTurnList.tsx`, `PromptTurnItem.tsx` | new optional prop `subagentMeta`; `buildAgentNodesForIds` (`:105`); `AgentActivationItem` (`:237`) | — |
| `…/session-log/workflow-agent-rows.ts` | `agentDescriptionText`, `cutAgentLabel`, `agentRowLabel` (`:68-73`) | DD-9 |
| `…/session-log/WorkflowAgentsTable.tsx` | Phase column (`:61-72`) | DD-13 |
| `…/session-log/SubAgentNode.tsx` | label (`:35-37`) | DD-10 |
| `…/session-log/AgentActivationItem.tsx` | optional prop `subagentMeta`, label (`:57`) | DD-10 |
| `…/session-log/CallTreeView.tsx`, `call-tree/useCallTreeNodes.ts` | build/pass `subagentMeta`; label (`:252`) | DD-10 |
| `…/session-log/tool-call-view/ToolViewContext.tsx` | modal label fallback (`:86`) | DD-10 |
| `…/session-log/charts/chart-data.ts`, `SessionChartsTab.tsx` | `subagentMeta` param per DD-11; build from `logsData.subagents` | DD-11 |
| `…/session-log/session-map/session-map-delta-merge.ts`, `session-map-model.ts` | per DD-12 | — |
| `docs/algorithm-examples/workflow-agent-rows.json`, `session-map-delta-merge.json`, `session-map-model.json` | algorithm rows | tests |
| `…/workflow-agent-rows.algo.test.ts`, `session-map/session-map-delta-merge.algo.test.ts`, `session-map/session-map-model.algo.test.ts` | harness input/expected keys | tests |
| `docs/knowledgebase/algorithms/workflow-agent-rows.md`, `session-map-delta-merge.md`, `session-map-model.md` | rules + edge cases | — |
| `server/test/contract/fixtures/world-v1.sql.ts`, `registry/f15-ingest.ts`, `registry/f17-sessions.ts` | seed + rows | tests |
| `tests/scenarios/helpers/golden.ts`, `tests/golden/gs-05-skills-rules-mcp-workflow/upload.json`, `tests/golden/gs-02-delegator/upload.json` | manifest fields `agentDescription?` / `workflowPhase?` | tests |
| `tests/golden/README.md` (`:37`), `tests/golden/gs-05-skills-rules-mcp-workflow/README.md`, `tests/golden/gs-02-delegator/README.md` | document the new manifest fields and the values set | — |
| `docs/changelog/<YYYY-MM-DD-HHmm>-workflow-agent-meta-labels.md` | one-line changelog entry before push | `changelog` skill |
| `tests/scenarios/hook/s-hook-01.spec.ts`, `hook/s-compat-01.spec.ts`, `view/s-sess-03.spec.ts`, `view/s-sess-04.spec.ts` | steps | tests |
| KB: `hook-system-overview.md`, `hook-api-versioning.md`, `db-tables.md`, `db_state.sql`, `session-log-view.md`, `session-map.md`, `session-export-import.md`, `upload-queue.md` | docs | — |
| `user-docs/data-collection.md` | list the two new collected fields | privacy statement |

## API changes

- **`POST /api/v2/logs`** (hook, API key):
  - New optional query params `agentDescription` and `workflowPhase`, each a string.
  - They are used only when `type=claude-subagent` and sanitised per DD-1.
  - An invalid, empty or repeated value is ignored silently.
  - The response shape is unchanged.
  - An old server ignores both params.
- **`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`:** each `subagents[]` entry gains `agentDescription: string | null` and `workflowPhase: string | null`, next to `parentSessionId`.
- **`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta`:**
  - Each `newSubagents[]` entry and each `subagentAppends[]` entry gains the same two fields.
  - A changed sub-agent with no new lines but with non-null meta yields an append entry with `lines: []` (DD-15).
- **Client types:** `SessionLogsData.subagents[]` and `SessionLogsDeltaNewSubagent` gain `agentDescription?: string | null` and `workflowPhase?: string | null`. They are optional because an old server does not send them.

## Database changes

- **`sessions`:** `agent_description varchar(255) NULL` and `workflow_phase varchar(255) NULL`. The columns are written only for `claude-subagent` sessions.
- **`upload_queue`:** the same two columns, staged per plain upload or chunk and consumed by the scheduler.
- **Migration:** `0085_agent_meta_labels.sql` per DD-16. There is no index, because neither column is filtered or joined on, and no backfill, because old rows stay `NULL`.
- **Follow-up skills:** after applying the migration locally, run the `migrations-data-integrity` and `db-state-update` skills.

## Test coverage plan

Only the three kinds the policy allows.

- **Algorithm: `workflow-agent-rows`.**
  - Rows in `docs/algorithm-examples/workflow-agent-rows.json`:
    - description present → description label;
    - description `""` → prompt fallback;
    - description `"   "` → prompt fallback;
    - description longer than 60 chars → "…" cut.
  - The harness in `workflow-agent-rows.algo.test.ts:47-56` reads an optional `agentDescription` on `input.label`.
  - The doc gains the rule and the edge cases.
- **Algorithm: `session-map-delta-merge`.**
  - New rows: a `newSubagents` entry with `agentDescription` / `workflowPhase`, carried into the merged state and into `parse.agentDescriptions`; and one without them, which gives `null` and no map entry.
  - Every existing row whose expected `subagents` contains a newly merged entry gains `agentDescription: null, workflowPhase: null`.
  - The parse branch's key set gains `agentDescriptions`.
  - The doc is updated.
- **Algorithm: `session-map-model`.** A row whose agent has both a prompt and an `agentDescriptions` entry. The harness gains an optional `expected.labels: Record<id, string>`, checked only when present. The doc gets the label rule.
- **Contract, `f15-ingest.ts`** (template `F15-upload-child-session`, `:117-145`):
  - The new params are stored on `upload_queue`.
  - A 300-char `agentDescription` is stored at 255.
  - A whitespace-only value is stored as `NULL`.
- **Contract, `f17-sessions.ts`:**
  - `F17-session-logs` / a new row asserting `subagents[]` carries `agentDescription` / `workflowPhase` (seed values on s03).
  - `F17-session-logs-delta-subagents` (`:515-545`, `strict`) gains both fields.
  - The world-v1 seed (`world-v1.sql.ts:1099-1126`) gives s03 non-null values.
- **Scenario, hook:** `s-hook-01` checks that the new hook sends both params for the workflow agent, and sends none when the meta has none.
- **Scenario, compatibility:** `s-compat-01` step 6 checks that a session from the frozen 2.6.1 hook has `agent_description` / `workflow_phase` `NULL` in SQL, and that `/logs` returns `null` for both.
- **Scenario, view:**
  - `s-sess-03` step 8b, with GS-05 where W1 has a description and phase and W2 has neither, checks:
    - the description label and the fallback label;
    - the Phase cell, and `—` for W2;
    - the modal title;
    - the Charts Agent Tree node;
    - the Session Map card label. The Map is built from `/logs/delta`, so this check also covers the `newSubagents` path.
  - `s-sess-03` step 8c checks that a run with no phases has no Phase header.
  - `s-sess-04` (GS-02 with one agent given a description) checks the turn Sub-agents tree label.
- **Live delta arrival:** a sub-agent that first arrives through `/logs/delta` is covered by the delta-merge algorithm rows, the F17 delta contract row and the Session Map check above, which reads `newSubagents`.
- **Export/import:** verified by inspection, per DD-14. The F23 rows must stay green.

## Visual/UX notes

- **Agents table:**
  - The Task cell shows the description, cut at 60 chars with "…". The hover `title` is unchanged: the cleaned prompt, or else the agent id.
  - The Phase column sits between Task and Duration and uses the same cell styling as Task. `—` is `text-muted-foreground`.
  - The column is absent when no agent of the run has a phase.
- **Modal title:** `agentRowLabel(agent)`. The agent id beside it is unchanged.
- **Turn Sub-agents tree (`SubAgentNode.tsx`):** shows the description when there is one, else the truncated id. The `font-mono` class applies only to the id fallback. With a description, the `title` attribute carries the full agent id.
- **Charts Agent Tree, Session Map card, `AgentActivationItem`, Call Tree:** the label text changes only. There are no layout changes.
- **Phase** is shown nowhere except the Agents table.

## Wireframes

No changes. `wireframes/workflow-agents-table.svg`, `workflow-agent-modal-title.svg` and `subagent-labels-other-views.svg` match this plan.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | DB schema + migration | 4 | first; everything server-side depends on the columns |
| 2 | Server ingest path | 5 | needs chunk 1 |
| 3 | Server read + export/import | 6 | needs chunk 1–2 |
| 4 | Hook | 7 | independent of server code; API contract per API changes |
| 5 | Client data path | 7 | needs API shape (chunk 3) |
| 6 | Client labels: Logs tab + Call Tree | 7 | needs chunk 5 |
| 7 | Client labels: Charts + Session Map | 5 | needs chunk 5–6 (helpers) |
| 8 | Docs (KB + user docs + changelog) | 8 | after code |
| 9 | Algorithm tests | 6 | needs chunks 6–7 |
| 10 | Contract tests | 5 | needs chunks 1–3 |
| 11 | Scenario tests: fixtures + hook | 5 | needs everything |
| 12 | Scenario tests: views + runs | 6 | needs chunk 11 |

### Chunk 1 — DB schema + migration
- [ ] `server/src/database/schema/index.ts`: add nullable `agentDescription: varchar('agent_description', {length: 255})` and `workflowPhase: varchar('workflow_phase', {length: 255})` to `sessions` (next to `workflowRunId`, `:142`) and to `upload_queue` (next to `:1809`).
- [ ] Create `server/drizzle/migrations/0085_agent_meta_labels.sql` per DD-16: four `ADD COLUMN IF NOT EXISTS` statements plus `COMMENT ON COLUMN` for each, separated by `--> statement-breakpoint`.
- [ ] Register 0085 in `server/drizzle/migrations/meta/_journal.json` (`when` 1791849600000, tag `0085_agent_meta_labels`) and in `meta/migrations.lock.json`, following the 0084 entries.
- [ ] Apply the migration to the local dev DB, then run the `migrations-data-integrity` skill and the `db-state-update` skill to regenerate `docs/knowledgebase/db_state.sql`.

### Chunk 2 — Server ingest path
- [ ] Create `server/src/logs/agent-meta-param.ts` exporting `sanitizeAgentMeta(v: unknown): string | null` per DD-1, plus the constant `AGENT_META_MAX_LENGTH = 255`.
- [ ] `logs-v2.controller.ts`: add `@Query('agentDescription') agentDescriptionRaw: unknown` and `@Query('workflowPhase') workflowPhaseRaw: unknown`. Sanitise both, null them unless `logType === 'claude-subagent'` (DD-3), and pass both into `saveRawUpload` (`:141`) and `saveChunk` (`:255`).
- [ ] `upload-queue.service.ts`: add `agentDescription?: string | null` and `workflowPhase?: string | null` to `SaveRawUploadMeta` / `SaveChunkMeta` (`:12-44`), and write them in the plain (`:114-126`) and chunk (`:183-197`) inserts.
- [ ] `upload-queue-scheduler.service.ts`: add `agent_description` / `workflow_phase: string | null` to `UploadQueueRawRow` (`:28-46`), which is filled by `RETURNING *` (`:343`), and pass `{agentDescription, workflowPhase}` as the new trailing `upsert` argument (`:403-411`).
- [ ] `logs.service.ts` `upsert` (`:279-347`): add a trailing optional `agentMeta?: {agentDescription: string | null; workflowPhase: string | null}`. Insert and conditionally `set` each column per DD-4, only when `logType === 'claude-subagent'` and the value is non-null.

### Chunk 3 — Server read + export/import
- [ ] `repositories.controller.ts`: select `sessions.agentDescription` / `sessions.workflowPhase` in `subagentRows` (`:1806-1813`), and emit `agentDescription` / `workflowPhase` (`?? null`) in the `subagents` map (`:1850-1856`) and in the object built from it that the response returns. The response is built inline, with no declared DTO.
- [ ] `dto/session-logs-delta.dto.ts` (`:37-44`): add `agentDescription: string | null` and `workflowPhase: string | null` to both the `subagentAppends` and the `newSubagents` entry types.
- [ ] `session-logs-delta.service.ts`:
  - Add both fields to `TreeMetaRow` (`:86-91`), select `s.agent_description`, `s.workflow_phase` next to `s.workflow_run_id` (`:285`) and map them (`:297, 311`).
  - Include them in `newSubagents.push` (`:225-231`) and in `subagentAppends.push` (`:218`).
  - Push an append with empty lines when either value is non-null (DD-15).
- [ ] `export-import-zip.ts` `SessionJson` (`:77-91`): add `agentDescription?: string | null` and `workflowPhase?: string | null`, following the `okfSnapshotId` precedent.
- [ ] `repository-export-import.service.ts`: add both fields to `MatchingSessionRow` (`:72-81`), to the `findMatchingSessions` select (`:1088-1095`) and to the `session.json` write (`:904-907`). On import (`:652-655`), pass `sanitizeAgentMeta(meta.agentDescription)` / `sanitizeAgentMeta(meta.workflowPhase)`, guarded by the `agent-` prefix rule (DD-14).
- [ ] `logs.service.ts`: add `agentDescription?: string | null` and `workflowPhase?: string | null` to `ImportSessionInput` (`:245-262`), and set them in the `importSession` sessions upsert (`:962-984`) under the DD-4 rule.

### Chunk 4 — Hook
- [ ] `send-logs-hook.js`: replace `readParentAgentId` (`:465`) with `readAgentMeta(metaPath)` per DD-6. Add a local `sanitizeAgentMeta` per DD-1 and a constant `AGENT_META_MAX_LENGTH = 255` with a comment that it mirrors `server/src/logs/agent-meta-param.ts`. Update the JSDoc.
- [ ] `send-logs-hook.js`: in the `subagents/` scan (`:1132`) and the `workflows/<wf>/` scan (`:1165-1177`), call `readAgentMeta` once per agent, derive `parentSessionId` as today, and add `agentDescription` / `workflowPhase` to each `filesToProcess` entry.
- [ ] `send-logs-hook.js`: destructure `agentDescription` / `workflowPhase` (`:1612`). Pass `agentDescription || workflowPhase ? {agentDescription, workflowPhase} : null` as the new last argument of both upload calls (`:1720-1721`).
- [ ] `upload-logs.js`: add a trailing `agentMeta` parameter to `uploadFile` (`:427`), `uploadFileChunked` (`:775`, forwarded at `:836`) and `uploadFileMaybeCompressed` (`:947`, forwarded at `:964` / `:973`), per DD-5. Append each param only when truthy. Update the JSDoc.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.31.0`, then run `npm run lint` and `npm test` in `hook/`.
- [ ] Run `npm run build:hooks-installer`, then refresh `.artisyn/marketplace/plugins/log-hub-hooks/` exactly as `.claude/rules/hook.md` describes.
- [ ] Run the `update-install-instructions` skill for the hook change.

### Chunk 5 — Client data path
- [ ] `client/src/viewer/api.ts`: add optional `agentDescription?: string | null` and `workflowPhase?: string | null` to `SessionLogsData.subagents[]` (`:1558-1571`), to `SessionLogsDeltaNewSubagent` (`:1649-1655`) and to the `subagentAppends[]` entry type of `SessionLogsDeltaUpdate`.
- [ ] `session-log/types.ts` `SubAgentNode` (`:262-291`): add `agentDescription?: string | null` and `workflowPhase?: string | null`, with JSDoc "from the agent's `.meta.json` via the server; absent for old hooks/servers".
- [ ] `log-parser.ts`: add `SubagentMetaMap` and `buildSubagentMeta(subagents)` next to `buildAgentParentMap` (`:1454`), per DD-8.
- [ ] `log-parser.ts`: add a `parseSessionLogs` option `subagentMeta?: SubagentMetaMap` (`:1664-1693`) and pass it to `buildSubAgentTree` (call at `:2199`, new last param). Spread non-null `agentDescription` / `workflowPhase` into the node built at `:990`.
- [ ] `log-parser.ts` `buildAgentNodesForIds` (`:1234`): add a trailing optional `subagentMeta?: SubagentMetaMap`, and spread non-null meta fields into the node built at `:1300`.
- [ ] `useRepositoryData.ts` (`:321-354`) and `SessionLogView.tsx` (`:59-94`): build `subagentMeta = buildSubagentMeta(subagents ?? [])` with `useMemo`, and pass it as the `parseSessionLogs` `subagentMeta` option. Add it to the memo deps.
- [ ] `SessionLogView.tsx` → `PromptTurnList.tsx` → `PromptTurnItem.tsx`: thread a new optional `subagentMeta` prop next to `agentParentMap`. Pass it as the last argument of `buildAgentNodesForIds` (`PromptTurnItem.tsx:105`) and add it to the memo deps.

### Chunk 6 — Client labels: Logs tab + Call Tree
- [ ] `workflow-agent-rows.ts`: add the exported `agentDescriptionText` and `cutAgentLabel`, and rewrite `agentRowLabel` (`:68-73`) per DD-9. Update its JSDoc for the description-first rule.
- [ ] `WorkflowAgentsTable.tsx`: compute `showPhase` per DD-13. Render a `Phase` header between Task and Duration (`:61-67`) and a per-row cell (`cutAgentLabel(phase)` or a muted `—`) only when `showPhase` is true. Keep the label and `title` logic (`:71-72`) unchanged.
- [ ] `SubAgentNode.tsx` (`:35-37`): render `cutAgentLabel(desc)` when `agentDescriptionText(agent.agentDescription)` is non-null, with `title={agent.agentId}` and no `font-mono`. Otherwise keep `truncateAgentId(agent.agentId)` unchanged (DD-10).
- [ ] `AgentActivationItem.tsx`: add an optional prop `subagentMeta?: SubagentMetaMap`. Set the label (`:57`) to `activation.description ?? agentDescriptionText(subagentMeta?.get(activation.agentId)?.agentDescription) ?? \`agent-${activation.agentId}\``. Pass the prop from `PromptTurnItem.tsx:237`.
- [ ] `CallTreeView.tsx` (`:75-96`): build `subagentMeta` with `buildSubagentMeta(logsData?.subagents ?? [])` and pass it to `useCallTreeNodes` as a new trailing optional argument.
- [ ] `call-tree/useCallTreeNodes.ts`: add a trailing optional `subagentMeta` to `useCallTreeNodes` (`:281`) and to `buildAgentNode` (`:31`), including its recursive call (`:243`). Set the label (`:252`) to `Agent: ${activation.description ?? agentDescriptionText(subagentMeta?.get(activation.agentId)?.agentDescription) ?? activation.agentId.slice(0, 20)}`. Add the map to the memo deps (`:752`).
- [ ] `tool-call-view/ToolViewContext.tsx` (`:86`): change the modal label to `label || (node && agentDescriptionText(node.agentDescription) ? agentRowLabel(node) : \`Agent ${agentId.slice(0, 8)}\`)`, per DD-10.

### Chunk 7 — Client labels: Charts + Session Map
- [ ] `charts/chart-data.ts`: give `resolveAgent` (`:343`) a trailing optional `subagentMeta`, with the label set to `activation.description ?? agentDescriptionText(subagentMeta?.get(activation.agentId)?.agentDescription) ?? \`agent-${id}\``.
- [ ] `charts/chart-data.ts`: add a trailing optional `subagentMeta` to `buildWorkflowAgentNodes`, `assistantTimeline`, `toolHeatmap` and `agentTree`, and pass it to every `resolveAgent` call (`:453, 536, 689, 904, 951, 1006`) per DD-11. `agentTree` must also forward it to its `buildWorkflowAgentNodes` call (`:1028`).
- [ ] `SessionChartsTab.tsx`: build `subagentMeta = useMemo(() => buildSubagentMeta(logsData?.subagents ?? []), [logsData])` and pass it to `assistantTimeline`, `toolHeatmap` and `agentTree` (`:66-91`), adding it to the memo deps.
- [ ] `session-map/session-map-delta-merge.ts`: add `agentDescription` / `workflowPhase: string | null` to `SessionMapSubagent` (`:17-23`) and set them in `mergeSubagents` (`:68-75`) from `newSubagents`. For known agents, apply non-null append meta, including empty-line appends, without appending lines (DD-15). Add `agentDescriptions: Map<string, string>` to `SessionMapParseInputs` and fill it in `toParseInputs` (`:128-157`), all per DD-12.
- [ ] `session-map/session-map-model.ts`: pass `agentDescription: inputs.agentDescriptions.get(d.agentId)` into the `agentRowLabel({...})` call (`:764-766`), per DD-12.

### Chunk 8 — Docs (KB + user docs + changelog)
- [ ] `docs/knowledgebase/db-tables.md` (`:68-74`): document `agent_description` / `workflow_phase` on `sessions` and `upload_queue`. Cover: sub-agent only, sanitised per DD-1, never overwritten by an absent value (DD-4).
- [ ] `docs/knowledgebase/hook-api-versioning.md`:
  - Add `agentDescription` / `workflowPhase` next to `parentSessionId` / `workflowRunId` (`:46`, `:361`).
  - Add a section in the style of `okfSnapshotId` (`:558`): sanitising, sub-agent only, old-server behaviour.
  - Add a `2.31.0` row to "Hook-side behaviour history" (`:723`).
- [ ] `docs/knowledgebase/hook-system-overview.md` (`:156`): the `claude-subagent` upload row gains `agentDescription` / `workflowPhase` read from `.meta.json`. Also update `docs/knowledgebase/upload-queue.md` with the two staged columns.
- [ ] `docs/knowledgebase/session-log-view.md` (`:83-101`): add the `/logs` `subagents[]` fields, `buildSubagentMeta`, and the description-first label order per DD-10 for each view. Describe the Phase column.
- [ ] `docs/knowledgebase/session-map.md` (`:66-71`, `:128`): `newSubagents` meta fields, `agentDescriptions` in the parse inputs, the card label rule, and the live meta update for known agents through `subagentAppends` (DD-15).
- [ ] `docs/knowledgebase/session-export-import.md` (`:56-62`, `:120-123`): the optional `session.json` fields `agentDescription` / `workflowPhase`. An old archive imports them as `null`. Note the DD-14 scope (sub-agent sessions are not exported).
- [ ] `user-docs/data-collection.md`: list each sub-agent's `.meta.json` `description` and `workflowPhase` among the data the hook sends. Then run `npm run build:help`.
- [ ] Follow the `changelog` skill to write `docs/changelog/<YYYY-MM-DD-HHmm>-workflow-agent-meta-labels.md` (a one-line summary) once the work is ready to push.

### Chunk 9 — Algorithm tests
- [ ] `docs/algorithm-examples/workflow-agent-rows.json`: add the AL rows listed under Test coverage plan → `workflow-agent-rows` (present, empty, whitespace-only, over 60 chars), continuing the existing AL-xx numbering.
- [ ] `workflow-agent-rows.algo.test.ts` (`:47-56`): pass an optional `input.label.agentDescription` into `agentRowLabel`. Update `docs/knowledgebase/algorithms/workflow-agent-rows.md` Label rules and edge cases with the description-first rule.
- [ ] `docs/algorithm-examples/session-map-delta-merge.json`: add `agentDescription: null, workflowPhase: null` to every existing expected merged sub-agent, and add the expected `agentDescriptions` to the parse rows. Then add rows:
  - a new sub-agent with meta (carried);
  - a new sub-agent without meta (`null`);
  - an append with lines plus meta (relabels a known agent);
  - an empty-line append with meta (meta only, no lines);
  - an append with `null` meta (keeps the stored value).
- [ ] `session-map-delta-merge.algo.test.ts` (`:182-200`): include `agentDescriptions` (as an entries object) in the parse-branch key set. Update `docs/knowledgebase/algorithms/session-map-delta-merge.md` (`:30`, `:45`, `:58`).
- [ ] `docs/algorithm-examples/session-map-model.json`: add a row whose agent has a prompt plus an `agentDescriptions` entry, with `expected.labels` mapping that agent id to its description.
- [ ] `session-map-model.algo.test.ts` (`:296-330`): accept `inputs.agentDescriptions` (default empty), and assert the node labels when `expected.labels` is present. Update `docs/knowledgebase/algorithms/session-map-model.md` (`:126`) with the label rule.

### Chunk 10 — Contract tests
- [ ] `server/test/contract/fixtures/world-v1.sql.ts` (`:1099-1126`): add the `agent_description` / `workflow_phase` columns to the sessions insert, set to `'contract-desc'` / `'Implement'` on s03 and `NULL` elsewhere.
- [ ] `registry/f15-ingest.ts`: add a row modelled on `F15-upload-child-session` (`:117-145`). It uploads `claude-subagent` with `agentDescription=load-config&workflowPhase=Config` and checks the `upload_queue` delta columns.
- [ ] `registry/f15-ingest.ts`: add a row where `agentDescription` is 300 `x` (stored as 255 `x`) and `workflowPhase` is `%20%20` (stored `NULL`). Expect 201.
- [ ] `registry/f17-sessions.ts`: extend `F17-session-logs` (`:418`), or add a row, asserting `subagents[]` for s03 carries `agentDescription: 'contract-desc'` and `workflowPhase: 'Implement'`.
- [ ] `registry/f17-sessions.ts` `F17-session-logs-delta-subagents` (`:515-545`, strict): add `agentDescription` / `workflowPhase` to the expected `newSubagents` fields. Add a delta row whose cursor already holds s03 after s03's log is re-uploaded (the same body), expecting a `subagentAppends` entry with `lines: []` and s03's meta. Grep `registry/` for other strict s03 or `subagents[]` assertions and update them. Then run the full `npm run test:contract` from `server/`.

### Chunk 11 — Scenario tests: fixtures + hook
- [ ] `tests/scenarios/helpers/golden.ts`: add optional `agentDescription?` / `workflowPhase?` to the sub-agent manifest type (`:62-68`), copy them (`:364-369`) and send them as query params next to `workflowRunId` (`:402-403`).
- [ ] `tests/golden/gs-05-skills-rules-mcp-workflow/upload.json`: give W1 `agentDescription: "load-config"` and `workflowPhase: "Config"`. Leave W2 without either. Document this in that fixture's `README.md` and add the manifest fields to `tests/golden/README.md` (`:37`).
- [ ] `tests/golden/gs-02-delegator/upload.json`: give agent key `d` `agentDescription: "deep-research"`, and no `workflowPhase`. Document this in `tests/golden/gs-02-delegator/README.md`.
- [ ] `tests/scenarios/hook/s-hook-01.spec.ts`:
  - In setup (`:117-150`), write `wf_abc/agent-w1.meta.json` with `description: "chunk-6-Tests"` and `workflowPhase: "Implement"`.
  - Add `"description": "   "` to `agent-a1.meta.json`, so the plain `subagents/` scan exercises the whitespace drop.
  - Assert (`:168-193`) that the W1 upload query carries both params, and that the `agent-a1` query carries neither while its `parentSessionId` is unchanged.
  - The chunked path is not covered by a scenario step: forwarding on every chunk mirrors `workflowRunId`.
- [ ] `tests/scenarios/hook/s-compat-01.spec.ts` step 6 (`:315-347`): assert that the frozen 2.6.1 `v26.wfAgent` session row has `agent_description` / `workflow_phase` `NULL`, and that `/logs` returns `null` for both.

### Chunk 12 — Scenario tests: views + runs
- [ ] `tests/scenarios/view/s-sess-03.spec.ts` step 8b (`:390-449`):
  - W1's Task label is `load-config`, and its Phase cell is `Config`.
  - W2 keeps the prompt label, and its Phase cell is `—`.
  - The modal title is `load-config` (`:432`).
  - Re-index the `nth()` cell selectors for the new column.
- [ ] `s-sess-03.spec.ts`: add a new step `8b2. GS-05 agent description in Charts and Session Map`, right after 8b.
  - Agent Tree chart tab: `getByText('load-config')` is visible.
  - Session Map tab: the W1 card (located by agent id, as `s-sess-04` steps 13–14 do) has the title `load-config`.
  - End the step by switching back to the Logs tab, so step 8c starts from the state it expects.
- [ ] `s-sess-03.spec.ts` existing step 8c (`:451`): add an assertion that its workflow runs, which have no phases, show `getByRole('columnheader', {name: 'Phase'})` with count 0.
- [ ] `tests/scenarios/view/s-sess-04.spec.ts`: add a step asserting the turn Sub-agents tree row for agent `d` reads `deep-research` instead of its truncated id.
- [ ] Grep `tour-03-owner-repo.spec.ts`, `tour-05-session-detail.spec.ts` and `s-slife-09.spec.ts` for GS-05 W1 / GS-02 `d` labels (prompt text, truncated ids, map card titles), and update any assertion the new descriptions change.
- [ ] Run the touched scenarios: `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-HOOK-01|@S-COMPAT-01|@S-SESS-03|@S-SESS-04|@S-SLIFE-09"`. Then run tours 03 and 05, plus `--mode a --only corpus`, to confirm GS-05 and GS-02 still pass.
