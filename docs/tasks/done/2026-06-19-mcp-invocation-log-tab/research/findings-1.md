# T-26 Tools/MCP tab: context for the implementation plan

Paths are relative to `D:/_work/Artisyn-LogHub/_repo/` unless absolute. The server line numbers are under `server/src/`. Nothing was written or changed.

## Requirements summary

Source: `D:/_work/Artisyn-LogHub/_repo/docs/tasks/todo/2026-06-19-mcp-invocation-log-tab/requirements.md` (T-26, rewritten 2026-10-28), plus `research-cli-tool-capture.md` and `notes.md` in the same folder.

The task adds a repository-level **Tools/MCP** main tab, a single pane of glass for how the agent uses tools. There are two channels:
- **MCP**: every `mcp__<server>__<tool>` call, taken from transcripts only. No configuration and no hook change.
- **CLI**: tools the user adds by name in the UI. A wrapper put in front of the tool by the hook captures them, and the transcript is the fallback.

| FR | Gist |
|---|---|
| FR-1 | Explorer layout in three panes: tools tree → calls table → call details.<br>• Top bar: date range (default 30 days), Status filter, search, scope chip, Monitored tools button.<br>• Splitters with widths kept in localStorage; the tree pane collapses to a rail (`«` / `»`).<br>• Tree: All tools → MCP / CLI groups → tool → operation, each with calls, a bar and error % (grey < 5 %, amber < 15 %, red ≥ 15 %). Filter box, sort by calls / error % / retried % / last used, `never called` greyed nodes.<br>• Calls table: Time, Tool · operation, In, Out, Status with hints (cut, empty, truncated, no wrapper). Paginated, ↑/↓ moves the selection.<br>• Details: header with "Open in session" to the turn, Parameters, Input (stdin), Output with three views (Terminal with ANSI on a light surface and table re-alignment; As the agent saw it; Raw), a JSON tree when the output is JSON, a red stderr block, Copy buttons, Signals chips, collapse of long content.<br>• Tab id `tab-repo-<id>`, URL-backed; Sessions-tab scope rules; the whole sub-agent tree is included. |
| FR-2 | Monitored-tools panel per tool: `name`, `enabled`, `capture: full|meta`. Two levels, personal and team (team editing gated by `canEditTeamConfig`).<br>• Recorded set = owner's personal list ∪ the lists of the owner's teams on the repo; `full` beats `meta`.<br>• The panel shows the level(s) each tool is on, when wrapper data last arrived, and a "hook too old" hint.<br>• Display still follows session-visibility rules. The hook config route returns the already-merged list. |
| FR-3 | MCP extraction on the server: `tool_use` joined to `tool_result`; `server`/`operation` split; status ok / error / no result; duration; output, with images and other non-text blocks shown as placeholders. |
| FR-4 | CLI collection.<br>• Hook: fetch config at SessionStart, cache it on disk; Bash shims plus `export PATH` into `$CLAUDE_ENV_FILE`; a PowerShell `PreToolUse` `updatedInput` prefix; throttled refresh on UserPromptSubmit; records go through the existing upload, and old servers must ignore them.<br>• Wrapper: the shell runs the real tool; full output even when the agent cut it; 100 KB cap on stdout+stderr plus 100 KB on stdin; crash-safe start/exit records.<br>• Server: joins wrapper records to transcript calls (unmatched ones become `indirect`), and falls back to transcript-only data when there are no wrapper records. |
| FR-5 | Signals from the agent's next 3 tool calls: `empty`, `retried`, `fell back`, `opened file`, plus error status. |
| FR-6 | Backward compatibility both ways: an old hook means no wrapping and transcript-only CLI data; an old server returns 404 and nothing is wrapped; the config response is versioned. |
| FR-7 | Table keyed by session + tool with one jsonb of calls plus per-operation aggregates. Rewritten whole on every upload. The summary reads aggregates only. Background re-extraction when a tool is added; a one-off MCP backfill. |
| FR-8 | Wrapper safety:<br>1. A hard denylist enforced in UI, server and hook, plus name rules (`[A-Za-z0-9._-]`, at most 64 characters).<br>2. Fail open.<br>3. SessionStart pre-flight with a `--self-test`.<br>4. Circuit breaker per tool, and globally after 3 faults.<br>5. Kill switches: per-tool, "Pause all wrapping" per repo, `LOGHUB_TOOL_WRAP=0`, `toolWrap:false`.<br>6. `LOGHUB_SHIM_ACTIVE` stops recursion.<br>7. Byte-level fidelity.<br>8. At most 150 ms overhead per call. |

