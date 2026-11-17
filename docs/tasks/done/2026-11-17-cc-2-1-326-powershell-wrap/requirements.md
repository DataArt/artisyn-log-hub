# 2026-11-17: Claude Code 2.1.326 Compatibility of the PowerShell Tool Wrapper and Morning-Check Security Fixes

**Status:** todo
**Priority:** high
**Type:** bug
**Module(s):** hook | server | client
**Owner:** denis.tsyplakov
**Created:** 2026-11-17
**Tracker:** GH-149 https://github.com/DataArt/artisyn-log-hub/issues/149

## Description

The morning check of 2026-11-17 (`docs/morning-check/daily/2026-11-17-1225.md`) found three
exposures of the hook to Claude Code 2.1.326 and several security advisories. Work happens on the
branch `fix/morning-check`.

**Main bug (reproduced on Claude Code 2.1.326, Windows, PowerShell 5.1).** Outside
`bypassPermissions` mode a PowerShell command rewritten by
`hook/.claude/telemetry_tool/tool-wrap-powershell.js` (PreToolUse `updatedInput` = prefix + command)
is refused with `Command name is a dynamic expression which cannot be statically validated`, while
the same command unwrapped runs under an allow rule (e.g. `PowerShell(curl.exe:*)`,
`PowerShell(hostname)`). The cause is `& $__real @__a` inside `__lhWrap`. In `claude -p` it is a
permission denial; in an interactive session presumably a permission prompt on every wrapped call
(not observed). In `bypassPermissions` mode the wrap works and call records land in
`<sessionDir>/calls/`. Defining functions named like the tools (`Set-Item function:<tool>`) was
**not** refused.

Impact: for a user with monitored CLI tools who does not run in bypass mode, every PowerShell call
of a monitored tool is denied or prompts, although the user allowed it.

**Also in scope**

- Two exposures of 2.1.326 that were not tested yet: wrapper call records with the sandbox on, and
  the plugin's hooks / OTEL env in a linked git worktree session.
- Two fidelity observations from the same run (bare `curl` alias; a `RemoteException` line in the
  wrapped output).
- The security fixes of the morning check, already implemented on the branch and uncommitted; only
  their verification is left.

**Fix direction for the main bug (owner decision, 2026-11-17, after the PoC).** No wrapper form
keeps the permission outcome: on 2.1.326 and 2.1.311 any prefix statement — even a read-only
`Get-Command … | Out-Null;` — makes an allow-rule command prompt or be denied, and a PATH-shim
prefix (`$env:PATH = …`) is refused the same way (PoC
`docs/pocs/2026-11-17-1558-ps-wrap-static-form/`). So the hook rewrites a PowerShell command only
when the PreToolUse input has `permission_mode` equal to `bypassPermissions`; in any other mode,
or when the field is missing, the command runs unchanged and no PowerShell call records are
written. Bash monitoring is not affected. There is no Claude Code version gate.

**Verification approach.** The checks that need another Claude Code version, a sandbox or a linked
worktree can be run in a container (owner, 2026-11-17: "you can check it in a container yourself")
— the agent is limited to read-only git commands in this repository.

## Functional Requirements

- FR-1. On Claude Code 2.1.326, for every PowerShell call of a monitored CLI tool the permission
  outcome of the wrapped command equals the outcome of the same command unwrapped: matched by an
  allow rule → runs without a prompt; matched by a deny rule → denied; matched by an ask rule or by
  no rule → the same prompt (interactive) or the same denial (`claude -p`). This holds in the
  permission modes `default`, `acceptEdits`, `plan`, `dontAsk` and `bypassPermissions`, on Windows
  PowerShell 5.1 and PowerShell 7.
- FR-2. A wrapped call still writes its records (`start`, `stream_end`, `exit`, and `.out` /
  `.err` / `.in` for capture `full`) to `<sessionDir>/calls/`. When the hook leaves a call
  unwrapped because of a failure it can detect (inside the hook process or inside `__lhWrap`), the
  call runs unchanged and the reason is written to the hook's own log once per session per reason.
- FR-3. Dropped (owner decision, 2026-11-17): whether the refusal is a regression against 2.1.314
  is not known and is deliberately not investigated, and no repro on an earlier Claude Code version
  is required for that purpose — the wrap worked before and every user ends up on the new version,
  so the fix targets the current version (2.1.326). The number is kept so the other FR numbers
  stay stable.
