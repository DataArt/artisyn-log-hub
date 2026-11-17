# Research findings 1 — 2026-11-17

Audit archive of the plan-deep research subagent report (verbatim). Nothing downstream reads it.

I found everything the plan needs except one item: no server rule yet sends a 2.27.0–2.32.1 hook the "update the hook" hint. A PoC of a static wrapper form already exists, unfinished: `docs/pocs/2026-11-17-1558-ps-wrap-static-form/` (created 15:58 today, after the git snapshot) has no README and no recorded results.

## Requirements summary
GH-149, branch `fix/morning-check`. On Claude Code 2.1.326 the PowerShell prefix from `tool-wrap-powershell.js` is refused with "Command name is a dynamic expression which cannot be statically validated" outside `bypassPermissions`. The cause is `& $__real @__a` inside `__lhWrap`.
- **FR-1:** replace it with a statically valid form, so a wrapped call gets the same permission outcome as the unwrapped one (allow / deny / ask / no rule). This must hold in all 5 permission modes, on PowerShell 5.1 and 7. It is proved by a PoC; the fallback is a PATH shim. No version gate and no permission-mode gate.
- **FR-2:** records still land in `calls/`. When the hook leaves a call unwrapped because of a failure it can detect, it writes the reason to `hook.log` once per session per reason.
- **FR-4:** check in a Linux container that records land with the sandbox on. A silent loss is a bug to fix here.
- **FR-5:** check that the plugin hooks and the OTEL env load in a linked-worktree session.
- **FR-6:** document bare `curl` (the PS 5.1 alias wins) as a known limit.
- **FR-7:** fix the `RemoteException` line in both the re-emitted output and the `.err` capture / `stderrBytes`, and add a new fidelity row.
- **FR-8:** the security fixes are already in the working tree. Only verification is left: `@S-REPO-12`, the final health check, and `npm run perf` within 20 %.
- **Also required:** check on 2.1.314 or the nearest earlier version; the config `schemaVersion` stays 1.
- **Open question 1 answered (option a):** old hooks only get an "update the hook" hint, nothing else.

## Wireframes
None referenced. The only UI text involved is the hint label in `MonitoredToolsSettings.tsx`.

## Knowledgebase
- `docs/knowledgebase/tool-monitoring.md`
  - §"PowerShell (DD-14)" (l.112-118) and §"Wrapper safety" (l.135-163) need updating.
  - Hint rules are at l.301-303: `hook_too_old` fires only when `tool_wrap_status` is NULL.
  - The backward-compatibility table is at l.348-357.
  - The FR-4 sandbox result and the FR-6 bare-`curl` limit go here; the existing `find`/`grep` limit at l.105 is the paragraph to model them on.
- `docs/knowledgebase/algorithms/tool-wrapper-fidelity.md`
  - The Rules, the Fixture tools list, Edge cases, the Examples key list, "Rows (15)" and Mutations all need updating for a new row and fixture.
  - Rule 2: PowerShell fidelity is compared as text, not bytes.
  - Rule 7: skip rules.
- `docs/knowledgebase/hook-api-versioning.md`
  - l.684: shape of the `tool_wrap_status` line.
  - l.769-795: "Hook-side behaviour history" needs a new row for the new hook version (pattern: the `2.27.0` row).
- `docs/knowledgebase/hook-system-overview.md`
  - Design rules: fail-open, CommonJS, every Node.js LTS.
  - Linked worktrees resolve to the main checkout (l.149-152).
- `hook/INSTALL_HOOK.md`
  - l.349-360 and l.431: the PreToolUse PowerShell entry.
  - l.494-505: project root in a linked worktree (`ARTISYN_PROJECT_ROOT`).
  - l.536: `toolWrap` key. This file must stay in sync through the `update-install-instructions` skill.
