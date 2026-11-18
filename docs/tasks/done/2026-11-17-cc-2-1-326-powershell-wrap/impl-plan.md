# Implementation plan: PowerShell tool wrapper on Claude Code 2.1.326 + morning-check security fixes

## TL;DR

- **Hook `2.32.2` (PATCH):** `tool-wrap-powershell.js` rewrites a PowerShell command only when the
  PreToolUse input has `permission_mode === 'bypassPermissions'`. Any other mode, or no field, leaves
  the command exactly as typed, so the user's permission flow is untouched. Bash shims are not
  changed. The PoC showed that no wrapper form keeps allow-rule parity (DD-1).
- **Also in `tool-wrap-powershell.js`:**
  - `planPowerShellWrap` returns a new shape `{ updatedInput, tools, skipReason }`.
  - A call left unwrapped (permission mode, breaker, planning failure) is logged to `hook.log` once
    per session per reason, through the existing `claimSessionWarning`.
  - FR-7: native stderr text comes from `Exception.Message` instead of `ToString()`.
- **Server:** `resolveToolHint` also returns `hook_too_old` for a `win32` status whose `hookVersion`
  is below the new constant `POWERSHELL_WRAP_FIX_HOOK_VERSION = '2.32.2'`. No API shape change, no
  DB change; the tool-wrap config stays `schemaVersion` 1.
- **Client:** the `hook_too_old` hint text becomes "hook too old — update the hook". No other UI
  change.
- **Tests:**
  - 3 new fidelity rows: FW-12 and FW-13 (FR-7, new fixture `zze`), FW-14 (gate).
  - The fidelity harness gains `permissionMode` and `errCapture`.
  - S-REPO-17 gets step 8 (old-hook hint).
  - The F24 contract fixture's hook version is bumped so the existing hint rows keep their meaning.
- **Dev tooling:** the `loghub-tool-wrap-check` Linux image gains pwsh 7.4.6, so the pwsh row runs
  there.
- **Docs:**
  - `tool-monitoring.md`, `hook-api-versioning.md`, `hook-system-overview.md`, `INSTALL_HOOK.md`
    and `user-docs/tuning-your-setup.md` (with `build:help`) record the bypass-only wrap, the
    hint, and the FR-4/5/6 results.
  - `algorithms/tool-wrapper-fidelity.md` (new rows and keys) and
    `docs/qaa-overview/scenarios/02-repos-sessions.md` (step 8) follow the tests; a changelog
    entry closes the task.
  - A follow-up task holds the Linux sandbox run.
- **FR-8 security fixes** are already in the tree and only verified here: `@S-REPO-12`, the full
  final check set, `npm run perf`.
- **Verification** includes real `claude -p` runs of the fixed hook on 2.1.326 (all modes) and
  2.1.311, with the PoC's `real-hook-run.mjs`.

## Reference

- Requirements: [requirements.md](requirements.md) (decisions of 2026-11-17 already merged in).
- PoC: [docs/pocs/2026-11-17-1558-ps-wrap-static-form/](../../../pocs/2026-11-17-1558-ps-wrap-static-form/README.md).
- Research archive: `research/findings-1.md`.

## Design Decisions

**DD-1. Permission-mode gate (FR-1, owner decision 2026-11-17).**
- `planPowerShellWrap` wraps only when `input.permission_mode === 'bypassPermissions'`. The
  comparison is exact and case-sensitive.
- The gate is applied after the mentioned monitored tools are known, so a call that mentions none
  is not logged.
- Why: on Claude Code 2.1.326 **and** 2.1.311, any prefix statement makes an allow-rule command
  prompt or be denied. That includes a read-only `Get-Command … | Out-Null;` and `$x = 1;`. The
  2.1.326 PowerShell analyzer also returns "ask" for script blocks, .NET methods, non-CLM types,
  splatting, `$()` and env writes, and that "ask" beats a matching allow rule. A PATH-shim prefix
  is refused the same way.
