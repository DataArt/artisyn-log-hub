# GS-09 bulk (generated)

Written by `tests/golden/gen-gs09.mjs` — do not edit the JSONL by hand; change the generator and
re-run `node tests/golden/gen-gs09.mjs` (`--check` verifies the committed files are current).

One root session on `fix/windows` (claude-sonnet-4-6), repo root `C:\work\acme-shop`, W2 Thursday.

- 400 `Edit` calls, one per file, each replacing one line (old 1 / new 1, nothing in common):
  written 400, diff +400 / −400, 400 changed files.
- Folders `src\<area>\<layer>\<kind>\` — 5 × 4 × 4 = 80 leaves, four levels, 106 folders in all;
  leaves hold 5 files (6 in the first four), and `src/users/ui/views` holds a single file.
- Three files are named `wombat-*.ts` in three different areas (the filter case).
- 20 responses of 20 parallel Edits, every response split over one line per block (same
  `message.id` and usage). Tokens 1000 / 500 → **$0.0105**; work time **200 s**.

Checks: the 400-file change-surface tree — filter, collapse, sort, single-child folders, the
`/files` API.

Dates are written relative to `A` = Monday 2026-01-05 (W1 = 05–11 Jan, W2 = 12–18 Jan); the
loader (`tests/scenarios/helpers/golden.ts`) shifts every timestamp by whole days. `{{RUN}}` and
`{{REPO}}` are placeholders the loader replaces. The numbers here are documentation; the contract is
`expected.json` (DD D3) and `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §2.3.
