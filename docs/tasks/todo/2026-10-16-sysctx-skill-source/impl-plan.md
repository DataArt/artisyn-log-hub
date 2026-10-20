# Implementation plan — System Context: correct skill source via harness snapshot

## TL;DR

- **New DB table `harness_snapshots`**: one row per (owner `user_id`, `snapshot_id`), with the whole snapshot in a `body jsonb`. **New columns**: `sessions.harness_snapshot_id` (no FK, COALESCE-bound) and `upload_queue.harness_snapshot_id`. All of it is in one migration, `0073_harness_snapshots.sql`.
- **New server module `server/src/logs/harness-snapshot.ts`**: `extractHarnessSnapshot`, `extractHarnessSnapshotRef`, `storeHarnessSnapshot`, `bindSessionSnapshot`, `loadHarnessSnapshot`, `isHarnessSnapshotKnown`, `deleteOrphanHarnessSnapshots`.
  - Ingest Step 5d now builds `harness_elements` from the stored snapshot. The old `skill-definitions`, `mcp-config` and `system-context` events are no longer read.
- **API, `POST /api/v2/logs`**:
  - New optional query params `snapshotId` and `snapshotFull=1`.
  - New optional response field `unknownSnapshotId`. It is additive, and existing fields are unchanged.
- **API, `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`**: new field `harnessSnapshot: HarnessSnapshot | null`, with the same access checks as the logs.
- **Hook (version `2.22.0`)**:
  - `skill-catalog.js` is rewritten to read the exact plugin catalog: merged `enabledPlugins` plus the `installPath` from `installed_plugins.json`, with skills, workflows and commands from project, user and plugin sources.
  - New `harness-snapshot.js` builds the snapshot and computes `snapshotId`.
  - `harness-state.js` v2 records the known snapshot ids.
  - Every upload of the current session carries `harness-snapshot-ref`. The full `harness-snapshot` is sent only when the id is unknown.
  - `prompt-upload-hook.js` prepends the ref only (DD-19).
  - The hook stops sending the four old events.
- **Client**:
  - The System Context tabs Skills, Agents, MCP, Files and Rules are built only from `harnessSnapshot`.
  - The `skill_listing` fallback and the parsing of the old events are deleted.
  - New `user` source badge; `built-in` is removed.
  - The skill modal gets a Plugin row and loses its Modified row.
  - Raw Logs gets compact rows for the two new event types (DD-17).
- **Retention**: `purgeSessionChildData` and the team-repo deletion clear the snapshot references and delete snapshots no session references. Export embeds the snapshot and import re-binds it.
- **Harness-usage reports**: skill `source` can now be `'user'`, on the server (`harness-usage.service.ts`) and in the client model.
- **Hook worker**: `post-turn-analysis-worker.js` switches to `buildSkillCatalog`.
- **No backward compatibility** for old hooks (DD-17). This is the owner's explicit exception, for this task only, to the CLAUDE.md § Hook API backward-compatibility rule:
  - Their uploads still succeed (`201`), but their sessions have no snapshot and no longer feed `harness_elements`.
  - Already-stored sessions that only have the old events lose their Skills, Agents, MCP, Files and Rules tabs. There is no backfill.

## Reference

- Requirements: [requirements.md](requirements.md)
- Wireframes: `wireframes/sysctx-skills-tab.svg`, `wireframes/skill-detail-modal.svg`, `wireframes/sysctx-no-snapshot.svg`
- Research archive: `research/findings-1.md`

## Design Decisions

**DD-1. Snapshot event shape (hook → server).** It is one NDJSON line, and `body` is the same object minus `type`:

```jsonc
{
  "type": "harness-snapshot",
  "snapshotId": "<64 lowercase hex>",
  "schemaVersion": 1,
  "perToolDetailSupported": true,          // capability flag, NOT part of the id
  "skills": [{
    "name": "adlc-lh:tracker",             // plugin entries are "<pluginName>:<name>"
    "kind": "skill" | "workflow" | "command",
    "source": "project" | "user" | "plugin",
    "description": "…", "argumentHint": "…"?,
    "body": "<file text after frontmatter; workflow = whole .js text>",
    "path": "<per DD-3>", "bytes": 10650, "contentHash": "<sha256 hex>",
    "plugin": { "id": "adlc-lh@artisyn", "name": "adlc-lh", "marketplace": "artisyn",
                "version": "1.3.1", "gitCommitSha": "…"? }   // plugin source only
  }],
  "agents": [{ "name", "description", "body", "path", "bytes", "contentHash", "source": "project" }],
  "mcpServers": [{ "name", "command", "args", "url"?, "configSource": "project"|"user",
                   "connected"?: bool, "tools"?: [{ "name", "schemaSizeTokens" }] }],
  "systemContext": { "totalBytes": 0, "files": [{ "path", "bytes", "contentHash", "content"? }] } | null
}
```

- The `projectRoot` field mentioned in FR-6 is **left out**. It is an absolute local path, which FR-3 and the "no absolute path" acceptance criterion forbid, and every path is already relative.
- The reference line is `{ "type": "harness-snapshot-ref", "snapshotId": "<id>" }`.

**DD-2. `snapshotId` algorithm.** `snapshotId = sha256Hex(JSON.stringify(canon))`, where `canon` is built as follows:

```
canon = { v: 1,
  skills:  entries sorted by (source, name) → [name, source, plugin ? `${plugin.id}@${plugin.version}` : '', contentHash],
  agents:  sorted by path                   → [name, path, contentHash],
  mcp:     sorted by name                   → [name, command, args, url ?? '', configSource],
  context: systemContext files sorted by path → [path, contentHash] }
```

- `contentHash` is the sha256 hex of the raw UTF-8 file text, the whole file including frontmatter.
- MCP probe results (`connected`, `tools`) and `perToolDetailSupported` are excluded from the id.
- The server **never recomputes** the id; it trusts the hook's value and only validates the format `^[0-9a-f]{64}$`.

**DD-3. Path rules for every section.**

| Source | Path format |
|---|---|
| `project` | Relative to `projectRoot`, with forward slashes. A systemContext file outside the root (from the `path.dirname(cwd)` candidates) gets `path.relative` output (`../x/CLAUDE.md`), which is still not absolute. |
| `user` | `~/.claude/<rel>`, where `<rel>` is taken from `claudeConfigDir(env)`. |
| `plugin` | `<pluginName>@<version>/<rel inside installPath>`, e.g. `adlc-lh@1.3.1/skills/tracker/SKILL.md`. This follows the wireframe. |

- Rule paths keep their `.claude/rules/` segment.
- `lastModified` is removed everywhere.

**DD-4. Which plugins are enabled.**

1. Merge `enabledPlugins` from three files in order: `<claudeConfigDir>/settings.json`, then `<projectRoot>/.claude/settings.json`, then `<projectRoot>/.claude/settings.local.json`. A later file overrides an earlier one, and the value `false` disables a plugin.
2. For each enabled `<name>@<marketplace>`, read the `plugins["<id>"]` array of `<claudeConfigDir>/plugins/installed_plugins.json` (v2 format). Pick the first entry that matches, in this order:
   - `scope: "local"` with a matching `projectPath`;
   - `scope: "project"` with a matching `projectPath`;
   - `scope: "user"`.
   `projectPath` matches `projectRoot` or the session `cwd` after normalising: `path.resolve`, backslashes to `/`, trailing `/` stripped, and lower-cased on win32.