- In bypass mode the PoC showed records landing and deny rules still applied: a wrapped
  `curl.exe` under `--disallowedTools "PowerShell(curl.exe:*)"` was denied.
- `permission_mode` is present in every PreToolUse input on 2.1.311 and 2.1.326. A missing field
  means "do not wrap", the safe fallback.
- Not wrapping in `default` mode under a tool-wide `PowerShell` allow is a deliberate loss. The
  hook cannot see CLI rules, so it cannot detect that case reliably.

**DD-2. New return shape of `planPowerShellWrap(input)`, the seam to the fidelity harness (chunk 5).**
- `null` when nothing is to be done and nothing is to be logged: not a PowerShell call, empty
  command, `MUST_STAY_FIRST`, kill switch, no session dir / preflight, `off/__all`, a cached config
  missing or empty, or no mentioned tool.
- Otherwise `{ updatedInput: object|null, tools: string[], skipReason: string|null }`:
  - wrapped: `updatedInput` = `{ ...tool_input, command: prefix + command }` and
    `skipReason: null`;
  - left unwrapped: `updatedInput: null` and `skipReason` set.
- `skipReason` values:
  - `permission-mode:<mode>`, where `<mode>` is the raw value, or `none` when the field is missing
    or not a string;
  - `breaker:__global` when `breaker/__global` exists and at least one tool is mentioned;
  - `breaker:<tool>` when every mentioned tool is skipped and the first of them by
    `breaker/<tool>`.
- `tools` = the mentioned tool names: the wrapped ones, or the would-be-wrapped ones when
  skipped.
- The order of checks inside the function: existing cheap checks → kill switch → session dir /
  preflight → `off/__all` → effective tools and mention matching (tools with an `off/<tool>` marker
  are dropped silently; tools with `breaker/<tool>` are dropped and remembered) → `breaker/__global`
  → permission gate (DD-1) → prefix.
  - The `breaker/__global` check moves after mention matching, so a skip is attributable. Its
    effect is unchanged: no wrap.

**DD-3. Once-per-session `hook.log` lines (FR-2).** In the entry point of `tool-wrap-powershell.js`:
- a plan with `skipReason` → `claimSessionWarning(sessionId, 'tool-wrap-ps:' + skipReason, cwd)`
  from `throttle-state.js` (l.205; existing helper, file `otel-session-warnings.json`, 24 h TTL;
  the key prefix keeps it apart from the OTEL keys); when it returns `true` →
  `hookLog(HOOK_FILE, sessionId, 'result', 'tool-wrap: PowerShell call of <tools> left unwrapped: <reason text>', cwd)`;
- reason texts:
  - `permission mode <mode> (PowerShell calls are wrapped only in bypassPermissions)`;
  - `breaker tripped for <tool>`;
  - `breaker tripped for all tools`;
- the catch branch (planning failure) logs its existing `error` line only when
  `claimSessionWarning(sessionId, 'tool-wrap-ps:error', cwd)` is `true`;
- the per-call `result` line "PowerShell call wraps …" stays as it is (it already exists on every
  wrapped call);
- without a `session_id` in the input, `claimSessionWarning` always returns `true`, so the line is written on every such call (accepted: Claude Code always sends `session_id`);
- a failure inside `__lhWrap` keeps writing `breaker/<tool>` + `faults` (unchanged). The next call
  of that tool is then logged once as `breaker:<tool>` through the path above. No PowerShell-side
  `hook.log` write.

**DD-4. FR-7 stderr text.**
- In `WRAP_FUNCTION` the text of an `ErrorRecord` `$__l` is
  `if ($__l.Exception -is [System.Management.Automation.RemoteException]) { $__l.Exception.Message } else { $__l.ToString() }`.
- It is used in two places: the `.err` builder (l.97, which also feeds `stderrBytes`) and the raw
  re-emit `[Console]::Error.WriteLine(...)` (l.114).
- The `Write-Error -ErrorRecord $__l` path (redirected stderr) is unchanged: the unwrapped command
  produces the same `ErrorRecord`.
