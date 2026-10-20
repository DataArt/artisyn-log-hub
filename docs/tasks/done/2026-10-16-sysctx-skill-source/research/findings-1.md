**Requirements summary**
This replaces the four separate harness events (`skill-definitions`, `agent-definitions`, `mcp-config`, `system-context`) with one harness snapshot per session.

- **Hook catalog.** The hook builds an exact catalog of what Claude Code loads for the project:
  - `project` and `user` sources: skills, workflows and commands.
  - `plugin` source: only enabled plugins. The enabled set merges user settings, then project settings, then local settings. Each plugin's files are read from `installPath` of the matching `installed_plugins.json` entry. Names are `<plugin>:<skill>`, with `plugin {id, marketplace, version, gitCommitSha}`.
  - Paths are relative or `~/…`, and each entry carries a `contentHash` instead of `lastModified`.
- **Snapshot id.** The catalog goes into a snapshot with sections `skills`, `agents`, `mcpServers` and `systemContext`. `snapshotId` is a sha256 of the canonical content; MCP probe results are kept in the snapshot but left out of the id.
- **What the hook sends.** Every upload of the current session's artisyn log carries a `harness-snapshot-ref`. The full `harness-snapshot` is sent only when the hook does not know the server already has it. The hook sends `snapshotId` as a query parameter, and `POST /api/v2/logs` answers with an optional `unknownSnapshotId` so the hook can resend.
- **Server storage.** One table, one row per (owner, snapshotId). `sessions.harness_snapshot_id` is set with COALESCE and has no FK. Retention deletes snapshots that no session references. `harness_elements` is filled from the snapshot and keeps `user` as a source. The `/logs` endpoint returns the snapshot, or an explicit "no snapshot".
- **Client.** The Skills, Agents, MCP, Files and Rules data comes only from the snapshot, with skills filtered by `skill_listing`. The `skill_listing` fallback and the reading of the old events are removed. A `user` badge is added, and the modal shows the plugin and version.
- **Compatibility.** Old hooks do not need to work fully: their uploads must still succeed, but their sessions get no snapshot.

**Wireframes** (`docs/tasks/todo/2026-10-16-sysctx-skill-source/wireframes/`)
- `sysctx-skills-tab.svg`
  - Header chips: `6 MCP · 23 tools · 41 skills · 6 agents`. "N skills" counts the rows actually shown (snapshot ∩ `skill_listing`, or the whole snapshot when there is no listing).
  - Tabs: Files, MCP, Tools, Skills, Agents, Rules. All of them except Tools come from the snapshot.
  - Columns are Name, Source and Tokens; Tokens is filled on every row.
  - Badges: `project` sky, new `user` amber, `plugin` violet.
  - Every row is clickable and opens the modal.
  - Plugin names keep their namespace, including `*-wf`. The version appears only in the modal.
  - Never shown: built-ins (`loop`, `simplify`, `update-config`, `claude-api`, `run`, `init`), `anthropic-skills:*` (also filtered explicitly), and `adlc:*` (plugin disabled).
- `skill-detail-modal.svg`
  - Overview and Body tabs; Body is always present.
  - Source badge: PROJECT, USER or PLUGIN. BUILT-IN is removed.
  - New **Plugin** row, for plugin skills only: `adlc-lh@artisyn · v1.3.1 · 4f2a9c1` (short gitCommitSha).
  - Path examples: `adlc-lh@1.3.1/skills/tracker/SKILL.md`, `~/.claude/skills/deploy-helper/SKILL.md`, or repo-relative.
  - Size: `10.4 KB · ~2.6K tok`. Argument and Description rows stay.
  - The **"Modified" row is dropped.**
- `sysctx-no-snapshot.svg`
  - Only the Tools tab remains (deferred tools from the session log), with only the `23 tools` chip.
  - No skills, MCP or agents chips. The Skills, Files, MCP, Agents and Rules tabs are not rendered.
  - No fallback, no error and no empty state. The panel is hidden if nothing is left.
  - Note: the MCP tab today is also built from `mcp__*` deferred tools, and the wireframe drops it as well.

