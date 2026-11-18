# Host verification runs — 2026-11-17 (FR-4, FR-5, FR-7)

Claude Code 2.1.326, Windows 11, Windows PowerShell 5.1, `claude -p --model haiku`, scratch
projects outside the repo. The main-bug PoC (FR-1) is in
[docs/pocs/2026-11-17-1558-ps-wrap-static-form/](../../../../pocs/2026-11-17-1558-ps-wrap-static-form/README.md).

## FR-4 — tool-wrapper records with the sandbox on

- On this Windows host, `{"sandbox":{"enabled":true}}` prints "Sandbox disabled: sandbox is
  enabled but the Windows sandbox is not active on this session (feature gate off)" and runs every
  command unsandboxed.
  - The gate is the env override `CLAUDE_CODE_NANKEEN_KESTREL` or the server flag
    `tengu_nankeen_kestrel`.
  - Turning it on would provision a `ClaudeCodeSandbox` Windows account and WFP filters (admin,
    machine-wide), so it was not forced.
- Real hook 2.32.1 (`lifecycle-hook.js` + `tool-wrap-powershell.js`), with a pre-seeded config
  cache for `curl` and `hostname` and no server:

  | Path | Sandbox setting | Result | Records |
  |---|---|---|---|
  | Bash shim, `default` + `--allowedTools Bash` | off | ok | curl and hostname: `start,stream_end,exit` + `.out`/`.err` |
  | Bash shim | on (inactive) | ok | same |
  | PowerShell, `bypassPermissions` | off | ok | curl and hostname: `start,stream_end,exit` |
  | PowerShell, `bypassPermissions` | on (inactive) | ok | same |

  No breaker, no `faults`.
- The Linux sandbox run (needs an interactive login in a container) is left for a follow-up task.

## FR-5 — plugin hooks and OTEL env in a linked worktree

- Setup: a scratch git repo with the log-hub-hooks plugin (2.32.1) installed the way the installer
  does it (project-scope marketplace + `enabledPlugins`), plus a `git worktree add` worktree.
- Main checkout and linked worktree behaved the same:
  - the plugin loaded from the main checkout's marketplace path;
  - SessionStart, UserPromptSubmit, PostToolUse, PostToolBatch, Stop and SessionEnd hooks fired;
  - `hook.log` and telemetry went to the main checkout's `.artisyn/ai_work_dir`, and the
    SessionStart `git` block has `worktreeRoot` set.
  - Claude Code's own `--worktree` behaved the same way.
- OTEL: the plugin ships no settings and no OTEL env.
  - The installer writes the OTEL keys to user-scope settings; project / local OTEL keys are
    ignored since 2.1.282.
  - Exported logs and metrics reached a local OTLP sink from both the main checkout and the
    worktree.
  - The Bash tool never shows `OTEL_*` in its environment, so `env` is not a valid probe.
- Verdict: no "worktree skips plugin settings" effect for log-hub-hooks; nothing to fix.
- Not covered: real user-scope OTEL keys in a worktree, the `otelEnabled: true` receiver
  registration, and interactive sessions.

## FR-7 — native stderr `ErrorRecord` fields

- Windows PowerShell 5.1 (host) and pwsh 7.4.6 (`mcr.microsoft.com/powershell:7.4-ubuntu-22.04`):
  a native stderr line is an `ErrorRecord` whose `Exception` is a `RemoteException`.
- For an empty line, `Exception.Message` is `""` (length 0) and `ToString()` is the type name.
  For a non-empty line both give the line.
- On pwsh, `TargetObject` is a string only on the first record.
- A `Write-Error` record is not a `RemoteException`.
- Fixture check: a `.cmd` writing `>&2 echo(` produces exactly that empty record.