3. If no entry matches, skip the plugin and write a `hook.log` line, `harness: plugin <id> enabled but not installed for this project — skipped`.
4. The plugin name is `.claude-plugin/plugin.json` `name`, falling back to the id part before `@`.

**DD-5. What the catalog scans.**

- For **project** (`<projectRoot>/.claude/`) and **user** (`<claudeConfigDir>/`):
  - `skills/<dir>/SKILL.md`: name from frontmatter `name`, else the directory name. Kind `skill`.
  - `workflows/*.js`: name from the regex `meta\s*=\s*\{[\s\S]*?name:\s*['"]([^'"]+)['"]` and description from the matching `description:` (the file is never executed); else the file basename. Kind `workflow`.
  - `commands/*.md`, top level only: name is the file basename. Kind `command`.
- For a **plugin**: the same three folders under `installPath`, plus any extra directories that `plugin.json` lists in `skills` or `commands` (a string or an array of relative paths). The name is `<pluginName>:<name>`.
- On a project/user name collision, **project wins**.
- The recursive scan of `~/.claude/plugins/` and the reading of directory-marketplace working copies are removed.

**DD-6. Hook known-state (`harness-state.json` v2).**

- File shape: `{ version: 2, knownSnapshotIds: string[], sessionSnapshots: { [sessionId]: snapshotId } }`. `knownSnapshotIds` is most recent first; both are capped at `HARNESS_KNOWN_SNAPSHOTS_MAX = 20`. `sessionSnapshots` feeds DD-19.
- A v1 file, or one that is missing or corrupt, reads as empty. The full snapshot is then sent once.
- Updates:
  - The id is added only after a successful upload that carried the full snapshot.
  - The id is removed, and the file persisted, when the response carries `unknownSnapshotId` equal to it.
- Same writer as today: temp file + rename, never throws.

**DD-7. Hook per-run flow** (current-session artisyn uploads only; backlog sessions get neither line):

1. Build the static snapshot: catalog, agents, systemContext and static MCP config. Then compute `snapshotId`.
2. If the id is known, the prefix is `[ref]` and the query is `snapshotId=<id>`.
3. Otherwise, run the MCP probe, then the prefix is `[ref, full]` and the query is `snapshotId=<id>&snapshotFull=1`.
4. The result is memoised per run, so the probe runs at most once.
5. The prefix keeps the old harness position: after `hook-status`, before `code-inventory`.
6. For chunked uploads, every chunk carries the same query params.

**DD-8. Server "known" check (FR-10)**, synchronous in the controller:

- `unknownSnapshotId` is returned only when all four hold:
  - `snapshotId` is valid per DD-2;
  - `snapshotFull !== '1'`;
  - no `harness_snapshots` row exists for (`req.userId`, id);
  - no `upload_queue` row exists for (`user_id = req.userId`, `harness_snapshot_id = id`, `status IN ('pending','processing','partially_uploaded')`).
- It is returned on the single-upload response and the chunk-complete response. It is **not** returned on intermediate chunks or foreign-session responses.
- An invalid `snapshotId` is ignored, never a `400`.
- `upload_queue.harness_snapshot_id` is set (to `snapshotId`) only when `snapshotFull=1`. For a chunked upload it is set on the row insert at chunk 0.

**DD-9. Ingest binding (artisyn logs only, inside the existing per-session transaction).** This replaces the old Step 5d inventory source:

1. Store: `snap = extractHarnessSnapshot(lines)`. If present, `inserted = storeHarnessSnapshot(tx, userId, snap)`, an `INSERT … ON CONFLICT (user_id, snapshot_id) DO NOTHING RETURNING id`.
2. Bind: `ref = extractHarnessSnapshotRef(lines) ?? snap?.snapshotId`. If present, `bound = bindSessionSnapshot(tx, sessionRowId, ref)`, an `UPDATE sessions SET harness_snapshot_id = $ref WHERE id = $id AND harness_snapshot_id IS NULL RETURNING id`.
3. Inventory: on every artisyn upload that carries a ref or a full snapshot, read the session's current `harness_snapshot_id`, then load the row (`userId`, current id). If it exists, upsert inventory from it into every repo linked through `log_repositories`. This runs on every upload, not just the first bind, so a repo linked by a later upload still gets inventory, as the current Step 5d does.
4. Capability columns:
   - `harness_inventory_reported_at` is always set.
   - `harness_mcp_per_tool_supported = true` is set only when `body.perToolDetailSupported === true`.
- The snapshot owner is the uploading `userId`.

**DD-10. Inventory mapping from the snapshot.**

| Element | Built from |
|---|---|
| Rules | `systemContext.files` whose path contains `.claude/rules/`; name is the basename. |
| Skills | `skills` with `kind !== 'workflow'`; `source` is kept as `'project' \| 'user' \| 'plugin'`. Workflows are left out because harness-usage tracks them as workflow runs. |
| MCP | `mcpServers`, plus their `tools`, as today. |

**DD-11. Orphan cleanup (FR-9a).** `purgeSessionChildData` (`sessions.service.ts:175`) is shared by soft delete, hard delete, admin family delete and retention. It gains two steps:

- **g.** `UPDATE sessions SET harness_snapshot_id = NULL WHERE id IN (ids)`.
- **h.** `deleteOrphanHarnessSnapshots(tx)`: `DELETE FROM harness_snapshots hs WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.harness_snapshot_id = hs.snapshot_id)`.

The orphan test matches the snapshot id across owners. A row whose id is still referenced by any session survives, which is conservative and needs no owner join.

The team-repo deletion in `server/src/teams/teams.service.ts` (step 4d, around line 656) deletes orphaned `sessions` rows directly. After that delete it calls `deleteOrphanHarnessSnapshots(tx)`. Account deletion is covered by `ON DELETE CASCADE` on `users`.

**DD-12. Read path (FR-11).**

- `getSessionLogs` selects `sessions.harness_snapshot_id` for the root session row. If both that column and `sessionOwnerRow.userId` are set, it loads `harness_snapshots.body` for (owner, id).
- It appends `"harnessSnapshot":<body JSON>|null` to the hand-built response.
- `body` carries `snapshotId` but no `type`.
- Access is exactly the existing checks of the route.

**DD-13. Client mapping.**

`parseSessionLogs(raw, { harnessSnapshot })` builds:

| Field | Built from |
|---|---|
| `skillDefinitions` | Map of every snapshot skill except `anthropic-skills:*`; feeds the turn chips (FR-17). |
| `visibleSkills: SkillDefinition[]` | Entries whose name is in `registeredSkills`; when `registeredSkills` is empty, all of them. Sorted by name. |
| `agentDefinitions` | Map from `snapshot.agents`. |
| `visibleAgents` | Same rule as `visibleSkills`, against `registeredAgents`. |
| `mcpConfig` | `snapshot.mcpServers`. |
| `claudeMd` | `snapshot.systemContext`, with the role classified as today. |