**Knowledgebase**
- `docs/knowledgebase/hook-system-overview.md` §"Context injection" (~l.318–361): documents the 4 events, the once-per-session rule, the mtime fingerprint and `harness-state.json` with commit-after-success. Needs rewriting for the snapshot; keep commit-after-success and the temp-file + rename write.
- `docs/knowledgebase/hook-api-versioning.md`:
  - "Compatibility matrix" and "`perToolDetailSupported`" (l.225–266): additive response fields, and capability flags on the event rather than the version string. The new `unknownSnapshotId` response field and `snapshotId` query parameter need a section in the same style.
  - Note: `perToolDetailSupported` currently rides on the `mcp-config` event. It must move into the snapshot, and Step 5d's `harness_mcp_per_tool_supported` must read it from there.
- `docs/knowledgebase/upload-queue.md`: stage-then-queue, and the controller never parses the body. This matters for FR-10's "in the queue counts as known".
- `docs/knowledgebase/data-retention.md` §"Purge mechanics": `purgeSessionChildData` already deletes orphaned `contexts`, which is the precedent for the snapshot cleanup in FR-9a.
- `docs/knowledgebase/db-schema-code.md` §"Adding or changing a table":
  - Hand-write `server/drizzle/migrations/NNNN_*.sql` and the `meta/_journal.json` entry.
  - Run `npm run migrations:lock`.
  - Never run `drizzle-kit generate`; no `CONCURRENTLY`.
  - Update `db-tables.md`.
- `docs/knowledgebase/session-log-view.md` §"Special log event fields" (l.408–418): documents `skill-definitions` and the `skill_listing` fallback. Both must be rewritten.
- `docs/knowledgebase/harness-usage-tab.md`: the session Harness-usage tab does not use `parseSessionLogs`. It is unaffected, but check it.
- `docs/knowledgebase/algorithms/README.md`:
  - Doc format: required sections, one `examples` JSON block, front-matter `reviewed: no` / `reviewer: none`, and an independent derivation in each row's `note`.
  - Add a row to the Docs table.
  - The hook test goes in **`hook/.claude/telemetry_tool/__tests__/<name>.algo.test.js`**, not `hook/__tests__` as the AC says. `hook/scripts/run-tests.js` picks up `*.test.js` there.
  - The loader is `scripts/algo-docs/load-examples.cjs`, which `scripts/__tests__/algo-docs.test.js` validates.
- `docs/knowledgebase/session-export-import.md`: export is built from `logs.body`, so a snapshot would not be exported (see gaps).

**Existing patterns**

Hook:
- `hook/.claude/telemetry_tool/skill-catalog.js:42`: `parseFrontmatter` (reuse).
- `hook/.claude/telemetry_tool/skill-catalog.js:91`: `readSkillFile`. Replace `mtimeMs` with a sha256 of the text it already reads.
- `hook/.claude/telemetry_tool/skill-catalog.js:121`: `readProjectClaudeSettings`. Extend it with user settings; `false` disables.
- `hook/.claude/telemetry_tool/skill-catalog.js:190`: `buildSkillDefinitions`, to rewrite. Remove the recursive `~/.claude/plugins` scan (l.226–235) and the directory-marketplace scan (l.155, l.237–244).
- `hook/.claude/telemetry_tool/claude-config-dir.js:432`: `claudeConfigDir(env)`, injectable env. Useful for fixture tests.
- `hook/.claude/telemetry_tool/send-logs-hook.js:236`: `buildClaudeMdContext`.
  - It emits absolute paths plus `lastModified`, and rule `content`.
  - Its candidates include `path.dirname(cwd)`, which can sit outside `projectRoot`.
- `hook/.claude/telemetry_tool/send-logs-hook.js:305`: `buildAgentDefinitions`, which reads `.claude/agents/<name>/AGENT.md`.
- `hook/.claude/telemetry_tool/send-logs-hook.js:344`, `:523`: `extractMcpServers` (scrubbed config) and `buildMcpConfig` (config, then the probe).
  - Split it so the id is computed from the static config before probing.
