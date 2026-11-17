# PoC: a PowerShell tool-wrapper form that Claude Code's permission check accepts

Task: [2026-11-17-cc-2-1-326-powershell-wrap](../../tasks/todo/2026-11-17-cc-2-1-326-powershell-wrap/requirements.md)
(GH-149, FR-1, FR-7).

## Question

The PreToolUse(PowerShell) hook rewrites a command into `prefix + command`, where the prefix defines
`__lhWrap` and one function per monitored tool. Outside `bypassPermissions`, Claude Code 2.1.326
refuses the rewritten command with `Command name is a dynamic expression which cannot be statically
validated`. Is there a prefix form that keeps the permission outcome of the unwrapped command
(allow rule → runs, deny rule → denied) in every permission mode? If not, where does the wrap still
work, and how should the hook behave instead?

Side question (FR-7): which field of a native-stderr `ErrorRecord` holds the original line, so that
an empty stderr line is not rendered as `System.Management.Automation.RemoteException`?

## How to run

From this folder, with a Claude Code native install that keeps versions under
`<home>/.local/share/claude/versions/<ver>` (or `CLAUDE_BIN=<path>`), logged in:

```sh
node run.mjs --ver 2.1.326 --variant old    --mode default --allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)" --name old-default
node run.mjs --ver 2.1.326 --variant static --mode default --allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)" --name static-default
node run.mjs --ver 2.1.326 --variant none   --mode default --allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)" --name none-default
node run.mjs --ver 2.1.326 --variant raw-p1-readonly --mode default --allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)" --name p1
node run.mjs --ver 2.1.326 --variant old    --mode bypassPermissions --deny "PowerShell(curl.exe:*)" --name byp-deny
```

- `hook.cjs` — the stand-in PreToolUse hook. Variants: `old` (the real `buildPowerShellPrefix`
  of the hook), `static` (`static-prefix.cjs`: the real tool called by a literal absolute path, no
  dynamic command name, logging split into `__lhStart` / `__lhEnd`), `raw-<probe>` (a one-line
  prefix from `probes/<probe>.ps1`), `none` (no hook at all).
- `run.mjs` — one `claude -p --model haiku` run in a scratch project under `POC_WORK`
  (default `<os tmp>/lh-ps-wrap-poc`, never in the repo); prints each PowerShell call's result,
  the denials and the call records written.
- `prompt.txt` — asks for `curl.exe --version` and `hostname`, one PowerShell call each.
- `real-hook-run.mjs` — the same run against the **real** hook of this repo (`lifecycle-hook.js` at
  SessionStart, `tool-wrap-powershell.js` at PreToolUse) with a pre-seeded tool-wrap config cache
  and no server; prints the calls, the call records and `hook.log`. Used to verify the fix:
  `node real-hook-run.mjs --ver 2.1.326 --mode default --allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)" --name r-default`.

## Result

**No prefix form keeps the permission outcome. The wrap is safe only in `bypassPermissions`.**

Claude Code 2.1.326 (`claude -p`, Windows PowerShell 5.1, allow rules `PowerShell(curl.exe:*)`,
`PowerShell(hostname)` unless stated):

| Run | Variant / probe prefix | Mode | Outcome of `curl.exe --version` / `hostname` | Records |
|---|---|---|---|---|
| none-default | no hook | default | both run | — |
| old-default | current `__lhWrap` | default | both refused: `Command name is a dynamic expression which cannot be statically validated` | 0 |
| old-accept | current | acceptEdits | both refused, same message | 0 |
| old-dontask | current | dontAsk | both denied ("running in don't ask mode") | 0 |
| old-plan | current | plan | `curl.exe` ran; `hostname` refused: "auto mode classifier gave no verdict … a hook changed this call's input after auto mode reviewed it" | 1 |
| static-default | literal path, no dynamic name | default | both refused: `New-Object instantiates .NET type 'System.Text.UTF8Encoding' outside the ConstrainedLanguage allowlist` | 0 |
| p1 | `Get-Command -Name hostname -CommandType Application \| Out-Null;` | default | both refused: "This PowerShell command contains multiple operations. The following part requires approval: …" | — |
| p2 | `function hostname { HOSTNAME.EXE };` | default | both refused: "… inside a control-flow or chain statement … requires manual approval" | — |
| p3 | `Set-Item -LiteralPath 'function:hostname' -Value { HOSTNAME.EXE };` | default | both refused: `Command contains script block that may execute arbitrary code` | — |
| p4 | `$__x = 1;` | default | both refused: "contains multiple operations … requires approval" | — |
| old-toolwide | current, allow rule `PowerShell` (whole tool) | default | both run | 2 (start, stream_end, exit) |
| byp326 | current, no rules | bypassPermissions | both run | 2 |
| byp326-deny | current, deny `PowerShell(curl.exe:*)` | bypassPermissions | `curl.exe` denied, `hostname` runs — deny parity holds | 1 |

Claude Code 2.1.311 gives the same result: `old` in `default` is refused with the same
dynamic-expression message, the read-only probe p1 is refused, `old` in `bypassPermissions` works
with records. So this is not a 2.1.326 regression: the PowerShell wrap already blocks allow-rule
users outside bypass.

Why no form exists: the PowerShell permission check splits the command into its statements and
needs every statement to be allowed. A prefix statement matches no user rule (the user allowed
`curl.exe:*`, not `Get-Command` or an assignment), so the whole command falls back to a prompt
(interactive) or a denial (`-p`), even for a read-only prefix. On top of that, the 2.1.326
PowerShell security analyzer returns "ask" for every construct a wrapper needs — script blocks,
.NET method calls, types outside the ConstrainedLanguage allowlist, splatting, `$()`
subexpressions, variable / environment writes — and that "ask" also wins over a matching allow
rule. A PATH-shim prefix (`$env:PATH = …`) hits "Command modifies environment variables" the same
way, and the PowerShell tool has no `CLAUDE_ENV_FILE` equivalent (the 2.1.326 binary sources that
file only ahead of Bash commands).

Every PreToolUse input on 2.1.311 and 2.1.326 carries `permission_mode` (`default`, `acceptEdits`,
`plan`, `dontAsk`, `bypassPermissions` seen) next to `session_id`, `cwd`, `tool_name`, `tool_input`.
**Decision (owner, 2026-11-17):** the hook rewrites a PowerShell command only when
`permission_mode === 'bypassPermissions'`; any other value, or no field, leaves the command
untouched.

FR-7: a native-stderr line arrives as an `ErrorRecord` whose `Exception` is a
`System.Management.Automation.RemoteException`. For an empty line `ToString()` returns the type
name, while `Exception.Message` is the line itself (`""`, length 0). Checked on Windows PowerShell
5.1 and on pwsh 7.4.6 (`mcr.microsoft.com/powershell:7.4-ubuntu-22.04`); `TargetObject` is not
usable (a string only for the first line on pwsh). A non-native `ErrorRecord` (`Write-Error`) is
not a `RemoteException` and keeps `ToString()`. The `old` bypass run above shows the bug live: the
wrapped `curl.exe --version` output contains a `System.Management.Automation.RemoteException` line.