**Tests named in the requirements:**
- Algorithm docs:
  - CLI command recognition
  - wrapper-record ↔ transcript matching
  - signals
  - MCP parsing and status
  - output format detection and table re-alignment
  - name validation and denylist
  - a wrapper fidelity matrix run by a hook `*.algo.test.js`
- Contract rows: the hook config route, the settings routes, and the summary / calls / detail routes.
- A new scenario.

**Open questions:** there is no `open_questions_ru.md` in the task folder, so none are answered. Six are open in requirements.md §Open Questions:
1. Where config is stored: the existing blobs or a new table.
2. The size of the FR-7 row, up to about 30 MB, and whether outputs go in a sibling column or table.
3. How records travel: artisyn JSONL lines or a separate file, given concurrent appends on Windows.
4. A per-prompt Tools/MCP section (proposed as a follow-up).
5. Selective MCP monitoring versus a UI filter.
6. An LLM judge (follow-up).

## Wireframes

`D:/_work/Artisyn-LogHub/_repo/docs/tasks/todo/2026-06-19-mcp-invocation-log-tab/wireframes/tools-mcp-tab.svg`, generated by `docs/pocs/2026-10-28-1140-cli-tool-capture/wireframe/gen-wireframe.mjs`.
- **Tab bar:** Sessions | Analytics | Reports | Tools/MCP | Settings. The new tab sits after Reports; code today has `okf` between Reports and Settings.
- **Top bar:** `Last 30 days ▾`, `Status: All ▾`, search box, `Scope: ce › callers ✕`, `⚙ Monitored tools (3)`.
- **Tree pane:** header `TOOLS «`, filter box, sort segments (calls / error % / retried % / last used), columns calls and err.
  - Sample numbers: All tools 801 calls, 13 %. MCP · 3 servers 559 / 18 % (playwright 523 / 18 %, postgres 35 / 11 %, webstorm 1 / 0 %). CLI · 3 monitored 203 / 2 % (ce 142 / 3 % → callers 88, query 31, search 15, help 8; find 61; cb `never called`).
  - The sample figures do not add up. Rounded MCP rows give 92 + 4 + 0 = 96 errors of 559 (17.2 %, not 18 %). The tool rows sum to 523 + 35 + 1 + 142 + 61 = 762, not 801. They are illustrative only; acceptance requires real rollups to add up.
- **Calls pane:** columns Time / Tool · operation (channel badge) / In / Out / Status. Hint rows: cut, empty, no wrapper, ✗ error with Out `—`, truncated at 100 KB, ⏹ killed. Pager `◂ 1–10 of 88 (ce › callers) ▸`. An inset shows the 28 px collapsed rail `» TOOLS · ce › callers`.
- **Details pane:**
  - Header: `CLI ce callers ✓ exit 0`, `cut by agent: saw 2 of 8 lines`, `Open in session → turn 3 ↗`, and a meta line (time · 623 ms · user · root agent · bash · resolved path).
  - PARAMETERS: command / args `[0] callers [1] setStatus` / cwd.
  - INPUT (stdin): shown only when something was piped.
  - OUTPUT: tabs Terminal | As the agent saw it | Raw, `⧉ Copy`, `stdout 457 B · stderr 0 B`. A Markdown table is re-aligned into a box table, and an amber bar marks the lines the agent received.
  - SIGNALS chips.
  - A JSON-tree variant for MCP `postgres:query`.

