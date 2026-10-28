# Implementation plan — T-26 Tools/MCP tab

## TL;DR

- **New shared package `@loghub/tool-monitor`** (`packages/tool-monitor/`): the FR-8.1 denylist, `validateToolName()` and capture constants for server and client. The hook has a plain-JS copy, `tool-wrap-names.js`. The package and the hook copy are tested from one algorithm doc.
- **DB (migration `0076_tool_monitoring.sql`, additive only):**
  - new tables `repo_tool_monitor_config` (personal), `team_repo_tool_monitor_config` (team) and `session_tool_usage` (FR-7: one row per session + channel + tool, with `aggregates` / `calls` / `outputs` jsonb);
  - new nullable columns `sessions.tool_usage_version` and `repositories.tool_wrap_status`.
- **Server module `server/src/logs/tool-monitoring/`:**
  - config service with the personal ∪ team merge;
  - extractors: MCP, CLI recognition, wrapper matching, signals;
  - a background **rebuild drain**: ingest only marks a tree stale, and the drain rebuilds its rows. This one mechanism also does the MCP backfill and the re-extraction after a tool is added;
  - new env vars `TOOL_USAGE_REBUILD_INTERVAL_MS` / `TOOL_USAGE_REBUILD_BATCH`, plus a version-reset step in `initializeDatabase()`.
- **Tests infra:** the wrapper fidelity check runs in a separate verification project, a sibling folder outside the repo (`<repo>/../loghub-tool-wrap-check/`), created by a new script. `CLAUDE.md` and `repo-health-checks.json` are **not** changed (DD-26). Nothing in this task ever deletes that project (DD-27).
- **New API:**
  - hook-facing `GET /api/v2/tool-monitoring/config` (API key);
  - UI routes under `/api/v1/repositories/:repoId/tool-monitoring/`: `config` GET/PUT, `summary`, `calls`, and `calls/:usageId/:callId`.
- **New upload log kind `tool-calls`** (NDJSON). Wrapper records travel in it, never in artisyn JSONL. An old server stores it as an inert generic `logs` row.
- **Hook (high blast radius, version 2.26.0 → 2.27.0):**
  - re-introduces a **`PreToolUse` hook**, absent since 2.19.0 (matcher `PowerShell`, `updatedInput`);
  - six new files: `tool-wrap-{names,config,shims,tee,powershell,records}.js`;
  - SessionStart generates the Bash shims, runs a pre-flight and writes the `CLAUDE_ENV_FILE` PATH export;
  - new Node tee script `tool-wrap-tee.js`;
  - new config keys `toolWrap` and `toolWrapConfigTimeoutMs`.
  - Fail-open everywhere, with three kill switches (UI pause, `LOGHUB_TOOL_WRAP=0`, `toolWrap:false`).
- **Client:**
  - new repo main tab `tools` (three-pane explorer, Monitored tools dialog, ANSI / table / JSON output views);
  - new session deep-link param `tu=<toolUseId>` that scrolls the Logs tab to the turn holding that call.
- **Decisions on requirements gaps, confirmed by the owner 2026-10-28** (also recorded in requirements.md):
  - PowerShell fidelity is text-level, not byte-level (DD-14);
  - rows are derived asynchronously, a few seconds after upload (DD-7);
  - Status / search filters do not recalculate the tree (DD-18);
  - Bash stdin is captured in full and truncated to 100 KB at upload (DD-13).

## Reference

- Requirements: [requirements.md](requirements.md) (FR-1 … FR-8)
- Research: [research-cli-tool-capture.md](research-cli-tool-capture.md), POC `docs/pocs/2026-10-28-1140-cli-tool-capture/`, archived findings [research/findings-1.md](research/findings-1.md)
- Wireframe: [wireframes/tools-mcp-tab.svg](wireframes/tools-mcp-tab.svg)
- Closest existing feature (copy its shape): OKF usage, `docs/knowledgebase/okf-usage.md`

## Design Decisions

**DD-1 Config storage (answers Open Question 1).** Config lives in two dedicated tables mirroring `repo_config` / `team_repo_config`, not inside `RepoConfigJson`.
- Personal: `repo_tool_monitor_config`, PK `repo_id` (the `repositories` row is already per user).
- Team: `team_repo_tool_monitor_config`, PK `team_repository_id`.
- Both hold `config jsonb` of type `ToolMonitorConfigJson = { paused: boolean; tools: { name: string; enabled: boolean; capture: 'full' | 'meta' }[] }`.
- Why not the settings blob:
  - the existing settings PUTs replace the whole blob, so a client save would drop the tool list;
  - saving through them runs the synchronous file-stats recompute (`repositories.service.ts` `saveTeamConfig`→`recomputeTeamScope` :1009/:1131, `saveUserConfig`→`recomputeForRepo` :1060).

**DD-2 Merge rule.** `resolveMonitoredTools(userId, repoUrl)` merges the owner's personal row with every `team_repo_tool_monitor_config` whose team links the normalized `repoUrl` and has `userId` as a member.
- Result: `{ paused, tools: [{ name, capture, levels: ('personal'|'team')[] }] }`.
- Union of **enabled** tools by name; `capture` is `full` if any enabled level says `full`.
- `paused` is true if any level is paused. The hook ignores the tool list when `paused`.
- Denylisted or invalid names are always dropped.
- `resolveEffectiveConfig` (`repositories.service.ts:635`) is not reused, because it picks one layer and never merges.

**DD-3 Hook config response (FR-6 versioning).** `{ schemaVersion: 1, paused: boolean, tools: [{ name, capture }] }`.
- The hook acts only on `schemaVersion === 1` fields and ignores unknown fields.
- A later server adds fields without bumping the version, and bumps it only for a breaking change. The hook treats an unknown higher version as "wrap nothing".

**DD-4 Denylist and name rules (FR-8.1), single table in `@loghub/tool-monitor` plus the hook copy.**
- Denylist:
  - shells: `bash sh zsh dash fish ksh powershell pwsh cmd wsl`;
  - tools the wrapper itself uses: `node tee env cygpath cat printf mkdir date command`;
  - agent infrastructure: `claude git npx npm`;
  - process control: `sudo su doas runas exec nohup timeout xargs time`;
  - builtins: `cd echo export source . set alias exit eval trap read test [ true false type which where`.
- Matching is case-insensitive and ignores a trailing `.exe` / `.cmd` / `.bat` / `.ps1`.
- Name rule: `^[A-Za-z0-9._-]{1,64}$`, not `.` or `..`.
- `validateToolName(name) → { ok: true } | { ok: false, code: 'empty'|'too_long'|'bad_chars'|'denylisted', message }`. The denylist message names the role, e.g. "`powershell` is the agent's shell and cannot be monitored".
- Constants: `TOOL_NAME_MAX = 64`, `CAPTURE_LIMIT_BYTES = 102400`, `STDIN_CAPTURE_LIMIT_BYTES = 102400`, `MAX_MONITORED_TOOLS = 100`.

**DD-5 Wrapper record transport (answers Open Question 3).** No shared file is ever appended by two processes, so concurrent appends on Windows cannot happen.
- Each wrapped call writes its own files under `<workDir>/tool-wrap/<sessionId>/calls/`:
  - `<callId>.jsonl` with `start` / `stream_end` / `exit` records, written sequentially by that call only;
  - `<callId>.out`, `.err` and `.in` raw bytes.
- `callId` = `<epochMs>-<pid>-<random4>`.
- At upload time `tool-wrap-records.js` assembles `<workDir>/tool-wrap/upload/<sessionId>.jsonl` and uploads it as log kind **`tool-calls`**.
- Body format: one line per call (DD-6) plus one `tool_wrap_status` line.
- The assembled file is capped at 50 MB. Past the cap, the text of the oldest calls is dropped (`textDropped: true`) and their meta is kept.
- The `logs` row is unique per `(session_id, log_type)`, so every upload re-sends the whole cumulative set.

**DD-6 `tool-calls` line shapes.** The hook sends them; the server parses tolerantly and ignores unknown fields.
- `tool_call` line: `{ type:'tool_call', schema:1, callId, sessionId, tool, args: string[], real, cwd, shell:'bash'|'powershell', startedAt, endedAt|null, exitCode|null, durationMs|null, bytes:{stdin,stdout,stderr}, consumerClosed, truncated, capture:'full'|'meta', stdin?, stdout?, stderr?, encoding:'utf8'|'base64', textDropped? }`.
- A missing `exit` record gives `endedAt` / `exitCode` = null, shown as `killed`.
- `tool_wrap_status` line: `{ type:'tool_wrap_status', schema:1, hookVersion, os, preflight:{ ok, reason|null, shells:{bash:boolean, powershell:boolean} }, breaker:{ global:boolean, tools:string[] }, at }`.

**DD-7 Derived rows are rebuilt asynchronously per session tree.** Ingest never extracts inline: it only sets `sessions.tool_usage_version = NULL` on the uploaded node and its top ancestor (`topAncestorIdsSql`, `logs/session-tree.sql.ts`).
- What marks a tree stale:
  - ingest of `claude`, `claude-subagent` or `tool-calls`;
  - ingest of `artisyn` when Step 5 inserted a new `log_repositories` link (`linksInserted > 0`), because the owner's repository only becomes known then;
  - import (`writeImportedLog`);
  - `recomputeAllSessionStats`;
  - adding or enabling a CLI tool, for the scope sessions per FR-7.
- `ToolUsageRebuildService` drains on an interval (`TOOL_USAGE_REBUILD_INTERVAL_MS`, default 15 000) and on a post-commit nudge from ingest. Template: `server/src/logs/session-cost/session-cost-recompute.service.ts:40-96`, using `SchedulerRegistry` the same way.
- Each pass:
  - claims up to `TOOL_USAGE_REBUILD_BATCH` (default 20) non-deleted sessions with `tool_usage_version IS NULL` using `FOR UPDATE SKIP LOCKED`;
  - resolves their roots and sets `tool_usage_version = TOOL_USAGE_EXTRACTOR_VERSION` (1) on every node of each tree **before** reading;
  - rebuilds each tree's rows in its own transaction.
- An upload that commits mid-rebuild sets NULL again, so it is re-run.
- Initial NULLs on all existing sessions are the one-off MCP backfill.
- A future bump of `TOOL_USAGE_EXTRACTOR_VERSION` is applied by an `initializeDatabase()` step that NULLs older versions.
- Why: per-upload cost stays O(1), bursts of prompt uploads collapse into one rebuild, and the rebuild reads only its own tree.

