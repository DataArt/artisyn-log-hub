---
type: "Architecture Guide"
title: "Tool Monitoring (Tools/MCP tab)"
description: "How Log Hub records MCP and CLI tool calls for the repository Tools/MCP tab: the two channels (MCP from transcripts, CLI from transcripts plus the hook's wrapper), the personal and team config levels and their merge, the tool-calls upload, the background rebuild drain, the session_tool_usage tables, the routes, wrapper safety (denylist, fail-open, pre-flight, breaker, kill switches) and backward compatibility."
tags:
  - tools
  - mcp
  - hook
  - reports
  - session-view
timestamp: "2026-10-29T00:00:00+04:00"
---

# Tool Monitoring (Tools/MCP tab)

The **Tools/MCP** main tab of a repository answers: which MCP servers and CLI tools did the agents
call, how often did a call fail or get killed, was the output useful (heuristic signals), and what
exactly went in and came out of each call. There is no LLM anywhere in it.

Task of origin: `docs/tasks/todo/2026-06-19-mcp-invocation-log-tab/` (requirements FR-1 … FR-8,
impl-plan with the DD-n design decisions quoted below, research and POC).

## Two channels

| Channel | Source | What is known |
|---|---|---|
| **MCP** (`mcp`) | The `claude` / `claude-subagent` transcripts only: every `tool_use` named `mcp__<server>__<rest>` and its `tool_result`. Always on, no config | `tool` = the server, `operation` = the rest (extra `__` kept); status, duration, input, the text the agent saw |
| **CLI** (`cli`) | The Bash / PowerShell `tool_use`s of the transcripts (what the agent ran and saw) **plus** the hook's wrapper records (the real exit code, the full stdout / stderr / stdin) for the CLI tools a user **configured** | `tool` = the command word, `operation` = the first argument that does not start with `-`, else `(none)` |

A CLI call without a wrapper record (old hook, wrapper off, a tool configured after the session)
still appears from the transcript, with the hint `no_wrapper`. A wrapper record no transcript
command matches (the tool was called from a script) is `indirect`. Rules:
[algorithms/mcp-call-extraction.md](algorithms/mcp-call-extraction.md),
[algorithms/cli-command-recognition.md](algorithms/cli-command-recognition.md),
[algorithms/tool-wrapper-matching.md](algorithms/tool-wrapper-matching.md),
[algorithms/tool-usefulness-signals.md](algorithms/tool-usefulness-signals.md).

## Configuration: monitored CLI tools