## Knowledgebase

All under `docs/knowledgebase/`.

- **`okf-usage.md`** is the closest analog for the whole feature.
  - Per-node rows written at ingest (Step 3b′), import, heal (`rewriteSessionTreeFileStats`) and recompute.
  - Repo tab plus API-key facts route.
  - Personal vs team follows the route (`/repos/:id` vs `/teams/:t/repos/:id`), not a toggle.
  - Lifecycle: delete step c2 in `purgeSessionChildData`, export/import, recompute.
  - A backward-compatibility table to mirror.
- **`hook-system-overview.md`**
  - Fail-open; built-ins only; plain readable JS (no native code, WASM or minified code).
  - Runs on every current Node LTS using the user's own `node`.
  - Files table at :24-49 says "14 events (no PreToolUse)" at :27; namespace table :178-184; principles :605-634.
- **`hook-api-versioning.md`**
  - Additive optional fields only; invalid optional params are ignored, never a 400; capability flags preferred over version strings (:227-262).
  - New config route and log kind need a compat section like :486-527.
- **`hook-installation.md`** — config keys :213-318 (model: the `okf` key at :297); the guardrail note at :255-266 says there is no PreToolUse.
- **`turn-end-cost-advisor.md`** — model for the hook-facing `GET /api/v2/post-turn-analysis/config`.
- **`db-schema-code.md`** — hand-written SQL migrations only, never `drizzle-kit generate`; `IF NOT EXISTS`; no `CONCURRENTLY`; startup data steps go in `initializeDatabase()` (:96).
- **`db-tables.md`** — `repo_config` :853, `team_repo_config` :901, `session_tool_stats` :735, `session_okf_access` :1013, migration history :1400.
- **`session-metrics-scope.md`** — rollup over the whole tree at read time; `descendantSessionsCte` / `topAncestorIdsSql`; watch the double-count trap.
- **`harness-usage-tab.md`** — `mcp` kind naming `name.slice(5).split('__').join(':')`; the tab answers "was it used", not output quality.
- **`session-log-view.md`** — ToolCallView and MCP handling. :259-262 notes `CLAUDE_ENV_FILE` export was verified for Bash; for PowerShell it was untested (the POC later showed PowerShell does not read it).
- **`algorithms/README.md`** — doc format: one `examples` JSON block `{id,input,expected,note}`, required sections, `reviewed`/`reviewer` front matter plus AI review; add a row to its registry.
- **`algorithms/tool-call-outcome.md`** — reuse `classifyToolOutcome` for status.
- **`algorithms/okf-access-extraction.md`** — template doc for a transcript extractor.
- **`algorithms/bash-command-view.md`** — `@loghub/bash-view` `analyzeBash` with the server tree-sitter parser; candidate for CLI command recognition.
- **`repo-local-packages.md`** — shared server+client code goes in `packages/`; the hook keeps a plain-JS copy. Fits the shared denylist and validation table.
- **`upload-queue.md`** — upload priority :161-170; the 10 % malformed-line tolerance; NDJSON only.
- **`ui-principles.md`** — light-only UI (:16-20); popups via `ViewportPopover` (:89-108); light tooltips only (:112-125).
- **`client-component-map.md`, `client-routing-and-layout.md`** — update after adding components (per the `ui-components` skill).
- **`test/scenarios.md`, `test/contract-tests.md`, `test/client-unit-tests.md`** — `client-unit-tests.md:16` is stale: it lists 3 algo tests and 7 exist.
- **`product-purpose-and-data-capture.md`** — full capture of tool output is by design.
- **`.claude/rules/hook.md`** — procedure: lint:fix + lint, the `update-install-instructions` skill, MINOR bump of `version.json`, `npm run build:hooks-installer`, refresh the dogfood copy.

## Existing patterns