- `hook/.claude/telemetry_tool/send-logs-hook.js:1386–1500`: `readHarnessState`, `getHarnessPrefix` (memoised once per run), `commitHarnessReport` (after success). Replace these with the snapshot logic.
- `hook/.claude/telemetry_tool/send-logs-hook.js:1646–1668`: the artisyn prepend order. extraEvents (hook-status) come first, then the harness prefix (current session only), then code-inventory.
- `hook/.claude/telemetry_tool/send-logs-hook.js:1817–1838`: the current-session artisyn pass, which commits on success.
- `hook/.claude/telemetry_tool/harness-state.js`: versioned state file, fail-open read, temp + rename write. Reuse its shape for "known snapshotIds".
- `hook/.claude/telemetry_tool/upload-logs.js:418–505`: `uploadFile` builds query parameters and parses the 201 JSON.
  - Add a `snapshotId` parameter and parse `unknownSnapshotId`; the 2000-byte response cap is fine.
  - The chunked path at `:740` / `:845` returns `warnings`. Add the new field there too.
- `hook/.claude/telemetry_tool/post-turn-analysis-worker.js:44`, `:432`: `resolveSkillInvocations` also uses `buildSkillDefinitions(cwd)` and must follow the new API. Namespaced names now match the `Skill` tool input.
- `scripts/build-hooks-installer.js:105–140`: the `HOOK_JS_FILES` allow-list. Add any new module or the build fails.
- `hook/.claude/telemetry_tool/version.json`: currently `2.21.1`; bump it. Then run `npm run build:hooks-installer` and refresh `.artisyn/marketplace/plugins/log-hub-hooks/`, as `.claude/rules/hook.md` requires.
- `hook/.claude/telemetry_tool/__tests__/work-time.algo.test.js`: the hook algo-test template (`loadExamples`, then `node:test`).

Server:
- `server/src/logs/logs-v2.controller.ts:34–211`: `postLogs`. Add `@Query('snapshotId')` and an additive `unknownSnapshotId` to both return paths (single and chunk-complete). The return type is at l.48–50.
- `server/src/logs/upload-queue.service.ts:77`, `:367`, `:383`: `saveRawUpload` (body staged to disk, `upload_queue` row inserted), `isForeignSession`, `getPendingWarnings`. These are the precedent for synchronous controller-side DB checks.
- `server/src/logs/logs.service.ts`:
  - `:175–198`: Step 1, session upsert with `onConflictDoUpdate`. Add a COALESCE on the snapshot column here.
  - `:269–277`: the COALESCE pattern used for `git_repo_root`.
  - `:457–535`: Step 5d, inventory and capability columns across `log_repositories`. Switch it to read from the stored snapshot row.
  - `:81`: the per-session lock.
- `server/src/logs/artisyn-extractor.ts`:
  - `:82–93`: `NON_ACTIVITY_LINE_TYPES`. Add `harness-snapshot` and `harness-snapshot-ref`.
  - `:360`, `:407`, `:456`: `extractHarnessRuleInventory` (`.claude/rules/` marker), `extractHarnessSkillInventory` (source narrowed to project|plugin at `:426`), `extractHarnessMcpInventory`. Retarget all three at the snapshot sections.
- `server/src/logs/harness-elements-writer.ts:20`, `:71`, `:86`: `source` is already a free string, so no schema change is needed for `'user'`.
- `server/src/logs/reports/harness-usage.service.ts:55`, `:95`, `:545`: `source` is narrowed to `'project' | 'plugin' | null`. Widen it to include `'user'`.
- `server/src/database/schema/index.ts`:
  - `:133`: `sessions` (no owner column; the owner comes from the artisyn `logs.user_id`).
  - `:809`: `harness_elements.source`.
  - `:1172`: `upload_queue` (no body or snapshot column).
- `server/src/logs/repositories.controller.ts`:
  - `:1753–2236`: `getSessionLogs`. The access checks (Step 1b/team scope, l.1806–1859) apply to the new data. The response is hand-built JSON at `:2232` (`res.end('{"main":…,"sessionAttribution":…}')`), so append `"harnessSnapshot":…|null` there.
  - Step 1 (`:1785`) uses `sessionCheck.sessionRowId`; the owner is in `sessionOwnerRow.userId`.
- `server/src/sessions/sessions.service.ts`:
  - `:175–216`: `purgeSessionChildData`; step (e), the orphaned-`contexts` cleanup at `:195`, is the template for the snapshot cleanup.
  - `:363`: `hardPurgeExpiredSessions`.
  - `:224`: `hardDeleteSessionsInTx`, also used by admin at `admin.service.ts:338`.
  - `:77`: soft `deleteSession` sets `deleted=true` and keeps the row.