**DD-8 Rebuild of one tree.**
- Read inputs:
  - every node's `claude` / `claude-subagent` transcript body;
  - the root's `tool-calls` body, which may be absent;
  - the owner and repository: the `repositories` row (`userId`, `repoUrl`, `id`) linked to the root's `artisyn` log through `log_repositories`. With no link yet, CLI recognition uses wrapper-record tools only and `tool_wrap_status` is not written. The link insert re-marks the tree stale (DD-7);
  - the owner's monitored set via `resolveMonitoredTools(ownerUserId, repoUrl)`.
- After writing the rows, the rebuild calls `writeToolWrapStatus` (DD-20) when the tree has a `tool-calls` log and a linked repository row.
- Recognised CLI tools = enabled monitored names ∪ tool names present in wrapper records. A tool removed from the config keeps the rows of sessions that are not rebuilt again.
- Delete all `session_tool_usage` rows of the tree's nodes, then insert the new rows.
- Each row belongs to the node whose transcript holds the call. An unmatched (`indirect`) wrapper record belongs to the root.

**DD-9 FR-7 row layout (answers Open Question 2).** `session_tool_usage` has three jsonb columns so the summary never detoasts outputs. PostgreSQL TOASTs each column separately, and a query that names only `aggregates` never reads the other two.
- `aggregates`: per-operation totals.
- `calls`: an array of call metadata with no text, at most a 300-char `inputPreview`.
- `outputs`: an object keyed by `callId` holding `{ input?, stdin?, stdout?, stderr?, agentSaw?, encoding }`.
- MCP `agentSaw` and `input` are stored capped at `CAPTURE_LIMIT_BYTES`. This is the only copy the tab needs; full transcripts are not duplicated.
- Indexes:
  - scalar columns `first_call_at` and `last_call_at`;
  - `UNIQUE (session_id, channel, tool)`, whose leading `session_id` serves the per-node delete and the tree read.

**DD-10 Call record in `calls` (shared by builder, read routes and client types).** `{ callId, channel, tool, operation, ts, durationMs|null, status, hints, source, shell|null, exitCode|null, inBytes, outBytes, agentSawBytes|null, toolUseId|null, agentId|null, agentKind, inputPreview, real|null, cwd|null, args|null, signals }`.
- `status`: `'ok'|'error'|'killed'|'no_result'`.
- `hints`: subset of `['cut','empty','truncated','no_wrapper','indirect','persisted']`.
- `source`: `'transcript'|'wrapper'|'both'`.
- `agentKind`: `'root'|'subagent'|'workflow'`.
- `signals`: subset of `['empty','retried','fell_back','opened_file']`.
- CLI: `toolUseId` is null only for `indirect`.

**DD-11 Aggregates shape.** `{ operations: { [op]: { calls, errors, killed, noResult, empty, retried, fellBack, openedFile, durationMsSum, durationCount, inBytesSum, outBytesSum, lastTs } } }`.
- The summary route sums these over rows in scope.
- `error %` = (errors + killed) / calls.
- `retried %` = retried / calls.

**DD-12 Algorithms.** Server, pure functions, each with an algorithm doc.
- **MCP extraction (FR-3):**
  - name `mcp__<server>__<rest>` → `server` = segment 1, `operation` = the remaining segments joined with `__`;
  - status `error` if `is_error === true`, `no_result` if no matching `tool_result`, else `ok`, reusing `classifyToolOutcome` (`logs/tool-stats.ts:104`);
  - duration via `resolveToolDuration` (`tool-stats.ts:163`);
  - non-text content blocks become `[image]` / `[<type>]` placeholders; text via `flattenToolResultText` (`claude-extractor.ts:365`);
  - sidechain filtering and the ordered `tool_use` pass follow `okf/okf-access-extractor.ts:254-309`.
- **CLI recognition (FR-4 fallback):** `recognizeCliCalls(parser, command, shell, toolNames)`.
  - Bash commands are parsed with the server tree-sitter parser from `getServerBashParser()` (`server/src/logs/okf/server-bash-parser.ts:83`). The parser is injected the way `okf/okf-access-extractor.algo.spec.ts:72` does it; a `null` parser falls back to the PowerShell-style tokenizer.
  - Walk every `command` node: `command_name` text is the command word, `word` / `string` / `raw_string` children are the arguments, unquoted. `@loghub/bash-view` is not changed, because its `analyzeBash` does not return simple commands with full arguments;
  - PowerShell commands are split on `;`, `|`, `&&`, `||` outside quotes, then tokenised on whitespace, honouring quotes;
  - a simple command matches when its command word (basename, without `.exe`) equals a recognised tool name;
  - `operation` = first argument not starting with `-`, else `(none)`;
  - not covered: absolute or relative paths, `npx`, aliases.
- **Wrapper ↔ transcript matching:**
  - a record matches the Bash / PowerShell `tool_use` of the same tree whose time window `[tool_use.ts − 2 s, tool_result.ts + 2 s]` contains `startedAt` and whose recognised commands include the record's `tool` with equal `args[0]`;
  - ties go to the earliest unmatched `tool_use`;
  - a record inside a window whose command does not name the tool → `indirect`, linked to that `toolUseId` for the turn;
  - otherwise `indirect` with `toolUseId` null;
  - a `tool_use` with no record → transcript-only call, hint `no_wrapper`;
  - `cut` = `consumerClosed`, or the agent saw fewer bytes than the wrapper captured.
- **Signals (FR-5)**, over the next 3 `tool_use`s of the same agent:
  - `empty`: output empty after trimming, or it matches `/^(no (results|matches)|not found|nothing found|0 results)/im`;
  - `retried`: same tool + operation again;
  - `fell_back`: `Grep` / `Glob`, or a Bash / PowerShell command word in `grep rg findstr Select-String`;
  - `opened_file`: `Read` / `Edit` whose `file_path` basename appears in the output.
  - The UI labels them as heuristics.

**DD-13 Bash wrapper (hook, FR-4 / FR-8).**
- One script per enabled tool in `<workDir>/tool-wrap/<sessionId>/shims/`, generated from a template string in `tool-wrap-shims.js`. The session id and real-tool resolution are baked in at generation.
- Pass-through (`exec` the real tool on the PATH with the shim dir removed) when any of these holds:
  - `LOGHUB_SHIM_ACTIVE` is set;
  - `CLAUDE_CODE_SESSION_ID` is unset;
  - marker `off/<tool>` or `off/__all` exists;
  - `node` is not on PATH;
  - the resolved path is inside the shim dir (this also trips the breaker).
- Otherwise:
  - write the `start` record;
  - run `LOGHUB_SHIM_ACTIVE=1 "$real" "$@" 2> >(tee "$d/$id.err" >&2) | node tool-wrap-tee.js …`;
  - take the exit code from `PIPESTATUS[0]`, write the `exit` record, `exit` with the tool's code.
- When stdin is a pipe or file (`[ -p /dev/stdin ] || [ -f /dev/stdin ]`), it is fed through `tee "$d/$id.in" |`. The uploader truncates `.in` to 100 KB.
- `tool-wrap-tee.js`:
  - forwards stdout bytes unchanged and captures up to `CAPTURE_LIMIT_BYTES` (counting stderr bytes read from `.err` at exit);
  - on EPIPE stops forwarding and keeps draining until the limit (`consumerClosed`), then exits so the tool gets SIGPIPE (`truncated`);
  - catches every logging error and keeps forwarding;
  - writes the `stream_end` record;
  - has a `--self-test` mode.
- A tool not resolvable at SessionStart gets no shim, so the shell's own `command not found` / 127 is untouched.
- Records are written only when `capture` is `full` (text) or `meta` (records only, no `.out`/`.err`/`.in`). The marker `mode/<tool>.meta` switches it per call.

**DD-14 PowerShell wrapper (hook, FR-4.3).**
- The `PreToolUse` entry `tool-wrap-powershell.js` (matcher `PowerShell`) reads the cached config and the session's pre-flight result.
- If the command mentions an enabled tool (regex `(^|[\s;|&(])<tool>(\.exe)?(\s|$)`, case-insensitive), it returns `{ hookSpecificOutput: { hookEventName:'PreToolUse', updatedInput: { …input, command: prefix + command } } }`. Otherwise it exits 0 with no output.
- `prefix` defines `__lhWrap` plus one function per mentioned tool:
  - resolves the real tool with `Get-Command -CommandType Application`;
  - runs `& $real @args 2>&1`, separating `ErrorRecord`s as stderr;
  - writes the start / exit records and the `.out`/`.err` text (UTF-8) in a `try { } catch { }` that never rethrows;
  - re-emits stdout to the pipeline and stderr via `Write-Error -ErrorRecord`, then restores `$LASTEXITCODE`;
  - missing tool → call `& $toolName @args` unchanged.
- **Fidelity in PowerShell is text-level:** PowerShell itself decodes native output to strings in both the wrapped and unwrapped path. The fidelity test compares what the agent's PowerShell sees, not raw bytes (confirmed by the owner 2026-10-28).

**DD-15 SessionStart pre-flight and kill switches (FR-8.3 / 8.5).**
- Skip everything when any of these holds:
  - `LOGHUB_TOOL_WRAP=0`;
  - config `toolWrap === false`;
  - no `CLAUDE_ENV_FILE`;
  - config fetch is 404 and there is no cache;
  - `paused`;
  - empty tool list.
- Pre-flight:
  - generate the shims into a temp dir, then rename;
  - `chmod 0755`;
  - `bash`, `node`, `tee` resolve;
  - run `<shim-dir>/__selftest --self-test` and expect stdout `loghub-selftest-ok` with exit 0.
- On success, append `export PATH="<git-bash-form shim dir>:$PATH"` to `CLAUDE_ENV_FILE`. On Windows `C:\a\b` becomes `/c/a/b`.
- On failure, inject nothing and write one `[warn]` to `hook.log`. The result is stored in `<workDir>/tool-wrap/<sessionId>/preflight.json` and reported in `tool_wrap_status`.
- Breaker:
  - files `breaker/<tool>` and `breaker/__global`, the latter after 3 faults counted in `breaker/faults`;
  - the shim checks them like the `off/` markers.
- Session dirs older than 7 days are pruned at SessionStart.