### Hook (`hook/.claude/telemetry_tool/`)

- **Hook registration:** `scripts/build-hooks-installer.js:306-346` (`HOOKS_JSON`, generated). :305 says there is no PreToolUse.
  - `:97` `HOOK_JS_FILES`: every new module must be listed, or `assertHookFilesComplete` (:162) fails.
  - `:351/:371/:483-492`: the build fails on event drift against `hook/INSTALL_HOOK.md:302-395`.
- **SessionStart:** `lifecycle-hook.js:157-169`. It already writes `{systemMessage}` to stdout at :200-207, so new stdout output must coexist. Fail-open catch at :216-220.
- **UserPromptSubmit throttle:** `telemetry-hook.js:101-129` + `throttle-state.js:41-99` (`claimThrottleSlot(cwd, '<file>.json', ms)`).
- **HTTP to the server:** `post-turn-analysis-worker.js:159-210` `httpRequestJson` sends `X-API-Key`, resolves `null` on failure, and returns `{status, body}`, so a 404 is just non-200.
  - Config fetch at :1762-1792 (serverUrl/apiKey from config, timeout `sendLogsTimeoutMs||10000`).
  - That fetch runs detached. A SessionStart fetch is synchronous and needs a new short-timeout config key.
- **Repo identity:** `git-context.js:124-154` `getGitContext(cwd).remote`, as `post-turn-analysis-hook.js:82-86` sends `repoUrl`; the server normalises it.
- **Config:** `env-context.js:72-93` `CONFIG_DEFAULTS`, :95-116 `CONFIG_TYPES`, :150-173 coercion with one `[warn]`, :196-212 `normalizeOkfConfig` as the object-key model, :313-343 `loadConfig`. `toolWrap` is one line in each table.
- **Upload:** `send-logs-hook.js:899` `runUpload`.
  - `artisyn` = top-level `telemetry/*.jsonl` only (:923-936).
  - Subdirectory kind template: `claude-otel` at :1078-1091.
  - Extra data rides as prepended artisyn lines: `getHarnessPrefix` :1217, `getOkfPrefix` :1322, applied at :1526-1550.
  - Dedupe manifest at :1460-1482. `session-files.js:204-244` (SessionEnd/prompt flush) covers only artisyn + claude.
- **Upload request:** `upload-logs.js:427-609`.
- **State files:** `okf-state.js:32-163`, `harness-state.js:41-202` (versioned JSON, temp+rename). Work dir via `git-context.js:159-167`.
- **Logging:** `hook-log.js:95` `hookLog(...,'warn',...)`. `:125` `exitIfSelfCheck` must be called by every new entry script.
- **Version:** `version.json` 2.26.0 (single source). Algorithm tests in `__tests__/*.algo.test.js`, e.g. `okf-snapshot.algo.test.js:19-20` using `scripts/algo-docs/load-examples.cjs`; helpers in `test-helpers.js`.
- **Dogfood copy:** `.artisyn/marketplace/plugins/log-hub-hooks/` (scripts, `version.json`, `.claude-plugin/plugin.json`, `hooks/hooks.json` — copy the new PreToolUse entry there by hand).

### POC (`docs/pocs/2026-10-28-1140-cli-tool-capture/`)

- `shim/posix-shim.template.sh` is the Bash wrapper: strip the shim dir from PATH, `command -v`, run the tool, pipe stdout to `tee-log.mjs`, `2> >(tee …)`, `PIPESTATUS`, exit record.
- `shim/tee-log.mjs` handles start / stream_end and keeps draining after EPIPE.
- `shim/ps-prefix.template.ps1` is the `__lhWrap` PowerShell function.
- `sample/claude-config/session-start.mjs` (CLAUDE_ENV_FILE with a Git-Bash path) and `pre-tool-use.mjs` (`updatedInput`, tool-mention regex `(^|[\s;|&(])tool(\.exe)?(\s|$)`).
- `extract.mjs` holds the MCP classification, the signal heuristics (next 3 calls, file-path regex, empty regex) and the shim join (session + tool + `args[0]` + ±60 s). This is seed logic for the algorithm docs.