- `server/src/sessions/session-retention.service.ts:88`: `tick()`. The cleanup can hook in here or in `purgeSessionChildData`.

Client:
- `client/src/viewer/api.ts:1166`: the `SessionLogsData` interface. Add the snapshot field.
- `client/src/viewer/api.ts:1229`: `fetchSessionLogs`.
- `client/src/viewer/pages/repository/session-log/log-parser.ts`:
  - `:1753`: `parseSessionLogs(raw, options)`. Pass the snapshot through `options`, as is done for `subagentStats` and `workflows`.
  - `:1786–1789`: map declarations.
  - `:2389–2421`: reads `system-context`.
  - `:2424–2463`: reads `skill-definitions`.
  - `:2465–2502`: reads `agent-definitions`.
  - `:2504–2529`: reads `mcp-config`.
  - `:2728–2755`: `registeredSkills` / `skill_listing`.
  - `:2770–2827`: `skill_listing` fallback, to delete.
  - `:2829–2836`: resolves `skill.definition` for turn chips (FR-17).
  - `:72`: `normaliseClientPath`.
- `client/src/viewer/pages/repository/session-log/types.ts:247`, `:258`, `:268`, `:339–342`: `SkillDefinition` (`'project'|'builtin'|'plugin'`, `lastModified`), `AgentDefinition`, `McpServerConfig`, and the `SessionSummary` fields.
- `client/src/viewer/pages/repository/session-log/SessionContextPanel.tsx`:
  - `:70–118`: the `has*` flags and chips. Today `hasSkills` is `registeredSkills.length`, and MCP comes from deferred tools plus `mcpConfig`.
  - `:360–410`: the Skills table, which iterates `registeredSkills`.
  - `:412–460`: the Agents table.
- `client/src/viewer/pages/repository/session-log/SourceBadge.tsx`: add `user`.
- `client/src/viewer/pages/repository/session-log/SkillDetailModal.tsx`: drop the Modified row (`:100–109`), change the badge (`:62–80`), add a Plugin row.
- `client/src/viewer/pages/repository/session-log/prompt-turn-helpers.tsx:274`: `buildSkillDefinitionRows(def)`, the tooltip rows.
- Other `summary.claudeMd` consumers that FR-18 will empty for sessions without a snapshot:
  - `session-info-derive.ts:237`
  - `SessionInfoTab.tsx:291`
  - `charts/context-usage/context-data.ts:220`
  - `call-tree/useCallTreeNodes.ts:317`
- `client/src/viewer/pages/repository/reports/harness-usage-rows.ts:108`: `filterProjectSkillsOnly`, already `=== 'project'`. `client/src/models/harness-usage.ts:34` narrows `source` and needs widening.

Tests (only the three allowed kinds):
- **Algorithm:**
  - New doc `docs/knowledgebase/algorithms/<harness-snapshot>.md`.
  - New test `hook/.claude/telemetry_tool/__tests__/<name>.algo.test.js`.
  - Fixture cases (a)–(f) mean the test must write a virtual tree to a temp dir and pass `env.CLAUDE_CONFIG_DIR`. No existing algo test touches the filesystem; `work-time` is pure.
- **Contract:**
  - `server/test/contract/registry/f15-ingest.ts:16`: the `F15-upload` case with `bodyMatches: { warnings: [] }`. Add a row with `query.snapshotId` to assert the additive `unknownSnapshotId`.
  - `registry/f17-sessions.ts:296–339`: `F17-session-logs*` rows, including the outsider 403 at `:334`. Add a "no snapshot" shape row and a denied row.
  - World fixture: `fixtures/world-v1.sql.ts`. A seeded snapshot row is needed for a positive case.
  - Case type: `types.ts:179–213`.