- Verified on Windows PowerShell 5.1 and on pwsh 7.4.6: for an empty native stderr line
  `Exception.Message` is `""` while `ToString()` is the type name. `TargetObject` is not usable on
  pwsh.

**DD-5. Hook version and compatibility.**
- `version.json` `2.32.1` → `2.32.2` (PATCH: bug fix).
- No config field changes, so `schemaVersion` stays 1 and the previous-hook criterion does not
  apply.
- An older Claude Code without `permission_mode` gets no PowerShell wrap. Bash monitoring is
  unchanged.
- Old hooks on a new server: only a hint changes (DD-6).

**DD-6. Server hint for old Windows hooks (owner: "show update the hook and that is all").**
- Add `export const POWERSHELL_WRAP_FIX_HOOK_VERSION = '2.32.2';` to
  `server/src/logs/tool-monitoring/tool-usage.constants.ts`, with a doc comment naming GH-149.
- In `resolveToolHint`, after the `breaker` check and before the `no_data_yet` line, return
  `'hook_too_old'` when all of these hold:
  - `status.os === 'win32'`;
  - `typeof status.hookVersion === 'string'` and `parseVersion(status.hookVersion)` is non-null;
  - `compareVersions(status.hookVersion, POWERSHELL_WRAP_FIX_HOOK_VERSION) < 0`.
- Both helpers come from `server/src/common/semver.ts`.
- Resulting precedence (unchanged order): `preflight_failed` > `breaker` > `hook_too_old` (no
  status, **or** an outdated Windows hook) > `no_data_yet`.
- Windows only, because the PowerShell tool is on by default only there. A null or unparseable
  `hookVersion` gives no version hint.

**DD-7. Client hint text.** In `MonitoredToolsSettings.tsx` `hintText`, `case 'hook_too_old'`
returns `'hook too old — update the hook'`. No type change: the hint union stays
`'preflight_failed' | 'breaker' | 'hook_too_old' | 'no_data_yet'`.

**DD-8. Fidelity harness contract (chunk 5, algorithm doc `tool-wrapper-fidelity.md`).**
- New optional `input.permissionMode` for PowerShell rows (default `'bypassPermissions'`), passed
  as `permission_mode` to `planPowerShellWrap`.
- New optional `expected.wrapped` (boolean, default `true`):
  - `wrapped: false` → the harness asserts that the plan is `null` or has `updatedInput === null`,
    and the wrapped run uses the command unchanged;
  - otherwise → it asserts that `plan.updatedInput` is set (as today), so an unwrapped plan fails
    the row.
- `readCalls` also reads `<callId>.err` as `call.err`. The new expected key `errCapture` (string)
  is compared with `call.err` decoded as UTF-8; a missing file reads as `null`.

**DD-9. Fixture `zze` (FR-7), added to `FIXTURE_TOOLS` in `__tests__/tool-wrap-fixtures.js`.**
- `zze` (bash, executable, LF): `printf 'zze out\n'; printf '\nzze: after empty\n' >&2; exit 0`.
- `zze.cmd` (`windowsOnly`, CRLF): `@echo off` / `echo zze out` / `>&2 echo(` /
  `>&2 echo zze: after empty` / `exit /b 0`.
- Checked on the host: PowerShell 5.1 gets `zze out`, then an empty `RemoteException` record, then
  `zze: after empty`.

**DD-10. Fidelity rows (ids continue after FW-11).**
- **FW-12:**
  - input: `{os: "windows", shell: "powershell", tools: ["zze"], command: "zze"}`;
  - expected: `{exitCode: 0, records: 1, record: {tool: "zze", exitCode: 0, stderrBytes: 20}, errCapture: "\r\nzze: after empty\r\n"}`;
  - note: `.NET` `AppendLine` writes CRLF on Windows; 2 + 16 + 2 = 20 bytes.
