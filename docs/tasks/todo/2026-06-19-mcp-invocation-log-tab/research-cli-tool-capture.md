# Research: monitoring arbitrary CLI tools (not only MCP)

**Date:** 2026-10-28
**Question:** the task covers MCP calls. The same "single pane of glass" is wanted for CLI tools the
agent runs through Bash/PowerShell — e.g. CodeExplorer `ce`, but in general **any command-line tool,
including ones that do not exist yet and whose authors will never cooperate with Log Hub**. How do we
capture what such a tool returned and whether it was useful?

**Decided direction (maintainer):** tools are added to monitoring by hand, starting in the UI: for a
repository the user says "monitor `ce`", the hook wraps it automatically, results show on a
**Tool Monitoring** tab; the user tunes or switches it off and the hook follows. Windows, Linux and
macOS must all work.

POC code: [`docs/pocs/2026-10-28-1140-cli-tool-capture/`](../../../pocs/2026-10-28-1140-cli-tool-capture/README.md): `shim/posix-shim.template.sh` + `shim/tee-log.mjs`
(Bash), `shim/ps-prefix.template.ps1` (PowerShell), `extract.mjs`, `envtest/.claude/session-start.mjs`,
`envtest/.claude/pre-tool-use.mjs`, `wintest/make-pstest.mjs`. `shim/tool-shim.mjs` is the first,
superseded attempt (see "Rejected" below).

## Finding 1 — the transcript already has what the agent saw

Claude Code writes every Bash/PowerShell result into the transcript, which Log Hub uploads as-is:
`tool_use` (`input.command`) and `tool_result` + `toolUseResult` (`stdout`, `stderr`, `interrupted`,
`persistedOutputPath` for large outputs). Verified with a live `claude -p` session using `ce`: the
transcript's `stdout` equals the real tool output when the agent did not pipe it.

But Log Hub cannot tell that `ce callers x` is "a tool" and `npm run build` is not — it needs to be
told which tools to monitor. And the transcript lacks: exit code, the full output when the agent
piped it (`| head`, `Select-Object -First`), outputs persisted to a file, calls made from scripts.

## Finding 2 — a generic wrapper works for any tool, on every OS and in both shell tools

**Principle: the shell itself runs the real tool, exactly as it would without the wrapper; the
wrapper only observes.** The wrapper knows nothing about the tool but its name.

| Agent shell | How the wrapper gets in front | Wrapper |
|---|---|---|
| Bash tool (Windows Git Bash, Linux, macOS) | `SessionStart` hook appends `export PATH="<shim-dir>:$PATH"` to `$CLAUDE_ENV_FILE`; Claude Code sources it before every Bash command (on Windows the dir in Git-Bash form, `/d/...`) | bash script per tool (`posix-shim.template.sh`): resolves the real tool with `command -v` on PATH minus the shim dir, runs it itself; stdout piped through `tee-log.mjs`, stderr through `tee`; exit code from `PIPESTATUS` |
| PowerShell tool | does **not** read `CLAUDE_ENV_FILE` (verified). `PreToolUse` hook (matcher `PowerShell`) returns `updatedInput` with wrapper functions prepended — only when the command mentions a monitored tool | PowerShell function per tool calling a shared `__lhWrap`: `Get-Command -CommandType Application` (skips the function itself), `& $real @args 2>&1`, buffers everything, writes the log, then emits stdout to the pipeline and stderr to the error stream, restores `$LASTEXITCODE`. No Node involved |

Log format (both shells): `tool-calls.jsonl` with a `start` record (callId, tool, args exactly as typed,
resolved `real` path, cwd, `session_id` from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets in the
shell), a `stream_end` record (bytes, `consumer_closed`, duration) and an `exit` record (exit code);
the output itself in `out/<callId>.out` / `.err`. The start record is written before the tool runs,
so a killed call still leaves a trace.

**Full output even when the agent cut it — by design.** The purpose is debugging the tool, not
replaying what the agent saw. Bash: when the consumer closes the pipe (`| head`), `tee-log.mjs` stops
forwarding but keeps draining the tool to the end (stops it only past the 100 KB capture limit). PowerShell: the
function buffers the whole run before emitting, so `Select-Object -First` cannot cut it.

### Verified matrix

| Check | Windows Git Bash | Linux (`node:22-alpine` + bash) | Windows PowerShell 5.1 | macOS |
|---|---|---|---|---|
| Arbitrary unknown tool (`zz`, a 20 000-line script) wrapped by name only | yes | yes | yes | not run (same bash path as Linux) |
| Exit codes preserved (0 / 1 / 2 / 3) | yes | yes | yes | — |
| stderr reaches the agent and the log | yes | yes | yes | — |
| `\| head -1` / `\| Select-Object -First 1`: full output logged (20 000 lines) | yes | yes | yes | — |
| `find /nonexistent` byte-identical to the unwrapped call | yes | yes | — | — |
| `find` resolves to the same binary as unwrapped | GNU `find` (`Git\usr\bin`) | busybox `find` | `C:\WINDOWS\system32\find.exe` | — |
| Live `claude -p` session: PATH injection / function injection actually used by the agent | yes | — | yes | — |
| Transcript keeps the **original** command after the PowerShell `updatedInput` rewrite | — | — | yes | — |

Known behaviour differences (both deliberate, both only when the agent cuts the output):
- Bash `| head`: the tool runs to completion instead of dying on SIGPIPE — slower for huge outputs
  (bounded by the 100 KB capture limit).
- PowerShell `| Select-Object -First N`: unwrapped the tool is killed and `$LASTEXITCODE` is `-1`;
  wrapped it completes and reports its real exit code. Output is delivered at the end, not streamed.