### Server

- **Ingest plug-in point:**
  - `logs/logs.service.ts:257` `upsert()` (transaction + advisory lock :285). Step 3 at :408-485; Step 3b′ OKF rebuild at :467 is where a per-session MCP/CLI extractor goes. :488 is the early return for non-artisyn logs.
  - Step 5f heal at :737-751 is a trigger for "wrapper records arrived after the transcripts", but it does not fire on every artisyn re-upload.
- **Import:** `logs.service.ts:976` `writeImportedLog`. :1049 re-derives only for `claude`, not `claude-subagent` (an existing gap). :1072 OKF rebuild.
- **Heal:** `logs/session-file-stats-writer.ts:212-270`.
- **Recompute:** `logs/repositories.service.ts:1282` `recomputeAllSessionStats`, loop at :1415-1461, `recomputeOkfAccess` at :1476-1517. The route is `repositories.controller.ts:2267-2295`.
- **Writer contract:** `logs/okf/okf-access-writer.ts:25/68/94` (delete-then-insert per node; rebuild for nodes).
- **Extractor template:** `logs/okf/okf-access-extractor.ts:254-309` (sidechain filter, `tool_result` map, ordered `tool_use` pass).
  - `claude-extractor.ts`: `:971` `mcpCallsByServer`, `:1058` `toolResults` map, `:365` `flattenToolResultText`, `:1180-1208` join + `classifyToolOutcome` + `resolveToolDuration`, `:1391` `computeToolResultBytes`.
  - `logs/tool-stats.ts:104` `classifyToolOutcome`, `:163` `resolveToolDuration`, `:629` `mcpServerOfTool`.
- **Hook-record join template:**
  - `logs/change-surface/changed-paths.sql.ts:139` `loadSessionTreeEditRecords` (artisyn PostToolUse lines of the root, read via jsonb).
  - `logs/artisyn-extractor.ts:623/669` indexes records by `tool_use_id` / `agent_id`.
  - `artisyn-extractor.ts:87-109` `NON_ACTIVITY_LINE_TYPES`: new artisyn line types must be added there, or they stretch the session time span.
- **Unknown log kinds:** `logs-v2.controller.ts:47` only checks that `type` is present. An unknown kind is stored as a generic `logs` row, unique per `(session_id, log_type)`, and an old server never rejects it. The body must be NDJSON (`parseNdjsonLinesTolerant`).
- **Background jobs:**
  - `logs/session-cost/session-cost-recompute.service.ts:40-96` + `session-cost-writer.ts:229` (stale flag, `FOR UPDATE SKIP LOCKED`, cluster-safe) is the template for tool-added re-extraction and the MCP backfill.
  - `logs/repo-backfill.service.ts:37-46` is a one-off bootstrap backfill.
  - Config saves currently recompute synchronously: `saveTeamConfig`→`recomputeTeamScope` :1009/:1131, `saveUserConfig`→`recomputeForRepo` :1060.
- **Config storage:**
  - Tables: `repo_config` (`schema/index.ts:1219`), `team_repo_config` (:1240, FK `team_repositories`), `RepoConfigJson` (:1155).
  - Helpers in `logs/team-repo-config.ts:26-159`.
  - Routes `repositories.controller.ts:456` (GET settings), `:472` (PUT team), `:492` (PUT user).
  - Hand-written validation in `repositories.service.ts:711` `validateConfig`. `canEditTeamConfig` = `isTeamOwner` at :585-588.
  - `resolveEffectiveConfig` (:635) picks one layer and never merges, so the union rule is new code. `resolveTeamOnlyConfig` (:683) is the model for team-only fields.
