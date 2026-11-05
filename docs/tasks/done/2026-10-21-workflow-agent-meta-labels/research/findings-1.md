**Requirements summary**
The hook already reads each sub-agent's sibling `<agent-id>.meta.json` for `parentAgentId`. It should also read `description` and `workflowPhase` from the same file, trim them, drop empty or non-string values, cap them at 255 chars, and send them as optional `agentDescription` / `workflowPhase` query params on `POST /api/v2/logs`, on both the plain and the chunked paths. The server takes them only for `claude-subagent` uploads, trims/drops/truncates them and never returns a 4xx because of them. It carries them through `upload_queue`, the scheduler and `LogsService.upsert` into two new nullable `varchar(255)` columns on `sessions` and `upload_queue`; a later upload without the params never overwrites stored values. Both fields are returned (`null` when unknown) on `/logs` `subagents[]` and on `/logs/delta` `newSubagents[]`. On the client, the description replaces the prompt-derived / `agent-<id>` fallback label in five views: the workflow Agents table, its modal title, the turn Sub-agents tree, the Charts Agent Tree and the Session Map. Labels that come from the spawning Agent tool call's `description` stay. `workflowPhase` becomes a Phase column (between Task and Duration) in the Agents table, shown only when at least one agent of the run has a phase. Sessions from old hooks and old servers must behave exactly as today. The answers in `open_questions_ru.md` are already in the requirements: Phase is shown in this task (Q1), and the label applies in every view (Q2).

**Wireframes**
- `wireframes/workflow-agents-table.svg`: the Task cell shows the description (e.g. `load-config`, `chunk-6-Tests`) with the `AGENT_LABEL_LIMIT` "…" cut. A PHASE column sits between TASK and DURATION (`Config`/`Implement`/`Test`, `—` when absent). A nested `↳` agent and an agent without a description (row 7) fall back to the prompt label. The hover tooltip is unchanged (cleaned prompt, or the agent id). The column is hidden when no agent of the run has a phase.
- `wireframes/workflow-agent-modal-title.svg`: the `WorkflowAgentModal` title is `agentRowLabel(agent)`. The agent id beside it and the transcript body are unchanged.
- `wireframes/subagent-labels-other-views.svg`:
  - Session Map agent card title = `agentRowLabel` with the description, including agents that arrive live through `/logs/delta`.
  - Charts Agent Tree node shows `chunk-6-Tests` instead of `agent-a30d0eba1a…`.
  - Logs tab: an Agent tool description ("Explore session-log folder") is unchanged, while `chunk-6-Tests` replaces the "prompt-derived / agent-<id> fallback".
  - Label order: 1) spawning Agent tool `description`, 2) meta `agentDescription` (non-empty after trim), 3) today's fallback.
  - Phase is not shown in these views.

**Knowledgebase**
- `docs/knowledgebase/hook-system-overview.md:156`: the upload table row for `claude-subagent` (parentSessionId from meta, workflowRunId from the folder) needs the two new params. Design rules: fail-open, CommonJS, every Node LTS.
- `docs/knowledgebase/hook-api-versioning.md`: params are added additively next to `parentSessionId`/`workflowRunId` (l.46, l.361). Add a section in the style of `okfSnapshotId` (l.558) and a row in "Hook-side behaviour history" (l.723; l.732 is the 1.5.0/1.6.0 meta row).
- `.claude/rules/hook.md`: bump `hook/.claude/telemetry_tool/version.json` (currently `2.30.4`), run `npm run build:hooks-installer`, refresh `.artisyn/marketplace/plugins/log-hub-hooks/`, run the `update-install-instructions` skill, and `npm run lint` in `hook/`.
- `docs/knowledgebase/upload-queue.md`: the staging / claim / chunk pattern the new columns travel through.
- `docs/knowledgebase/db-tables.md:68-74`: rules for `parent_session_id` / `workflow_run_id`; add the new columns there. Also run the `db-state-update` skill (comments plus regenerating `docs/knowledgebase/db_state.sql`; `0084_schema_comments.sql:85` is the COMMENT style) and the `migrations-data-integrity` skill.
- `docs/knowledgebase/session-log-view.md:83-101`: the `/logs` payload contract and the `agent-` prefix rules. Client maps are keyed by the bare id.
- `docs/knowledgebase/session-map.md:66-71,128`: the delta → merge → `toParseInputs` flow and the `workflowRunId` map used for grouping.
- `docs/knowledgebase/session-export-import.md:56-62,120-123`: `session.json` fields. Optional new fields stay compatible with older zips (the `okfSnapshotId` precedent, DD-42).
- `docs/knowledgebase/algorithms/workflow-agent-rows.md`: Label rules 1–3, edge-case and mutation lists. The rows live in `docs/algorithm-examples/workflow-agent-rows.json` (17 rows, AO-xx / AL-xx ids).
- `docs/knowledgebase/algorithms/session-map-delta-merge.md:30,45,58` and `docs/knowledgebase/algorithms/session-map-model.md:126`: these need the new fields and the description-label rule.
- `docs/knowledgebase/server-endpoint-map.md`: hook-route backward compatibility.
- `docs/knowledgebase/test/scenarios.md` and `test/contract-tests.md`: suite conventions.