- With no snapshot, all of these are `undefined` or empty.
- MCP tab: shown only when `mcpConfig` is non-empty. Deferred `mcp__*` tools no longer create the MCP tab or the MCP chip, but they still appear in the Tools tab. This matches `wireframes/sysctx-no-snapshot.svg`.

**DD-14. Export/import.**

- Export (`runExportJob` in `repository-export-import.service.ts`) prepends to `artisyn.jsonl` of a session that has a snapshot:
  - the `harness-snapshot` line built from the table row, keyed by the artisyn log owner;
  - a `harness-snapshot-ref` line, if the body has none.
- Import (`LogsService.importSessionLog`, `logs.service.ts:683`) runs DD-9 steps 1–2 for artisyn logs, with owner `resolvedUserId`.

**DD-15. Sibling task `2026-10-16-sysctx-instruction-files`.** That task's "hook `system-context` event" source becomes `summary.claudeMd` built from `snapshot.systemContext` (DD-13), which it then merges with the Claude-log `instructions` / `nested_memory` attachments. This task deletes the `system-context` event reading.

**DD-16. Constants.**

| Constant | Location |
|---|---|
| `HARNESS_SNAPSHOT_SCHEMA_VERSION = 1` | Hook `harness-snapshot.js` |
| `SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/` | Server `harness-snapshot.ts` |
| `HARNESS_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024` | Server `harness-snapshot.ts` |
| `HARNESS_STATE_VERSION = 2` | Hook `harness-state.js` |
| `HARNESS_KNOWN_SNAPSHOTS_MAX = 20` | Hook `harness-state.js` |
| `PENDING_QUEUE_STATUSES = ['pending','processing','partially_uploaded']` | Server `harness-snapshot.ts` |
| `HIDDEN_SKILL_PREFIX = 'anthropic-skills:'` | Client `log-parser.ts` |

**DD-17. Old data and the raw-logs view.**

- Already-stored sessions with only the old `skill-definitions`, `agent-definitions`, `mcp-config` or `system-context` events lose their System Context tabs, by the owner's decision (no fallback, no backfill). Their raw rows stay visible in Raw Logs through the existing renderers.
- `getSessionLogs` keeps prepending the artisyn body to `main`, so `harness-snapshot` lines also reach Raw Logs. The duplicate payload exists only in the one upload that carried the full snapshot; later uploads overwrite the body with the ref only.
- `raw-logs/renderers.tsx` and `raw-logs/utils.ts` get compact cases:
  - `harness-snapshot`: the first 12 characters of the id, plus counts of skills, agents, MCP servers and files. No bodies.
  - `harness-snapshot-ref`: the first 12 characters of the id.

**DD-18. Hook-side type.** `harness-snapshot.js` declares the DD-1 shape as JSDoc `@typedef HarnessSnapshot`, mirroring the server `HarnessSnapshotBody` and the client `HarnessSnapshot`.

**DD-19. Prompt-triggered uploads (`prompt-upload-hook.js`).**

- That path re-uploads the current session's artisyn log on every UserPromptSubmit. It must stay fast, so it never builds the catalog or runs the probe.
- harness-state v2 also records `sessionSnapshots: { [sessionId]: snapshotId }`, capped at `HARNESS_KNOWN_SNAPSHOTS_MAX` entries with the most recent kept. `send-logs-hook.js` writes it after every current-session artisyn upload.
- `prompt-upload-hook.js` reads the session's recorded id:
  - If one exists, it prepends `harness-snapshot-ref` to the artisyn body and sends `snapshotId=<id>`. It never sends `snapshotFull`. On `unknownSnapshotId` it calls `forgetSnapshot`.
  - If none exists, it adds nothing, and the session binds at the next Stop.

**DD-20. Server validation of `harness-snapshot`.** A line is valid only when all of these hold:

- `snapshotId` matches `SNAPSHOT_ID_RE`;
- `schemaVersion === 1`;
- `skills`, `agents` and `mcpServers` are arrays;
- `systemContext` is an object or null;
- the serialized body is at most `HARNESS_SNAPSHOT_MAX_BYTES`.

An invalid line is ignored with a `logger.warn`, and the upload is processed otherwise unchanged.