- **Hook-facing GET:** `logs/post-turn-analysis/post-turn-analysis.controller.ts:57-82,121`: `ApiKeyAuthGuard` (`api-keys/api-key-auth.guard.ts:11`), query `repoUrl` → `normalizeRepoUrl`, `Promise.allSettled` with a feature-off fallback. Also `logs/okf/okf-facts.controller.ts:20-34`. GET routes need no body-limit entry.
- **Read routes and visibility:**
  - The repo OKF route `reports/reports.controller.ts:350` uses `resolveUsageScope`(:732) → `resolveReportScope` (repositories.service :715). In restricted teams that returns 403 to everyone except owners and managers, which are report rules.
  - Sessions-tab rules are `repositories.service.ts:316` `resolveTeamScope` (own-only / transparent / restricted), :480 `assertSessionVisible`, :500 `buildSessionListConditions`, `logs/team-scope.ts` `maskFirstPrompt`.
  - Session-level route pattern: `repositories.controller.ts:1513` + `resolveChangeSurfaceSessionScope` :1554-1597.
  - Scoped roots: `analytics/scoped-sessions.sql.ts:157`; dates via `analytics/analytics-query.ts:37`.
  - Tree helpers: `logs/session-tree.sql.ts:36/68/101`.
- **Schema and migrations:** `database/schema/index.ts`, siblings `sessionOkfAccess` :1293, `sessionToolStats` :896, `sessionHarnessUsage` :1006. Latest migration is `server/drizzle/migrations/0075_okf_usage.sql`, so the next is `0076_*.sql`. Journal `meta/_journal.json`; lock via `npm run migrations:lock`. The plan stage must apply the `migrations-data-integrity` skill.
- **Delete:** `sessions/sessions.service.ts:173` `purgeSessionChildData` (step c2 at :196-200). A soft delete does not cascade, so the new table needs a step there.
- **Server algorithm tests:** `logs/tool-stats.algo.spec.ts` (minimal), `logs/okf/okf-access-extractor.algo.spec.ts:1-60` (`toEntries()` builds tool_use/tool_result pairs).

### Client (`client/src/viewer/`)

- **Tabs:** `tab-ids.ts:36-43` `REPO_MAIN_TABS`, :86, :94 `tabTestId`.
  - `pages/repository/RepositoryView.tsx`: :28-41 lazy tabs, :52-58 labels, :76-105 `canSeeTeamWideTabs`, :356-363 `PageTabs testIdGroup="repo"`, :456-460 OKF tab mount.
  - `useRepositoryViewState.ts:59-64,103-125`: `mtab` param; `setMainTab` drops `okf*` params when leaving the tab, so add the same for the new tab's params.
- **Tab template:** `pages/repository/okf/RepoOkfTab.tsx`.
  - :57-86 filters in the URL via `okf-url-state.ts:19-57`.
  - :67-76 `useDraggableWidth` (`hooks/useDraggableWidth.ts:12-71`; mouse only, localStorage).
  - :91-115 react-query key including `teamId`.
  - :185-216 `role="separator"` handle.