**Existing patterns**

Hook:
- `hook/.claude/telemetry_tool/send-logs-hook.js:465` `readParentAgentId(metaPath)`: fail-open read. Extend it, or replace it with one helper that returns `{parentAgentId, description, workflowPhase}`.
- `send-logs-hook.js:1132` (the `subagents/` scan) and `:1165-1177` (the `workflows/<wf>/` scan, which sets `workflowRunId: wfDir.name`) build `filesToProcess` entries. Add the new fields there.
- `send-logs-hook.js:1612` destructures the entry. `:1720-1721` passes `parentSessionId || null, workflowRunId || null` positionally into the chunked and plain upload calls.
- `hook/.claude/telemetry_tool/upload-logs.js:427-436`: `uploadFile(...)` appends `&workflowRunId=` only when the value is truthy. Positional signatures at `:775` (`uploadFileChunked`, which forwards at `:836`) and `:947` (`uploadFileMaybeCompressed`, `:964`/`:973`). New params need threading, or a meta object.

Server ingest:
- `server/src/logs/logs-v2.controller.ts:49` uses `@Query('workflowRunId')`. It is passed into `saveRawUpload` at `:141` and `saveChunk` at `:255`. Silent validation precedent: `snapshotIdRaw` → `undefined` at `:95-99`.
- `server/src/logs/upload-queue.service.ts:12-44` holds the `SaveRawUploadMeta` / `SaveChunkMeta` interfaces. Inserts are at `:114-126` (plain) and `:183-197` (chunk).
- `server/src/logs/upload-queue-scheduler.service.ts:28-46`: the `UploadQueueRawRow` snake_case interface. `:403-411` calls `logsService.upsert(..., parent_session_id, workflow_run_id)` positionally.
- `server/src/logs/logs.service.ts:279-347` `upsert`: `hasWorkflowRunId = logType === 'claude-subagent' && !!workflowRunId` and conditional `onConflictDoUpdate set` (`excluded.workflow_run_id`). This is the "never overwrite with absent" rule to copy.
- `server/src/logs/otel-chunk.ts:83-96` `stringAttrOf`: the existing "non-empty → slice(0,255) → else null" sanitiser to mirror (add a trim).

Schema and migration:
- `server/src/database/schema/index.ts:142` (`sessions.workflowRunId varchar(255)`) and `:1809` (`upload_queue.workflowRunId`).
- `server/drizzle/migrations/0025_workflow_run_id.sql` and `0083_upload_queue_attempts.sql`: ALTER … ADD COLUMN IF NOT EXISTS style with `--> statement-breakpoint`.
- The next migration is `0085`. The last journal entry, `0084_schema_comments`, has `when` = 1791763200000. The +1-day convention gives 1791849600000. Also update `meta/_journal.json` and `meta/migrations.lock.json`.

Server read paths:
- `server/src/logs/repositories.controller.ts:1806-1856`: the `subagentRows` select (`workflowRunId` at `:1810`) and the `subagents` map at `:1850-1856`, which today emits only `sessionId, parentSessionId, logsText`. Add the two fields there.
- `server/src/logs/dto/session-logs-delta.dto.ts:38-44` `newSubagents` type.
- `server/src/logs/session-logs-delta.service.ts`: `TreeMetaRow` at `:86-91`; the raw SQL `SELECT s.workflow_run_id` at `:285` and the row mapping at `:297,311`; the `newSubagents.push` at `:225-231`.

Export / import:
- `server/src/logs/export-import-zip.ts:77-91` `SessionJson`. `okfSnapshotId?: string | null` is the optional-field precedent.
- `server/src/logs/repository-export-import.service.ts:72-81` (`MatchingSessionRow`), `:1088-1095` (the select), `:904-907` (writing `session.json`), `:652-655` (import passes `meta.workflowRunId ?? null`).
- `logs.service.ts:245-262` `ImportSessionInput` and the `importSession` session upsert at `:962-984`.