- **FW-13:**
  - input: `{os: "linux", shell: "pwsh", tools: ["zze"], command: "zze"}`;
  - expected: `{exitCode: 0, records: 1, record: {tool: "zze", exitCode: 0, stderrBytes: 18}, errCapture: "\nzze: after empty\n"}`.
- **FW-14:**
  - input: `{os: "windows", shell: "powershell", tools: ["zzc"], command: "zzc one two; \"exit=$LASTEXITCODE\"", permissionMode: "default"}`;
  - expected: `{exitCode: 0, wrapped: false, records: 0}`;
  - note: DD-1, the gate leaves the command as typed.

**DD-11. Linux check image with pwsh.** `scripts/tool-wrap-check/template/linux/Dockerfile` installs
pwsh 7.4.6 from the pinned release tarball
`https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/powershell-7.4.6-linux-x64.tar.gz`
into `/opt/microsoft/powershell/7`, linked as `/usr/local/bin/pwsh`, and adds `pwsh -v` to the
existing tool check line. This makes FW-09-style pwsh rows runnable in `npm run check:linux`.

**DD-12. FR-4 / FR-5 / FR-6 outcomes go to docs only.**
- FR-4 (host run, 2026-11-17): on 2.1.326 Windows, `sandbox.enabled: true` prints "Sandbox
  disabled: … the Windows sandbox is not active on this session (feature gate off)" and runs
  unsandboxed. Records landed for a Bash shim call (`default` + `--allowedTools Bash`) and a
  bypass PowerShell call. No breaker, no faults.
- The Linux sandbox run needs an interactive login in a container and goes to a follow-up task.
- FR-5 (host run, 2026-11-17, scratch repo with the plugin installed as the installer does):
  - In a `git worktree add` worktree on 2.1.326, the plugin loaded from the main checkout's
    marketplace path. Every hook fired (SessionStart, UserPromptSubmit, PostToolUse,
    PostToolBatch, Stop, SessionEnd), writing to the main checkout's `.artisyn/ai_work_dir`.
    OTEL export reached a local OTLP sink, exactly as in the main checkout. The same held for
    Claude Code's own `--worktree`.
  - The plugin itself ships no settings and no OTEL env. The installer puts the OTEL keys in
    user-scope settings, which a worktree cannot skip; project / local OTEL keys have been ignored
    since 2.1.282.
  - No fix, no linked task, no `hook/README.md` change.
- FR-6: bare `curl` in PowerShell 5.1 resolves to the `Invoke-WebRequest` alias before any
  function, so it is never wrapped, the same as unwrapped. This is a known limit.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `hook/.claude/telemetry_tool/tool-wrap-powershell.js` | Gate, return shape, once-per-session logging, FR-7 | DD-1–DD-4; update the header comment (l.2-35) |