**DD-21. Accepted race.** A purge can delete a row between the controller's "known" answer and the ingest of a ref-only upload. That session is then bound to an id with no row. The next upload of that session self-heals: the controller reports the id unknown, the hook resends the full snapshot, and the ingest stores the row. A session that never uploads again stays without a snapshot, and that is accepted.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0073_harness_snapshots.sql` + `meta/_journal.json` | Migration | Hand-written, no `CONCURRENTLY`. Then run `npm run migrations:lock`. |
| `server/src/database/schema/index.ts` | `harnessSnapshots` table; new columns on `sessions` and `upload_queue` | Per Database changes |
| `server/src/logs/harness-snapshot.ts` (new) | Types, extraction, store/bind/load/known/orphan helpers | DD-1, DD-8, DD-9, DD-11 |
| `server/src/logs/artisyn-extractor.ts` | `NON_ACTIVITY_LINE_TYPES` gets both new types; the three inventory extractors take a snapshot body | DD-10 |
| `server/src/logs/logs.service.ts` | Step 5d rewritten; `importSessionLog` binding | DD-9, DD-14 |
| `server/src/logs/reports/harness-usage.service.ts` | `source` widened to `'project'\|'user'\|'plugin'\|null` | Lines 55, 95, 545 |
| `server/src/sessions/sessions.service.ts` | Steps g and h in `purgeSessionChildData` | DD-11 |
| `server/src/teams/teams.service.ts` | Orphan snapshot sweep after the step-4d session delete | DD-11 |
| `client/src/viewer/pages/repository/session-log/raw-logs/renderers.tsx`, `raw-logs/utils.ts` | Compact rows for `harness-snapshot` and `harness-snapshot-ref` | DD-17 |
| `docs/knowledgebase/api-reference.md` | New query params and response fields; old inventory events removed | Lines around 295, 340, 2032, 2354 |
| `hook/HOW_HOOK_WORKS.md`, `hook/INSTALL_HOOK.md` | Snapshot flow replaces the event sections (around lines 205 and 276); `harness-snapshot.js` added to the file lists (around lines 224 and 331) | |
| `server/src/logs/repository-export-import.service.ts` | Export prepends snapshot lines | DD-14 |
| `server/src/logs/logs-v2.controller.ts` | Query params and `unknownSnapshotId` | DD-8 |
| `server/src/logs/upload-queue.service.ts` | `harnessSnapshotId` in `saveRawUpload`/`saveChunk` meta and insert | DD-8 |
| `server/src/logs/repositories.controller.ts` | `harnessSnapshot` in `getSessionLogs` | DD-12 |
| `hook/.claude/telemetry_tool/skill-catalog.js` | Rewritten as `buildSkillCatalog({projectRoot, cwd, env, log})` | DD-3 – DD-5 |
| `hook/.claude/telemetry_tool/harness-snapshot.js` (new) | `buildAgentDefinitions`, `buildSystemContext`, `readMcpServersStatic`, `computeSnapshotId`, `buildHarnessSnapshot` | DD-1 – DD-3 |
| `hook/.claude/telemetry_tool/harness-state.js` | v2 known-ids state | DD-6 |
| `hook/.claude/telemetry_tool/prompt-upload-hook.js` | Ref-only prefix plus `snapshotId` query on the artisyn upload | DD-19 |
| `docs/knowledgebase/hook-installation.md` | Remove `PLUGIN_SKILL_MAX_DEPTH` and the recursive plugin scan (around lines 232–235) | DD-5 |
| `docs/knowledgebase/raw-logs-renderers.md` | New raw-log cases | DD-17 |
| `hook/.claude/telemetry_tool/send-logs-hook.js` | Harness prefix, probe split, commit/forget logic; old builders removed | DD-7 |
| `hook/.claude/telemetry_tool/upload-logs.js` | `snapshotQuery` param; parse `unknownSnapshotId` (single + chunked) | DD-8 |
| `hook/.claude/telemetry_tool/post-turn-analysis-worker.js` | Uses `buildSkillCatalog` | Line 44, 432 |
| `hook/.claude/telemetry_tool/version.json` | Bump `2.21.1` → `2.22.0` | |
| `scripts/build-hooks-installer.js` | Add `harness-snapshot.js` to `HOOK_JS_FILES` (lines 105–140) | |
| `.artisyn/marketplace/plugins/log-hub-hooks/` | Dogfood refresh | Per `.claude/rules/hook.md` |
| `client/src/viewer/api.ts` | `HarnessSnapshot` types; `SessionLogsData.harnessSnapshot` | DD-1 |
| `client/src/viewer/pages/repository/session-log/types.ts` | `SkillDefinition` / `AgentDefinition` changes; new `SessionSummary` fields | DD-13 |
| `client/src/viewer/pages/repository/session-log/log-parser.ts` | Snapshot mapping; delete old-event parsing and the fallback | DD-13 |
| `SessionLogView.tsx:68`, `useRepositoryData.ts:312`, `session-export-runner.ts:96`, `CallTreeView.tsx:66` | Pass `harnessSnapshot` | |
| `client/src/viewer/pages/repository/session-log/SessionContextPanel.tsx` | Tabs, chips and rows from the snapshot; test ids | Visual/UX notes |
| `client/src/viewer/pages/repository/session-log/SourceBadge.tsx` | `user` badge (amber) | |
| `client/src/viewer/pages/repository/session-log/SkillDetailModal.tsx` | Badge, Plugin row, Modified row removed | |
| `client/src/viewer/pages/repository/session-log/prompt-turn-helpers.tsx` | `buildSkillDefinitionRows` (line 274): source label, plugin version | |
| `client/src/models/harness-usage.ts` | `source` gets `'user'` (line 34) | |
| `docs/knowledgebase/algorithms/harness-snapshot.md` (new) + `algorithms/README.md` | Algorithm doc + Docs table row | |
| `hook/.claude/telemetry_tool/__tests__/harness-snapshot.algo.test.js` (new) | Table test | |
| KB: `hook-system-overview.md`, `hook-api-versioning.md`, `session-log-view.md`, `data-retention.md`, `upload-queue.md`, `db-tables.md`, `session-export-import.md`, `index.md` | Docs | |
| `server/test/contract/fixtures/world-v1.sql.ts`, `registry/f15-ingest.ts`, `registry/f17-sessions.ts`, `registry/f18-session-delete-retention.ts` | Contract rows | |
| `tests/golden/gs-05-skills-rules-mcp-workflow/{artisyn.jsonl,session.jsonl,expected.json,README.md}` | Golden converted to snapshot | |
| `tests/scenarios/view/s-sess-03.spec.ts`, `hook/s-hook-01.spec.ts`, `hook/s-hook-09.spec.ts`, `hook/s-compat-01.spec.ts`, `ingest/s-ingest-02.spec.ts`, `repos/s-repo-09.spec.ts` | Scenario steps | |
| `tests/e2e/harness-usage.spec.ts` | Existing legacy spec: payload switched to snapshot events so `e2e-full` stays green | No new test |

## API changes

**`POST /api/v2/logs`** (`logs-v2.controller.ts`)

- New optional query params:
  - `snapshotId`: 64-char hex. An invalid value is ignored.
  - `snapshotFull`: `'1'` when the body carries the full `harness-snapshot`.
- Response, additive only:
  - Single upload: `{ warnings: string[], unknownSnapshotId?: string }`.
  - Chunked: `{ complete: true, warnings: string[], unknownSnapshotId?: string }`.
  - Intermediate chunks (`{ complete: false }`) and foreign-session responses are unchanged.
- The TypeScript return type at lines 48–50 is extended to match.
- An old hook sends no `snapshotId`, so it never gets the field.

**`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`** (`repositories.controller.ts:1753`)

- New response field `harnessSnapshot: HarnessSnapshot | null`, shaped as DD-1 minus `type`.
- Same access checks as the logs: owner, admin, team scope. The outsider still gets `403`.
- Client type `HarnessSnapshot`, with `HarnessSnapshotSkill`, `HarnessSnapshotAgent`, `HarnessSnapshotMcpServer` and `HarnessSnapshotFile`, lives in `client/src/viewer/api.ts`. The server-side interface lives in `server/src/logs/harness-snapshot.ts`.

## Database changes

Migration `0073_harness_snapshots.sql` (next free number after `0072_team_repo_config.sql`):

```sql
CREATE TABLE harness_snapshots (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_id varchar(64) NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT harness_snapshots_user_id_snapshot_id_key UNIQUE (user_id, snapshot_id)
);
CREATE INDEX idx_harness_snapshots_snapshot_id ON harness_snapshots (snapshot_id);
ALTER TABLE sessions ADD COLUMN harness_snapshot_id varchar(64);
CREATE INDEX sessions_harness_snapshot_id_idx ON sessions (harness_snapshot_id);
ALTER TABLE upload_queue ADD COLUMN harness_snapshot_id varchar(64);
```

- Steps: hand-write the SQL, add the `meta/_journal.json` entry, run `npm run migrations:lock` (from `server/`), and mirror it in the Drizzle schema `index.ts`. Per `docs/knowledgebase/db-schema-code.md`, never run `drizzle-kit generate`.
- Run the `migrations-data-integrity` skill.
- No backfill.

## Test coverage plan

Only the three allowed kinds.

**Algorithm**

- New doc `docs/knowledgebase/algorithms/harness-snapshot.md`, with a Docs-table row in `algorithms/README.md`.
- New test `hook/.claude/telemetry_tool/__tests__/harness-snapshot.algo.test.js`. The requirements' `hook/__tests__` path is wrong; the hook runner picks up this folder.
- Each row's `input` is a virtual file tree (path → text, plus `settings` / `installed_plugins` JSON). The test writes it into a temp dir and calls `buildSkillCatalog` / `computeSnapshotId` with `env.CLAUDE_CONFIG_DIR` pointing into it.
- Rows:

  | Row | Case | Expected |
  |---|---|---|
  | (a) | Two cached versions of a plugin | Only the `installPath` one |
  | (b) | Plugin enabled at user level but `false` in local settings | Excluded |
  | (c) | `project` scope with a foreign `projectPath` | Excluded |
  | (d) | Plugin workflow | `<plugin>:<meta.name>` |
  | (d) | `.claude/commands/x.md` | `project` |
  | (e) | Plugin enabled but not installed | Skipped |
  | (f) | Touch without an edit | Same id |
  | (f) | Edit that keeps the mtime | New id |
  | (g) | MCP probe fields differ | Same id |
  | (h) | MCP config change | New id |
  | (i) | User skill | `source: user`, `~/.claude/…` path |
  | (j) | Project/user name collision | Project wins |

