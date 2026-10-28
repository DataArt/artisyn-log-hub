# Notes — T-26 Tools/MCP tab

## 2026-10-28 — requirements history moved from requirements.md

**2026-10-28:** Requirements rewritten from "per-prompt MCP section" to a repository-level
Tools/MCP tab covering two channels (MCP from transcripts, CLI tools via a UI-configured wrapper).
Research and POC: [research-cli-tool-capture.md](research-cli-tool-capture.md); POC code in
[`docs/pocs/2026-10-28-1140-cli-tool-capture/`](../../../pocs/2026-10-28-1140-cli-tool-capture/README.md). Snapshot of a local install: 559 MCP calls, `playwright:browser_navigate`
fails in 41 % of calls (mostly 30 s timeouts).

**2026-10-28:** Config is two-level (personal / team); a session records the union of its owner's
personal list and the repository's team lists; display follows the existing visibility rules.
Storage: one jsonb row per session + tool, overwritten as a whole (FR-7) — not one row per call.

**2026-10-28:** Wireframe replaced by `wireframes/tools-mcp-tab.svg` (explorer layout: calls table
left, call details right; terminal-style output with table alignment, JSON pretty-print). Capture
limit fixed at 100 KB per call (no per-tool setting); stdin is captured when piped.

**2026-10-28:** Tools chip strip replaced by a tools tree (MCP / CLI → tool → operation) as the
first explorer pane — chips do not scale to 40+ tools. Panes are resizable with splitters; the tools
pane collapses to a rail. Wireframe regenerated.

**2026-10-28:** Added FR-8 (wrapper safety: hard denylist incl. shells / `node` / `git`, fail-open,
pre-flight self-test, circuit breaker, kill switches, no recursion, byte-level fidelity, overhead
budget) and visible Copy buttons for Output / stderr / Parameters / Input.

## 2026-10-28 — Chunk 16: wrapper fidelity verification (DD-26)

Verification project generated with `node scripts/tool-wrap-check/create-check-project.mjs`
(default `<repo>/../loghub-tool-wrap-check/`; refusal guards checked against the drive root, the
parent folder, the repo root, a path inside the repo, the home dir and a non-empty folder without
the marker — all exit 1 with nothing written). Nothing was deleted; the `runs/` folders stay for
the owner.

| Run | Result | Rows | `find` overhead (median of 5) |
|---|---|---|---|
| `npm run check` — Windows 11, Git Bash + PowerShell 5.1, node 24.22.1 | pass | 13 pass; FW-06 skipped (Linux only), FW-09 skipped (pwsh 7 not installed) | 39 → 193 ms (+154 ms) |
| `npm run check:linux` — `node:22-bookworm` (GNU tools), node 22.23.4 | pass | 13 pass; FW-08/FW-09 skipped (Windows only) | 4 → 124 ms (+120 ms) |
| `npm run check:linux -- --image node:22-alpine` (busybox) | pass | 13 pass; FW-08/FW-09 skipped | 13 → 258 ms (+245 ms) |
| `npm run check:linux-live` — `log-hub-dev:latest`, Claude Code 2.1.304 | pass | `zz \| head -1` recorded with `consumerClosed: true` (exit 141, 102400 bytes captured); `ls /nonexistent` recorded with exit 2 | — |

Findings and the changes they caused:

- **SIGINT fidelity (fixed in the hook).** The first Linux run failed FW-06: a wrapped tool killed
  by SIGINT made the shim exit *normally* with 130 (bash carries on because the last pipeline
  element, the node tee, ignores SIGINT), so job control printed `Exit 130` instead of `Interrupt`.
  The shim template (`tool-wrap-shims.js`) now writes the `exit` record and then kills itself with
  the same signal for exit codes 129/130/131/141/143. Rule 8 of
  `algorithms/tool-wrapper-fidelity.md`; dogfood copy and installer refreshed (hook version stays
  2.27.0, unreleased).
- **`find` and `grep` cannot be wrapped in Claude Code's Bash tool.** Claude Code 2.1.304 defines
  `find` and `grep` as shell functions in its Bash tool (its embedded `bfs` / `ugrep`); a shell
  function always wins over a PATH shim, so those calls are seen only through the transcript
  (`no wrapper` hint). The live check therefore requires `zz` and `ls` and reports `find` as
  informational. Worth a UI hint in the Monitored tools dialog later (not in this task's scope).
  **Owner decision 2026-10-29:** accepted as is — `find` / `grep` do not need wrapper capture;
  any other simple command (here `ls`) is a valid failing-tool acceptance check.
- **Test harness detail.** The wrapped Bash run puts the shim dir on PATH with the same
  `export PATH=…` line SessionStart writes to `CLAUDE_ENV_FILE`, inside the started shell: Git for
  Windows' `bash.exe` prepends `/usr/bin` at startup, which shadows a shim given through the
  process environment.
- **Deviations from DD-26.** (1) The Linux container mounts the whole repo read-only at `/repo`
  instead of only the hook at `/hook`, because the test loads its rows from
  `docs/knowledgebase/algorithms/` through `scripts/algo-docs/load-examples.cjs`; the live run still
  mounts the hook read-only at `/hook`. (2) The live session's hooks are registered with
  `claude --settings linux/live-settings.json` instead of a project `.claude/settings.json`, so a
  host session opened in the project never sees `/hook/...` commands. (3) The PowerShell fixture is
  `zzc.cmd` (not `zz.cmd`), so PowerShell never has to choose between the Bash script `zz` and a
  `.cmd` of the same name. (4) The fixture texts live in
  `hook/.claude/telemetry_tool/__tests__/tool-wrap-fixtures.js`, shared by the test and the
  generator; the other generated files are templates under `scripts/tool-wrap-check/template/`.
- macOS and PowerShell 7 were not covered on this machine (no Mac, no `pwsh`).
