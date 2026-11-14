---
reviewed: no
reviewer: none
---

# Work Hub names: display names, uniqueness key and branch

## Purpose

Decides whether a workspace or workstream name is acceptable, when two names count as the same,
and which git branch a new workstream gets. A rejected name shows its message under the name field;
the branch is what the agent works on and what the user later merges.

## Code

- Implementation: `work-hub/server/src/names.rs` (`validate_display_name`, `name_key`,
  `branch_slug`, `derive_branch`; constants `MAX_NAME_CHARS`, `MAX_SLUG_CHARS`, `BRANCH_PREFIX`,
  `EMPTY_SLUG`). Callers: `work-hub/server/src/workspaces/` (create) and
  `work-hub/server/src/workstreams/` (open; the taken set is the repo's `refs/heads/ws/*` plus every
  branch in the DB of the workspace's workstreams, discarded ones included).
- Twins: none. The web UI shows the server's message.
- Test: `work-hub/server/tests/algo.rs` (`workhub_names`), run by `npm run test:algo` from
  `work-hub/`.

## Input and output

Three operations, picked by `input.op`:

- `validate` — the raw name → `{ok: true, name}` (the trimmed name) or `{ok: false, message}`;
- `key` — a name → `{key}`, the uniqueness key;
- `branch` — a name and the set `taken` of full branch names → `{branch}`.

## Rules

Display name (`validate`):

1. Trim Unicode whitespace at both ends (spaces, tabs, line breaks, U+00A0, U+3000, …).
2. Empty → "Enter a name."
3. More than `MAX_NAME_CHARS` = 100 Unicode scalar values (not bytes, not UTF-16 units) → "Use at
   most 100 characters."
4. Any control character (general category Cc: U+0000–U+001F, U+007F–U+009F) or the line / paragraph
   separators U+2028 / U+2029 → "A name cannot contain line breaks or control characters."
   Other invisible characters (e.g. the zero-width space, a format character) are allowed.

The rules run in this order; the first failing one gives the message. The accepted name is the
trimmed one.

Uniqueness (`key`):

5. The key is the trimmed name in Unicode lowercase. Two workspaces of one user, or two workstreams
   of one workspace, may not share a key: "You already have a workspace with this name." / "This
   workspace already has a workstream with this name." (the duplicate check itself needs the DB and
   is not in this table).

Branch (`branch`):

6. Transliterate to ASCII (`deunicode`: `é` → `e`, `Исправить` → `Ispravit'`), then lowercase.
7. Every run of characters outside `[a-z0-9]` becomes one `-`.
8. Trim `-` at both ends, keep the first `MAX_SLUG_CHARS` = 50 characters, trim `-` again.
9. Empty → `EMPTY_SLUG` = `work`.
10. The base is `ws/<slug>`. If it is in `taken`, try `ws/<slug>-2`, `-3`, … and use the first one
    not in `taken`. `taken` holds full branch names and is compared exactly.

## Edge cases

- Trimming, including Unicode spaces and line breaks at the ends: WN-02, WN-03, WN-14.
- Empty and whitespace-only: WN-04, WN-05.
- Length 100 / 101, counted in chars after trimming: WN-06, WN-07, WN-08.
- Control characters inside: tab WN-10, LF WN-09, BEL WN-11, C1 NEL WN-12, U+2028 WN-13; a
  format character is allowed: WN-15.
- Rule order (length before control characters): WN-16.
- Case-insensitive key, Unicode lowercase: WN-17..WN-19.
- Slug: runs WN-21, `_` and edge dashes WN-22, digits WN-23, Cyrillic WN-24, Latin accents WN-25,
  punctuation only → `work` WN-26.
- 50-char cut: WN-27; the cut landing on a `-`: WN-28.
- Clashes: `-2` WN-29, `-3` WN-30, only a suffix taken WN-31, gap WN-32, suffix after the cut
  WN-33, exact full-name match WN-34.

## Examples

`input.raw` is a string, or for long values `{before?, repeat, times, after?}` meaning `before` +
`repeat` repeated `times` times + `after`. `expected` lists the keys the row pins (a subset of the
output).

Rows (34): [`docs/algorithm-examples/workhub-names.json`](../../algorithm-examples/workhub-names.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Length in bytes instead of chars -> WN-06.
- `>=` instead of `>` on the length -> WN-06.
- Length counted before trimming -> WN-08.
- Control check before the length check -> WN-16.
- ASCII-only trim -> WN-03; no trim before the control check -> WN-14.
- Control check limited to C0 -> WN-12; line separators forgotten -> WN-13; "any non-printing
  char" -> WN-15.
- Key not lowercased or not trimmed -> WN-17, WN-18; ASCII-only lowercase -> WN-19.
- No transliteration (non-ASCII dropped) -> WN-24, WN-25.
- Each non-alphanumeric char a separate `-` -> WN-21.
- No second trim after the cut -> WN-28.
- Suffix numbering from 1, or from the highest taken -> WN-29, WN-32.
- Prefix-match instead of exact match against `taken` -> WN-34.

## Where the result is visible

The name field's error in the New workspace dialog and the Open
workstream dialog (`400 invalid_name` / `duplicate_name` with this `message`); the branch name in
the workstream switcher and in `git branch` inside the workspace container.