- **Filter strip and dates:** `okf/OkfFilterStrip.tsx` (:176-302), `analytics/DateRangePicker.tsx:21`, `reports/report-url.ts:23` (`defaultDateRange`, 30 days) and :65.
- **Collapsible rail:** `components/AppShell.tsx:9-68` (`artisyn:leftNavCollapsed`, 48 px, chevrons, drag disabled while collapsed).
- **Trees:** `session-log/harness-usage/HarnessSessionTree.tsx`, `session-log/okf/OkfTree.tsx`, `reports/ReportsTree.tsx:14-38` (collapse state in localStorage).
- **Keyboard list:** `session-log/bash-tab/BashCallList.tsx:50-100` (listbox, `aria-activedescendant`, ↑/↓, `scrollIntoView`). `bash-tab/useBashCallParam.ts` keeps the URL selection.
- **Badges and chips:** `session-log/tool-call-view/StatusBadge.tsx:14-107`, `ui/badge.tsx:10-35`, `harness-usage/HarnessElementList.tsx:128-141`.
- **MCP display naming:** `session-log/prompt-turn-helpers.tsx:66-76` (`srv:tool`, violet).
- **Output and copy:** `session-log/tool-call-view/ToolOutputBlock.tsx` (:8 `TRUNCATE_AT`, :82 `pre`, :94 "show all"), `hooks/useCopyToClipboard.ts:3`, `raw-logs/primitives.tsx:20-50` (`JsonBlock`, `CopyButton`), `HighlightedScript.tsx`, `BashCommandView.tsx` (Formatted | Raw toggle).
- **Settings editors:** `pages/repository/RepositorySettings.tsx:62-129,261-300` (`readOnly = isTeamView && !canEditTeam`, "Managed by team owner"). `FileCategoriesEditor.tsx:85-151` and `SessionAttributionSettings.tsx:354` are row editors with mirrored validation. API helpers in `api.ts:1050-1102`.
- **Dialogs:** `ui/dialog.tsx`, `ui/confirm-dialog.tsx`.
- **API client:** `api.ts:99` `ApiError`, `:130` `apiFetch`, `:827` `fetchRepoOkfUsage`. Types are mirrored in `client/src/models/`.
- **Session deep link:** `#/repos/:id?session=<sid>&tab=logs` (`useRepositoryViewState.ts:176-182`, `hooks/useHashRoute.ts:15-17`). Turn scrolling uses transient state in `SessionDetailPane.tsx:138-148` and `SessionLogView.tsx:88-106` via `[data-turn-index]` (`PromptTurnItem.tsx:129`, `turn-anchor.ts`).
- **Client algorithm tests:** `session-log/workflow-agent-rows.algo.test.ts:6-46` pattern (`createRequire` → `loadExamples`, `it.each`).
- **Feature flag option:** `lib/feature-flags.ts` `parseBooleanFlag`.

### Tests

- **Contract registry:** `server/test/contract/registry/index.ts` (FAMILIES F01–F23; a new family also needs `f<NN>.contract-spec.ts`).
  - Repo GET example: `f21-reports.ts:333-440` (owner, hot files, outsider 403).
  - Hook route examples: `f16-post-turn.ts:38-80` (`ownerKey`, `repoUrl`) and :390-450 (404 / 400 / 401 cases).
  - Settings routes are in `f14-repositories.ts`.
  - Meta-test: `routes.contract-spec.ts:126-200`.
  - `fixtures/world-v1.sql.ts` delete-order list (:1330, :1564) must include the new table.
- **Scenarios:**
  - `tests/scenarios/repos/s-repo-16.spec.ts` is the OKF tab steps 7-11 template (:229-290: `createApiKey`, upload, API assertions, `browserAs(…'?mtab=okf')`, `tab-repo-okf` `data-state`).
  - Helpers: `tests/scenarios/helpers/okf.ts:166-294` (custom `tool_use`/`tool_result` transcripts plus extra artisyn lines, `uploadOkfSessionTree`), `helpers/prompt-session.ts:72-263`, `helpers/ingest.ts`, `helpers/teams.ts`, `helpers/queue.ts`.
  - Tags: `@S-XXX-NN … @mode-a`.
  - Catalog: `docs/qaa-overview/scenarios/02-repos-sessions.md`, `04-ingest-hook-installer-platform.md`.
  - Tours: `tests/scenarios/tours/screen-registry.ts:587-597` needs a row for the new tab (`tour-10-registry` fails without it), and `tour-03-owner-repo.spec.ts:70` lists the repo tabs.
- **Will break:** `tests/scenarios/hook/s-hook-09.spec.ts:13-14,214,218` asserts that `PreToolUse` hooks equal `[]`. Also `hook/INSTALL_HOOK.md:304` ("All 14 events…").

## Open gaps

