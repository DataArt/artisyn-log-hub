# Notes

## 2026-11-10: Diagnostics deep-dive (from the initial survey)

462 diagnostics items over the same 12 sessions: all from `typescript` (the `typescript-lsp`
plugin), 368 Error / 94 Hint; 85 % on files the transcript's own agent did not edit with
Edit/Write (written by workflow subagents or Bash); **no** diagnostics attachment ever landed in a
subagent transcript — the parent gets all of them; 24 % on scratchpad / `tmp/` files; the bulk is
mid-edit noise (`Cannot find name`, `declared but never read`). Signal worth keeping:
broken-then-fixed edits (e.g. JSX syntax errors), errors never followed by another edit of that
file, recurring config-gap codes (`80001`, missing `@types/node`).
