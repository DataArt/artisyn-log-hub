# Tools/MCP POC (T-26)

Proof-of-concept code behind [../research-cli-tool-capture.md](../research-cli-tool-capture.md).
Not product code: it is not built, linted or tested by the repo. Run artefacts (logs, captured
outputs, `.codeexplorer` indexes) go to `out/` and friends and are gitignored here.

| Path | What it is |
|---|---|
| `shim/posix-shim.template.sh` | **The Bash wrapper** (Git Bash, Linux, macOS). One copy per tool with `__TOOL__` replaced; the shell runs the real tool, stdout goes through `tee-log.mjs`, stderr through `tee`. `shim/ce`, `shim/find`, `shim/zz` are generated copies |
| `shim/tee-log.mjs` | Logging tee for the Bash wrapper: `start` / `stream_end` records, keeps draining after the consumer closed the pipe |
| `shim/ps-prefix.template.ps1` | **The PowerShell wrapper**: `__lhWrap` function; prepend it plus `function <tool> { __lhWrap '<tool>' $args }` to a command |
| `shim/tool-shim.mjs`, `shim/*.cmd` | The first attempt (Node spawns the tool) — **rejected**, it changes tool behaviour; kept for reference |
| `sample/` | Small Java project to index with CodeExplorer (`ce init poc && ce scan .`) |
| `sample/claude-config/` | Claude Code hooks for a live test: `session-start.mjs` (PATH via `CLAUDE_ENV_FILE`), `pre-tool-use.mjs` (PowerShell `updatedInput`). Deliberately not named `.claude/` — run with `claude --settings claude-config/settings.json` from `sample/` |
| `wintest/`, `linuxtest/` | `zz` — an arbitrary "unknown" tool printing 20 000 lines (`zz fail` exits 3); `wintest/make-pstest.mjs` builds a PowerShell native-vs-wrapped comparison script |
| `extract.mjs` | Unified invocation log + usefulness signals from transcripts (`node extract.mjs <transcript.jsonl> --shim out/tool-calls.jsonl`) or from local prod (`--prod`, via `docker exec` into the DB container) |
| `wireframe/` | Generator of `../wireframes/tools-mcp-tab.svg` and a Playwright screenshot helper (run `shot.mjs` from the repo root so `playwright` resolves) |

Quick check of the Bash wrapper (Git Bash / Linux / macOS):

```sh
cd poc
export PATH="$(pwd)/shim:$(pwd)/linuxtest/bin:$PATH"   # wintest/bin on Windows
zz big | head -1          # agent sees 1 line …
cat out/tool-calls.jsonl  # … the log has the full 20 000-line output in out/out/<callId>.out
```

Paths in the scripts are relative to this folder; logs default to `out/` (override with
`TOOL_SHIM_DIR`).