- FR-4. Verify on 2.1.326 that wrapper call records still land when the sandbox is on (a
  hook-rewritten command now stays sandboxed; a failure only trips the breaker). The run is in a
  Linux container with default sandbox settings: one Bash-tool call through a shim and, if the
  PowerShell tool is available there (`pwsh`), one wrapped PowerShell-tool call; otherwise the
  PowerShell part is recorded as not applicable. Records land → a KB note only. Records do not
  land → the call must still succeed and the breaker must trip (`breaker/<tool>` plus a `faults`
  line); a silent loss is a bug fixed in this task.
- FR-5. Verify on 2.1.326 that the log-hub-hooks hooks and the OTEL env still load in a session
  started in a linked git worktree ("Some worktree sessions skip some plugin settings"). If they
  do not: a fix inside the hook / plugin is done in this task; a cause the hook cannot fix goes to
  a separate linked task, and the limitation is stated in the shipped `hook/README.md`.
- FR-6. Bare `curl` in PowerShell 5.1 is not wrapped because the built-in alias
  (`Invoke-WebRequest`) wins over the defined function — the same behaviour as unwrapped, and the
  CLI tool is not called at all. It stays a known limit, stated in
  `docs/knowledgebase/tool-monitoring.md` and in the user docs.
- FR-7. Wrapped `curl.exe --version` output shows a `System.Management.Automation.RemoteException`
  line where the unwrapped output has an empty stderr line: with `2>&1` an empty native stderr
  line becomes an `ErrorRecord` whose `ToString()` returns the exception type name, and the wrapper
  uses it both for the re-emitted output and for the `.err` capture / `stderrBytes`. Fix both
  places so that the wrapped output and the stored capture match the unwrapped stderr.
- FR-8. Security fixes, already implemented on the branch: multer limits in
  `server/src/logs/import-zip-upload.interceptor.ts` (`files: 1`, `fields: 8`, `parts: 9` — a
  multipart body with more parts gets 400; same weakness class as GHSA-c8fr-c7pf-58pf);
  `@nestjs/common`, `core`, `platform-express`, `testing` at `^11.2.10` (GHSA-c8fr-c7pf-58pf,
  GHSA-jgpx-8x6j-fcpf); `vite` at `^7.3.8` (GHSA-p4f5-76q4-ffq7); step 7 in
  `tests/scenarios/repos/s-repo-12.spec.ts` (50 extra form fields → 400); a paragraph in
  `docs/knowledgebase/session-export-import.md`. Remaining: run that scenario and the final check
  set.

## Non-Functional Requirements

- The hook never returns a permission decision that bypasses the user's permission flow.
- Fail-open: any failure inside the hook process or inside `__lhWrap` leaves the call running
  unchanged. A refusal of the rewritten command by Claude Code is not recoverable by the hook, so
  the wrapper form must be one Claude Code never refuses.
- Backward compatibility: hooks already installed stay in use for a long time, and older Claude
  Code versions must keep working with the new hook; a server-side change must not break old hooks.
- Hook rules of `.claude/rules/hook.md`: version bump in `version.json`, `npm run
  build:hooks-installer`, refresh of the dogfooded install, `update-install-instructions`.
- Tests only of the three allowed kinds (algorithm rows, contract row, scenario step).

## Acceptance Criteria

- [x] FR-1: on Claude Code 2.1.326, `claude -p` with allow rules for `curl.exe` and `hostname`, in
      each of the modes `default`, `acceptEdits`, `plan`, `dontAsk` and `bypassPermissions`: the
      wrapped calls of the repro have the same outcome as the unwrapped ones (no `cannot be
      statically validated` refusal).
- [x] FR-1: with `--disallowedTools "PowerShell(curl.exe:*)"` the wrapped `curl.exe` call is
      denied, as the unwrapped one is.
- [x] FR-1: with no matching rule in `claude -p` the wrapped call is denied the same way as the
      unwrapped one.
- [ ] FR-1: the allow-rule repro in `default` mode passes on Windows PowerShell 5.1 and on
      PowerShell 7.
- [x] FR-2: in `bypassPermissions` each wrapped call of the repro leaves a `.jsonl` record with
      `start`, `stream_end` and `exit` in `<sessionDir>/calls/`; in the other modes the call is
      not rewritten and `hook.log` has one "left unwrapped: permission mode" line per session.
- [x] FR-4: the host sandbox run (Windows sandbox gated off on 2.1.326, records landed) is recorded
      in `docs/knowledgebase/tool-monitoring.md`, and a follow-up task holds the Linux sandbox run.
- [x] FR-5: a session in a linked worktree shows the plugin's hooks firing and the OTEL env set;
      otherwise it is fixed, or a linked task exists and `hook/README.md` states the limitation.
- [x] FR-6: the bare-`curl` limit is stated in `docs/knowledgebase/tool-monitoring.md` and in the
      user docs.