### `find` as the test tool — what it shows

- The same name is a **different tool per shell**: GNU `find` in Git Bash, Windows `find.exe` (text
  search) in Claude's PowerShell tool. The log keeps the resolved `real` path so the UI can tell them apart.
- `find` is called constantly, including from `xargs`/`$(…)` — a good load test for the overhead.
- Errors pass through unchanged, e.g. PowerShell → `find.exe` `FIND: Parameter format not correct`,
  exit 2, wrapped and unwrapped alike.

### Rejected: a Node wrapper that spawns the real tool

The first POC (`shim/tool-shim.mjs`) had Node resolve and spawn the tool. It **changed behaviour**:
under Git Bash, POSIX paths in arguments were converted for Node (a native Windows program) and
reached MSYS tools converted (`find /nonexistent` → `find "C:/Program Files/Git/nonexistent"`);
`zz.cmd` became callable as `zz` although plain Git Bash cannot run it; `shell: true` for `.cmd`
made Node print a `DEP0190` warning into the tool's stderr; PowerShell `Select-Object -First` killed
the wrapper before it logged. Hence the principle above.

Not covered by any PATH/function wrapper: calls by absolute path (`C:\…\ce.exe`, `./bin/ce`), `npx x`,
shell builtins/aliases, and shells outside Claude Code's tools. These still appear in the transcript
(Finding 1) if the name matches.

## Proposed design

```
UI (repo → Tool Monitoring → Settings)        server                         hook (client machine)
  add "ce", enabled, capture: full|meta,  →  repo_tool_monitors table  →  SessionStart: GET config (1-2 s
  (100 KB cap per call)                       GET /api/v1/hook/tool-        timeout, cached on disk) →
                                              monitors?repo=<git remote>    generate shim dir → CLAUDE_ENV_FILE
                                                                            PreToolUse(PowerShell): prepend fns
                                                                            shim → tool-calls.jsonl + out/*.out
  Tool Monitoring tab  ←  tool_invocations  ←  upload with the session logs (new artisyn log kind)
```

1. **Config in the UI, per repository.** A monitored tool = `name`, `enabled`, capture mode
   (`full` output / `meta` only: args, exit code, sizes, duration); capture capped at 100 KB per call.
   Stored on the server — personal and team levels, see requirements FR-2.
2. **Hook pulls config** at `SessionStart` (all sources: startup/resume/clear/compact) with the
   existing API key, short timeout; the last good response is cached in the telemetry dir so offline
   sessions keep working. Faster toggle: `UserPromptSubmit` refreshes the cache (throttled), and
   the shim reads the cache on every call — a tool switched off in the UI stops being logged from
   the next prompt (the shim becomes a pure pass-through; the PATH entry stays until the session ends).
3. **Hook generates the shim dir** (`.artisyn/ai_work_dir/tool-shims/`): per tool a bash script from
   the template, plus the shared `tee-log.mjs` shipped with the hook; for PowerShell the function
   prefix is built per call by the PreToolUse hook from the same config.
4. **Upload** `tool-calls.jsonl` + `out/*.out` with the session's other artisyn files; the server
   stores one row per invocation and joins it to the transcript's `tool_use` (session + tool + args +
   time) to get "what the agent saw" and follow-up signals (retry, fallback to grep, opened a file
   from the output, empty result).
5. **Transcript-only fallback.** The server also recognises configured tool names in Bash/PowerShell
   commands of the transcript, so the tab shows data for older hooks, for history before the tool was
   added, and for calls the wrapper missed — just without exit code / full output.

### Backward compatibility

- Old hook + new server: the hook never asks for config → no wrapping; the tab still works from the
  transcript fallback.
- New hook + old server: config endpoint 404 → no wrapping, nothing else changes; the new artisyn log
  kind is not uploaded when nothing was recorded.
- Wrapper failure must never break the tool: all logging is best-effort; if the real binary is not
  found the shim reports it like a missing command (exit 127).

### Open points

- Per-call overhead: Bash — one extra Node start (the stdout tee) per monitored call; PowerShell — none
  (pure PowerShell). To be measured on a high-frequency tool such as `find`.
- PreToolUse `updatedInput` may interact with other PreToolUse hooks that also rewrite input.
- `full` capture uploads tool output verbatim — consistent with the full-capture policy in
  `docs/knowledgebase/product-purpose-and-data-capture.md`; size bounded by the fixed 100 KB per-call cap.
- Detection regex for "command mentions tool X" (PowerShell path and transcript fallback) has edge
  cases: tool name inside a quoted argument, `& 'x'`, `x.exe`.

## "Is it useful?" — signals POC'd (`extract.mjs`)

Per invocation, from the next 3 tool calls: `emptyResult`, `retriedSameTool`, `fellBackToSearch`,
`openedFileFromOutput`; plus error rate, median duration, output size per `tool:subcommand`. A
stronger, on-demand version is an LLM judge over (input, output, next steps).

## Local prod snapshot (2026-10-28) — MCP part

559 MCP calls, 100 % have a joined result. `playwright:browser_navigate` 45 / 110 errors (31 ×
30 s timeout, 11 × `file:` protocol blocked); `browser_run_code_unsafe` 30 / 92 errors, 61 % retried;
`postgres:query` 4 / 35 errors. No `ce` calls yet.

## Impact on this task

The per-turn "MCP invocations" section becomes "tool invocations" (`source: mcp | bash | powershell`),
plus a repo-level **Tool Monitoring** tab: settings (monitored tools) + per-`tool:subcommand` stats +
drill-down to individual calls. MCP needs no configuration; CLI tools come from the UI list.