**API contract**

- `registry/f12-team-repos.ts`: the `DELETE /api/v1/teams/:teamId/repositories/:repoId` row that removes orphaned `sessions` gets a `harness_snapshots` delete delta. A world snapshot is bound to one of the sessions that row removes.
- `registry/f15-ingest.ts`: a single-chunk upload (`uploadId`, `chunkIndex=0`, `totalChunks=1`, `totalSize`) with an unknown `snapshotId` returns `{ complete: true, unknownSnapshotId }`.
- `registry/f15-ingest.ts`:
  - New row: `POST /api/v2/logs` with `query.snapshotId` = an unknown id → `bodyMatches { warnings: [], unknownSnapshotId: <id> }`, plus an `upload_queue` insert with `harness_snapshot_id IS NULL`.
  - New row: the world-seeded id → no `unknownSnapshotId`.
  - New row: `snapshotFull=1` → the queue row has `harness_snapshot_id` set.
- `registry/f17-sessions.ts`:
  - A `F17-session-logs-snapshot` row on `s04` reads `harnessSnapshot` from the seeded `harness_snapshots` row.
  - A `F17-session-logs-no-snapshot` row on `s01` expects `harnessSnapshot: null`.
  - The existing `F17-session-logs-outsider` already pins the denial.
- `registry/f18-session-delete-retention.ts`: the `F18-delete-by-admin` row (`s04`) gets extra deltas. The `harness_snapshots` row is deleted, and `sessions.harness_snapshot_id` becomes NULL.
- `fixtures/world-v1.sql.ts`: seed the snapshot for the `s04` owner, and set `sessions.harness_snapshot_id` on `s04`.

**Scenarios**

| Scenario | Step |
|---|---|
| `view/s-sess-03` | Upload `gs-05` as well. gs-05 Logs → System Context: Skills tab rows are snapshot ∩ `skill_listing`; `unused-skill` is hidden; the `plugin` badge and tokens are shown. Clicking `adlc:review-deep` opens the modal with `skill-detail-plugin` and no Modified row. gs-01 has no Skills, Agents or MCP tab. |
| `repos/s-repo-11` | New step: import a zip built with `buildZip` (`helpers/zip.ts`) holding a new session whose `artisyn.jsonl` has snapshot lines. Afterwards a `harness_snapshots` row exists for the importer, and the session's `harness_snapshot_id` is set. |
| `hook/s-hook-01` | Step 4: `harness-snapshot-ref` + `harness-snapshot` and the query params; old events absent. Step 5: the second Stop sends only the ref. New step: the fake hub answers `unknownSnapshotId` → the next Stop resends the full snapshot. |
| `hook/s-hook-09` | Step 4: the snapshot row exists and `agents` contains `rev`. Step 5: the second Stop sends no full snapshot, still one row, and GET logs still returns `harnessSnapshot`. |
| `ingest/s-ingest-02` | Two owners upload the same `snapshotId` → two rows, and each session returns its owner's body. A later ref-only upload does not change the session's column. |
| `hook/s-compat-01` | Step 6: the 2.6.1 upload is OK and `sessions.harness_snapshot_id IS NULL`. |
| `repos/s-repo-09` | Step 2: the exported `artisyn.jsonl` of a snapshot session contains a `harness-snapshot` line. |

- The `system-context` line in `gs-01` `session.jsonl` (a Claude-log fixture line) is untouched. `s-sess-12` and `gs-01/expected.json` assert it only as a Raw Logs row, so they stay green; gs-01 simply has no Files tab any more.
- `tour-03` only uploads gs-05 and does not assert its System Context, so it needs no change.

## Visual/UX notes

Follows the three wireframes.

- **Header chips**:
  - `N MCP` is the count of snapshot `mcpServers`.
  - `N tools` is unchanged.
  - `N skills` is `visibleSkills.length`.
  - `N agents` is `visibleAgents.length`.
  - `N files` is the count of snapshot systemContext files.
  - A chip is absent when its count is 0.
- **Tabs** are shown only when they have data: Files, MCP, Tools, Skills, Agents, Rules. With no snapshot, only Tools can remain, and the panel returns `null` if nothing is left. There is no empty or error state.
- **Skills table**: columns Name (monospace, plugin namespace kept), Source and Tokens (`~N tok` from `bytes / charsPerToken`). Every row has the pointer cursor and opens `SkillDetailModal`.
- **`SourceBadge` colours**:

  | Source | Classes |
  |---|---|
  | `project` | `text-sky-600 dark:text-sky-400` |
  | `user` | `text-amber-600 dark:text-amber-400` |
  | `plugin` | `text-violet-600 dark:text-violet-400` |

  `built-in` is removed.
- **Modal**:
  - Badge: PROJECT / USER / PLUGIN.
  - New Plugin row for plugin skills only: `<id> · v<version> · <gitCommitSha first 7>`, with the sha part omitted when there is none.
  - The Path row shows the DD-3 path.
  - The Modified row is removed.
  - The Body tab is always present.
- **Test ids**:
  - `sysctx-panel`
  - `sysctx-tab-<files|mcp|tools|skills|agents|rules>`
  - `sysctx-skill-row` (attribute `data-skill-name`)
  - `sysctx-agent-row`
  - `skill-detail-modal`
  - `skill-detail-plugin`

## Wireframes

No changes; the three SVGs in `wireframes/` already match DD-13 and the Visual/UX notes.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | DB schema + migration | 4 | First; everything server-side depends on it |
| 2 | Server snapshot module + extractors | 6 | Needs chunk 1 schema |
| 3 | Server ingest, retention, export/import | 7 | Uses chunk 2 helpers |
| 4 | Server API (upload + session logs) | 5 | Uses chunks 2–3 |
| 5 | Hook catalog (skill-catalog.js) | 6 | Independent of server; before chunk 6 |
| 6 | Hook snapshot builder + state | 6 | Uses chunk 5 |
| 7 | Hook upload wiring + release | 8 | Uses chunks 4 (API) and 6 |
| 8 | Client data layer | 7 | Uses chunk 4 response shape |
| 9 | Client UI | 7 | Uses chunk 8 |
| 10 | Knowledgebase (hook + API) | 5 | After code is settled |
| 11 | Knowledgebase (data, retention, view) | 6 | After code is settled |
| 12 | Algorithm doc + hook table test | 4 | Tests: algorithm |
| 13 | Contract rows | 7 | Tests: API contract |
| 14 | Golden data + view/ingest scenarios | 6 | Tests: scenarios |
| 15 | Hook/compat/export scenarios + legacy spec fix | 6 | Tests: scenarios |