| `hook/.claude/telemetry_tool/version.json` | `2.32.2` | DD-5 |
| `hook/.claude/telemetry_tool/__tests__/tool-wrap-fixtures.js` | `zze`, `zze.cmd` | DD-9 |
| `hook/.claude/telemetry_tool/__tests__/tool-wrap-fidelity.algo.test.js` | `permissionMode`, `wrapped`, `.err` / `errCapture` | DD-8 |
| `docs/algorithm-examples/tool-wrapper-fidelity.json` | FW-12, FW-13, FW-14 | DD-10 |
| `docs/knowledgebase/algorithms/tool-wrapper-fidelity.md` | Rules / fixtures / edge cases / examples keys / rows count 18 / mutations | DD-8–DD-10 |
| `scripts/tool-wrap-check/template/linux/Dockerfile` | pwsh 7.4.6 | DD-11 |
| `.artisyn/marketplace/plugins/log-hub-hooks/scripts/tool-wrap-powershell.js`, `.../scripts/version.json` | Dogfooded install copy | `.claude/rules/hook.md` |
| `.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json` | `version` `2.32.2` | `.claude/rules/hook.md` |
| `hook/INSTALL_HOOK.md` | PowerShell entry: bypass-only note | via `update-install-instructions` skill |
| `server/src/logs/tool-monitoring/tool-usage.constants.ts` | `POWERSHELL_WRAP_FIX_HOOK_VERSION` | DD-6 |
| `server/src/logs/tool-monitoring/tool-monitor-config.service.ts` | `resolveToolHint` version rule (l.212-230) | DD-6; update its doc comment |
| `server/test/contract/fixtures/world-v1.sql.ts` | R1 status `hookVersion` `2.21.0` → `2.32.2` (l.2308) | keeps F24 hint rows meaning "current hook" |
| `server/test/contract/registry/f24-tool-monitoring.ts` | `R1_WRAP_STATUS.hookVersion` → `2.32.2` (l.72) | same |
| `client/src/viewer/pages/repository/tools/MonitoredToolsSettings.tsx` | Hint text (l.64-65) | DD-7 |
| `tests/scenarios/repos/s-repo-17.spec.ts` | Step 8: old Windows hook → `hook_too_old`, fixed → `null` | Test coverage plan |
| `docs/knowledgebase/tool-monitoring.md` | PowerShell §(l.112-118), Wrapper safety, hint rules (l.301-303), backward-compat table (l.348-357), FR-4 / FR-6 notes | DD-1, DD-6, DD-12 |
| `docs/knowledgebase/hook-api-versioning.md` | History row `2.32.2` (after `2.31.0`, ~l.795) | DD-5 |
| `user-docs/tuning-your-setup.md` | §Monitored Tools (l.53-60): PowerShell recorded only in bypass mode; bare `curl` limit | DD-1, DD-12 |
| `docs/knowledgebase/hook-system-overview.md` | FR-5 note next to the linked-worktree paragraph (l.149-152) | DD-12 |
| `client/public/help/*.md` | Regenerated by `npm run build:help` | from `user-docs/` |
| `docs/qaa-overview/scenarios/02-repos-sessions.md` | S-REPO-17 step list (l.345-358): add step 8 | Test coverage plan |
| `docs/tasks/todo/<new follow-up task>/requirements.md`, `docs/tasks/todo/index.md` | Follow-up task (Linux sandbox run), via `adlc-lh:scratch` (+ its GitHub issue mirror) | DD-12 |
| `docs/tasks/todo/2026-11-17-cc-2-1-326-powershell-wrap/notes.md`, `requirements.md` | Verification results; ticked acceptance criteria | final chunk |
| `docs/changelog/<YYYY-MM-DD-HHmm>-cc-2-1-326-powershell-wrap.md` | One-line changelog entry | `changelog` skill, final chunk |

## API changes

No route, request or response shape changes. `GET /api/v1/repos/:repoId/tools/config` (and its
team variant) can now answer `hint: 'hook_too_old'` for a Windows wrapper status older than
`2.32.2` (DD-6). The value already exists in the union (`tool-monitoring.types.ts:21`,
`client/src/models/tool-monitoring.ts:15-19`). The hook config route is unchanged, and so is
`schemaVersion` 1.

## Test coverage plan

Only the three allowed kinds:

- **Algorithm — `docs/knowledgebase/algorithms/tool-wrapper-fidelity.md`.**
  - Rows FW-12, FW-13 (FR-7) and FW-14 (DD-1 gate) go into `tool-wrapper-fidelity.json`, read by
    `tool-wrap-fidelity.algo.test.js`.
  - The harness extensions are in DD-8.
  - The rows are skipped in the fast set (`LOGHUB_FIDELITY_TEST` unset). They are run manually:
    - `npm run check` in `../loghub-tool-wrap-check` on the Windows host (FW-08, FW-12, FW-14;
      pwsh rows are skipped when pwsh is absent);
    - `npm run check:linux` (FW-13 with the DD-11 image).
- **API contract — `server/test/contract/registry/f24-tool-monitoring.ts`.** The changed config
  route keeps its rows. The fixture hook version is bumped to `2.32.2`, so `F24-config-personal` /
  `F24-config-team` still pin `null` / `no_data_yet` for a current hook. No new route.
