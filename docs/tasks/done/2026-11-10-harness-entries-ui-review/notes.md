# Notes

## 2026-11-10: Diagnostics deep-dive (from the initial survey)

462 diagnostics items over the same 12 sessions: all from `typescript` (the `typescript-lsp`
plugin), 368 Error / 94 Hint; 85 % on files the transcript's own agent did not edit with
Edit/Write (written by workflow subagents or Bash); **no** diagnostics attachment ever landed in a
subagent transcript — the parent gets all of them; 24 % on scratchpad / `tmp/` files; the bulk is
mid-edit noise (`Cannot find name`, `declared but never read`). Signal worth keeping:
broken-then-fixed edits (e.g. JSX syntax errors), errors never followed by another edit of that
file, recurring config-gap codes (`80001`, missing `@types/node`).

Caveat (2026-11-11): this is one setup — Windows, WebStorm, the `typescript-lsp` plugin. The
entry carries `source` / `code` / `severity` only; nothing says whether an IDE integration or an
LSP plugin produced it. The TypeScript codes above are examples, not rules — see FR-8.

## 2026-11-11: Setup samples beyond Windows + WebStorm (moved from requirements.md Notes)

**First non-WebStorm sample** — one stored local-prod session, VS Code + a C project (Windows,
Claude Code 2.1.314):

- `entrypoint` is `cli` — a CLI started in the VS Code terminal with the IDE integration is not
  told apart from a plain terminal by `entrypoint`; the IDE shows up only through `*_in_ide`
  entries.
- `opened_file_in_ide` carries only `filename` — no `ideName` (seen only on
  `selected_lines_in_ide` so far), so the IDE facet is often "IDE, name not recorded".
- The filename has a lower-case drive letter (`d:\…`) while `cwd` has `D:\…` — repo-relative path
  reduction must compare drive letters case-insensitively.
- No `diagnostics` at all, although clangd is installed and the agent wrote files: absence of
  diagnostics means "no producer", never "clean code".
- `hook_success.hookName` equals the event (`Stop`); the hook identity is `command` (here a status
  text, e.g. "Uploading logs..."), and `stderr` can hold absolute paths.
- Harness entries present: `turn_duration`, `stop_hook_summary`, `hook_success`,
  `silent_turn_reminder`, `opened_file_in_ide`, plus the startup set — same shapes as on WebStorm.

**First Linux sample** — `claude -p` in WSL (Ubuntu 22.04, native Linux node + Claude Code
2.1.322, Java test repo `../wsl-test-repo`, local-prod repository 5421): `entrypoint` is
`sdk-cli`, `cwd` is POSIX (`/mnt/d/…`); no `turn_duration` in a `-p` session (only
`stop_hook_summary`); new line type `queue-operation`; hook upload and SessionEnd flush worked.
The local repo identity is `<email>/mnt/d/…`, so the same folder opened from Windows would be a
second repository.

**Local prod facet matrix:** 297 stored sessions, 1 user, all Windows; IDE entries in 1 session;
`diagnostics` in 147, all `source: typescript`.