### Chunk 1 — DB schema + migration
- [ ] Write `server/drizzle/migrations/0073_harness_snapshots.sql` with the exact SQL from Database changes.
- [ ] Add the `0073_harness_snapshots` entry to `server/drizzle/migrations/meta/_journal.json`, following the previous entry's shape.
- [ ] In `server/src/database/schema/index.ts`, add the `harnessSnapshots` pgTable (columns, unique, index per Database changes), `harnessSnapshotId: varchar('harness_snapshot_id', {length: 64})` plus its index on `sessions` (line 133), and the same column on `uploadQueue` (line 1172).
- [ ] Run `npm run migrations:lock` from `server/` and follow the `migrations-data-integrity` skill.

### Chunk 2 — Server snapshot module + extractors
- [ ] Create `server/src/logs/harness-snapshot.ts` with the `HarnessSnapshotBody` interfaces (DD-1), `SNAPSHOT_ID_RE` and `PENDING_QUEUE_STATUSES` (DD-16), `HARNESS_SNAPSHOT_MAX_BYTES`, `extractHarnessSnapshot(lines)` (first line valid per DD-20, body minus `type`, else null with a warn log), and `extractHarnessSnapshotRef(lines)` (first valid ref id).
- [ ] Add `storeHarnessSnapshot(tx, userId, body): Promise<boolean>`, `bindSessionSnapshot(tx, sessionRowId, id): Promise<boolean>` and `loadHarnessSnapshot(db, userId, id)` to `harness-snapshot.ts`, using the SQL from DD-9.
- [ ] Add `isHarnessSnapshotKnown(db, userId, id)`, implementing the DD-8 table-or-queue check, and `deleteOrphanHarnessSnapshots(tx)`, implementing the DD-11 step h SQL, to `harness-snapshot.ts`.
- [ ] In `server/src/logs/artisyn-extractor.ts`, add `'harness-snapshot'` and `'harness-snapshot-ref'` to `NON_ACTIVITY_LINE_TYPES` (lines 82–93).
- [ ] Change `extractHarnessRuleInventory` (line 360), `extractHarnessSkillInventory` (line 407) and `extractHarnessMcpInventory` (line 456) to take a `HarnessSnapshotBody`, mapping per DD-10. Keep the `user` source; drop the old-event parsing.
- [ ] Widen the skill `source` type to `'project' | 'user' | 'plugin' | null` in `server/src/logs/reports/harness-usage.service.ts` (lines 55, 95, 545).

### Chunk 3 — Server ingest, retention, export/import
- [ ] Rewrite Step 5d in `server/src/logs/logs.service.ts` (lines 457–535) as DD-9 for artisyn logs. Build `elements` from the loaded snapshot via the chunk-2 extractors, and keep the existing `upsertHarnessElements` and repositories `UPDATE` statements.
- [ ] Set `harness_mcp_per_tool_supported = true` in Step 5d only when the loaded body has `perToolDetailSupported === true`; otherwise update only `harness_inventory_reported_at` (DD-9 step 4).
- [ ] In `LogsService.importSessionLog` (line 683), for `logType === 'artisyn'`, run DD-9 steps 1–2 inside its transaction with owner `resolvedUserId`.
- [ ] In `SessionsService.purgeSessionChildData` (`server/src/sessions/sessions.service.ts:175`), add steps g and h from DD-11 after step f.
- [ ] In `server/src/teams/teams.service.ts` step 4d (around line 656), call `deleteOrphanHarnessSnapshots(tx)` right after the orphaned `sessions` delete (DD-11).
- [ ] In the export job (`server/src/logs/repository-export-import.service.ts`, where `artisyn.jsonl` is synthesised near line 670), prepend the snapshot lines per DD-14 when the session's `harness_snapshot_id` resolves for the artisyn owner.
- [ ] Update the Step 5d comment block and the `NON_ACTIVITY_LINE_TYPES` comment to describe the snapshot source and remove the mention of the old events.

### Chunk 4 — Server API (upload + session logs)
- [ ] In `server/src/logs/logs-v2.controller.ts` `postLogs`, add `@Query('snapshotId')` and `@Query('snapshotFull')`, and extend the return type (lines 48–50) with `unknownSnapshotId?: string`.
- [ ] Pass `harnessSnapshotId` (set only when `snapshotFull === '1'` and the id is valid) through `SaveRawUploadMeta` / `SaveChunkMeta` into both `upload_queue` inserts in `upload-queue.service.ts` (lines 100 and 166).
- [ ] In `postLogs`, compute `unknownSnapshotId` per DD-8 via `isHarnessSnapshotKnown`, and add it to the single-upload return and the chunk-complete return only.
- [ ] In `getSessionLogs` (`server/src/logs/repositories.controller.ts:1753`), select the root session's `harness_snapshot_id` and load the body for `sessionOwnerRow.userId` per DD-12.
- [ ] Append `,"harnessSnapshot":${JSON.stringify(body ?? null)}` to the `res.end(...)` JSON at line 2242.

### Chunk 5 — Hook catalog (skill-catalog.js)
- [ ] Rewrite `hook/.claude/telemetry_tool/skill-catalog.js`. Export `parseFrontmatter` and `buildSkillCatalog({projectRoot, cwd, env, log})`, which returns the `skills[]` entries of DD-1. Delete `findSkillFiles`, the recursive plugins scan and the directory-marketplace scan (lines 155, 226–244).
- [ ] Implement `readEnabledPlugins(projectRoot, env)`, merging the three settings files per DD-4 (`false` disables), replacing `readProjectClaudeSettings` (line 121).
- [ ] Implement `resolveInstalledPlugin(id, projectRoot, cwd, env)`. It reads `installed_plugins.json` v2 and applies the DD-4 scope order and `projectPath` normalisation, returning `{installPath, version, gitCommitSha, marketplace}` or null. When it returns null, log the DD-4 skip line.
- [ ] Implement the DD-5 scanners for `skills/`, `workflows/*.js` (meta regex, no execution) and `commands/*.md` (top level), plus the `plugin.json` extra `skills` / `commands` paths. Apply the project, user and plugin naming rules and project-wins dedupe.
- [ ] Compute each entry's `path` per DD-3, plus `bytes` and `contentHash`: sha256 hex of the text the scanner already reads, replacing the `mtimeMs` use in `readSkillFile` (line 91).
- [ ] Switch `post-turn-analysis-worker.js` (lines 44 and 432–434) to `buildSkillCatalog({projectRoot: getGitRoot(cwd), cwd})`, keeping its `{name, description}` dedupe.

### Chunk 6 — Hook snapshot builder + state
- [ ] Create `hook/.claude/telemetry_tool/harness-snapshot.js` and move `buildAgentDefinitions` there from `send-logs-hook.js:305`. It emits a DD-3 relative `path`, `contentHash` and `source: 'project'`, with no `lastModified`.
- [ ] Move `buildClaudeMdContext` from `send-logs-hook.js:236` into the same file as `buildSystemContext(cwd, projectRoot, env)`, with the same candidates, DD-3 paths and `contentHash` instead of `lastModified`. Rule `content` is kept.
- [ ] Move the static part of `buildMcpConfig` (`send-logs-hook.js:523–573`, including `extractMcpServers`) into `readMcpServersStatic(projectRoot, env)`. It returns `{servers, rawConfigByName}` with no probe.
- [ ] Add the JSDoc `@typedef HarnessSnapshot` (DD-18), `computeSnapshotId(sections)` per DD-2, and `buildHarnessSnapshot({projectRoot, cwd, env, log})`, which returns `{snapshotId, skills, agents, mcpServers, systemContext, rawConfigByName}` and uses the DD-16 schema version.
- [ ] Rewrite `harness-state.js` to v2 per DD-6: `readKnownSnapshots(workDir)`, `rememberSnapshot(workDir, id)`, `forgetSnapshot(workDir, id)`, `recordSessionSnapshot(workDir, sessionId, id)`, `readSessionSnapshot(workDir, sessionId)`, keeping the temp + rename writer and fail-open read. Remove `computeHarnessFingerprint`.
- [ ] Add `harness-snapshot.js` to `HOOK_JS_FILES` in `scripts/build-hooks-installer.js` (lines 105–140).

