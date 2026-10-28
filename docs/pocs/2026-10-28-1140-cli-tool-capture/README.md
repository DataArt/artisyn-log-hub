# PoC: capturing CLI tool and MCP invocations (any tool, any OS)

**Task:** [2026-06-19-mcp-invocation-log-tab](../../tasks/todo/2026-06-19-mcp-invocation-log-tab/requirements.md)
(Tools/MCP tab). Full write-up: [research-cli-tool-capture.md](../../tasks/todo/2026-06-19-mcp-invocation-log-tab/research-cli-tool-capture.md).

## Question

1. Is a CLI tool's output (e.g. CodeExplorer `ce`) recoverable from what Log Hub already uploads?
2. Can the hook wrap **any** command-line tool, known only by name, so that every call is logged
   with full output, stdin and exit code — in the Bash tool (Git Bash, Linux, macOS) and in the
   PowerShell tool — without changing the tool's behaviour for the agent?
3. How do MCP calls look in the existing data (a local Log Hub install)?

## Layout

| Path | What it is |
|---|---|
| `shim/posix-shim.template.sh` | **The Bash wrapper**. One copy per tool with `__TOOL__` replaced; the shell runs the real tool, stdout goes through `tee-log.mjs`, stderr through `tee`. `shim/ce`, `shim/find`, `shim/zz` are generated copies |
| `shim/tee-log.mjs` | Logging tee for the Bash wrapper: `start` / `stream_end` records, keeps draining after the consumer closed the pipe |
| `shim/ps-prefix.template.ps1` | **The PowerShell wrapper**: `__lhWrap` function; prepend it plus `function <tool> { __lhWrap '<tool>' $args }` to a command |
| `shim/tool-shim.mjs`, `shim/*.cmd` | First attempt (Node spawns the tool) — **rejected**, it changes tool behaviour; kept for reference |
| `sample/` | Small Java project to index with CodeExplorer |
| `sample/claude-config/` | Claude Code hooks for a live test: `session-start.mjs` (PATH via `CLAUDE_ENV_FILE`), `pre-tool-use.mjs` (PowerShell `updatedInput`). Deliberately not `.claude/`, so opening the folder in Claude Code activates nothing |
| `wintest/`, `linuxtest/` | `zz` — an arbitrary "unknown" tool printing 20 000 lines (`zz fail` exits 3); `wintest/make-pstest.mjs` builds a PowerShell native-vs-wrapped comparison script |
| `extract.mjs` | Unified invocation log + usefulness signals from transcripts, or from a local Log Hub install (`--prod`) |
| `wireframe/` | Generator of the task's `wireframes/tools-mcp-tab.svg` and a Playwright screenshot helper |

Logs default to `out/` here (override with `TOOL_SHIM_DIR`); `out/` and other run artefacts are
gitignored.

## How to run (from this folder)

Bash wrapper, any POSIX shell environment (Git Bash on Windows, Linux, macOS):

```sh
export PATH="$(pwd)/shim:$(pwd)/wintest/bin:$PATH"   # linuxtest/bin on Linux/macOS
zz big | head -1                  # the agent side sees 1 line
zz fail >/dev/null; echo $?       # 3 — exit code preserved
find /nonexistent; echo $?        # identical to the unwrapped call
cat out/tool-calls.jsonl          # start / stream_end / exit records; out/out/<callId>.out has all 20 000 lines
```

Linux in Docker (from this folder, Git Bash on Windows shown):

```sh
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/shim:/shim" -v "$(pwd -W)/linuxtest:/t" -e TOOL_SHIM_DIR=/t/log \
  node:22-alpine sh -c 'apk add -q bash; export PATH=/shim:/t/bin:$PATH; bash -c "zz big | head -1; zz fail; echo \$?"; cat /t/log/tool-calls.jsonl'
```

PowerShell wrapper (Windows):

```sh
node wintest/make-pstest.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File wintest/pstest.ps1
```

Live Claude Code session (needs `ce` installed):

```sh
cd sample && git init -q && ce init poc && ce scan .
claude -p "Using ce via Bash and via PowerShell, find who calls findById" --settings claude-config/settings.json
node ../extract.mjs ~/.claude/projects/<encoded-sample-path>/<session>.jsonl --shim ../out/tool-calls.jsonl
```

MCP calls on a local Log Hub install: `node extract.mjs --prod` (reads the default `artisyn-log-hub-db` container of a docker-compose install).

## Result

1. **Yes, for direct calls.** The transcript's `toolUseResult.stdout` equals the tool's real output
   (4 of 4 `ce` calls in a live session; the difference is a trailing newline). It lacks the exit
   code, the full output when the agent piped it (`| head`), outputs persisted to a file, and calls
   made from scripts. Log Hub also cannot tell a monitored tool from any other command without
   being told its name.
2. **Yes — if the shell runs the real tool and the wrapper only observes.**
   - Bash: PATH injected via `CLAUDE_ENV_FILE` from `SessionStart` (live `claude -p`: `command -v ce`
     → the shim). PowerShell does not read that file; a `PreToolUse` `updatedInput` prefix with
     wrapper functions works (live `claude -p`), and the transcript keeps the original command.
   - Verified on Windows Git Bash, Linux (`node:22-alpine` + bash) and Windows PowerShell 5.1: exit
     codes 0/1/2/3 preserved, stderr reaches both the agent and the log, `| head -1` /
     `Select-Object -First 1` still logs all 20 000 lines, `find /nonexistent` byte-identical to the
     unwrapped call, `find` resolves to the same binary (GNU `find` in Git Bash, `system32\find.exe`
     in PowerShell). macOS not run (same bash path as Linux).
   - Rejected: Node spawning the tool — Git Bash converted `/nonexistent` to
     `C:/Program Files/Git/nonexistent` for the MSYS `find`, `.cmd` handling differed, a Node
     `DEP0190` warning leaked into stderr, and PowerShell `Select-Object -First` killed the wrapper
     before it logged.
3. 559 MCP calls in a local Log Hub install, 100 % with a joined result; `playwright:browser_navigate` fails in
   45 of 110 calls (31 × 30 s timeout, 11 × `file:` protocol blocked).