- **Scenario — `@S-REPO-17`, new final step 8.** It re-uploads session `s1`'s `tool-calls` log
  with the same calls:
  - The call specs are rebuilt from the `tree` returned by step 3 (they use `startedAt` from
    `tree.steps[3|4].toolUseAt + 200 ms`), through a helper function hoisted out of step 3.
  - The server keeps one log per `(session_id, log_type)`, so a re-upload replaces it and the call
    rows are rebuilt, not duplicated.
  - The status merge keeps the newest `reportedAt` (`tool-wrap-status.ts`), so each re-upload uses
    a fresh `at: new Date()`, later than the previous one.
  - The two re-uploads:
    - with status `{hookVersion: '2.32.1', os: 'win32'}` → poll the owner's config until
      `wrapStatus.hookVersion === '2.32.1'`, then expect `tools[0].hint === 'hook_too_old'` and the Monitored Tools panel row `ce` shows `hook too old — update the hook` (DD-7);
    - then with `{hookVersion: '2.32.2', os: 'win32'}` → poll until `2.32.2`, then `hint` is
      `null`.
- **Behaviour on real Claude Code (FR-1 / FR-2, AC) is verified, not tested:** the PoC runner
  `real-hook-run.mjs` loads the hook source from `hook/.claude/telemetry_tool` directly and is
  re-run in the final chunk. Per the test policy this is not a new test.
- **FR-8:** `@S-REPO-12` step 7 already exists. It is only run, in the final chunk.

## Visual/UX notes

- Only the hint string changes (DD-7). The cell keeps its `title` attribute and layout.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Hook: PowerShell wrapper gate, logging, FR-7 | 6 | Defines the DD-2 shape used by chunk 5 |
| 2 | Hook release plumbing | 4 | After chunk 1 (copies its file) |
| 3 | Server: outdated-hook hint + contract fixture | 4 | Independent of the hook chunks |
| 4 | Client: hint text | 4 | Text for the DD-6 hint |
| 5 | Tests: fidelity harness, fixture, rows, check image | 6 | Needs the DD-2 shape (chunk 1) |
| 6 | Tests: scenario step | 4 | Asserts the chunk 3 rule (API) and the chunk 4 text (UI) |
| 7 | Docs | 8 | After chunks 1–6 |
| 8 | Verification | 8 | Last |

### Chunk 1 — Hook: PowerShell wrapper gate, logging, FR-7
- [ ] In `tool-wrap-powershell.js` `planPowerShellWrap`, reorder the checks and return the shape of DD-2. Collect mentioned tools, dropping `off/<tool>` silently and `breaker/<tool>` with memory. Then check `breaker/__global`. Then check the permission gate of DD-1.
- [ ] Apply the DD-4 stderr-text expression in `WRAP_FUNCTION` at the `.err` builder (l.97) and at the raw re-emit (l.114); leave `Write-Error -ErrorRecord` unchanged.
- [ ] In the entry point (l.225-253), require `claimSessionWarning` from `./throttle-state`. Output `hookSpecificOutput` only when `plan.updatedInput` is set. Log skips and the catch-branch error once per session, per DD-3.
- [ ] Keep the `module.exports` names (`planPowerShellWrap`, `buildPowerShellPrefix`, `renderToolFunction`, `psQuote`). Add a JSDoc `@returns` with the DD-2 shape.
- [ ] Rewrite the file header comment (l.2-35) to state: bypass-only wrapping (DD-1), the skip reasons and once-per-session logging (DD-3), and the FR-7 text rule (DD-4).
- [ ] Run `npm run lint:fix`, then `npm run lint` and `npm test`, in `hook/`.