### Chunk 7 — Hook upload wiring + release
- [ ] In `send-logs-hook.js`, replace `getHarnessPrefix` / `commitHarnessReport` (lines 1386–1500) with the DD-7 flow. Probe only the unknown case via `probeMcpServerTools` over `rawConfigByName`, and emit ref (plus full with `perToolDetailSupported: true`).
- [ ] Thread `snapshotQuery {snapshotId, snapshotFull}` from the current-session artisyn `processFile` call (lines 1817–1838) into `uploadFile` and the chunked upload path in `upload-logs.js`.
- [ ] In `upload-logs.js` `uploadFile` (lines 418–505), append `&snapshotId=…` and `&snapshotFull=1` when present, and return `unknownSnapshotId` parsed from the 201 JSON. Do the same in the chunked path's final result (around lines 740 and 845).
- [ ] In `prompt-upload-hook.js` `runUploads` (lines 116–160), apply DD-19 for the artisyn file. Pass the `snapshotQuery` into `uploadFileMaybeCompressed` / `uploadFileChunked`, and call `forgetSnapshot` on `unknownSnapshotId`.
- [ ] After each current-session artisyn upload: on success with the full snapshot sent, call `rememberSnapshot`; when `unknownSnapshotId === snapshotId`, call `forgetSnapshot`. Always call `recordSessionSnapshot`. Log both outcomes with `hookLog` (`harness: snapshot <id12> sent|known|unknown on server — will resend`).
- [ ] Remove the now-unused `buildSkillDefinitions` import and the old four-event emission. Update the artisyn prepend comment (lines 1646–1668) to name `harness-snapshot-ref` / `harness-snapshot`.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.22.0`, run `npm run build:hooks-installer`, and refresh `.artisyn/marketplace/plugins/log-hub-hooks/` per `.claude/rules/hook.md`.
- [ ] Run the `update-install-instructions` skill for the hook change.

### Chunk 8 — Client data layer
- [ ] In `client/src/viewer/api.ts`, add the `HarnessSnapshot` interfaces (DD-1 minus `type`) and `harnessSnapshot?: HarnessSnapshot | null` on `SessionLogsData` (line 1166).
- [ ] In `session-log/types.ts`, update the following:
  - `SkillDefinition.source` becomes `'project'|'user'|'plugin'`; add `kind?`, `plugin?` (DD-1) and `contentHash?`; remove `lastModified`.
  - `AgentDefinition.source` gets the same union.
  - Add `visibleSkills?: SkillDefinition[]` and `visibleAgents?: AgentDefinition[]` to `SessionSummary` (lines 339–342).
- [ ] In `log-parser.ts`, add an `options.harnessSnapshot` parameter (line 1755) and build `claudeMd`, `skillDefinitions`, `agentDefinitions` and `mcpConfig` from it per DD-13, filtering `HIDDEN_SKILL_PREFIX`.
- [ ] Delete the `system-context`, `skill-definitions`, `agent-definitions` and `mcp-config` event loops (`log-parser.ts` lines 2389–2529) and the `skill_listing` content fallback (lines 2770–2827), including the now-unused `skillListingContent` variable.
- [ ] Compute `visibleSkills` and `visibleAgents` after `registeredSkills` / `registeredAgents` are known (lines 2709–2755) per DD-13, and put both on the summary. Keep the turn-chip definition resolution (lines 2829–2836) on `skillDefinitions`.
- [ ] Pass `harnessSnapshot: logsData.harnessSnapshot ?? null` at the root-session call sites `SessionLogView.tsx:68`, `useRepositoryData.ts:312`, `session-export-runner.ts:96` and `CallTreeView.tsx:66`.
- [ ] Add `'user'` to the skill `source` type in `client/src/models/harness-usage.ts` (line 34). Keep `filterProjectSkillsOnly` (`harness-usage-rows.ts:108`) as `=== 'project'`.

### Chunk 9 — Client UI
- [ ] In `SourceBadge.tsx`, change the union to `'project'|'user'|'plugin'`, add the amber `user` style per Visual/UX notes, and remove the `built-in` label.
- [ ] In `SessionContextPanel.tsx` (lines 70–118), derive `hasSkills` / `hasAgents` from `visibleSkills` / `visibleAgents`, and `hasMcp` / `serverCount` only from `summary.mcpConfig`. Compute the chips per Visual/UX notes.
- [ ] Change the Skills table (lines 360–410) to iterate `summary.visibleSkills`, with every row clickable, and the Agents table (lines 412–460) to iterate `summary.visibleAgents`.
- [ ] Add the test ids listed in Visual/UX notes to `SessionContextPanel.tsx` (panel, tab triggers, skill/agent rows) and to `SkillDetailModal.tsx`.
- [ ] In `SkillDetailModal.tsx`, update the badge (lines 62–80) to PROJECT/USER/PLUGIN, remove the Modified row (lines 100–109), and add the Plugin row (`skill-detail-plugin`) per Visual/UX notes.
- [ ] In `prompt-turn-helpers.tsx` `buildSkillDefinitionRows` (line 274), show the `user` source label and, for plugin skills, `plugin.id v<version>`. Remove any `lastModified` row.
- [ ] Add the compact `harness-snapshot` / `harness-snapshot-ref` cases from DD-17 to `raw-logs/renderers.tsx` and `raw-logs/utils.ts`, next to the existing `system-context` case.

### Chunk 10 — Knowledgebase (hook + API)
- [ ] Rewrite `docs/knowledgebase/hook-system-overview.md` §"Context injection" (around lines 318–361) for the snapshot: DD-1 shape, DD-2 id, DD-4 and DD-5 catalog, DD-6 and DD-7 state and flow. Keep the commit-after-success wording.
- [ ] Add a `snapshotId` / `snapshotFull` / `unknownSnapshotId` section to `docs/knowledgebase/hook-api-versioning.md`, next to the compatibility matrix (around lines 225–266). Record that pre-2.22.0 hooks get no snapshot, and that `perToolDetailSupported` moved to the snapshot root.
- [ ] Update `docs/knowledgebase/api-reference.md`:
  - `POST /api/v2/logs` query params and the 201 response (around lines 295 and 340) get `snapshotId`, `snapshotFull` and `unknownSnapshotId`.
  - The GET logs response (around line 2354) gets `harnessSnapshot`.
  - The old inventory events (around line 2032) are replaced with `harness-snapshot` / `harness-snapshot-ref`.
- [ ] Update `hook/HOW_HOOK_WORKS.md`, replacing the `skill-definitions` / `mcp-config` sections (around lines 205 and 276) with the DD-7 snapshot flow, and add `harness-snapshot.js` to the file lists in `hook/INSTALL_HOOK.md` (around lines 224 and 331).
- [ ] In `docs/knowledgebase/hook-installation.md` (around lines 232–235), remove `PLUGIN_SKILL_MAX_DEPTH` and the recursive plugin-scan text, and describe the DD-4 plugin resolution.

### Chunk 11 — Knowledgebase (data, retention, view)
- [ ] Update `docs/knowledgebase/session-log-view.md` §"Special log event fields" (lines 408–418): the System Context data comes from `harnessSnapshot` (DD-13), the `skill_listing` fallback is removed, and old sessions lose their tabs (DD-17).
- [ ] Add orphan snapshot cleanup (DD-11, including the team-repo deletion) to `docs/knowledgebase/data-retention.md` §"Purge mechanics", and the `harness_snapshot_id` known-check (DD-8) to `docs/knowledgebase/upload-queue.md`.
- [ ] Add the DD-14 snapshot lines in the export and the import binding to `docs/knowledgebase/session-export-import.md`.
- [ ] Document `harness_snapshots` and the two new columns from Database changes in `docs/knowledgebase/db-tables.md`.
- [ ] Add the DD-17 `harness-snapshot` / `harness-snapshot-ref` cases to `docs/knowledgebase/raw-logs-renderers.md`.
- [ ] Add `algorithms/harness-snapshot.md` to `docs/knowledgebase/index.md` (it gets its row in `algorithms/README.md` in chunk 12).

### Chunk 12 — Algorithm doc + hook table test
- [ ] Write `docs/knowledgebase/algorithms/harness-snapshot.md` in the README format, with front-matter `reviewed: no` and `reviewer: none`. The Rules section restates DD-2 to DD-5, and the Code section names `skill-catalog.js` and `harness-snapshot.js`.
- [ ] Add the doc's single `examples` block with the rows (a)–(j) from Test coverage plan. Each `note` carries an independent derivation, and each `input` is a virtual file tree with settings and `installed_plugins` JSON.
- [ ] Create `hook/.claude/telemetry_tool/__tests__/harness-snapshot.algo.test.js` on the `work-time.algo.test.js` template. It writes each row's tree to a temp dir, sets `env.CLAUDE_CONFIG_DIR`, and compares catalog subsets and id equality pairs.
- [ ] Add the `harness-snapshot` row to the Docs table in `docs/knowledgebase/algorithms/README.md`, with runner `node --test`.

### Chunk 13 — Contract rows
- [ ] In `server/test/contract/fixtures/world-v1.sql.ts`, add `harnessSnapshotId` (a fixed 64-hex constant) to `WORLD_V1`, and a `harness_snapshots` insert for `user_id = U.owner.id` (the s04 owner) with a minimal DD-1 body: one skill each of `project`, `user` and `plugin`.
- [ ] In the `world-v1.sql.ts` sessions insert (around line 890), add the `harness_snapshot_id` column: the constant on s04, null on all other sessions.
- [ ] In `registry/f15-ingest.ts`, add the three rows from Test coverage plan:
  - unknown id, actor `authorKey`;
  - the seeded id, actor `ownerKey`;
  - `snapshotFull=1`, actor `authorKey`.
  Each row gets its `upload_queue` delta.
- [ ] In `registry/f17-sessions.ts`, add `F17-session-logs-snapshot` (s04, `read.sql` over `harness_snapshots.body`, path `harnessSnapshot`) and `F17-session-logs-no-snapshot` (s01, `bodyMatches { harnessSnapshot: null }`).
- [ ] In `registry/f18-session-delete-retention.ts`, extend `F18-delete-by-admin` (s04) with a deleted-row delta for `harness_snapshots` and a changed `sessions.harness_snapshot_id` → NULL.
- [ ] In `registry/f15-ingest.ts`, add the single-chunk unknown-id row from Test coverage plan.
- [ ] In `registry/f12-team-repos.ts`, extend the `DELETE …/repositories/:repoId` row that removes orphaned `sessions` with the `harness_snapshots` delete delta. Seed a second world snapshot bound to one of those sessions in `world-v1.sql.ts`.

### Chunk 14 — Golden data + view/ingest scenarios
- [ ] In `tests/golden/gs-05-skills-rules-mcp-workflow/artisyn.jsonl`, replace the `mcp-config`, `skill-definitions` and `system-context` lines with a `harness-snapshot-ref` plus a `harness-snapshot` line. Use a fixed 64-hex id. Copy over the skills `adlc:review-deep`, `adlc:review` and `unused-skill` (keep their fields), the MCP servers `postgres` and `playwright`, and the files `CLAUDE.md` (3500 B), `.claude/rules/db.md` (700 B) and `.claude/rules/ui.md` (1400 B), all with DD-3 paths.
- [ ] Add an `isInitial: true` `skill_listing` attachment naming `adlc:review-deep` and `adlc:review` to `gs-05` `session.jsonl`. Update `expected.json` and `README.md` only where the stored or derived values actually change.
- [ ] Extend `tests/scenarios/view/s-sess-03.spec.ts` to upload `gs-05` too, and add the gs-05 step from Test coverage plan, using the Visual/UX test ids.
- [ ] Add the gs-01 no-snapshot step to `s-sess-03.spec.ts`: no `sysctx-tab-skills`, `sysctx-tab-agents` or `sysctx-tab-mcp`, and no page error.
- [ ] Add the two-owner and COALESCE step from Test coverage plan to `tests/scenarios/ingest/s-ingest-02.spec.ts`, using raw `POST /api/v2/logs` uploads and DB queries.
- [ ] Run the touched scenarios only: `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-SESS-03|@S-INGEST-02"`.

