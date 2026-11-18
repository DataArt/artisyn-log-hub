---
reviewed: no
reviewer: none
---

# Work Hub repo path: relative file paths inside a view

## Purpose

Every file request (tree, open, save, upload, rename, delete, download) names a file by a path
relative to the view root (`/workspace/repo` or a workstream's `/workspace/worktree`). This rule
keeps such a path inside the view and away from git's own data, before any command runs in the
container.

## Code

- Implementation: `work-hub/server/src/repo_path.rs` (`normalize`, constant `MAX_PATH_BYTES`;
  `container_path` joins the result to the view root). Callers: `work-hub/server/src/fs/` and
  `work-hub/server/src/api/fs.rs`.
- Twins: none. The web UI only sends paths it got from the tree.
- Test: `work-hub/server/tests/algo.rs` (`workhub_repo_path`), run by `npm run test:algo` from
  `work-hub/`.

## Input and output

A `/`-separated string → `{ok: true, path}` (the normalized path, `""` = the view root) or
`{ok: false, error: "invalid_path"}` (answered as `400 invalid_path`).

## Rules

1. More than `MAX_PATH_BYTES` = 4096 bytes (UTF-8, of the raw input) → rejected.
2. Strip one leading `./`.
3. Rejected if it starts with `/` (absolute), or contains `\` or a NUL character anywhere.
4. Drop one trailing `/`.
5. If the rest is not empty, split it on `/`. Rejected if any segment is empty, `.`, `..` or
   exactly `.git` (case-sensitive: the container's filesystem is Linux).
6. Otherwise the result is the rest; `""` is the view root.

Nothing is trimmed and nothing is resolved: `a/../b` is refused, not turned into `b`.

## Edge cases

- Root: `""` RP-01, `./` RP-02; `/` alone is absolute RP-10.
- One `./` only: RP-04, RP-05.
- Trailing slash: one dropped RP-07, two rejected RP-08.
- Absolute RP-09; `..` RP-11, RP-12; `.` RP-13; names with dots are fine RP-14.
- `.git` at the top RP-15, in the middle RP-16, at the end RP-17; `.github`, `.gitignore` and
  `.GIT` are fine RP-18..RP-20.
- Backslash RP-21, NUL RP-22, empty middle segment RP-23.
- Spaces and non-ASCII kept as they are: RP-24, RP-25.
- 4096-byte limit: RP-26, RP-27; bytes not chars RP-28; measured before stripping `./` RP-29.

## Examples

`input.path` is a string, or for long values `{before?, repeat, times}` meaning `before` + `repeat`
repeated `times` times. `expected` lists the keys the row pins.

Rows (29): [`docs/algorithm-examples/workhub-repo-path.json`](../../algorithm-examples/workhub-repo-path.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Every leading `./` stripped -> RP-05.
- All trailing slashes dropped -> RP-08.
- `..` resolved instead of refused -> RP-12.
- `.git` matched as a prefix (`starts_with(".git")`) -> RP-18, RP-19; matched case-insensitively ->
  RP-20; only the first segment checked -> RP-16, RP-17.
- Length in chars instead of bytes -> RP-28; checked after stripping `./` -> RP-29; `>=` instead
  of `>` -> RP-26.
- Input trimmed -> RP-24.

## Where the result is visible

`400 invalid_path` ("That file path is not allowed.") from every `/api/v1/…/fs/…` route; safe
behaviour otherwise: no file outside the view and nothing under `.git` can be read or written
through the file API.