1. **Hook-facing config route:** none exists. Model it on `GET /api/v2/post-turn-analysis/config` (`repoUrl` + API key). There is no response-versioning convention beyond additive fields and `/v2`, so FR-6's "versioned shape" needs e.g. a `schemaVersion` field.
2. **Merging personal and team config:** `resolveEffectiveConfig` never merges layers.
   - The plan must add union and full-over-meta logic, and decide between the `RepoConfigJson` blob and a new table.
   - Saving through the existing settings PUT triggers the synchronous file-stats recompute.
   - "Pause all wrapping", per-level indicators, last-received time and breaker state have no storage yet.
3. **Visibility mismatch:** the requirement asks for Sessions-tab rules (`resolveTeamScope`). The OKF repo route uses `resolveReportScope`, which returns 403 in restricted teams. The plan must choose and justify. Pagination also has no offset/cursor convention server-side and no client pagination component.
4. **Record transport:**
   - Artisyn uploads cover only top-level `telemetry/*.jsonl`.
   - A `logs` row is unique per `(session_id, log_type)` and each upload replaces the body, so per-call output files cannot be separate uploads.
   - Bodies must be NDJSON, so outputs need JSON-encoded lines, with bytes as base64 or UTF-8.
   - Options: a new kind (like `claude-otel`) or prefixed artisyn lines (like OKF). The latter needs `NON_ACTIVITY_LINE_TYPES`.
   - `session-files.js` (SessionEnd/prompt flush) must be extended for a new kind.
   - Concurrent appends on Windows from several wrappers are unverified.
5. **Sub-agent attribution of wrapper records:** `CLAUDE_CODE_SESSION_ID` gives the session, not the agent. Sub-agent and workflow-agent calls must be attributed through the transcript join; the FR-7 `session_id` (root vs sub-agent) mapping is undefined.
6. **Rewrite triggers:** no current hook point rewrites a tree's rows when artisyn wrapper records arrive (Step 5f is conditional), and there is no background job for tool-added re-extraction or the MCP backfill. Use the session-cost stale-drain template. Import skips `claude-subagent` re-derivation (an existing gap).
7. **FR-7 row size:** up to about 30 MB per row. Undecided whether outputs go in a sibling column or table.
8. **Client pieces with no existing code:**
   - ANSI renderer (no dependency)
   - collapsible JSON tree (only a `JsonBlock` `pre`)
   - table detection and re-alignment
   - pagination
   - a URL deep link to a prompt turn (needs a new `turn` param read into `targetTurnIndex`)
   - the tree pane rail (only `AppShell` has one)
   - keyboard splitters (`useDraggableWidth` is mouse-only)
9. **Shared denylist and validation table for UI, server and hook:** no package exists for it. Candidates are a new `packages/` package for server+client plus a plain-JS hook copy, one algorithm doc tested by three runners.
10. **The POC is not production-grade against FR-4/FR-8:**
    - `tee-log.mjs` has `MAX_CAPTURE` = 1 MB, not 100 KB.
    - No stdin capture.
    - The Bash shim prints its own `command not found`, which may not be byte-identical to the shell's.
    - The PowerShell `__lhWrap` merges `2>&1`, decodes to strings rather than bytes, `throw`s when the tool is missing, and has no fail-open or self-test.
    - No breaker, no `LOGHUB_SHIM_ACTIVE`, no pre-flight.
    - `sample/claude-config/pre-tool-use.mjs` still points at the rejected `tool-shim.mjs`.
11. **PreToolUse vs existing SessionStart stdout:** `lifecycle-hook.js:200-207` already emits `systemMessage`. Interaction with other users' `PreToolUse` `updatedInput` hooks is unknown (research open point). The dogfood `hooks/hooks.json` must be refreshed by hand.
12. **Doc drift to fix along the way:**
    - `docs/knowledgebase/test/client-unit-tests.md:16` lists only 3 client algo tests; 7 exist.
    - `hook-installation.md` and `hook-system-overview.md` state "no PreToolUse".