### Chunk 15 — Hook/compat/export scenarios + legacy spec fix
- [ ] In `tests/scenarios/hook/s-hook-01.spec.ts`, change `HARNESS_TYPES` (line 48) and step 4 to the snapshot lines plus query params. Make step 5 assert ref-only. Add a step where `hub.respond` returns `unknownSnapshotId` and the next Stop carries the full `harness-snapshot`.
- [ ] In `tests/scenarios/hook/s-hook-09.spec.ts`, change step 4 (lines 231–263) and step 5 (lines 265–275) per Test coverage plan.
- [ ] Add the assertion `sessions.harness_snapshot_id IS NULL` for the 2.6.1 session to step 6 of `tests/scenarios/hook/s-compat-01.spec.ts`.
- [ ] Give one setup session in `tests/scenarios/repos/s-repo-09.spec.ts` snapshot lines, and assert in step 2 that its exported `artisyn.jsonl` contains a `harness-snapshot` line.
- [ ] Switch the `skill-definitions` / `mcp-config` payloads in the existing legacy `tests/e2e/harness-usage.spec.ts` (around lines 134–145) to `harness-snapshot-ref` plus `harness-snapshot` lines, so the stored inventory stays as asserted.
- [ ] Add the `s-repo-11` import-binding step from Test coverage plan to `tests/scenarios/repos/s-repo-11.spec.ts`.