### Chunk 2 — Hook release plumbing
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.32.2`.
- [ ] Run `npm run build:hooks-installer` from the repo root (in the background).
- [ ] Copy `tool-wrap-powershell.js` and `version.json` into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`; set `version` `2.32.2` in `.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json`.
- [ ] Run the `update-install-instructions` skill so `hook/INSTALL_HOOK.md` says the PowerShell `PreToolUse` entry wraps only in `bypassPermissions` (DD-1).

### Chunk 3 — Server: outdated-hook hint + contract fixture
- [ ] Add `POWERSHELL_WRAP_FIX_HOOK_VERSION = '2.32.2'` with a doc comment (GH-149) to `server/src/logs/tool-monitoring/tool-usage.constants.ts` (DD-6).
- [ ] In `tool-monitor-config.service.ts` `resolveToolHint` (l.212-230), add the DD-6 rule after the breaker check, importing `compareVersions` and `parseVersion` from `../../common/semver`. Update its doc comment.
- [ ] Set the R1 `tool_wrap_status.hookVersion` to `'2.32.2'` in `server/test/contract/fixtures/world-v1.sql.ts` (l.2308) and `R1_WRAP_STATUS.hookVersion` in `server/test/contract/registry/f24-tool-monitoring.ts` (l.72).
- [ ] Run `npm run lint`, `npm run typecheck` and `npm run test` in `server/`.

### Chunk 4 — Client: hint text
- [ ] Change `hintText` `case 'hook_too_old'` in `client/src/viewer/pages/repository/tools/MonitoredToolsSettings.tsx` (l.64-65) to return `'hook too old — update the hook'` (DD-7).
- [ ] Run `bun run lint` in `client/`.
- [ ] Run `bun run typecheck` in `client/`.
- [ ] Run `bun run test` in `client/`.

### Chunk 5 — Tests: fidelity harness, fixture, rows, check image
- [ ] Add `zze` and `zze.cmd` to `FIXTURE_TOOLS` in `hook/.claude/telemetry_tool/__tests__/tool-wrap-fixtures.js`, exactly per DD-9.
- [ ] In `tool-wrap-fidelity.algo.test.js` (PowerShell branch, l.153-165), pass `permission_mode: input.permissionMode || 'bypassPermissions'` to `planPowerShellWrap`. Handle `expected.wrapped` per DD-8.
- [ ] In `readCalls` (l.243-272), read `<callId>.err` into `call.err`. After the `stdin` check, assert `expected.errCapture` against `call.err` as UTF-8 (`null` when missing), per DD-8.
- [ ] Append rows FW-12, FW-13 and FW-14 to `docs/algorithm-examples/tool-wrapper-fidelity.json` exactly as DD-10, each with a `note` naming its rule.
- [ ] Update `docs/knowledgebase/algorithms/tool-wrapper-fidelity.md` per DD-8–DD-10: Rule 1 (PowerShell wraps only in bypass, `permissionMode`), Rule 3 keys (`errCapture`, `wrapped`), Fixture tools (`zze`), Edge cases, Examples keys, "Rows (18)", Mutations (`ToString()` → FW-12; gate removed → FW-14).
- [ ] Add the pwsh 7.4.6 install to `scripts/tool-wrap-check/template/linux/Dockerfile` per DD-11. Then run `npm test` in `hook/` and `npm run test:scripts` from the repo root.

### Chunk 6 — Tests: scenario step
- [ ] In `tests/scenarios/repos/s-repo-17.spec.ts`, move step 3's two wrapper call specs into a closure `wrapperCalls(tree: ToolSessionTree): WrapperCallSpec[]` inside the test body (it uses `run`, `sid`). Step 3 calls it with `uploaded`. Add `WrapperCallSpec` to the `../helpers/tool-monitoring` import.
- [ ] Add the final step `'8. GH-149: an outdated Windows hook gets the update hint'` exactly as the Test coverage plan "Scenario" item says (statuses, fresh `at`, `expect.poll` on `getConfig(owner)`). After `2.32.1`, open the Monitored Tools panel as step 1 does and expect the `ce` row text `hook too old — update the hook`.
- [ ] Add step 8 to the S-REPO-17 step list in `docs/qaa-overview/scenarios/02-repos-sessions.md` (l.345-358).
- [ ] Run `npm run typecheck:tests`, then `npm run test:scenarios -- --mode a --only scenarios --grep "@S-REPO-17"`, from the repo root.