- `.claude/rules/hook.md`:
  1. Bump `hook/.claude/telemetry_tool/version.json` (currently **2.32.1**; a fix means PATCH → 2.32.2).
  2. Run `npm run build:hooks-installer`.
  3. Copy the changed files and `version.json` into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`.
  4. Set the `version` in `.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json` (currently 2.32.1).
  5. Run `npm run lint:fix` then `npm run lint` in `hook/`.
- `.claude/rules/server.md` l.97-104: `npm run perf` from `server/`, no metric worse by more than 20 %. The script is in `server/package.json:9`.
- `docs/knowledgebase/session-export-import.md`: the FR-8 paragraph is already added (diff around l.146).

## Existing patterns
- **`hook/.claude/telemetry_tool/tool-wrap-powershell.js`**
  - l.76-116 `WRAP_FUNCTION`: the culprit line is l.93 `& $__real @__a 2>&1`, where `$__real` is the `.Path` resolved at l.83.
  - FR-7 bug sites: l.97 (`$__err.AppendLine($__l.ToString())`, which also feeds `stderrBytes`) and l.114 (re-emit through `[Console]::Error.WriteLine($__l.ToString())`).
  - l.112-113: the catch writes `breaker/<tool>` and a `faults` line `"<tool> powershell-record"`. It writes nothing to `hook.log`.
  - l.126-134 `renderToolFunction`: `Set-Item function:<tool>` and `<tool>.exe`, guarded by `Get-Command -CommandType Application`.
  - l.143-152 `buildPowerShellPrefix`; l.173-223 `planPowerShellWrap`, gated on kill switch → preflight `shells.powershell` → `off/__all` → `breaker/__global` → per-tool markers.
  - l.225-253 entry point: it logs a `result` line on every wrapped call (l.245) and an `error` line on a planning failure (l.250).
  - Exports at l.255.
- **PoC `docs/pocs/2026-11-17-1558-ps-wrap-static-form/static-prefix.cjs`**: the candidate static form.
  - Node resolves the real path (`resolveApplication`: PATH then PATHEXT) and the prefix calls `& '<literal abs path>' @args 2>&1`.
  - The function is defined only when `(Get-Command … -CommandType Application).Path -eq '<literal>'`.
  - Logging is split into `__lhStart` / `__lhEnd`.
  - FR-7 fix idea: for `NativeCommandError` ErrorRecords whose `TargetObject` is a string, use `TargetObject` instead of `ToString()`.
  - `run.mjs` and `hook.cjs` drive `claude -p --ver … --variant … --mode … --allow/--deny`, with the work dir in OS temp. `prompt.txt` holds the curl.exe / hostname repro.
- **`tool-wrap-shims.js`**
  - l.64-235 `POSIX_SHIM_TEMPLATE`: the Bash shim, i.e. what a PowerShell PATH-shim fallback would mirror.
  - l.355 `findOnPath`, the Node-side resolver; on Windows it checks only `name` and `name.exe`, not the full PATHEXT.
  - l.382 `generateShimDir`, l.482 `runPreflight`.
  - l.614 `recordBreakerFault(sessionDir, tool, reason)`: the JS twin of the PowerShell breaker write.
  - l.696-760 `setupSessionToolWrap`: writes `preflight.json` with `shells: { bash: ok, powershell: true }`. `powershell` is always true when a config exists (l.739).
- **`tool-wrap-config.js`**: `isToolWrapDisabled` l.54, `sessionDirPath` l.74, `normalizeToolWrapConfig` l.86 (schema 1, unknown fields ignored), `effectiveTools` l.239, `writeSessionMarkers` l.282.
- **`tool-wrap-names.js`**: `CAPTURE_LIMIT_BYTES` = `STDIN_CAPTURE_LIMIT_BYTES` = 102400 (l.23/25), `CONFIG_SCHEMA_VERSION` = 1 (l.138), `toolMentionRegex` l.156.
- **`hook-log.js`**: `hookLog(hookFile, sessionId, event, message, cwd)` l.95 writes to `<root>/.artisyn/ai_work_dir/hook.log`; `hookLogTo` l.66. It has no once-per-session dedupe of its own.
- **`throttle-state.js` l.166-243**: `claimSessionWarning(sessionId, key, cwd)` / `hasSessionWarning`. This is the existing once-per-session-per-key helper, backed by `otel-session-warnings.json` with a 24 h TTL. Reuse it, or generalise it with a tool-wrap key, for the FR-2 hook.log line.
- **`lifecycle-hook.js` l.45-68**: SessionStart tool-wrap setup logging. Same `result` / `warn` / `error` style.
- **Fidelity test `hook/.claude/telemetry_tool/__tests__/tool-wrap-fidelity.algo.test.js`**
  - Skipped unless `LOGHUB_FIDELITY_TEST=1`.
  - PowerShell path l.153-165: writes the cache and `preflight.json`, then calls `planPowerShellWrap`.
  - Shells l.59-63: `powershell` only on win32, `pwsh` on any OS. `skipReason` l.326.
  - PowerShell comparison is text equality of stdout/stderr (l.180-183).
  - `readCalls` l.243-272 reads `.out` and `.in` but **not `.err`**. It picks `stderrBytes` into the merged record, so `expected.record.stderrBytes` already works.
- **`__tests__/tool-wrap-fixtures.js`**: `FIXTURE_TOOLS` (`zz`, `zzbin`, `zzin`, `zzsleep`, and the Windows-only `zzc.cmd` with CRLF). It is shared with `scripts/tool-wrap-check/create-check-project.mjs`, which writes them to `../loghub-tool-wrap-check/bin/`.
- **`docs/algorithm-examples/tool-wrapper-fidelity.json`**: a plain array of 15 rows.
  - Row shape: `{id, input:{os, shell, tools, command, env?, setup?, measure?}, expected:{exitCode?, stdout?, records?, record?, exitRecord?, outMatchesStdout?, stdin?, generated?, breaker?, setup?}, note}`.
  - The PowerShell rows are FW-08 (`os: windows, shell: powershell, tools: ["zzc"], command: "zzc one two; \"exit=$LASTEXITCODE\""`, expecting `record {tool, args, exitCode: 3}`) and FW-09 (the same on `pwsh`).
  - The next free id is FW-12.
- **`scripts/tool-wrap-check/`**: `create-check-project.mjs` plus `template/linux/Dockerfile` (`node:22.23.5-bookworm`, no Claude Code, no pwsh) and `template/linux/live-settings.json`, which already wires `PreToolUse` matcher PowerShell to `/hook/tool-wrap-powershell.js`. A possible base for the FR-4 container.
- **Plugin wiring**: `scripts/build-hooks-installer.js:311` (`HOOKS_JSON`) and l.507 (check against INSTALL_HOOK.md); the dogfooded copy is `.artisyn/marketplace/plugins/log-hub-hooks/hooks/hooks.json:19`.
- **Server hint (old-hook nudge)**
  - `server/src/logs/tool-monitoring/tool-monitor-config.service.ts` l.212-230 `resolveToolHint`: `null` status → `hook_too_old`; precedence `preflight_failed` > `breaker` > `hook_too_old` > `no_data_yet`.
  - Called at l.609 with `latest` (a `ToolWrapStatusJson` that has `hookVersion`, `preflight.shells?`, `os`).
  - Status type: `server/src/database/schema/index.ts:1749`.
  - Semver: `server/src/common/semver.ts:112` `compareVersions`, with a client twin in `client/src/viewer/lib/semver.ts:95`.
  - Hint union in `tool-monitoring.types.ts:21` and the client mirror `client/src/models/tool-monitoring.ts:15-19`. The label `'hook too old'` is at `client/src/viewer/pages/repository/tools/MonitoredToolsSettings.tsx:64`.
  - Precedent for a minimum-hook-version constant with an "update the hook" text: `client/src/viewer/pages/repository/otel/otel.constants.ts:33` `OTEL_LIVE_HOOK_MIN_VERSION`, used at `otel-format.ts:122` and `OtelSlowUpdatesBanner.tsx:23`.
- **Tests touching hints**
  - `tests/scenarios/repos/s-repo-17.spec.ts:176` expects `hook_too_old` when there is no status; its status line uses `hookVersion: '2.27.0'` (l.233, l.287).
  - Contract `server/test/contract/registry/f24-tool-monitoring.ts:72` has `hookVersion: '2.21.0'`, with hints at l.345-416. `world-v1.sql.ts` has 2.30.0 at l.1738 and 2.21.0 at l.2308.
  - A version-based hint would change these expectations.
- **Scenarios touching tool wrap**
  - `tests/scenarios/hook/s-hook-09.spec.ts` l.236-251: asserts exactly one PreToolUse entry, matcher PowerShell, `tool-wrap-powershell.js`.
  - `tests/scenarios/helpers/tool-monitoring.ts` (`buildToolCallsLog`, status line l.154/205), `s-repo-17`, `s-sess-03`, `s-sess-14`.
  - No scenario runs the PowerShell prefix itself; only the fidelity algorithm rows do.
- **FR-8**: S-REPO-12 step 7 is at `tests/scenarios/repos/s-repo-12.spec.ts:122`; the scenario is tagged `@mode-a @mode-c` (l.32). The interceptor diff (`files: 1`, `fields: 8`, `parts: 9`) is in `server/src/logs/import-zip-upload.interceptor.ts`.
- **Docs to touch**
  - `user-docs/tuning-your-setup.md` §"Monitored Tools" (l.53-60) and `user-docs/session-list.md` §"Tools/MCP tab" (l.84-102) are the user-docs homes for the FR-6 limit.
  - `hook/README.md` has no limitations section and does not mention the PreToolUse/PowerShell wrapper; an FR-5 limitation would need a new section.

## Open gaps
1. **The static form is unproven.** The PoC has no README or results yet. The open points are:
   - Whether `& '<literal path>'` inside a function defined through `Set-Item` passes 2.1.326's validation.
   - How a literal-path invocation matches allow rules like `PowerShell(curl.exe:*)`, since the rule sees the outer command text.
   - Path resolution in the hook process versus PowerShell: the hook's PATH may differ, PATHEXT handling differs, and a `.cmd` tool such as `zzc.cmd` must still work. `findOnPath` only knows `.exe`.
   - The repo's `poc` skill requires a README in that folder.
2. **FR-2 logging from inside `__lhWrap`.** Today a failure inside `__lhWrap` only writes `breaker/<tool>` and `faults`; nothing reaches `hook.log`. The plan must choose: PowerShell writes `hook.log` directly (path `<root>/.artisyn/ai_work_dir/hook.log`, plus the rotation rules), or the next hook process turns new `faults` lines into one `hook.log` line per reason through `claimSessionWarning`. Today the planning-failure path (l.250) logs on every call.
3. **No hint for 2.27.0–2.32.1 hooks.** Those hooks report a status, so `resolveToolHint` never shows `hook_too_old` for them. The plan must decide whether to add a minimum hook version compared against `status.hookVersion` (server constant plus `compareVersions`) and whether to limit it to PowerShell users (`preflight.shells.powershell` is stored but always true). That would change S-REPO-17 / F24 hint expectations (fixtures use 2.21.0 / 2.27.0 / 2.30.0) and need a contract-registry row update. It needs no hook-side config change, so `schemaVersion` stays 1.
4. **FR-7 test support is missing.**
   - `readCalls` does not read `.err`; a new expected key (e.g. `stderr` capture text) is needed in the test and in the doc's Examples key list.
   - No fixture writes an empty stderr line; a new one is needed in `tool-wrap-fixtures.js`, with the doc's Fixture-tools list updated. It must be Bash, or `.cmd` for Windows-only rows.
   - Whether `pwsh` 7.x produces the same ErrorRecord for an empty native stderr line has not been checked.
5. **No containers exist for FR-4, FR-5 or the 2.1.314 check.** The check-project Dockerfile has no Claude Code and no `pwsh`, and there is no sandbox-on or worktree harness. `big-prod-e2e-test` has a linked-worktree `claude -p` session, but it is manual and costly. The plan must define these container runs (pinned Claude Code versions through npm, default sandbox settings, a `pwsh` install if PowerShell is in scope).
6. **The PATH-shim fallback for PowerShell does not exist.** PowerShell does not read `CLAUDE_ENV_FILE`, so the shim dir would have to be prepended to `$env:PATH` inside the command, with `.cmd`/`.ps1` shims. It is fully new if needed.
7. **The new fidelity row's result belongs in `notes.md`.** The fidelity test only runs from `../loghub-tool-wrap-check` with `LOGHUB_FIDELITY_TEST=1`, not in the fast set. CLAUDE.md forbids deleting folders outside the repo.