**DD-16 Config refresh.**
- SessionStart: synchronous fetch with `toolWrapConfigTimeoutMs` (default 2000).
- UserPromptSubmit: refresh throttled via `claimThrottleSlot(cwd, 'tool-wrap-config.json', 60000)` (`throttle-state.js:41-99`).
- Both write `<workDir>/tool-wrap/config-cache.json` atomically (temp + rename) and rewrite the current session's `off/` and `mode/` markers.
- A tool added mid-session is wrapped only from the next session (no shim exists).
- Transport: `httpRequestJson` pattern (`post-turn-analysis-worker.js:159-210`), `X-API-Key`, `repoUrl` from `getGitContext(cwd).remote`.

**DD-17 Visibility and level.** The read routes use the **Sessions-tab** rules, not the report rules: the requirement says so, and `resolveReportScope` would 403 restricted-team members.
- Use `resolveTeamScope` (`repositories.service.ts:316`) and `buildSessionListConditions` (:518).
- Single-call detail additionally runs `assertSessionVisible` (:474).
- Without `teamId`: the caller's own sessions only, and the config level is personal.
- With `teamId`: team rules apply, and the config level is team, editable when `canEditTeamConfig` (`isTeamOwner`, :585-588).

**DD-18 Tab filters.**
- Date range and scope apply to both the tree and the table.
- Status and search apply to the calls table only, so the tree keeps showing totals.
- Search is server-side `ILIKE` over `inputPreview`, args and `outputs::text` of rows in range and scope.
- Paging: `page` (1-based) + `pageSize` (default 50, max 200), sorted `ts DESC, callId DESC`.

**DD-19 Deep link to the call.**
- "Open in session" goes to `#/repos/:repoId?session=<sessionExtId>&tab=logs&tu=<toolUseId>` (plus `teamId` when in team view).
- `SessionLogView` resolves the turn containing that `tool_use` id and sets the existing transient target-turn state (`client/src/viewer/pages/repository/session-log/SessionLogView.tsx:88-106`, `client/src/viewer/pages/repository/SessionDetailPane.tsx:138-148`).
- `indirect` calls without `toolUseId` link to the session only.

**DD-20 Wrapper status for the panel (FR-2 hints, FR-8.3 / 8.4).**
- During the tree rebuild (DD-8), not inline at ingest, the server writes the `tool_wrap_status` line, plus `lastWrapperAt` per tool (max `startedAt`), into `repositories.tool_wrap_status` of the repository row linked to the root's artisyn log. Last report wins, decided by `reportedAt`: `{ hookVersion, os, preflight, breaker, reportedAt, tools: { [name]: { lastWrapperAt } } }`.
- Panel hints:
  - `hook too old` when a tool is configured and the visible owners' `tool_wrap_status` is null;
  - `no wrapper data yet` when the status exists but has no `lastWrapperAt` for the tool;
  - `wrapper disabled on <os>: <reason>` when the last pre-flight failed;
  - `breaker tripped` when the tool, or global, is in `breaker`.
- Hint codes in the config GET: `hook_too_old`, `no_data_yet`, `preflight_failed`, `breaker`. Precedence: `preflight_failed` > `breaker` > `hook_too_old` > `no_data_yet`.

**DD-22 Constants.**

| Name | Value | Where |
|---|---|---|
| `TOOL_USAGE_EXTRACTOR_VERSION` | 1 | `server/src/logs/tool-monitoring/tool-usage.constants.ts` (Chunk 2) |
| `TOOL_USAGE_REBUILD_INTERVAL_MS` | env, default 15000; scenario stand 1000 | same file; `server/.env.example`; `tests/scenarios/modes.ts` stand env (next to `LOGS_MAX_BODY_MB`, :126) |
| `TOOL_USAGE_REBUILD_BATCH` | env, default 20 | same file; `server/.env.example` |
| `INPUT_PREVIEW_CHARS` | 300 | `tool-usage.constants.ts` |
| `MATCH_WINDOW_SLACK_MS` | 2000 | `tool-usage.constants.ts` |
| `SIGNAL_LOOKAHEAD` | 3 | `tool-usage.constants.ts` |
| `CALLS_PAGE_SIZE_DEFAULT` / `_MAX` | 50 / 200 | `tool-usage.constants.ts` |
| `SEARCH_MAX_CHARS` | 200 | `tool-usage.constants.ts` |
| `UPLOAD_CAP_BYTES` | 52428800 (50 MB) | `hook/.claude/telemetry_tool/tool-wrap-names.js` |
| `SESSION_DIR_MAX_AGE_MS` | 604800000 (7 days) | `tool-wrap-names.js` |
| `BREAKER_GLOBAL_FAULTS` | 3 | `tool-wrap-names.js` |
| `CONFIG_REFRESH_THROTTLE_MS` | 60000 | `tool-wrap-names.js` |
| `SELF_TEST_OUTPUT` | `loghub-selftest-ok` | `tool-wrap-names.js` |
| `STDIN_CAPTURE_LIMIT_BYTES` / `CAPTURE_LIMIT_BYTES` | 102400 / 102400 | `@loghub/tool-monitor` + `tool-wrap-names.js` (DD-4) |
| `CONFIG_FETCH_TIMEOUT_MS_DEFAULT` | 2000 (default of config key `toolWrapConfigTimeoutMs`) | `tool-wrap-names.js` |
| `toolMentionRegex(tool)` | `new RegExp('(^\|[\\s;\|&(])' + escapeRegExp(tool) + '(\\.exe)?(\\s\|$)', 'i')` | `tool-wrap-names.js` (DD-14) |
| `COLLAPSE_HEIGHT_PX` / `SEARCH_DEBOUNCE_MS` | 400 / 300 | `client/src/viewer/pages/repository/tools/tools-constants.ts` |
| `PENDING_REFETCH_MS` | 10000 | `tools-constants.ts` |
| `TREE_WIDTH_DEFAULT` / `_MIN` / `TREE_RAIL_WIDTH` | 280 / 200 / 28 | `tools-constants.ts` |
| `TABLE_WIDTH_DEFAULT` / `_MIN`, `DETAILS_MIN_WIDTH` | 560 / 360, 360 | `tools-constants.ts` |
| `ERROR_PCT_AMBER` / `ERROR_PCT_RED` | 5 / 15 (grey below 5, amber below 15, red at 15 and above) | `tools-constants.ts` |