### Chunk 7 — Docs
- [ ] `docs/knowledgebase/tool-monitoring.md` §"PowerShell (DD-14)" (l.112-118): wraps only in `bypassPermissions` (plan DD-1, PoC link) and the FR-7 text rule (plan DD-4). Next to the `find`/`grep` limit (l.105), add the bare-`curl` known limit (plan DD-12).
- [ ] `docs/knowledgebase/tool-monitoring.md` §Wrapper safety: add the permission-mode gate and the once-per-session skip lines (DD-3). Add a "Sandbox" bullet with the FR-4 host result (DD-12).
- [ ] `docs/knowledgebase/tool-monitoring.md`, hint rules (l.301-303): add the outdated-Windows-hook rule (DD-6). Backward-compatibility table (l.348-357): add "hook `2.27.0`–`2.32.1` on Windows → new server: `hook_too_old`" and "new hook, Claude Code without `permission_mode`: no PowerShell wrap".
- [ ] Add the `2.32.2` row to "Hook-side behaviour history" in `docs/knowledgebase/hook-api-versioning.md`. Change: PowerShell wrapped only in `bypassPermissions`; FR-7 stderr text. What an older hook does: outside bypass, PowerShell calls of monitored tools prompt or are denied.
- [ ] In `docs/knowledgebase/hook-system-overview.md`, next to the linked-worktree paragraph (l.149-152), add a one-line FR-5 result from DD-12 (2026-11-17, Claude Code 2.1.326).
- [ ] `user-docs/tuning-your-setup.md` §Monitored Tools: PowerShell calls are recorded only in bypass-permissions mode (Bash always). Bare `curl` in Windows PowerShell 5.1 is the built-in alias, so use `curl.exe`. Then run `npm run build:help`.
- [ ] Create the follow-up task "Linux sandbox run of the tool wrapper on Claude Code 2.1.326 (GH-149 FR-4 remainder)" via `adlc-lh:scratch`. Its body is the FR-4 question from DD-12 and the reason: a container needs an interactive `/login`.
- [ ] Run the `github-issues` skill for that new task folder (mirror to an issue).

### Chunk 8 — Verification
- [ ] Run `node scripts/tool-wrap-check/create-check-project.mjs`. It writes only its listed files into `../loghub-tool-wrap-check` and deletes nothing. Then, there, run `npm run check` and `npm run check:linux`. FW-12, FW-13 and FW-14 must pass, not be skipped. If the script refuses the folder, stop and ask the owner.
- [ ] From `docs/pocs/2026-11-17-1558-ps-wrap-static-form/`, run `real-hook-run.mjs` on 2.1.326 with `--allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)"`, once per mode: `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. Use `--name v-<mode>`. Expect the unwrapped outcome; records only in bypass.
- [ ] Run `real-hook-run.mjs --mode default --deny "PowerShell(curl.exe:*)" --name v-deny` and `real-hook-run.mjs --mode default --name v-norule`. Expect: both calls denied as unwrapped, no records, one "left unwrapped: permission mode default" `hook.log` line.
- [ ] Run `real-hook-run.mjs --ver 2.1.311 --mode bypassPermissions --name v-311`. Expect two calls with `start,stream_end,exit` and no `RemoteException` line in the `curl.exe` result.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-REPO-12"` (FR-8 step 7).
- [ ] Run `adlc-lh:check-health` with `finalRun: true`.
- [ ] Run `npm run perf` from `server/`. No metric may be worse by more than 20 % (`.claude/rules/server.md`).
- [ ] Append a dated "Verification" block with the results above to `notes.md`, tick the satisfied acceptance criteria in `requirements.md`, and write the changelog entry per the `changelog` skill.
