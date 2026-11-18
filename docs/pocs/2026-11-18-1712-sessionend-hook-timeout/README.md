# PoC: SessionEnd hook time budget in Claude Code

Task: [2026-11-18-receiver-upload-queue](../../tasks/todo/2026-11-18-receiver-upload-queue/requirements.md)

## Question

How long does Claude Code let a `SessionEnd` hook run before it kills it? Does
`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` or the hook's own `timeout` field change that, also for
a hook shipped in a plugin (Log Hub's hook is a plugin)? Is a killed hook reported as a failure?

## How to run

From this folder (needs a logged-in `claude` on `PATH`; each variant is one tiny `claude -p` call
on the `haiku` model):

```bash
node run.cjs                      # all variants
node run.cjs A-default C-env-4000 # selected variants
```

`run.cjs` writes a settings file (or a minimal plugin) with a `SessionEnd` hook that runs
`probe-hook.cjs`. The probe logs a tick every 100 ms for `sleepMs` and then logs `done`. Claude runs
with `--setting-sources local` in a fresh empty folder under the OS temp dir, so no user or project
hooks interfere. The temp folder is left in place. Output goes to `runs/<variant>/` (gitignored):
`ticks.log`, `claude.out`, `claude.err`. The summary is printed as JSON.

| Variant | Hook source | Hook `timeout` | Env var | Probe wants |
|---|---|---|---|---|
| A-default | `--settings` | — | — | 10 s |
| B-hook-timeout-10s | `--settings` | 10 s | — | 5 s |
| C-env-4000 | `--settings` | — | 4000 | 10 s |
| D-plugin-hook-timeout-10s | `--plugin-dir` | 10 s | — | 5 s |

Manual check, not scripted: in an interactive session with variant A's settings
(`claude --setting-sources local --settings runs/A-default/settings.json`), run `/clear` and
see what the UI shows.

## Result

Claude Code 2.1.311, Windows 11, 2026-11-18.

| Variant | Hook lived | Finished | `claude -p` wall | stderr |
|---|---|---|---|---|
| A-default | 1616 ms | no | 5.3 s | `SessionEnd hook [...] failed: Hook cancelled` |
| B-hook-timeout-10s | 5055 ms | yes | 7.5 s | — |
| C-env-4000 | 4135 ms | no | 7.8 s | `SessionEnd hook [...] failed: Hook cancelled` |
| D-plugin-hook-timeout-10s | 1618 ms | no | 5.3 s | `SessionEnd hook [...] failed: Hook cancelled` |

Conclusions:

1. **The default budget is 1500 ms**, confirmed in the binary as well as by measurement
   (`SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500`). The ~1.5 s inferred from `hook.log` was right.
   The hook is killed, not left running: its ticks stop and `done` is never written.
2. **A killed hook is reported as a failure**: `SessionEnd hook [<command>] failed: Hook
   cancelled` goes to stderr, already in 2.1.311 and also in `-p` mode.
3. **`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` works** (4000 → killed at ~4.1 s; capped at 1 h in
   the code). It is a user's environment setting, so Log Hub cannot rely on it.
4. **A hook's own `timeout` field raises the budget only for hooks from settings files** (B
   finished its 5 s, capped at 60 s in the code). **It does not work for plugin hooks**: D, with the
   same `timeout: 10` in the plugin's `hooks.json`, was killed at 1.5 s. Log Hub ships its hooks as
   a plugin, so adding `timeout` to its `hooks.json` is not a fix.
5. Raising the budget also delays exit: Claude waits for the `SessionEnd` hooks before it exits
   (B: 7.5 s wall clock against 5.3 s). A long `SessionEnd` therefore blocks `/clear` and exit for
   the user, which is one more reason to keep `SessionEnd` short and hand the work off.

Not checked here: how 2.1.327's UI shows the failure on an interactive `/clear` (2.1.311 was
installed). Conclusion 2 already shows that the failure is reported.