Client data path:
- `client/src/viewer/api.ts:1558-1571` (`SessionLogsData.subagents[]`) and `:1649-1655` (`SessionLogsDeltaNewSubagent`).
- `client/src/viewer/pages/repository/useRepositoryData.ts:321-354`: `subagentLogsMap`, `agentParentMap` and the `parseSessionLogs` call. `subagentMeta` goes here.
- `client/src/viewer/pages/repository/session-log/SessionLogView.tsx:59-94` builds its own copy of `subagentLogsMap`, `agentParentMap` and `parseSessionLogs`. This is the second place that needs `subagentMeta`.
- `session-log/log-parser.ts`:
  - `:1664-1693` `parseSessionLogs` options (add the new option).
  - `:929-1000` `buildSubAgentTree` (`SubAgentNode` creation at `:990`), called from `:2199`.
  - `:1234-1322` `buildAgentNodesForIds(agentIds, agentParentMap, subagentLogsMap, subagentStats?, pricing?)` (add the optional arg; node built at `:1300`).
- `session-log/PromptTurnItem.tsx:92-113`: the `buildAgentNodesForIds` caller. Sub-agents render at `:264-281`; `AgentActivationItem` at `:237`.
- `session-log/types.ts:262-291` `SubAgentNode`: add optional fields.

Client labels and views:
- `session-log/workflow-agent-rows.ts:68-73` `agentRowLabel(node)`: `cleanText(node.prompt) || node.agentId`, then the cut at `AGENT_LABEL_LIMIT = 60`.
- `session-log/WorkflowAgentsTable.tsx:61-67` (header) and `:71-72` (label/title); the modal label is at `:134`.
- `session-log/SubAgentNode.tsx:35-37` shows `truncateAgentId(agent.agentId)` today. There is no prompt label, so the fallback here is the truncated id. `SubAgentDetail.tsx:51-77` shows the prompt.
- `session-log/charts/chart-data.ts:343-349` `resolveAgent`: `activation.description ?? \`agent-${id}\``. Call sites:
  - `:453` `buildWorkflowAgentNodes`, which passes `{agentId, prompt:''}`, so the workflow agents in the Agent Tree always fall back today.
  - `:536`, `:689` `assistantTimeline`, `:904` `toolHeatmap`, `:951` and `:1006` `agentTree`.
  - `session-log/SessionChartsTab.tsx:66-91` passes `agentParentMap` into all three charts.
- Session Map:
  - `session-map/session-map-delta-merge.ts:17-23` `SessionMapSubagent`; `:68-75` `mergeSubagents`; `:128-157` `SessionMapParseInputs` / `toParseInputs` (the `workflowRunIds` precedent).
  - `session-map/session-map-model.ts:695-724` (drafts) and `:764-766` (the `agentRowLabel({agentId, prompt, children: []})` call).

Tests (the three allowed kinds only):
- Algorithm:
  - `session-log/workflow-agent-rows.algo.test.ts:47-56`: label rows feed `input.label {agentId, prompt}`. The harness needs an optional `agentDescription`.
  - `session-map/session-map-delta-merge.algo.test.ts:182-200`: the `parse` branch compares a fixed key set (needs `agentDescriptions`). The merge branch compares `subagents` with `toEqual`, so rows whose expected output includes a newly merged sub-agent must gain the new keys (19 `workflowRunId` occurrences in `docs/algorithm-examples/session-map-delta-merge.json`).
  - `session-map/session-map-model.algo.test.ts:296-330`: the `model` op checks only costs and ids. A label check needs a new `expected` key.
