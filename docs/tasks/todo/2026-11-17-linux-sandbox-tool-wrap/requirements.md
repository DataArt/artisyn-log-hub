# 2026-11-17: Linux Sandbox Run of the Tool Wrapper on Claude Code 2.1.326 (GH-149 FR-4 Remainder)

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook
**Owner:** denis.tsyplakov
**Created:** 2026-11-17
**Tracker:** GH-150 https://github.com/DataArt/artisyn-log-hub/issues/150

## Description

Follow-up to 2026-11-17-cc-2-1-326-powershell-wrap (GH-149).

Linux sandbox run of the tool wrapper on Claude Code 2.1.326 (GH-149 FR-4 remainder). Question
(FR-4): with `sandbox.enabled: true` on Linux, does the Log Hub tool wrapper still work on Claude
Code 2.1.326 — do Bash shims (PATH from `$CLAUDE_ENV_FILE`, writes to the session's tool-wrap dir
under `.artisyn/ai_work_dir`, `node tool-wrap-tee.js`) run inside the sandbox, do `tool_call`
records land, and is there no breaker trip and no faults?

The Windows host run of 2026-11-17 is done: on Windows 2.1.326 the sandbox is not active (feature
gate off), the session runs unsandboxed, and records landed for a Bash shim call and a bypass
PowerShell call with no breaker and no faults.

The Linux run was not done because Claude Code in a container needs an interactive `/login` first,
which the automated run could not do.

Plan: run in the `loghub-tool-wrap-check` Linux image (or a Claude sandbox container) after an
interactive `/login`, with the sandbox enabled, a monitored tool (e.g. a fixture tool), `default`
mode + `--allowedTools Bash`; record the result in `docs/knowledgebase/tool-monitoring.md`
§Wrapper safety, "Sandbox" bullet; if the sandbox blocks the shim, file a fix.

## Functional Requirements

- FR-1: Run a real Claude Code 2.1.326 session on Linux with `sandbox.enabled: true` and the Log
  Hub hook installed, after an interactive `/login`, in `default` mode with `--allowedTools Bash`,
  calling a monitored tool through the Bash tool.
- FR-2: Check that the Bash shim runs inside the sandbox: PATH injection via `$CLAUDE_ENV_FILE`,
  writes to the session's tool-wrap dir under `.artisyn/ai_work_dir`, `node tool-wrap-tee.js`.
- FR-3: Check that the `tool_call` records land, with no breaker trip and no faults.
- FR-4: Record the outcome in `docs/knowledgebase/tool-monitoring.md` §Wrapper safety, "Sandbox"
  bullet.
- FR-5: If the sandbox blocks the shim, file a fix task.

## Acceptance Criteria

- [ ] A Linux 2.1.326 session with `sandbox.enabled: true` was run with a monitored tool called via
  Bash (FR-1).
- [ ] The shim's behaviour inside the sandbox (PATH, tool-wrap dir writes, tee) is recorded (FR-2).
- [ ] Records landing, breaker and `faults` state are recorded (FR-3).
- [ ] The "Sandbox" bullet in `tool-monitoring.md` states the Linux result (FR-4).
- [ ] If the shim was blocked, a fix task exists (FR-5).

## Notes

<!-- Append timestamped notes here as work progresses -->