Only CLI tools need configuring (MCP is always recorded). The repository settings'
**Monitored Tools** tab (`stab=monitored-tools`, `tools/MonitoredToolsSettings.tsx`; the Tools/MCP
tab's "Monitored tools (N)" button opens it) edits one level, stored in its own table (DD-1) — not inside `RepoConfigJson`, because the settings PUTs
replace that whole blob and run the synchronous file-stats recompute:

| Level | Table | Edited by |
|---|---|---|
| personal | `repo_tool_monitor_config` (PK `repo_id` — a `repositories` row is already per user) | the repository row's owner, in the personal view (no `teamId`) |
| team | `team_repo_tool_monitor_config` (PK `team_repository_id`) | the team owner (`canEditTeamConfig`), in the team view; others see it read-only ("Managed by team owner") |

Both hold `{ paused, tools: [{ name, enabled, capture: 'full' | 'meta' }] }`, at most 100 tools,
names unique case-insensitively. The UI no longer offers `meta`: it saves every row with
`capture: 'full'`. The field stays in the API and the hook config for backward compatibility
(older hooks and older saved rows with `meta`).

**Merge (DD-2, `ToolMonitorConfigService.resolveMonitoredTools(userId, repoUrl)`).** What the hook
wraps for a user and what the rebuild recognises for a session owner: the owner's personal row
∪ every team row whose team links the normalised `repoUrl` and has the user as a member.

- union of the **enabled** tools by name (case-insensitive, first spelling wins);
- `capture` is `full` when any enabled level says `full`;
- `paused` when any level is paused (the hook then wraps nothing);
- denylisted or invalid names are always dropped.

**Name rules (DD-4)** live in the repo-local package `@loghub/tool-monitor`
(`packages/tool-monitor/`, used by the server and the client) and in its plain-JS hook twin
`tool-wrap-names.js` — change both together; one algorithm doc tests both,
[algorithms/tool-monitor-name-validation.md](algorithms/tool-monitor-name-validation.md).

- Name `^[A-Za-z0-9._-]{1,64}$`, not `.` or `..`.
- **Denylist** (case-insensitive, trailing `.exe` / `.cmd` / `.bat` / `.ps1` ignored): shells
  (`bash sh zsh dash fish ksh powershell pwsh cmd wsl`), tools the wrapper itself uses (`node tee env
  cygpath cat printf mkdir date command`), agent infrastructure (`claude git npx npm`), process control
  (`sudo su doas runas exec nohup timeout xargs time`) and builtins (`cd echo export source . set alias
  exit eval trap read test [ true false type which where`). The refusal names the role, e.g.
  "`powershell` is the agent's shell and cannot be monitored".
- `validateToolName(name)` → `{ ok: true }` or `{ ok: false, code: 'empty' | 'too_long' | 'bad_chars' | 'denylisted', message }`.
  The dialog checks as typed; the PUT answers `400 { message, field: 'tools[i].name', code }`.

Saving a level marks the level's scope sessions stale for every **newly added or newly enabled**
tool (`markScopeStale`), so history is re-extracted with the new tool (FR-7). A removed tool keeps
the rows of sessions that are not rebuilt again.

## Hook side: the CLI tool wrapper (hook `2.27.0`+)

Files (all in `hook/.claude/telemetry_tool/`, see [hook-system-overview.md](hook-system-overview.md)):
`tool-wrap-names.js`, `tool-wrap-config.js`, `tool-wrap-shims.js`, `tool-wrap-tee.js`,
`tool-wrap-powershell.js`, `tool-wrap-records.js`. Everything lives under
`<workDir>/tool-wrap/` (`.artisyn/ai_work_dir/tool-wrap/`).

**Config fetch (DD-16).** `GET /api/v2/tool-monitoring/config?repoUrl=…` (API key) → `{ schemaVersion: 1, paused, tools: [{ name, capture }] }`.
Synchronous at `SessionStart` (timeout `toolWrapConfigTimeoutMs`, default 2000), refreshed on
`UserPromptSubmit` at most once a minute (timeout capped at 1000 ms, `PROMPT_CONFIG_REFRESH_TIMEOUT_MS`,
so the prompt hook never holds Claude up on a hanging server). Each fetch rewrites `config-cache.json` atomically and the
running session's markers (`off/<tool>`, `off/__all`, `mode/<tool>.meta`). A non-200, a timeout or a
schema ≠ 1 is "no config": the cache is used, else nothing is wrapped. A tool added mid-session is
wrapped from the next session (no shim exists yet).

**Bash (DD-13).** At `SessionStart` `tool-wrap-shims.js` writes one Bash shim per monitored tool
that resolves on the PATH into `<sessionId>/shims/`, runs the pre-flight and appends
`export PATH="<shim dir>:$PATH"` to `$CLAUDE_ENV_FILE` (Git-Bash form `/c/…` on Windows), which
Claude Code sources before every Bash tool command. A shim runs
`LOGHUB_SHIM_ACTIVE=1 "$real" "$@" 2> >(tee …err >&2) | node tool-wrap-tee.js …`, takes the exit
code from `PIPESTATUS[0]` and exits with it — or, when the tool died of SIGHUP / SIGINT / SIGQUIT /
SIGPIPE / SIGTERM (129–143), kills itself with the same signal after writing the `exit` record, so
the parent sees the same signal death. Limitation: Claude Code's Bash tool defines `find` and
`grep` as shell functions (its embedded bfs / ugrep, seen in 2.1.304); a function always wins over
a PATH shim, so those two are only seen through the transcript (`no_wrapper`). `tool-wrap-tee.js` forwards stdout bytes unchanged,
captures the first 100 KB and, when the consumer closes the pipe (`| head -1`), keeps draining up to
the cap (`consumerClosed`) and then exits so the tool gets SIGPIPE as it would without the wrapper.
Piped stdin is teed to `.in`.

**PowerShell (DD-14).** The PowerShell tool does not read `$CLAUDE_ENV_FILE`, so it is wrapped by a
`PreToolUse` hook (matcher `PowerShell`, `tool-wrap-powershell.js`): when the command mentions a
monitored tool as a command word, it returns `updatedInput` with a prefix that defines `__lhWrap`
and one function per mentioned tool (only when the tool resolves as an application). The function
runs `& $real @args 2>&1`, writes the records and the UTF-8 text, re-emits stdout and stderr in order
and restores `$LASTEXITCODE`. It never returns a permission decision. Fidelity in PowerShell is
**text-level** (PowerShell decodes native output to strings in both paths), not byte-level.

**Per-call files (DD-5).** Each wrapped call writes only its own files under
`<sessionId>/calls/`: `<callId>.jsonl` (`start` → `stream_end` → `exit`) and `.out` / `.err` / `.in`
(capture `full` only; `meta` writes records only). `callId` = `<epochMs>-<pid>-<random4>`. No file
is appended by two processes, so there are no concurrent-append problems on Windows. A call with
no `exit` record was killed.

**Transport (DD-5, DD-6).** At upload time `tool-wrap-records.js` assembles one NDJSON file per
session, `upload/<sessionId>.jsonl`, uploaded by `send-logs-hook.js` (and the `SessionEnd` scoped
flush) as log kind **`tool-calls`** through the ordinary `POST /api/v2/logs`: one `tool_call` line per
call (text as UTF-8, or all streams base64 when one is not valid UTF-8; stdout / stderr / stdin cut
to 100 KB each, `truncated`) plus one `tool_wrap_status` line (hook version, OS, pre-flight, breaker).
The server keeps one log per `(session_id, log_type)`, so every upload re-sends the whole set; past
50 MB the oldest calls lose their text (`textDropped`). Line shapes and the wire contract:
[hook-api-versioning.md](hook-api-versioning.md).

### Wrapper safety (FR-8)

The wrapper sits between the agent and real tools, so it is built to never change what the agent
sees and to switch itself off rather than fail:

- **Denylist** (above) — shells, the wrapper's own helpers, `git` / `npx` / `npm` / `claude` and
  builtins can never be wrapped, which also rules out recursion through the wrapper.
- **No recursion** — a shim passes straight through (`exec` the real tool with the shim dir removed
  from PATH) when `LOGHUB_SHIM_ACTIVE` is set, when `CLAUDE_CODE_SESSION_ID` is unset, when `node`
  is missing, or when the resolved path is inside the shim dir (which also trips the breaker).
- **Fail open** — every logging step swallows its errors and keeps forwarding; a tool that does not
  resolve at `SessionStart` gets no shim, so the shell's own `command not found` / 127 is untouched;
  the PowerShell hook exits 0 with no output on any failure.
- **Pre-flight (DD-15)** — shims are generated into a temp dir and renamed, `chmod 0755`, `bash` /
  `node` / `tee` must resolve, and `__selftest --self-test` must print `loghub-selftest-ok` and exit 0.
  On failure nothing is injected, one `[warn]` goes to `hook.log`, and the result is kept in
  `preflight.json` and reported in `tool_wrap_status`. The PowerShell hook wraps only when the
  session's pre-flight reported `shells.powershell: true`.
- **Circuit breaker** — `breaker/<tool>` stops one tool, `breaker/__global` (after 3 faults in
  `breaker/faults`) stops all; shims check them like the `off/` markers.
- **Kill switches** — env `LOGHUB_TOOL_WRAP=0`, config key `toolWrap: false`
  ([hook-installation.md](hook-installation.md)), and "Pause all wrapping" in the UI.
- **Pruning** — session dirs older than 7 days are deleted at `SessionStart`: only directories
  directly under `tool-wrap/` whose name is a session id, via `lstat`, never following links, never
  `tool-wrap/` itself.
- **Fidelity check** — `__tests__/tool-wrap-fidelity.algo.test.js`
  ([algorithms/tool-wrapper-fidelity.md](algorithms/tool-wrapper-fidelity.md)) runs real shells
  wrapped and unwrapped; it is skipped unless `LOGHUB_FIDELITY_TEST=1` and is run manually from the
  verification project created by `scripts/tool-wrap-check/create-check-project.mjs` outside the repo.

## Server side

Module: `server/src/logs/tool-monitoring/` (providers and both controllers registered directly in
`logs.module.ts`, DD-24).

### Rebuild drain (DD-7, DD-8)

Ingest never extracts inline. It only marks the uploaded node and its top ancestor stale —
`sessions.tool_usage_version = NULL` (`tool-usage-writer.ts` `markTreeStale` / `markTreesStale`):

- ingest of `claude`, `claude-subagent` or `tool-calls` (`logs.service.ts` Step 3d);
- ingest of `artisyn` when it inserted a new `log_repositories` link (the owner's repository, and so
  the monitored tools, become known only then);
- import (`writeImportedLog`);
- `recompute-all-sessions` (`repositories.service.ts`);
- a newly added or enabled CLI tool (`markScopeStale`, the level's scope sessions).

`ToolUsageRebuildService` drains on an interval (`TOOL_USAGE_REBUILD_INTERVAL_MS`, default 15 000;
1000 on the scenario stand) and on a post-commit nudge from ingest (`notify()`). Each pass:

1. claims up to `TOOL_USAGE_REBUILD_BATCH` (default 20) non-deleted pending sessions with
   `FOR UPDATE SKIP LOCKED`, resolves their roots and sets `tool_usage_version =
   TOOL_USAGE_EXTRACTOR_VERSION` on every node of each tree **before** reading — an upload that
   commits mid-rebuild sets `NULL` again and the tree is re-run;
2. rebuilds each tree in its own transaction under a per-tree advisory lock
   (`rewriteTreeToolUsage`): reads every node's transcript, the tree's `tool-calls` body, the
   repository rows linked to the root's `artisyn` log and the owner's merged config; builds the rows
   (`tool-usage-builder.ts`); deletes the tree's rows and inserts the new ones; then merges the
   `tool_wrap_status` line into those repository rows (`tool-wrap-status.ts`, newest `reportedAt`
   wins, `lastWrapperAt` per tool = the max ever seen). A failing tree is logged and keeps its version,
   so a poison tree cannot loop.

Recognised CLI tools of a tree = the owner's enabled monitored names ∪ the tool names present in its
wrapper records. Without a linked repository yet, only the wrapper-record tools are recognised and no
status is written. The initial `NULL` on every session after migration `0076` is the one-off MCP
backfill; bumping `TOOL_USAGE_EXTRACTOR_VERSION` makes `initializeDatabase()` NULL every older version
on the next start. Safe across a cluster (`SKIP LOCKED` claim, per-tree lock).

### Tables

| Table / column | Content |
|---|---|
| `repo_tool_monitor_config` / `team_repo_tool_monitor_config` | The two config levels (above). Cascade with their `repositories` / `team_repositories` row |
| `session_tool_usage` | One row per tree node × `(channel, tool)`: `call_count`, `first_call_at`, `last_call_at`, `has_wrapper_data`, and three jsonb columns TOASTed separately — `aggregates` (per-operation totals, the only column the summary reads), `calls` (per-call metadata with a 300-char `inputPreview`, no text), `outputs` (captured text by `callId`, each part capped at 100 KB). A call belongs to the node whose transcript holds it; an `indirect` record to the root |
| `sessions.tool_usage_version` | Rebuild marker; `NULL` = pending (partial index `idx_sessions_tool_usage_pending`); the startup re-queue of older versions uses the partial index `idx_sessions_tool_usage_version` (migration `0077`) |
| `repositories.tool_wrap_status` | The hook's last wrapper status for that row plus `lastWrapperAt` per tool; `NULL` = never reported |

Column details and migration `0076_tool_monitoring.sql`: [db-tables.md](db-tables.md).

**Call record (DD-10)** in `calls`: `callId, channel, tool, operation, ts, durationMs, status`
(`ok` / `error` / `killed` / `no_result`), `hints` (`cut`, `empty`, `truncated`, `no_wrapper`,
`indirect`, `persisted`), `source` (`transcript` / `wrapper` / `both`), `shell, exitCode, inBytes,
outBytes, agentSawBytes, toolUseId, agentId, agentKind` (`root` / `subagent` / `workflow`),
`inputPreview, real, cwd, args, signals` (`empty`, `retried`, `fell_back`, `opened_file`).
`cut` = the consumer closed the pipe, or the agent saw fewer bytes than the wrapper captured.

### Routes

| Route | Auth / scope | Answer |
|---|---|---|
| `GET /api/v2/tool-monitoring/config?repoUrl=` | API key (`tool-monitoring-hook.controller.ts`); `repoUrl` normalised, missing → 400 | `{ schemaVersion: 1, paused, tools: [{ name, capture }] }` — the key user's merged list; unknown repo → empty list |
| `GET /api/v1/repositories/:repoId/tool-monitoring/config` (`teamId?`) | cookie session; `assertRepoAccess` | `{ level, canEdit, paused, tools: [{ name, enabled, capture, levels, lastWrapperAt, hint }], wrapStatus, denylist }` |
| `PUT …/tool-monitoring/config` (`teamId?`) | personal: the row's owner; team: the team owner, else 403 | the same view; 400 per invalid name; marks scope sessions stale for new tools |
| `GET …/tool-monitoring/summary` (`teamId?`, `from`, `to`, `sessionId?`) | Sessions-tab visibility | `{ range, pendingSessions, totals, groups: { mcp, cli }, tools: [… operations: […]], neverCalled }` |
| `GET …/tool-monitoring/calls` (`teamId?`, `from`, `to`, `sessionId?`, `channel?`, `tool?`, `operation?`, `status?`, `q?` ≤ 200, `page?`, `pageSize?` ≤ 200) | Sessions-tab visibility | `{ total, page, pageSize, items }`, sorted `ts DESC, callId DESC`; owner e-mail masked for a `team-no-prompts` caller |
| `GET …/tool-monitoring/calls/:usageId/:callId` (`teamId?`) | Sessions-tab visibility + `assertSessionVisible` (a 403 is answered as 404) | `{ call, output, link: { sessionId, toolUseId } }`; 404 when missing or not visible |

`teamId` must be a positive integer (else 400). Dates default to the last 30 days; a date-only `to`
covers the whole UTC day. No GET mutates anything. `sessionId` (a root session id, ≤ 256 chars)
narrows `summary` and `calls` to that one session tree — the session detail tab; with `sessionId`
and neither `from` nor `to` the range is the whole session.

- **Visibility (DD-17)** follows the **Sessions tab**, not the report rules: without `teamId` the
  caller's own sessions and the personal config level; with `teamId` the team access-mode row filter
  (`resolveTeamScope`) over every member's repository row for the URL, and the team level.
- **Filters (DD-18)**: date range and scope (channel / tool / operation) apply to the tree and the
  table; status and search apply to the table only, so the tree keeps its totals. Search is an
  `ILIKE` over `inputPreview`, args and the outputs of rows in range and scope.
- **Aggregates (DD-11)**: `error %` = (errors + killed) / calls, `retried %` = retried / calls.
- **Config hints (DD-20)**, precedence `preflight_failed` > `breaker` > `hook_too_old` >
  `no_data_yet`: `hook_too_old` when the visible owners' `tool_wrap_status` is `NULL`, `no_data_yet`
  when it has no `lastWrapperAt` for the tool.

Types: `server/src/logs/tool-monitoring/tool-monitoring.types.ts`, mirrored in
`client/src/models/tool-monitoring.ts`.

## Client: the Tools/MCP tab

`client/src/viewer/pages/repository/tools/` — `RepoToolsTab.tsx`, main tab `tools` ("Tools/MCP",
after Reports and before OKF, where `canSeeTeamWideTabs` allows). File-by-file:
[client-component-map.md](client-component-map.md).

- Top bar (date range, status, search, scope chip, "Monitored tools (N)" — opens the settings'
  Monitored Tools tab, dropping the `t*` params) over three resizable
  panes: the tools tree (All tools → MCP / CLI → tool → operation, sortable by calls / error % /
  retried % / last used, collapsible to a rail), the calls table (keyboard listbox, pager) and the
  call details (Parameters, Input, Output, stderr, Signals — each collapsible with a copy button).
- Output views: Terminal (ANSI colours on the light surface, an amber bar on the lines the agent
  received, table re-alignment, a JSON tree for JSON output), "As the agent saw it", Raw.
  Format detection: [algorithms/tool-output-format.md](algorithms/tool-output-format.md).
- Every filter, the scope, the page and the selected call are `t*` URL params (`tfrom`, `tto`,
  `tstatus`, `tq`, `tch`, `ttool`, `toper`, `tcall`, `tpage`), dropped when leaving the tab.
- While `pendingSessions > 0` a grey note says sessions are still being processed and the summary
  refetches every 10 s.
- "Open in session ↗" opens the Logs tab scrolled to the call's turn through the transient `tu`
  param (DD-19) — see "Deep links into the Logs tab" in [session-log-view.md](session-log-view.md).

### Session detail tab

The session detail pane has a "Tools/MCP" tab too (`tab=tools`, test id `tab-session-tools`, after
OKF): the same `RepoToolsTab` with `sessionId`, so the tree, the calls table and the details show
only that session tree's calls (root + sub-agents), for the whole session. It has no date range and
no Monitored tools button (the config is edited in the repository settings); its root carries
`data-testid="session-tools-tab"`. It shares the `t*` params (without `tfrom` / `tto`), which
`setSessionTab` and a session switch drop.

## Lifecycle

- **Delete**: `sessions.service.ts` `purgeSessionChildData` step c3 deletes `session_tool_usage`
  (a soft delete keeps the `sessions` row, so the cascade does not run); a hard delete cascades.
- **Export / import (DD-23)**: export carries only `claude` and `artisyn` logs, so `tool-calls` logs
  and both config tables stay out (like sub-agent logs and `repo_config`). After an import the trees
  are marked stale and the rebuild gives MCP rows and transcript-only CLI rows, using the target
  server's config of the owner.
- **Recompute**: `recompute-all-sessions` marks every tree of the repository stale.

## Backward compatibility

| Combination | Behaviour |
|---|---|
| Old hook (`< 2.27.0`) → new server | No wrapper, no `tool-calls` log, no config fetch. MCP calls and transcript-only CLI calls (`no_wrapper`) still appear; a configured tool shows `hook_too_old` |
| New hook → old server | The config route answers 404 → "no config" (cache if any, else nothing wrapped); a `tool-calls` upload is stored as an inert generic `logs` row |
| Old server upgraded later | Migration `0076` leaves every session pending, so the drain rebuilds all trees, including inert `tool-calls` rows stored before |
| Config answer with an unknown `schemaVersion` | Read as "no config" by the hook; the server adds fields without bumping the version |
| Older server build after a rollback | Ignores the new tables and columns (migration is additive only) |
| Old export zip → new server | Imports as before; the rebuild derives the rows |

Hook side: [hook-api-versioning.md](hook-api-versioning.md) (2.27.0) and the `toolWrap` /
`toolWrapConfigTimeoutMs` keys in [hook-installation.md](hook-installation.md).