- Contract:
  - `server/test/contract/registry/f15-ingest.ts:117-145` `F15-upload-child-session` (an `upload_queue` delta `check` on the column) is the template for the new-params row and the 255-truncation row.
  - `f17-sessions.ts:418` `F17-session-logs` and `:430` `F17-session-logs-subagent-stats` (path-based read).
  - `f17-sessions.ts:515-545` `F17-session-logs-delta-subagents` is `strict: true` on `newSubagents` fields, so it must gain `agentDescription` / `workflowPhase` or it fails.
  - The world seed is `server/test/contract/fixtures/world-v1.sql.ts:1099-1126` (the sessions insert; s03 is s02's child).
- Scenarios:
  - `tests/scenarios/hook/s-hook-01.spec.ts:117-150` (setup writes `agent-a1.meta.json` and a `wf_abc/agent-w1.jsonl`) and `:168-193` (asserts `query.get('workflowRunId')`). This is the natural place to check the hook sends the params; the requirements don't name it.
  - `tests/scenarios/hook/s-compat-01.spec.ts:315-347` step 6: frozen 2.6.1 with `v26.wfAgent`, SQL on `sessions`. Add the null asserts here.
  - `tests/scenarios/view/s-sess-03.spec.ts:390-449` step 8b, the GS-05 Agents table (W1/W2 prompt labels asserted at `:408-410`, cells by index `nth(1..4)`).
  - The GS-05 manifest is `tests/golden/gs-05-skills-rules-mcp-workflow/upload.json`. The loader is `tests/scenarios/helpers/golden.ts:62-68` (manifest type), `:364-369` (copies `workflowRunId`) and `:402-403` (query params).

**Open gaps**
1. **Sub-agent sessions are never exported.** `findMatchingSessions` (`repository-export-import.service.ts:1088-1121`) requires an `artisyn` log with `firstPrompt`, linked through `logRepositories`, and a `claude` log. `appendSessionChunk` reads only `['claude','artisyn']` (`:808`). The hook links only artisyn logs to a repo (`logs.service.ts:529`). So `claude-subagent` sessions never reach a zip, and the "export/import round-trips" acceptance criterion has no data path today (the existing `workflowRunId` round-trip is equally dead in practice). The plan must choose: only add the optional `session.json` fields plus parsing (round-trip limited to whatever is exported), or reword the criterion.
2. **Fallbacks outside FR-4a.** `AgentActivationItem.tsx:57` and `call-tree/useCallTreeNodes.ts:252` (`activation.agentId.slice(0, 20)`) also fall back to the agent id. They are not named in FR-4a, but the wireframe's Logs-tab panel ("chunk-6-Tests — was … agent-<id> fallback") implies `AgentActivationItem`. Decide whether they are in scope.
3. **`SubAgentNode.tsx` today shows the truncated agent id, not a prompt label.** "Description replaces the fallback" means description-or-`truncateAgentId` there. Decide whether the agent id stays visible next to it.
4. **Changing GS-05 breaks step 8b.** Adding descriptions to GS-05 (needed for the s-sess-03 step) changes the label asserted at `s-sess-03.spec.ts:408-410` and in the modal check at `:432`. `golden.ts` must also learn the manifest fields `agentDescription?` / `workflowPhase?` and send them at `:402-403`. `tour-03-owner-repo.spec.ts` also uses gs-05. A sensible split is W1 with a description and phase, W2 without, so one fixture also covers the fallback and the `—` cell. Phase-column visibility for an all-null run is covered by any other workflow fixture (step 8c's runs).
5. **Repeated query params.** Repeated `?agentDescription=a&agentDescription=b` reaches the Nest controller as `string[]`. The sanitiser needs a `typeof === 'string'` guard; `workflowRunId` has none today.
6. **Truncation semantics.** JS `slice(0, 255)` counts UTF-16 code units, which never exceeds the `varchar(255)` code-point limit, so it is safe. A cut can split a surrogate pair; decide whether that is acceptable or whether to cut by code points. The worst-case URL growth per param is 255 × 9 = 2295 chars (3-byte UTF-8 percent-encoded), 4590 for both.
7. **Charts description map.** There is no `agentDescriptions` plumbing in charts yet. `resolveAgent` has 6 call sites; the map must reach `assistantTimeline`, `toolHeatmap`, `agentTree` and `buildWorkflowAgentNodes`. It is built in `useRepositoryData.ts` and handed through `SessionTabContent.tsx` / `SessionChartsTab` like `agentParentMap`.
8. **Session-map-model label test.** The `session-map-model` algorithm test has no label assertion. Its harness needs a new `expected` key, for example `labels: Record<id, string>`.
9. **Hook release bookkeeping.** The hook has no algorithm doc for meta reading, so its behaviour is covered only by the s-hook-01 scenario. The version bump target is undecided (additive params suggest `2.31.0`), and the `hook-api-versioning.md` history row must be added.
10. **Contract seed.** Strong contract rows for `/logs` and `/logs/delta` need the world-v1 seed to give s03 non-null `agent_description` / `workflow_phase` (`world-v1.sql.ts:1105-1126` column list). Otherwise the rows only compare nulls.