- **Scenarios:**
  - `tests/scenarios/view/s-sess-03.spec.ts`: the Logs scenario, uploads through `uploadGoldenRepo`. Add the with/without-snapshot step.
  - `tests/scenarios/hook/s-hook-01.spec.ts`: `HARNESS_TYPES` at `:48`, step 4 at `:146–160`. The fake hub at `tests/scenarios/helpers/hook-process.ts:474` has `respond()` for a scripted `unknownSnapshotId` reply.
  - `tests/scenarios/hook/s-hook-09.spec.ts`: step 4 (`:231–263`) checks `harness_elements` and `agent-definitions` in the stored artisyn log. Step 5 (`:265–275`) asserts at most one `skill-definitions`.
  - `tests/scenarios/hook/s-compat-01.spec.ts`: the frozen 2.6.1 hook (`tests/fixtures/legacy-hooks/2.6.1/`) sends the old events. This is the natural place for "old hook uploads OK, no snapshot".

**Open gaps**
- **"Known in queue" check (FR-10).** `upload_queue` has no snapshot column and the body is staged unparsed on disk, so the controller cannot see a queued full snapshot. The plan must choose:
  - a hook query flag such as `snapshotFull=1` plus a new `upload_queue` column, or
  - a peek at the staged file, or
  - another mechanism.
  Chunked uploads: decide which chunk's response carries `unknownSnapshotId`.
- **Owner keying versus the session column.** `sessions` has no owner, and `harness_snapshot_id` stores only the id string. Resolving (owner, snapshotId) needs a join through the artisyn `logs.user_id`, or storing an owner or row id. The orphan check in FR-9a must use the same join.
- **Soft-deleted sessions.** They keep their `sessions` row, so they would keep a snapshot referenced. Decide whether soft-delete clears the column, and whether the cleanup runs in `purgeSessionChildData` or the retention `tick()`.
- **No precedent for parts of the plugin catalog:**
  - There is no `installed_plugins.json` reader anywhere.
  - Windows `projectPath` (backslashes, case) must be compared with `projectRoot` from `getGitRoot`, which needs normalisation.
  - There is no `.claude-plugin/plugin.json` custom-path handling.
  - There is no `.claude/commands/*.md` reading.
  - Workflow names come from `export const meta = { name, description }` in the `.js` file and need regex extraction without executing it. Example: `check-health-wf.js` gives `meta.name: 'check-health-wf'`, so the AC's "`<plugin>:<name>-wf`" just means `<plugin>:<meta.name>`.
- **Paths in `systemContext` (FR-3).** `buildClaudeMdContext` scans `path.dirname(cwd)` and the `client/`, `server/` and `hook/` subfolders, so some files can sit outside `projectRoot`. The relative-path rule for those is undecided.
- **Conflict with the sibling task `2026-10-16-sysctx-instruction-files`.** Its FR-2 keeps reading the `system-context` event as a fallback. This task (FR-18) removes that from `log-parser.ts`. The two need reconciling.
- **The MCP tab when there is no snapshot.** It is currently also built from `mcp__*` deferred tools in the Claude log. The wireframe hides the MCP tab without a snapshot, which is a behaviour change. It needs an explicit decision, including for `SessionInfoTab`'s MCP section.
- **Golden data uses the old events.** `tests/golden/gs-05-skills-rules-mcp-workflow/artisyn.jsonl` contains `mcp-config`, `skill-definitions` and `system-context`; `expected.json` (`context`, `inventory`, `harnessUsage`) and `tour-03-owner-repo.spec.ts` depend on it.
  - Server inventory and client context from gs-05 change unless it is converted to snapshot plus ref.
  - The snapshot row must also exist on the server, but golden upload goes only through `POST /api/v2/logs`.
  - gs-01's `session.jsonl` also has a `system-context` line; `s-sess-12` expects it only as a Raw Logs row.
  - Legacy `tests/e2e/harness-usage.spec.ts`, part of `e2e-full`, builds `skill-definitions` payloads.
- **Export/import.** Repository export is built from `logs.body` and carries no snapshot or `sessions` column, so imported sessions would lose their snapshot.
- **Agents source.** The hook reads only project `.claude/agents/<name>/AGENT.md`; there are no user or plugin agents. FR-4 only moves this into the snapshot, but `AgentDefinition.source` keeps `'builtin'`, which conflicts with FR-15's removal of `builtin` for skills.
- **`perToolDetailSupported`.** It must move into `snapshot.mcpServers` (or the snapshot root) so Step 5d can still set `harness_mcp_per_tool_supported`.