- [x] FR-7: a new row in `docs/algorithm-examples/tool-wrapper-fidelity.json`, with a fixture tool
      that writes an empty stderr line, passes on `powershell` and `pwsh`, and the stored `.err`
      capture holds the empty line.
- [ ] FR-8: the `@S-REPO-12` scenario passes with the new step 7, `adlc-lh:check-health` with
      `finalRun: true` is green, and `npm run perf` (from `server/`) shows no metric degraded by
      more than 20 %.
- [x] On Claude Code 2.1.314 (or the nearest earlier version available in a container) the new
      hook applies the wrap and the `start` / `stream_end` / `exit` records land.
- [x] If the fix adds or changes a field of the tool-wrap config served by the server, the
      previous hook release still fetches the config and wraps as before; `schemaVersion` stays 1.
      Not applicable when the config is not changed.

## Steps to Reproduce

1. Windows, Claude Code 2.1.326. A project whose PreToolUse hook (matcher `PowerShell`) answers
   with `updatedInput.command = buildPowerShellPrefix(...) + command` for the tools `curl`,
   `hostname`, `tar` (the stand-in hook described in `notes.md` does exactly that with the real
   function).
2. Run `claude -p` in `--permission-mode default` with
   `--allowedTools "PowerShell(curl.exe:*)" "PowerShell(hostname)" "PowerShell(tar:*)"` and ask it
   to run `curl.exe --version` and `hostname` through the PowerShell tool.
3. Repeat in a project without the hook.

**Expected:** both runs execute `curl.exe --version` and `hostname`.
**Actual:** with the hook every call is denied with `Command name is a dynamic expression which
cannot be statically validated`; without it they run.

## Open Questions

None open.

- Resolved (owner, 2026-11-17): hook releases already installed (2.32.1 and older) get no
  server-side mitigation; the server shows them the "update the hook" hint and that is all
  (`LOGHUB_TOOL_WRAP=0` / `toolWrap: false` stay the workaround).

## Common sense considerations

- Main-bug fix: wrap PowerShell only in `bypassPermissions` (per call, from the hook input's
  `permission_mode`); no wrapper form keeps permission parity outside it (PoC); no Claude Code
  version gate.
- Old hooks: the Monitored Tools hint `hook_too_old` also shows for a Windows hook older than the
  fixed release; no other server-side change.
- FR-1 is permission parity of wrapped and unwrapped commands for allow, deny, ask and no-rule
  cases, in `default`, `acceptEdits`, `plan`, `dontAsk` and `bypassPermissions`.
- FR-1 is checked with `claude -p`; an interactive session is not checked separately.
- Windows PowerShell 5.1 and PowerShell 7 are both in scope.
- Fail-open covers failures inside the hook process and inside `__lhWrap`; the only up-front skip
  is the permission-mode gate.
- The hook-log line for an unwrapped call is written once per session per reason (permission mode,
  breaker, planning failure).
- FR-4 was run on the Windows host instead of a Linux container (owner, 2026-11-17: a container
  needs an interactive login). On 2.1.326 the Windows sandbox is off behind a feature gate, so
  "sandbox on" ran unsandboxed and the records landed for a Bash shim call and a bypass PowerShell
  call; the Linux sandbox run stays open in a follow-up task.
- FR-5: a hook-side cause is fixed here, anything else goes to a linked task and into
  `hook/README.md`.
- FR-6: bare `curl` in PowerShell 5.1 is a documented known limit.
- FR-7: the `RemoteException` line is fixed and covered by a new fidelity row.
- The older-version check uses 2.1.314 or the nearest earlier version; "works" means the wrap is
  applied and the records land.
- The previous-hook criterion applies only when the served tool-wrap config changes.
- FR-8 final verification is the `finalRun: true` health check plus `npm run perf` from `server/`
  (`.claude/rules/server.md`, 20 % limit).

## Notes

<!-- Append timestamped notes here as work progresses -->

- Evidence trail (repro stand and run logs, FR-8 check state): `notes.md` in this folder.
- 2026-11-17 — PoC `docs/pocs/2026-11-17-1558-ps-wrap-static-form/`: no prefix form keeps
  allow-rule parity on 2.1.326 or 2.1.311 (any extra statement prompts or is denied); the wrap
  works, with deny rules respected, only in `bypassPermissions`. Host runs of FR-4 / FR-5 / FR-7:
  `research/host-verification.md`.
- 2026-11-17 — In the unwrapped `default`-mode run `tar --version | Select-Object -First 1` was
  itself refused by Claude Code ("Compound command extracts an archive followed by other
  commands"), so it is not a useful probe for FR-1; use `curl.exe` and `hostname`.
