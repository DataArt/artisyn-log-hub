# Notes: Claude Code 2.1.326 Compatibility of the PowerShell Tool Wrapper

Evidence trail for `requirements.md` in this folder. The contract lives there; this file only
records how the facts were obtained.

## 2026-11-17 — moved from requirements.md

### Repro stand and run logs

Developer machine, outside the repo:
`<session scratchpad>/cc326`

- `hook.cjs` — the stand-in PreToolUse hook: emits the real `buildPowerShellPrefix` output without
  the config / preflight gating.
- `run-def2-proj.jsonl` — `default` mode with the hook: refused.
- `run-def2-proj-nohook.jsonl` — `default` mode without the hook: allowed.
- `run-bypass.jsonl` — `bypassPermissions` mode with the hook: works.

The folder is session scratch and may be gone; the Steps to Reproduce in `requirements.md` rebuild
it.

### FR-8 check state

Fast checks green: server lint / typecheck / algorithm tests, client typecheck / algorithm tests,
tests typecheck, `npm run build`. The S-REPO-12 scenario and the final set were not run.

## 2026-11-17 — Verification (plan chunk 8, hook 2.32.2)

### Fidelity rows (`../loghub-tool-wrap-check`, refreshed by `create-check-project.mjs`)

- `npm run check` (Windows host, Git Bash + Windows PowerShell 5.1, no pwsh): exit 0, 15 pass,
  3 skipped (FW-06 and FW-13 are Linux rows, FW-09 needs pwsh). **FW-12 pass, FW-14 pass.**
  Wrapper overhead (FW-07 median): +126 ms.
- `npm run check:linux` (`node:22.23.5-bookworm` + pwsh 7.4.6 from DD-11): exit 0, 14 pass,
  4 skipped (Windows rows FW-08, FW-09, FW-12, FW-14). **FW-13 pass** (pwsh).

### Real `claude -p` runs (`docs/pocs/2026-11-17-1558-ps-wrap-static-form/real-hook-run.mjs`)

Claude Code 2.1.326, allow `PowerShell(curl.exe:*)` and `PowerShell(hostname)`:

| Run | Mode | `curl.exe --version` / `hostname` | Records | `hook.log` |
|---|---|---|---|---|
| v-default | default | both ran | 0 | one "left unwrapped: permission mode default" line |
| v-acceptEdits | acceptEdits | both ran | 0 | one "… permission mode acceptEdits" line |
| v-plan | plan | both ran | 0 | one "… permission mode plan" line |
| v-dontAsk | dontAsk | both ran | 0 | one "… permission mode dontAsk" line |
| v-bypassPermissions | bypassPermissions | both ran | 2 × `start,stream_end,exit` | "PowerShell call wraps curl" / "… hostname" |

Same outcome as the unwrapped baseline (`none-default` in the PoC README); no "cannot be
statically validated" refusal in any mode. Records only in bypass.

Claude Code 2.1.326, `default` mode:

- v-deny (`--disallowedTools "PowerShell(curl.exe:*)"`): `curl.exe` denied ("Permission to use
  PowerShell with command curl.exe --version has been denied"), `hostname` ran. 0 records, one
  "left unwrapped: permission mode default" line.
- v-norule (no rules): `curl.exe` denied ("This PowerShell command contains multiple operations.
  The following part requires approval: curl.exe --version"), `hostname` ran. 0 records, one
  "left unwrapped: permission mode default" line.
- In both, the call is passed unchanged, so the outcome is Claude Code's own for the typed command:
  `hostname` is auto-allowed as read-only, `curl.exe` is denied. The one skip line per session
  covers both calls (the second is deduplicated by `claimSessionWarning`).

Claude Code 2.1.311, `bypassPermissions`, no rules (v-311): both ran, 2 record files with
`start,stream_end,exit`; no `RemoteException` text anywhere in the transcript (FR-7), and the
`curl.exe` call has its `.err` capture.

Scratch projects and transcripts: `<os tmp>/lh-ps-wrap-poc/real-v-*` and `runs/real-v-*.jsonl`.

### Acceptance criteria left open

- FR-1 "default-mode repro on Windows PowerShell 5.1 **and PowerShell 7**": only 5.1 was run with
  real Claude Code; pwsh is not installed on the host. The gate does not depend on the shell
  (it reads `permission_mode` only), and FW-13 shows the wrap itself on pwsh 7.4.6.
- FR-8: final check set and the perf question below.

### FR-8

- `npm run test:scenarios -- --mode a --only scenarios --grep "@S-REPO-12"`: exit 0, 1 passed.
- `adlc-lh:check-health` with `finalRun: true`: run by the implement-deep orchestrator after this
  chunk (final verification), not by the chunk agent.
- `npm run perf` (from `server/`, dev DB `a-log`, dev server started for the run): exit 0, 48
  scenarios, 0 errors, every latency budget passed. Against the previous baseline
  (`tmp/perftests/results_2026-11-10_14-45-47.json`) 41 scenarios have a mean more than 20 % worse,
  including `health` (1.7 → 4.2 ms), which touches no DB and no changed code. The host was at
  85 % CPU from an unrelated long-running process during the run and the dev Postgres had just been
  started cold; the only server change of this task (`resolveToolHint`) is not on any measured
  route. **Open: the owner decides whether to re-run perf on an idle host** (`.claude/rules/server.md`
  says to stop and ask on a >20 % degradation).