**DD-23 Export/import.** Repository export (`server/src/logs/repository-export-import.service.ts:810`) carries only `claude` and `artisyn` logs, and no repository config.
- `tool-calls` logs and the two config tables stay out of export. That matches how sub-agent logs and `repo_config` are treated today.
- After import, `writeImportedLog` marks trees stale. The rebuild then gives MCP rows and transcript-only CLI rows (owner's config on the target server).

**DD-25 Tree sorting and detail rendering.**
- Tree sort keys at every level (group, tool, operation), descending:
  - calls;
  - error % (DD-11);
  - retried %;
  - last used = max `lastTs`, computed client-side from the operation aggregates.
- Details meta line: time · duration · owner email (masked per scope) · agent kind · shell · `real` path.
- Parameters:
  - CLI: the agent's command line (`inputPreview`, full in `output.input`), a numbered `args` list and `cwd`;
  - MCP: the pretty-printed `output.input` JSON.

**DD-26 Fidelity verification project (owner decision 2026-10-28).** `CLAUDE.md` and `.claude/repo_config/repo-health-checks.json` stay unchanged. No new health check is added.
- `tool-wrap-fidelity.algo.test.js` spawns real shells. It is skipped unless `LOGHUB_FIDELITY_TEST=1`, so the hook `npm test` in the fast `static` set stays environment-free.
- The fidelity check runs in a separate **verification project** outside the repo, created by `scripts/tool-wrap-check/create-check-project.mjs` (Node, built-ins only).
  - Default location: `path.resolve(repoRoot, '..', 'loghub-tool-wrap-check')`, overridable with `--dir`. Paths are always resolved, never machine-specific.
  - Re-running the script refreshes the generated files and never deletes anything (DD-27).
- Contents of `loghub-tool-wrap-check/`:
  - `git init`;
  - `bin/` fixture tools:
    - `zz`: bash script, 20 000 lines, exit code from `$ZZ_EXIT`;
    - `zzbin`: emits binary bytes 0–255;
    - `zzin`: echoes stdin to stdout and stderr;
    - `zzsleep`: sleeps, for the SIGINT row;
    - `zz.cmd`: Windows only;
  - `run-check.mjs`;
  - `package.json` with the scripts `check` → `node run-check.mjs` (host OS) and `check:linux` → `node run-check.mjs --linux` (Linux container, see below);
  - `linux/Dockerfile`: `FROM node:22-bookworm`, plus `bash`, `coreutils`, `findutils`, `procps` (all present in the image; the file pins it). With `--image node:22-alpine`, `run-check.mjs` adds `apk add bash` for the busybox variant;
  - `README.md`: purpose, how to run, how to read results.
- `run-check.mjs` runs `node --test <repo>/hook/.claude/telemetry_tool/__tests__/tool-wrap-fidelity.algo.test.js` with `LOGHUB_FIDELITY_TEST=1` and `LOGHUB_FIDELITY_PROJECT=<project dir>`. The repo path is stored in the generated `check.config.json`. It prints a pass / fail / skipped table per row and the measured wrapper overhead on `find` (FR-8.8). Exit code ≠ 0 on any failure.
- **Linux container run (`npm run check:linux`):**
  - `run-check.mjs --linux [--image <img>]` builds `linux/Dockerfile` as image `loghub-tool-wrap-check:local` (skipped when `--image` is given);
  - then runs `docker run --rm --name loghub-twc-<timestamp>` with:
    - the repo's `hook/.claude/telemetry_tool` mounted read-only at `/hook`;
    - the project mounted read-write at `/work`;
    - `-e LOGHUB_FIDELITY_TEST=1 -e LOGHUB_FIDELITY_PROJECT=/work`;
    - command `node --test /hook/__tests__/tool-wrap-fidelity.algo.test.js`.
  - `--rm` removes only the container, never host files (DD-27).
  - Test output is written to `runs/<timestamp>/` under the mounted project, so results stay on the host.
  - Rows marked `os: windows` are skipped; the Linux-specific rows (busybox vs GNU `find`, SIGINT via `kill -INT`) run here.
  - If Docker is not running, the script prints one clear message and exits 2, without falling back to a host run.
  - The run covers the stock `node:22-bookworm` image and `--image node:22-alpine`. Both results go into `notes.md`.
- **Live Linux session (`npm run check:linux-live`)**, the acceptance "live `claude -p` uses the wrapper" in Linux, without waiting for interactive login:
  - **Auth:** the shared sandbox profile `<repo>/docker-dev/claude-home`, path stored in `check.config.json`, overridable with `--claude-home`.
    - It is mounted read-write at `/home/dev/.claude-home` with `CLAUDE_CONFIG_DIR=/home/dev/.claude-home`, exactly as `docs/knowledgebase/docker-dev-container.md` mounts it. Read-write is needed because Claude refreshes the token.
    - The profile is never copied, modified by the scripts, or deleted (DD-27).
  - **Image:** `log-hub-dev:latest` (has `claude` at `/home/dev/.local/bin/claude`), run as uid 1000 with `--init --entrypoint bash` and `MSYS_NO_PATHCONV=1` when launched from Git Bash.
  - **Verified 2026-10-28:**
    ```
    docker run --rm --init --entrypoint bash -u 1000 -e CLAUDE_CONFIG_DIR=/home/dev/.claude-home -v <repo>/docker-dev/claude-home:/home/dev/.claude-home log-hub-dev:latest -lc 'claude -p "reply OK"'
    ```
    It printed `OK` (Claude Code 2.1.304).
  - **Setup:**
    - mount the project at `/work` and the repo hook read-only at `/hook`;
    - the generated `.claude/settings.json` registers `SessionStart` / `UserPromptSubmit` / `PreToolUse(PowerShell)` commands pointing at `node /hook/<entry>.js`;
    - seed `.artisyn/ai_work_dir/tool-wrap/config-cache.json` with `zz` and `find`, so no Log Hub server is needed (DD-16 cache fallback).
  - **Prompt:** "run `zz | head -1` and `find /nonexistent`, then reply DONE".
  - **Check:** exit 0, plus `calls/*.jsonl` records for both tools with `consumerClosed: true` for `zz` and exit code 1 for `find`. The result goes into `runs/<timestamp>/live.json`.
  - Spends a small amount of real Claude credits; run once per final verification.
- The test uses fixture tools from `LOGHUB_FIDELITY_PROJECT/bin`. It generates shims into a new `runs/<timestamp>/` folder inside the project, which is never cleaned up automatically (DD-27).

**DD-27 No deletion — owner's hard rule (2026-10-28).** Neither the implementation nor any script or test of this task may delete the verification project `loghub-tool-wrap-check`, or anything inside it or above it.
- **No deletion code at all:** `create-check-project.mjs`, `run-check.mjs` and `tool-wrap-fidelity.algo.test.js` contain no `rm` / `rmSync` / `rmdirSync` / `unlinkSync` / `rm -rf` / `Remove-Item` calls. Old `runs/*` folders are left for the owner to delete by hand.
- **Overwrites only touch the generated files**, listed explicitly in the script. They are written with `writeFileSync`, never by deleting the folder first.
- **`create-check-project.mjs` refuses to run (exit 1, no writes) when the target directory:**
  - is the filesystem root, the user's home directory, the repo root, or any ancestor of the repo root;
  - is inside the repo;
  - already exists, is non-empty, and has no `.loghub-tool-wrap-check` marker file. The script writes this marker when it creates the project.
- **During implementation:** never run a delete command against `../loghub-tool-wrap-check` or the parent folder `D:/_work/Artisyn-LogHub`. Leave cleanup to the owner.
- **The hook's own pruning (DD-15) is guarded the same way.** It deletes only directories directly under `<workDir>/tool-wrap/` whose name is a session id (`^[A-Za-z0-9-]{8,128}$`), uses `lstat`, never follows symlinks or junctions, and never deletes `<workDir>/tool-wrap` itself.
- The same project is used for the manual acceptance checks: install the hook, monitor `zz` / `find`, and run a live `claude -p` session in Git Bash and PowerShell.
- When to run: a manual step of this task's final verification:
  - `npm run check` on Windows (Git Bash, PowerShell 5.1 and 7);
  - `npm run check:linux`, plus `npm run check:linux -- --image node:22-alpine`;
  - `npm run check:linux-live`.
  - Record the results in the task's `notes.md`. macOS is not covered by a container and stays a manual check on a Mac when one is available.

**DD-24 Module wiring.** No separate Nest module, which avoids a cycle with `LogsModule`, where `RepositoriesService` lives. All new providers and both controllers are registered directly in `server/src/logs/logs.module.ts`, next to `OkfUsageService` / `SessionCostRecomputeService`.

**DD-21 Tab id and URL params.**
- `REPO_MAIN_TABS` gets `tools`, labelled "Tools/MCP", placed after `reports` and before `okf`, test id `tab-repo-tools`.
- URL params, all dropped by `setMainTab` when leaving the tab:
  - `tfrom`, `tto`: date range;
  - `tstatus`;
  - `tq`: search;
  - `tch`, `ttool`, `toper`: scope (`toper`, not `top`: the Sessions tab already owns `top` for its top-N filter);
  - `tcall`: `usageId:callId`;
  - `tpage`.
- localStorage keys `artisyn:toolsTab:treeWidth`, `artisyn:toolsTab:tableWidth`, `artisyn:toolsTab:treeCollapsed`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `packages/tool-monitor/{package.json,tsconfig.json,README.md,src/index.ts}` | Shared denylist and name validation | DD-4; erasable TS only, like `packages/pricing` |
| `server/package.json`, `server/package-lock.json`, `client/vite.config.ts`, `client/tsconfig.json` | Wire the package | `file:` dependency + `npm install` on the server; alias + `paths` + `include` on the client, per `docs/knowledgebase/repo-local-packages.md` "Adding a package" |
| `server/src/logs/tool-monitoring/tool-usage.constants.ts` | DD-22 server constants | |
| `server/.env.example` | Document `TOOL_USAGE_REBUILD_INTERVAL_MS` / `_BATCH` | next to `SESSION_COST_RECOMPUTE_INTERVAL_MS` (:66-71) |
| `server/src/logs/claude-extractor.ts` | Export `flattenToolResultText` (:365) and `computeToolResultBytes` (:1391) | currently module-private |
| `client/src/viewer/pages/repository/tools/tools-constants.ts` | DD-22 client constants | |
| `tests/scenarios/modes.ts` | Stand env `TOOL_USAGE_REBUILD_INTERVAL_MS: '1000'` | next to `LOGS_MAX_BODY_MB` (:126) |
| `server/drizzle/migrations/0076_tool_monitoring.sql` + `meta/_journal.json` + `migrations.lock.json` | Schema | Database changes |
| `server/src/database/schema/index.ts` | Drizzle mirrors and jsonb types | next to `sessionOkfAccess` (:1293) |
| `server/src/database/database-init.ts` (`initializeDatabase()`) | Extractor-version NULLing step | DD-7 |
| `server/src/sessions/sessions.service.ts` | Purge step for `session_tool_usage` | next to step c2 (:196-200) |
| `server/src/logs/tool-monitoring/tool-monitor-config.service.ts` | Config CRUD, merge, scope marking | DD-1, DD-2, DD-17 |
| `server/src/logs/tool-monitoring/mcp-call-extractor.ts` | FR-3 | DD-12 |
| `server/src/logs/tool-monitoring/cli-command-recognition.ts` | FR-4 fallback | DD-12 |
| `server/src/logs/tool-monitoring/wrapper-record-matching.ts` | Wrapper ↔ transcript | DD-12 |
| `server/src/logs/tool-monitoring/tool-call-signals.ts` | FR-5 | DD-12 |
| `server/src/logs/tool-monitoring/tool-calls-log.ts` | Parse the `tool-calls` NDJSON body | DD-6 |
| `server/src/logs/tool-monitoring/tool-usage-builder.ts` | Rows + aggregates for a tree | DD-8 to DD-11 |
| `server/src/logs/tool-monitoring/tool-usage-writer.ts` | Delete-then-insert per tree, stale marking | DD-7, DD-8 |
| `server/src/logs/tool-monitoring/tool-usage-rebuild.service.ts` | Background drain | DD-7 |
| `server/src/logs/tool-monitoring/tool-wrap-status.ts` | `repositories.tool_wrap_status` writer | DD-20 |
| `server/src/logs/tool-monitoring/tool-usage-read.sql.ts` | Summary / calls / detail queries | DD-11, DD-17, DD-18 |
| `server/src/logs/tool-monitoring/tool-monitoring.controller.ts` | UI routes | API changes |
| `server/src/logs/tool-monitoring/tool-monitoring-hook.controller.ts` | Hook config route | API changes |
| `server/src/logs/tool-monitoring/tool-monitoring.types.ts` | Response DTOs | API changes |
| `server/src/logs/logs.module.ts` | Register the new providers and controllers | DD-24 |
| `server/src/logs/logs.service.ts` | Mark stale after ingest and import; write wrap status | `upsert()` :257, `writeImportedLog` :976 |
| `server/src/logs/repositories.service.ts` | `recomputeAllSessionStats` marks trees stale | method at :1282 |
| `hook/.claude/telemetry_tool/tool-wrap-names.js` | Plain-JS copy of DD-4 | |
| `hook/.claude/telemetry_tool/tool-wrap-config.js` | Fetch, cache, kill switches, markers | DD-15, DD-16 |
| `hook/.claude/telemetry_tool/tool-wrap-shims.js` | Shim generation, pre-flight, env-file export, breaker, prune | DD-13, DD-15 |
| `hook/.claude/telemetry_tool/tool-wrap-tee.js` | Stdout tee + `--self-test` | DD-13 |
| `hook/.claude/telemetry_tool/tool-wrap-powershell.js` | PreToolUse entry | DD-14 |
| `hook/.claude/telemetry_tool/tool-wrap-records.js` | Assemble the `tool-calls` upload file | DD-5, DD-6 |
| `hook/.claude/telemetry_tool/{lifecycle-hook.js,telemetry-hook.js,send-logs-hook.js,session-files.js,env-context.js,version.json}` | Integration | |
| `scripts/build-hooks-installer.js`, `hook/INSTALL_HOOK.md` | `HOOK_JS_FILES`, PreToolUse in `HOOKS_JSON`, docs | :97, :306-346; INSTALL_HOOK.md :302-395 |
| `.artisyn/marketplace/plugins/log-hub-hooks/**` | Dogfood refresh incl. `hooks/hooks.json` | per `.claude/rules/hook.md` |
| `client/src/models/tool-monitoring.ts` | Client types | mirrors API changes |
| `client/src/viewer/api.ts` | Fetchers | next to `fetchRepoOkfUsage` :827 |
| `client/src/viewer/tab-ids.ts`, `pages/repository/RepositoryView.tsx`, `useRepositoryViewState.ts` | New tab + params | DD-21 |
| `client/src/viewer/pages/repository/tools/RepoToolsTab.tsx` | Tab root: panes, splitters, rail, states | Chunk 12 |
| `…/tools/ToolsTopBar.tsx` | Date range, status, search, scope chip, Monitored tools button | |
| `…/tools/ToolsTree.tsx` | Tools tree | DD-25 |
| `…/tools/ToolCallsTable.tsx` | Calls listbox + pager | |
| `…/tools/ToolCallDetails.tsx` | Details pane | DD-25 |
| `…/tools/ToolOutputView.tsx` | Terminal / agent / raw / JSON views | |
| `…/tools/JsonTree.tsx` | Collapsible JSON tree | |
| `…/tools/MonitoredToolsDialog.tsx` | Config editor | |
| `…/tools/tools-url-state.ts`, `output-format.ts`, `ansi-render.tsx` | URL state, format detection / re-alignment, ANSI spans | |
| `server/src/logs/tool-monitoring/{tool-monitor-name-validation,mcp-call-extractor,cli-command-recognition,wrapper-record-matching,tool-call-signals}.algo.spec.ts` | Server algorithm tests | Chunk 15 |
| `client/src/viewer/pages/repository/tools/output-format.algo.test.ts` | Client algorithm test | Chunk 16 |
| `hook/.claude/telemetry_tool/__tests__/{tool-wrap-names,tool-wrap-fidelity}.algo.test.js` | Hook algorithm tests (fidelity is env-gated) | DD-26 |
| `scripts/tool-wrap-check/create-check-project.mjs` | Creates the verification project `<repo>/../loghub-tool-wrap-check/` | DD-26; the generated project is outside the repo and never committed |
| `client/src/viewer/pages/repository/session-log/SessionLogView.tsx`, `client/src/viewer/pages/repository/SessionDetailPane.tsx` | `tu` deep link | DD-19 |
| `docs/knowledgebase/algorithms/*.md` (7 new) + `algorithms/README.md` registry | Algorithm docs | Test coverage plan |
| `docs/knowledgebase/tool-monitoring.md` + `index.md` and the KB updates in Chunk 14 | Docs | |
| `server/test/contract/registry/f24-tool-monitoring.ts`, `server/test/contract/f24.contract-spec.ts`, `server/test/contract/registry/index.ts`, `server/test/contract/fixtures/world-v1.sql.ts` | Contract rows | |
| `tests/scenarios/repos/s-repo-17.spec.ts`, `tests/scenarios/helpers/tool-monitoring.ts`, tours, `s-hook-09.spec.ts`, QA catalog | Scenario | |

## API changes

All `/api/v1/repositories/:repoId/tool-monitoring/*` routes:
- accept an optional `teamId` (positive int, else 400), checked with `assertRepoAccess(user, repoId, teamId)` as in `repositories.controller.ts:456-467`;
- use cookie-session auth;
- never mutate on GET.

| Route | Method | Request | Response |
|---|---|---|---|
| `/api/v2/tool-monitoring/config` | GET | `X-API-Key`; query `repoUrl` (normalized with `normalizeRepoUrl`; missing → 400) | DD-3 `{ schemaVersion:1, paused, tools:[{name,capture}] }`. Unknown repo → `{schemaVersion:1, paused:false, tools:[]}` |
| `…/tool-monitoring/config` | GET | `teamId?` | `{ level:'personal'\|'team', canEdit, paused, tools:[{ name, enabled, capture, levels:('personal'\|'team')[], lastWrapperAt\|null, hint:'hook_too_old'\|'no_data_yet'\|'preflight_failed'\|'breaker'\|null }], wrapStatus:{ hookVersion, os, preflight:{ ok, reason\|null }, breaker:{ global, tools:string[] }, reportedAt }\|null, denylist: string[] }`. `wrapStatus` is the most recent report among the visible owners' repository rows (DD-20) |
| `…/tool-monitoring/config` | PUT | `teamId?`; body `{ paused:boolean, tools:[{name,enabled,capture}] }` (≤ `MAX_MONITORED_TOOLS`, unique names case-insensitive) | Same as GET. 400 `{message, field:'tools[i].name', code}` per DD-4; 403 when team view and not `canEditTeamConfig`. Side effect: newly added or newly enabled tools mark the level's scope sessions stale (DD-7) |
| `…/tool-monitoring/summary` | GET | `teamId?`, `from`, `to` (ISO dates; default the last 30 days, validated like `analytics/analytics-query.ts:37`) | `{ range:{from,to}, pendingSessions:number, totals:Agg, groups:{ mcp:{ tools:number } & Agg, cli:{ tools:number } & Agg }, tools:[{ channel, tool, lastUsedAt } & Agg & { operations:[{ operation, lastUsedAt } & Agg] }], neverCalled: string[] }`, where `Agg = { calls, errors, killed, noResult, empty, retried, fellBack, openedFile, avgDurationMs\|null, inBytes, outBytes }`. `pendingSessions` = in-scope, non-deleted sessions in range with `tool_usage_version IS NULL` |
| `…/tool-monitoring/calls` | GET | `teamId?`, `from`, `to`, `channel?`, `tool?`, `operation?`, `status?` (`ok\|error\|killed\|no_result`), `q?` (≤ 200 chars), `page?`, `pageSize?` | `{ total, page, pageSize, items: (DD-10 call record minus args/cwd & { usageId, sessionId: string, sessionOwner: { id, email\|masked } })[] }` |
| `…/tool-monitoring/calls/:usageId/:callId` | GET | `teamId?` | `{ call: DD-10 record & { usageId, sessionId, rootSessionId }, output: { input?, stdin?, stdout?, stderr?, agentSaw?, encoding }, link: { sessionId, toolUseId\|null } }`. 404 when the row or call is missing or the session is not visible |

Hook API compatibility: purely additive.
- Old hooks never call the route.
- New hooks treat a non-200 response or a timeout as "no config".
- The `tool-calls` kind on an old server becomes an inert generic `logs` row (`logs-v2.controller.ts:47`).

## Database changes

Migration `server/drizzle/migrations/0076_tool_monitoring.sql`:
- hand-written, every statement guarded with `IF NOT EXISTS`;
- header comment in the style of `0075_okf_usage.sql`;
- then `npm run migrations:lock` (from `server/`).

| Object | Definition |
|---|---|
| `repo_tool_monitor_config` | `repo_id integer PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE`, `config jsonb NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()` |
| `team_repo_tool_monitor_config` | `team_repository_id integer PRIMARY KEY REFERENCES team_repositories(id) ON DELETE CASCADE`, `config jsonb NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()` |
| `session_tool_usage` | `id serial PK`, `session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`, `channel varchar(8) NOT NULL CHECK (channel IN ('mcp','cli'))`, `tool text NOT NULL`, `call_count integer NOT NULL DEFAULT 0`, `first_call_at timestamptz`, `last_call_at timestamptz`, `has_wrapper_data boolean NOT NULL DEFAULT false`, `aggregates jsonb NOT NULL`, `calls jsonb NOT NULL`, `outputs jsonb`, `UNIQUE (session_id, channel, tool)` |
| index | `CREATE INDEX IF NOT EXISTS idx_session_tool_usage_last_call_at ON session_tool_usage (last_call_at)` |
| `sessions.tool_usage_version` | `smallint` nullable, no default. NULL = rebuild pending |
| index | `CREATE INDEX IF NOT EXISTS idx_sessions_tool_usage_pending ON sessions (id) WHERE tool_usage_version IS NULL AND NOT deleted` |
| `repositories.tool_wrap_status` | `jsonb` nullable, no default (DD-20) |

Data-integrity analysis (migrations-data-integrity):
- **Additive only.** No existing column, row or constraint changes.
- **Lock profile:**
  - both `ADD COLUMN`s are nullable with no default: catalog-only, no rewrite;
  - the new tables are empty;
  - the partial index on `sessions` builds under a brief ShareLock. It covers every non-deleted session, because all are NULL at first. Size is proportional to `sessions`, which is acceptable: it is the same profile as `sessions_okf_snapshot_id_idx` in 0075;
  - no `CONCURRENTLY`, because Drizzle wraps each file in a transaction.
- **The backfill is implicit.** The first deploy makes the drain walk every existing non-deleted session in batches of 20. Its cost is bounded by the interval and batch size, and it never blocks ingest (`SKIP LOCKED`).
- **Edge cases the drain must handle without failing the batch:** each tree is in its own transaction; on error it logs, leaves the version set and continues, so a poison tree cannot loop forever.
  - sessions without a repository or owner → MCP only;
  - sub-agent nodes whose root row does not exist yet → treated as their own root;
  - transcripts with malformed lines → tolerant parse;
  - MCP names with extra `__`;
  - very long tool names → `text` column.
- Soft-deleted sessions are excluded by the partial index and purged by the new purge step.
- Hard delete cascades through the FKs.
- **Rollback safety:** older server builds ignore the new tables and columns.

## Test coverage plan

Per CLAUDE.md, only the three allowed kinds.

- **Algorithm**: seven new docs under `docs/knowledgebase/algorithms/`. Each has an `examples` block and an `*.algo.*` table test, and is registered in `algorithms/README.md`.
  - `tool-monitor-name-validation.md` (DD-4): one table run by two runners — server `*.algo.spec.ts` (covers the shared `@loghub/tool-monitor` code the client also uses) and hook `__tests__/tool-wrap-names.algo.test.js` (the plain-JS copy).
  - `mcp-call-extraction.md` (DD-12): server.
  - `cli-command-recognition.md` (DD-12): server.
  - `tool-wrapper-matching.md` (DD-12): server.
  - `tool-usefulness-signals.md` (DD-12): server.
  - `tool-output-format.md` (format detection JSON / pipe table / fixed-width / TSV / plain, plus re-alignment): client.
  - `tool-wrapper-fidelity.md`: hook `__tests__/tool-wrap-fidelity.algo.test.js` runs each row wrapped and unwrapped on the current OS and skips rows whose `os` / `shell` is unavailable. requirements.md "Tests" mandates this form. It uses only a temp dir and the local shells, no DB or server. Because it spawns real processes, it is skipped in the fast set and runs only from the verification project `loghub-tool-wrap-check` (DD-26) as a manual final-verification step. Each row has a 10 s timeout; rows needing PowerShell run only on Windows.
    - Rows: binary output, 20 000 lines, stdin pipe, args with spaces / quotes / Unicode, missing tool (127), SIGINT, `find /nonexistent` (Git Bash), `.cmd` tool (PowerShell), `| head -1` full capture, 100 KB truncation.
    - Fail-open rows: read-only log dir, `node` missing from PATH, corrupted config cache, `LOGHUB_SHIM_ACTIVE=1` nesting.
- **API contract**: a new family `f24-tool-monitoring.ts` in `server/test/contract/registry/` with rows for all six routes:
  - owner 200;
  - outsider 403/404;
  - bad `teamId` 400;
  - denylisted name 400 on PUT;
  - hook route without key 401 and missing `repoUrl` 400.
- **Scenario**: new `tests/scenarios/repos/s-repo-17.spec.ts` (`@S-REPO-17 @mode-a`). No existing scenario covers this tab. Steps:
  1. configure the personal `ce` and team `find` tools in the UI and see a denylist refusal;
  2. check the hook config route returns the merged list;
  3. upload a session tree with MCP calls plus a `tool-calls` log;
  4. wait for the rebuild;
  5. check the tree figures add up, the calls list, call detail (full output vs agent-saw, `cut`) and "Open in session";
  6. upload a second session without wrapper records and see `no wrapper`;
  7. check visibility for a non-team developer.
  - Existing `tests/scenarios/hook/s-hook-09.spec.ts` gets its PreToolUse assertion updated (step change, not a new test).
  - The tour registry gets the new screen row.

## Visual/UX notes

- **Layout:** follows the wireframe. Top bar (`ToolsTopBar`) over a three-pane row: tree (default 280 px, min 200, collapsible to a 28 px rail), table (default 560 px, min 360), details (flex, min 360).
  - Splitters use `useDraggableWidth` (`hooks/useDraggableWidth.ts:12-71`) twice, with the `role="separator"` handle from `RepoOkfTab.tsx:185-216`.
  - Collapse pattern from `components/AppShell.tsx:9-68`.
- **Tree:** rows of 24 px: chevron, channel badge (`MCP` violet as in `prompt-turn-helpers.tsx:66-76`, `CLI` slate), name, calls number + bar (width ∝ calls / max tool calls), error % chip.
  - Error colours: grey `< 5 %`, amber `< 15 %`, red `≥ 15 %`.
  - `never called` rows are greyed and italic.
  - Filter input and a sort segmented control (calls / error % / retried % / last used) at the top.
- **Table:** a listbox like `client/src/viewer/pages/repository/session-log/bash-tab/BashCallList.tsx:50-100`: ↑/↓, `aria-activedescendant`, `scrollIntoView`. Status column uses `StatusBadge` styling plus small grey hint text. Pager footer `◂ 1–50 of N ▸`.
- **Details:** header with badges and the "Open in session ↗" link. Collapsible sections Parameters / Input (stdin) / Output / stderr (red-tinted `bg-red-50`) / Signals, each with `CopyButton` (`raw-logs/primitives.tsx:20-50`).
  - Output tabs: Terminal | As the agent saw it | Raw. Terminal is replaced by the JSON tree when the output is JSON.
  - Light surface only (`ui-principles.md:16-20`). ANSI colours map to a light palette. The amber left bar marks the lines the agent received.
  - Long blocks collapse beyond 400 px with "Show all".
  - The Signals chip tooltip says "heuristic" (light tooltip, `ui-principles.md:112-125`).
- **Monitored tools dialog** (`ui/dialog.tsx`):
  - rows: name input, enabled switch, capture select (full / meta), level badges, last-received / hint text, remove button;
  - "Add tool" and a "Pause all wrapping" switch;
  - inline refusal message from `validateToolName`;
  - read-only with "Managed by team owner" when `!canEdit` (pattern `RepositorySettings.tsx:261-300`).
- **States:** loading skeletons, an empty range ("No tool calls in this range"), a 403 message, and a grey note "N sessions are still being processed…" while the summary's `pendingSessions > 0`. While it is non-zero, the summary query refetches every 10 s.

## Wireframes

No wireframe changes. The wireframe shows Tools/MCP between Reports and Settings. The code places it after Reports and before the existing OKF tab (DD-21), which keeps both tabs next to each other.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Shared package `@loghub/tool-monitor` | 5 | first; server and client import it |
| 2 | Schema and migration | 7 | needs 1 for jsonb types only |
| 3 | Server config service | 7 | needs 2 |
| 4 | Server extractors | 6 | pure functions; needs 2 types |
| 5 | Server builder, writer and rebuild drain | 7 | needs 3, 4 |
| 6 | Server read and hook routes | 6 | needs 3, 5 |
| 7 | Hook config, names, refresh | 5 | needs 6 (route contract) |
| 8 | Hook Bash wrapper and SessionStart | 6 | needs 7 |
| 9 | Hook PowerShell, upload, registration | 6 | needs 8 |
| 10 | Hook release steps | 4 | needs 9 |
| 11 | Client foundation | 7 | needs 6 |
| 12 | Client tab layout, tree, table | 5 | needs 11 |
| 13 | Client details, dialog, deep link | 7 | needs 12 |
| 14 | KB documentation | 6 | after code |
| 15 | Server algorithm docs and tests | 6 | tests |
| 16 | Client and hook algorithm docs and tests | 8 | tests |
| 17 | Contract tests | 4 | tests |
| 18 | Scenario and tour updates | 7 | last |

### Chunk 1 — Shared package `@loghub/tool-monitor`
- [ ] Create `packages/tool-monitor/` (`package.json` name `@loghub/tool-monitor`, `tsconfig.json`, `src/index.ts`), copying the `packages/pricing` setup; erasable TS syntax only.
- [ ] In `src/index.ts`, export `TOOL_DENYLIST` (with role per entry for messages), `validateToolName()`, `normalizeToolName()` and the constants, all per DD-4.
- [ ] Server wiring: add `"@loghub/tool-monitor": "file:../packages/tool-monitor"` to `server/package.json` and run `npm install` in `server/` (updates `package-lock.json`).
- [ ] Client wiring: add the alias to `client/vite.config.ts` and to `client/tsconfig.json` (`paths` and `include`), as `@loghub/pricing` is wired.
- [ ] Write `packages/tool-monitor/README.md` (purpose, the hook's plain-JS copy `tool-wrap-names.js` must stay in sync, tested by `tool-monitor-name-validation.md`). Add a row to the package table in `docs/knowledgebase/repo-local-packages.md`.

### Chunk 2 — Schema and migration
- [ ] Write `server/drizzle/migrations/0076_tool_monitoring.sql` exactly per Database changes, with a header comment (additive, lock profile, implicit backfill) styled like `0075_okf_usage.sql`.
- [ ] Add the journal entry in `meta/_journal.json`, then run `npm run migrations:lock` from `server/`.
- [ ] In `server/src/database/schema/index.ts`, add Drizzle mirrors `repoToolMonitorConfig`, `teamRepoToolMonitorConfig`, `sessionToolUsage`, plus the columns `sessions.toolUsageVersion` and `repositories.toolWrapStatus` (partial index mirrored with `.where`).
- [ ] Add the jsonb types `ToolMonitorConfigJson` (DD-1), `ToolUsageAggregates` (DD-11), `ToolCallRecord` (DD-10), `ToolCallOutputs` (DD-9) and `ToolWrapStatusJson` (DD-20) next to `RepoConfigJson` in the schema file.
- [ ] In `server/src/sessions/sessions.service.ts` `purgeSessionChildData`, add a step deleting `session_tool_usage` rows of the purged sessions next to step c2 (:196-200).
- [ ] Create `server/src/logs/tool-monitoring/tool-usage.constants.ts` with the server constants of DD-22, including env-read interval and batch.
- [ ] In `server/src/database/database-init.ts` `initializeDatabase()`, add a step that sets `sessions.tool_usage_version = NULL` where it is below `TOOL_USAGE_EXTRACTOR_VERSION`, per DD-7.

### Chunk 3 — Server config service
- [ ] Create `server/src/logs/tool-monitoring/tool-monitor-config.service.ts` with `getLevelConfig(repoId, teamId?)` and `saveLevelConfig(user, repoId, teamId?, body)`, reading and upserting the two tables per DD-1.
- [ ] Validate in `saveLevelConfig`: body shape, `MAX_MONITORED_TOOLS`, case-insensitive unique names and `validateToolName`; throw `BadRequestException({message, field, code})` per API changes. Team level requires `canEditTeamConfig` (else 403).
- [ ] Implement `resolveMonitoredTools(userId, repoUrl)` per DD-2: owner's personal row, plus team rows joined through `team_repositories` and team membership on the normalized `repoUrl`.
- [ ] Implement `markScopeStale(repoId, teamId?, toolNames)`, called from `saveLevelConfig` for newly added or enabled tools. It sets `tool_usage_version = NULL` on the scope sessions (personal: the owner's; team: the team members') of the repository URL, reusing the root selection in `server/src/logs/analytics/scoped-sessions.sql.ts`.
- [ ] Create `tool-monitoring/tool-monitoring.types.ts` with all response DTOs exactly per API changes.
- [ ] Implement `buildConfigView(user, repoId, teamId?)` returning the config GET DTO (levels per tool, `lastWrapperAt`, `hint` precedence, `wrapStatus`, `denylist`) per DD-20.
- [ ] Register `ToolMonitorConfigService` as a provider in `server/src/logs/logs.module.ts` (DD-24).

### Chunk 4 — Server extractors
- [ ] In `server/src/logs/claude-extractor.ts`, export the private `flattenToolResultText` (:365) and `computeToolResultBytes` (:1391) without changing their behaviour.
- [ ] Create `tool-monitoring/mcp-call-extractor.ts`: `extractMcpCalls(entries, nodeMeta)` → DD-10 records plus outputs, per DD-12 MCP rules, reusing `classifyToolOutcome`, `resolveToolDuration`, `flattenToolResultText` and `computeToolResultBytes`.
- [ ] Create `tool-monitoring/cli-command-recognition.ts`: `recognizeCliCalls(parser, command, shell, toolNames)` → `[{tool, operation, args}]`, per DD-12 (tree-sitter `command` node walk for Bash, tokenizer for PowerShell).
- [ ] Create `tool-monitoring/tool-calls-log.ts`: `parseToolCallsLog(lines)` → `{ calls, status }` per DD-6, tolerant of unknown fields and malformed lines; decodes `base64` text; clamps text to `CAPTURE_LIMIT_BYTES`.
- [ ] Create `tool-monitoring/wrapper-record-matching.ts`: `matchWrapperRecords(records, transcriptCliCalls)` → matched pairs, `indirect` records and transcript-only calls, with `cut` computed, per DD-12 matching rules.
- [ ] Create `tool-monitoring/tool-call-signals.ts`: `computeSignals(orderedToolUsesPerAgent, index)` → DD-10 `signals` per DD-12 signal rules. Like the other files of this chunk, it imports no DB or Nest code.

### Chunk 5 — Server builder, writer and rebuild drain
- [ ] Create `tool-monitoring/tool-usage-builder.ts`: `buildTreeToolUsage(nodes, toolCallsLog, monitored)` → rows per DD-8, with `aggregates` (DD-11), `calls` (DD-10, sorted by `ts`), `outputs` (DD-9) and the scalar columns.
- [ ] Create `tool-monitoring/tool-wrap-status.ts`: `writeToolWrapStatus(tx, repoRowId, parsedStatus, calls)`, last report wins by `reportedAt`, merging per-tool `lastWrapperAt` (max) per DD-20.
- [ ] Create `tool-monitoring/tool-usage-writer.ts`:
  - `markTreeStale(tx, sessionRowId)` (node + top ancestor via `topAncestorIdsSql`);
  - `rewriteTreeToolUsage(tx, rootId)` (load inputs and repository link per DD-8, delete-then-insert for every tree node, then `writeToolWrapStatus`).
- [ ] Create `tool-monitoring/tool-usage-rebuild.service.ts` per DD-7, using the DD-22 interval and batch: `SchedulerRegistry` interval, `FOR UPDATE SKIP LOCKED` claim, version set before read, per-tree transaction with error logging, and a `notify()` nudge.
- [ ] Register `ToolUsageRebuildService` in `server/src/logs/logs.module.ts` (DD-24). Document `TOOL_USAGE_REBUILD_INTERVAL_MS` and `TOOL_USAGE_REBUILD_BATCH` in `server/.env.example` next to `SESSION_COST_RECOMPUTE_INTERVAL_MS` (:66-71).
- [ ] In `logs.service.ts` `upsert()`:
  - before the non-artisyn early return (:488), call `markTreeStale` for `claude`, `claude-subagent` and `tool-calls`;
  - after the Step 5 link insert, call it when `linksInserted > 0`;
  - after commit, call `rebuildService.notify()`.
- [ ] In `logs.service.ts` `writeImportedLog` (:976) and `repositories.service.ts` `recomputeAllSessionStats` (:1282), call `markTreeStale` for each written or recomputed session.

### Chunk 6 — Server read and hook routes
- [ ] Create `tool-monitoring/tool-usage-read.sql.ts`:
  - `loadSummary(scope, range)`: aggregates plus `pendingSessions` only, never selecting `calls`/`outputs`;
  - `loadCalls(scope, filters, page)`: `jsonb_array_elements(calls)`, DD-18 filters and sort;
  - `loadCallDetail(usageId, callId)`.
- [ ] Add the summary tree assembly to `tool-usage-read.sql.ts`: group and tool totals summed from operations, and `neverCalled` = enabled configured CLI tools with no calls in range.
- [ ] Create `tool-monitoring/tool-monitoring.controller.ts` (`@Controller('api/v1/repositories')`) with routes `:repoId/tool-monitoring/config` GET/PUT, `summary`, `calls` and `calls/:usageId/:callId`, validating `teamId`/dates/paging and scoping per DD-17.
- [ ] In the detail route, call `assertSessionVisible` (`repositories.service.ts:474`) on the row's session; mask the owner email with `maskFirstPrompt`-style rules (`logs/team-scope.ts`) where the team scope requires it.
- [ ] Create `tool-monitoring/tool-monitoring-hook.controller.ts` (`@Controller('api/v2/tool-monitoring')`, `@Get('config')`, `ApiKeyAuthGuard`), returning DD-3 via `resolveMonitoredTools`, modelled on `post-turn-analysis.controller.ts:57-82`.
- [ ] Register both controllers in `server/src/logs/logs.module.ts` (DD-24), then run the server lint and typecheck.

### Chunk 7 — Hook config, names, refresh
- [ ] Create `hook/.claude/telemetry_tool/tool-wrap-names.js`: plain-JS copy of DD-4 (`TOOL_DENYLIST`, `validateToolName`, constants) plus the hook constants of DD-22, with a header comment naming `packages/tool-monitor` as the twin.
- [ ] In `env-context.js`, add `toolWrap` (boolean, default `true`) and `toolWrapConfigTimeoutMs` (number, default 2000) to `CONFIG_DEFAULTS` (:72-93) and `CONFIG_TYPES` (:95-116).
- [ ] Create `tool-wrap-config.js`:
  - `isToolWrapDisabled(config)` (`LOGHUB_TOOL_WRAP=0` / `toolWrap:false`);
  - `fetchToolWrapConfig(cwd, config, timeoutMs)` per DD-16 / DD-3 (non-200, timeout or a bad `schemaVersion` → `null`);
  - `readCache` / `writeCache` (atomic);
  - `effectiveTools(cfg)`, which drops denylisted or invalid names and returns `[]` when `paused`.
- [ ] Add `writeSessionMarkers(sessionDir, cfg, generatedTools)` to `tool-wrap-config.js`: it rewrites `off/<tool>`, `off/__all` (paused) and `mode/<tool>.meta` per DD-13 / DD-16.
- [ ] In `telemetry-hook.js` (UserPromptSubmit, near :101-129), add a throttled refresh via `claimThrottleSlot(cwd, 'tool-wrap-config.json', 60000)`: fetch, write cache, write markers. Wrap it in try/catch and fail open.

### Chunk 8 — Hook Bash wrapper and SessionStart
- [ ] Create `tool-wrap-tee.js` per DD-13:
  - byte forwarding, capture limit, keep draining after EPIPE until the limit;
  - `stream_end` record, swallowing every logging error;
  - `--self-test` prints `loghub-selftest-ok`;
  - calls `exitIfSelfCheck` (`hook-log.js:125`).
- [ ] Create `tool-wrap-shims.js` with `renderPosixShim(tool, opts)`, the Bash template per DD-13: pass-through conditions, PATH stripping, `LOGHUB_SHIM_ACTIVE`, stdin tee, `PIPESTATUS` exit, start/exit records, breaker files, and an `exec` to the real tool on any internal failure.
- [ ] Add `generateShimDir(sessionDir, tools)` to `tool-wrap-shims.js`: temp dir, then rename; one shim per tool resolvable on PATH; `__selftest` shim; `chmod 0755`.
- [ ] Add `runPreflight(shimDir)` to `tool-wrap-shims.js`: `bash`, `node` and `tee` resolve and the self-test passes. Also add `toGitBashPath(p)` and `appendEnvFileExport(envFile, shimDir)`, both per DD-15.
- [ ] Add `pruneOldSessionDirs(workDir)` (older than 7 days, DD-27 guards) and `recordBreakerFault(sessionDir, tool)` (global after 3) to `tool-wrap-shims.js`, per DD-15.
- [ ] In `lifecycle-hook.js` SessionStart (:157-169), call the DD-15 sequence inside its own try/catch, writing `preflight.json`; keep the existing `systemMessage` stdout (:200-207) unchanged, and write nothing extra to stdout.

### Chunk 9 — Hook PowerShell, upload, registration
- [ ] Create `tool-wrap-powershell.js` (PreToolUse entry) per DD-14:
  - read stdin JSON, cache and `preflight.json`;
  - mention regex;
  - build the `__lhWrap` prefix and emit `updatedInput`, else exit 0 silently;
  - fail open on any error;
  - call `exitIfSelfCheck`.
- [ ] Create `tool-wrap-records.js` with `assembleToolCallsUpload(workDir, sessionId)` per DD-5 / DD-6: read the call files, decode UTF-8 or base64, truncate `.in` to 100 KB, apply the 50 MB cap, add the `tool_wrap_status` line. It returns the file path, or null when there are no calls.
- [ ] In `send-logs-hook.js` `runUpload` (:899), add namespace `tool-calls`: assemble per session dir, then push to `filesToProcess` like `claude-otel` (:1078-1091), with a manifest key `tool-calls/<sessionId>` and size-based dedupe.
- [ ] In `session-files.js` (:204-244), include `tool-calls` in the SessionEnd / prompt flush set.
- [ ] In `scripts/build-hooks-installer.js`, add the six new files to `HOOK_JS_FILES` (:97). Add a `PreToolUse` entry (matcher `PowerShell`, command `tool-wrap-powershell.js`) to `HOOKS_JSON` (:306-346) and drop the "no PreToolUse" comment (:305).
- [ ] In `hook/INSTALL_HOOK.md` (:302-395), document the PreToolUse event and update the event count (:304).

### Chunk 10 — Hook release steps
- [ ] Run `npm run lint:fix` then `npm run lint` in `hook/`; fix the findings.
- [ ] Run the `update-install-instructions` skill for the new config keys and the PreToolUse event.
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.27.0` (MINOR).
- [ ] Run `npm run build:hooks-installer`, then refresh `.artisyn/marketplace/plugins/log-hub-hooks/` (scripts, `version.json`, `.claude-plugin/plugin.json`, `hooks/hooks.json` with the PreToolUse entry) per `.claude/rules/hook.md`.

### Chunk 11 — Client foundation
- [ ] Create `client/src/models/tool-monitoring.ts` mirroring the API changes response shapes and the DD-10 record.
- [ ] Create `client/src/viewer/pages/repository/tools/tools-constants.ts` with the client constants of DD-22 and the DD-21 localStorage keys.
- [ ] In `client/src/viewer/api.ts`, add `fetchToolMonitoringConfig`, `saveToolMonitoringConfig`, `fetchToolSummary`, `fetchToolCalls` and `fetchToolCallDetail`, all with an optional `teamId`, next to `fetchRepoOkfUsage` (:827).
- [ ] Add `tools` to `REPO_MAIN_TABS` (`tab-ids.ts:36-43`). Add a lazy tab and the label "Tools/MCP" in `RepositoryView.tsx` (:28-58, mount near :456). In `useRepositoryViewState.ts` `setMainTab` (:103-125), drop the DD-21 params.
- [ ] Create `pages/repository/tools/tools-url-state.ts` (read and write the DD-21 params; default range via `defaultDateRange`, `reports/report-url.ts:23`), modelled on `okf/okf-url-state.ts:19-57`.
- [ ] Create `pages/repository/tools/output-format.ts`:
  - `detectOutputFormat(text)` → `'json'|'pipe-table'|'fixed-width-table'|'tsv'|'plain'`;
  - `realignTable(text, format)` → `{ headers, rows }`;
  - `markAgentSeenLines(full, agentSaw)` → line indexes.
- [ ] Create `pages/repository/tools/ansi-render.tsx`: parse SGR codes 30–37 / 90–97 / 1 / 0 into spans with a light palette (no dark backgrounds), leaving other escape codes stripped.

### Chunk 12 — Client tab layout, tree, table
- [ ] Create `tools/RepoToolsTab.tsx`: react-query loads summary and calls (keys include `teamId` and the filters); three panes with two `useDraggableWidth` splitters and the tree-rail collapse, using the DD-21 storage keys and widths from Visual/UX notes.
- [ ] Create `tools/ToolsTopBar.tsx`: `DateRangePicker`, Status select, debounced (300 ms) search input, removable scope chip, and a "Monitored tools (N)" button. Layout like `okf/OkfFilterStrip.tsx`.
- [ ] Create `tools/ToolsTree.tsx`: All tools → MCP / CLI groups → tools → operations, with counts, bars, coloured error %, filter box, sort control, `never called` rows, and expansion state in component state, per Visual/UX notes and DD-25 sorting.
- [ ] Create `tools/ToolCallsTable.tsx`: listbox with Time, Tool · operation + channel badge, In, Out, Status + hints; ↑/↓ selection writing `tcall`; pager footer; pattern `pages/repository/session-log/bash-tab/BashCallList.tsx:50-100`.
- [ ] Add empty, loading and 403 states, plus the "processing" note, to `RepoToolsTab.tsx`, per Visual/UX notes.

### Chunk 13 — Client details, dialog, deep link
- [ ] Create `tools/ToolCallDetails.tsx`: header (badges, DD-25 meta line, "Open in session" link per DD-19), then Parameters (DD-25), Input (stdin, hidden when absent), Output, stderr and Signals sections with collapse beyond 400 px and a `CopyButton` per block.
- [ ] Create `tools/ToolOutputView.tsx`:
  - tabs Terminal | As the agent saw it | Raw;
  - Terminal uses `ansi-render` + `realignTable` + the agent-seen bar;
  - JSON output switches to `JsonTree`;
  - Copy copies the active view's text.
- [ ] Create `tools/JsonTree.tsx`: a collapsible JSON tree (objects and arrays expandable, first two levels open by default, monospace, light surface).
- [ ] Create `tools/MonitoredToolsDialog.tsx`: row editor per Visual/UX notes, inline `validateToolName` errors from `@loghub/tool-monitor`, the "Pause all wrapping" switch, save via `saveToolMonitoringConfig`, server 400 shown on the row, read-only when `!canEdit`.
- [ ] In `useRepositoryViewState.ts`, read and clear the `tu` param, and pass it through `SessionDetailPane.tsx` (:138-148).
- [ ] In `SessionLogView.tsx` (:88-106), resolve the turn containing tool_use id `tu` and set the existing target-turn state.
- [ ] Run the client lint and typecheck; visually check the tab with Playwright per the `use-playwright` skill.

### Chunk 14 — KB documentation
- [ ] Create `docs/knowledgebase/tool-monitoring.md`: channels, config levels and merge, transport, rebuild drain, tables, routes, wrapper safety, a backward-compatibility table like `okf-usage.md`. Add it to `docs/knowledgebase/index.md`.
- [ ] Update `hook-system-overview.md` (files table :24-49, ":27 no PreToolUse", namespace table :178-184) and `hook-installation.md` (config keys `toolWrap` / `toolWrapConfigTimeoutMs`, guardrail note :255-266).
- [ ] In `hook-api-versioning.md`, add a compatibility section for `GET /api/v2/tool-monitoring/config` and the `tool-calls` log kind, modelled on :486-527.
- [ ] Update `db-tables.md`: the three new tables, the two new columns, and migration history (:1400).
- [ ] Update `client-component-map.md` (new `tools/*` components) and `ui-principles.md` if a new pattern emerged, per the `ui-components` skill. Update `session-log-view.md` (the `tu` deep link; PowerShell does not read `CLAUDE_ENV_FILE`, :259-262).
- [ ] Fix `test/client-unit-tests.md:16` so it lists all client algorithm tests, including the new ones.

### Chunk 15 — Server algorithm docs and tests
- [ ] Write `docs/knowledgebase/algorithms/tool-monitor-name-validation.md` (DD-4; examples cover every denylist category, `.exe` suffix, case, length 64/65, path separators, metacharacters) and `server/src/logs/tool-monitoring/tool-monitor-name-validation.algo.spec.ts`.
- [ ] Write `algorithms/mcp-call-extraction.md` (DD-12 MCP rules; examples: ok, `is_error`, no result, image block, extra `__`, sidechain) and `mcp-call-extractor.algo.spec.ts`, using the `toEntries()` pattern of `okf/okf-access-extractor.algo.spec.ts:1-60`.
- [ ] Write `algorithms/cli-command-recognition.md` (Bash pipelines, `&&`, subshell, quoted args, `.exe`, PowerShell `;` / `|`, absolute path not matched, `(none)` op) and `cli-command-recognition.algo.spec.ts`.
- [ ] Write `algorithms/tool-wrapper-matching.md` (matched, two calls in one command, indirect inside a window, indirect without a window, transcript-only, `cut`) and `wrapper-record-matching.algo.spec.ts`.
- [ ] Write `algorithms/tool-usefulness-signals.md` (each signal, window of 3, other agent ignored) and `tool-call-signals.algo.spec.ts`.
- [ ] Register all new docs in `algorithms/README.md`. Fill the `reviewed` / `reviewer` front matter per its rules. Run the server `npm run test`.

### Chunk 16 — Client and hook algorithm docs and tests
- [ ] Add `hook/.claude/telemetry_tool/__tests__/tool-wrap-names.algo.test.js`, reading the `tool-monitor-name-validation.md` examples via `scripts/algo-docs/load-examples.cjs` (pattern `okf-snapshot.algo.test.js:19-20`).
- [ ] Write `algorithms/tool-output-format.md` (JSON, pipe table, fixed-width, TSV, plain, ANSI-coloured table, agent-seen lines) and `tools/output-format.algo.test.ts` (pattern `workflow-agent-rows.algo.test.ts:6-46`).
- [ ] Write `algorithms/tool-wrapper-fidelity.md` with the Test coverage plan fidelity and fail-open rows (`os` / `shell` fields per row) and register both new docs in `algorithms/README.md`.
- [ ] Write `hook/.claude/telemetry_tool/__tests__/tool-wrap-fidelity.algo.test.js`: generate a shim dir in a temp dir and run each row wrapped and unwrapped, comparing stdout / stderr bytes and exit code, and skipping rows for unavailable shells. Skip the whole file unless `LOGHUB_FIDELITY_TEST=1` (DD-26).
- [ ] Create `scripts/tool-wrap-check/create-check-project.mjs` generating `<repo>/../loghub-tool-wrap-check/` (fixture tools, `run-check.mjs`, `package.json`, `check.config.json`, `README.md`, marker) per DD-26, with the DD-27 refusal guards and no delete calls.
- [ ] Add the Linux container run to the generator output per DD-26: `linux/Dockerfile`, the `check:linux` script, `--linux` / `--image` handling in `run-check.mjs` (read-only `/hook` mount, `/work` mount, `--rm`, exit 2 without Docker).
- [ ] Add `check:linux-live` per DD-26:
  - `log-hub-dev:latest` image;
  - `docker-dev/claude-home` mounted read-write as `CLAUDE_CONFIG_DIR`;
  - generated `.claude/settings.json` hook commands;
  - seeded config cache;
  - result written to `runs/<timestamp>/live.json`.
- [ ] Run `npm test` in `hook/` and the client `bun run test`. Generate the verification project, run `npm run check` (Windows), both `check:linux` variants and `check:linux-live`, and record the results in `notes.md`.

### Chunk 17 — Contract tests
- [ ] Create `server/test/contract/registry/f24-tool-monitoring.ts` with rows for the six routes per Test coverage plan, using the `f16-post-turn.ts:38-80,390-450` (hook key) and `f21-reports.ts:333-440` (repo GET) patterns.
- [ ] Create `server/test/contract/f24.contract-spec.ts` and register family F24 in `registry/index.ts`.
- [ ] Add `session_tool_usage`, `repo_tool_monitor_config` and `team_repo_tool_monitor_config` to the delete-order lists in `fixtures/world-v1.sql.ts` (:1330, :1564).
- [ ] Run `npm run test:contract` from `server/` (final-run check, `app` group, not concurrent with build or e2e).

### Chunk 18 — Scenario and tour updates
- [ ] Create `tests/scenarios/helpers/tool-monitoring.ts`:
  - `buildToolCallsLog(calls)` (DD-6 lines);
  - `uploadToolCallsLog(...)`;
  - a transcript builder with MCP and Bash `tool_use`/`tool_result` pairs, reusing `helpers/okf.ts:166-294`;
  - `waitForToolUsage(...)`, which polls the summary API.
- [ ] Create `tests/scenarios/repos/s-repo-17.spec.ts` (`@S-REPO-17 @mode-a`) with the Test coverage plan steps, following the `s-repo-16.spec.ts:229-290` structure (`browserAs(…'?mtab=tools')`, `tab-repo-tools`).
- [ ] In `tests/scenarios/modes.ts`, add `TOOL_USAGE_REBUILD_INTERVAL_MS: '1000'` to the stand env next to `LOGS_MAX_BODY_MB` (:126).
- [ ] Update `tests/scenarios/hook/s-hook-09.spec.ts` (:13-14, :214, :218) to expect exactly one `PreToolUse` entry (matcher `PowerShell`).
- [ ] Add the Tools/MCP screen row to `tests/scenarios/tours/screen-registry.ts` (:587-597), and the tab to `tour-03-owner-repo.spec.ts:70`.
- [ ] Add S-REPO-17 to `docs/qaa-overview/scenarios/02-repos-sessions.md`, and the hook PreToolUse note to `04-ingest-hook-installer-platform.md`.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-REPO-17"` and fix failures.
