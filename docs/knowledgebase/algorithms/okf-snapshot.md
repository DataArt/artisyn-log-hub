---
type: "Algorithm"
title: "OKF snapshot: KB bundle detection, ignored flags and the snapshot id"
description: "The OKF tabs judge KB use \"as of session start\": which bundles (knowledge bases) the repository had, which files each held, how big they were and which were gitignored (private, never shown in a team view). The hook builds that picture — the `okf-snapshot` line — at upload time."
tags: [algorithm]
generated: { by: "human:denistsyplakov", at: "2026-11-20T22:18:32+04:00" }
reviewed: no
reviewer: none
---

# OKF snapshot: KB bundle detection, ignored flags and the snapshot id

## Purpose

The OKF tabs judge KB use "as of session start": which bundles (knowledge bases) the repository
had, which files each held, how big they were and which were gitignored (private, never shown in a
team view). The hook builds that picture — the `okf-snapshot` line — at upload time. Two things
decide what the server gets: **which** folders count as bundles and which `.md` files belong to
them, and the **content-only** id that lets the hook send the full body once per distinct KB state
and a cheap `okf-snapshot-ref` line on every other upload. A wrong detection shows the wrong KB or
leaks a private one; a wrong id either resends the body every upload or never resends it after a
real change.

## Code

- Implementation: `hook/.claude/telemetry_tool/okf-snapshot.js` — `buildOkfSnapshot({projectRoot,
  config, log, workDir})`, `detectOkfBundles`, `hasOkfFrontMatter`, `parseOkfFrontMatter`,
  `globToRegExp`, `computeOkfSnapshotId`, `buildOkfSnapshotRef`; constants
  `OKF_SNAPSHOT_SCHEMA_VERSION` = 1, `OKF_SNAPSHOT_MAX_FILES` = 20000,
  `OKF_FRONT_MATTER_READ_BYTES` = 8192 (512 before hook 3.1.0), `OKF_META_VALUE_MAX_CHARS` = 200,
  `OKF_SNAPSHOT_META_BUDGET_BYTES` = 8 MiB, `OKF_CHECK_IGNORE_TIMEOUT_MS` = 5000,
  `OKF_DETECTION_BUDGET_MS` = 300, `OKF_DEFAULT_EXCLUDE` = `["tmp/**"]`.
- `hook/.claude/telemetry_tool/git-context.js` — `gitWithInput(args, cwd, input, timeoutMs)`
  (`execFileSync` with stdin, never throws, returns `{status, stdout}`).
- `hook/.claude/telemetry_tool/okf-state.js` — `okf-state.json`: known ids
  (`OKF_KNOWN_SNAPSHOTS_MAX` = 20, `OKF_STATE_VERSION` = 1) and the content-hash cache.
- `hook/.claude/telemetry_tool/env-context.js` — the `okf` config key (`{ exclude: string[] }`).
- Delivery: `send-logs-hook.js` `getOkfPrefix()` (see [../okf-usage.md](../okf-usage.md)).
- Twins: none. The server never recomputes the id; it only accepts `^[0-9a-f]{64}$`
  (`server/src/logs/okf/okf-snapshot.ts`, `OKF_SNAPSHOT_ID_RE`) and ignores an invalid one.
- Test: `hook/.claude/telemetry_tool/__tests__/okf-snapshot.algo.test.js` (`node --test`).

## Input and output

The line (DD-13); `size` is bytes on disk, `hash` the sha256 hex of the content, paths are
repo-relative with `/`, a bundle's `ignored` is its `index.md`'s flag. No `timestamp`.

```json
{ "type": "okf-snapshot", "okfSnapshotId": "<64 hex>", "schemaVersion": 1,
  "bundles": [ { "root": "docs/knowledgebase", "index": "docs/knowledgebase/index.md",
                 "ignored": false,
                 "files": [ { "path": "docs/knowledgebase/db-tables.md", "ignored": false,
                              "size": 12345, "hash": "<sha256 hex>" } ] } ] }
```

Hook 3.1.0+ (OKF v0.3) adds, all optional so the server accepts snapshots with and without them:
a bundle's `okfVersion`, `title`, `description` (strings, each only when present in its
`index.md`) and every file's `meta` =
`{ frontMatter, hasGenerated, hasTimestamp, type?, status?, superseded_by?, stale_after? }` — the
three booleans always, each scalar only when present (rule 3b).

Ref line: `{ "type": "okf-snapshot-ref", "okfSnapshotId": "<64 hex>" }`.

## Rules

**Detection** (`detectOkfBundles`, DD-15, DD-43):

1. The walk starts at the project (git) root and never enters a directory named `.git` or
   `node_modules` (at any depth), a symlinked directory (a symlinked file is read like a file), or
   a path matching an exclude glob. The globs are `OKF_DEFAULT_EXCLUDE` (`tmp/**`, always) plus
   `config.okf.exclude`, matched against the repo-relative path of every folder and file.
2. **Globs** (`globToRegExp`): `**` = any number of segments (`a/**` matches `a` itself and
   everything under it; `**/b` matches `b` at any depth), `*` = any characters inside one segment,
   `?` = one character; anything else is literal, a leading `./` or `/` and a trailing `/` are
   dropped. A glob without wildcards excludes exactly that path (a folder: everything under it).
3. A file named `index.md` (any case) roots a bundle when its first
   `OKF_FRONT_MATTER_READ_BYTES` = 8192 bytes (512 before hook 3.1.0), after an optional UTF-8 BOM
   and with `\r\n` read as `\n`, start with a `---` line and contain a line starting `okf_version`
   + optional spaces + `:` before the next `---` line (or the end of the 8192 bytes). The value
   does not matter (empty, `0.1`, `foo` all count). The bundle `root` is that index's folder
   (`''` for the repo root).

**Front-matter metadata** (hook 3.1.0+, OKF v0.3; `parseOkfFrontMatter(head)`):

3a. The head (the same first 8192 bytes) is parsed with a line scanner, no YAML library: drop a
    UTF-8 BOM, split lines, strip `\r`. Line 0 must trim to `---`, else the result is
    `{frontMatter: false, hasGenerated: false, hasTimestamp: false, fields: {}}`. The following
    lines are scanned until one trims to `---` (→ `frontMatter: true`); if the head ends first
    the block is **unclosed** and the same all-false result is returned (metadata ignored). A
    top-level key line matches `^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$` — an indented line is never
    a key; the first occurrence of a key wins. A `generated` key sets `hasGenerated`, a
    `timestamp` key `hasTimestamp`. The whitelisted keys `okf_version`, `title`, `description`,
    `type`, `status`, `superseded_by`, `stale_after` keep a normalised scalar in `fields`: trim;
    a value starting with `"` or `'` with a matching closing quote → the inner text (the rest of
    the line ignored, a `#` inside kept); otherwise cut at the first whitespace-preceded `#` and
    trim; `''`, `null`, `~`, `|`, `|-`, `>`, `>-` (and an empty quoted string) → absent; an
    unquoted value starting with `"` / `'` (no closing quote), `[` or `{` (a flow sequence or
    mapping, e.g. a broken `title: [unclosed`) is not a scalar → absent; cap at
    `OKF_META_VALUE_MAX_CHARS` = 200 characters.
3b. A bundle's `okfVersion` / `title` / `description` are its root `index.md`'s `okf_version` /
    `title` / `description` fields. Every file of a bundle (its `index.md` included) gets `meta`
    from its own head: the three booleans plus `type`, `status`, `superseded_by`, `stale_after`
    when present — values exactly as written (case kept, `superseded_by` not resolved; the
    server interprets them, see [okf-metadata](okf-metadata.md)). `title` never goes into a
    file's `meta`.
4. Every `.md` file (any case) found by the walk belongs to the **deepest** bundle root containing
   it; files under no root are dropped. A nested `index.md` without `okf_version` is an ordinary
   file of its parent bundle. Links inside an index are never followed, so nothing outside the
   walk is ever read.
5. Bundles are sorted by `root`, files by `path` (plain code-unit order).
6. More than `OKF_SNAPSHOT_MAX_FILES` = 20000 files in all bundles → no snapshot (logged).

**Ignored flags** (DD-16):

7. One `git check-ignore --stdin -z` over all found file paths (`OKF_CHECK_IGNORE_TIMEOUT_MS` =
   5000). Exit 0 → the listed paths are ignored; exit 1 → none is ignored; any other outcome (not
   a git repo, git missing, timeout) → **every** file is ignored (fail closed: a private file must
   never reach a team view). A bundle's `ignored` = its `index.md`'s flag.

**Content and id** (DD-14):

8. Each file is read once: `size` = bytes, `hash` = sha256 hex of the content, `meta` from the
   first 8192 bytes of the same buffer. With `workDir` the hash and `meta` are reused from
   `okf-state.json`'s cache when the file's `(mtimeMs, size)` is unchanged (files modified in the
   last 2 s are not cached); the cache never changes the result. A cache entry is
   `[mtimeMs, size, sha256, meta]`; a hit needs matching mtime and size, a string hash and an
   object `meta` with the three booleans. A legacy 3-element entry (hook < 3.1.0) is a miss: the
   file is re-read once and the cache is rewritten even when the tree key and entry count are
   unchanged. Older hooks read only elements 0..2, so a 4-element entry is still a hit for them;
   `OKF_STATE_VERSION` stays 1.
9. `okfSnapshotId = sha256Hex(JSON.stringify(canon))`, `canon` = the bundles sorted by `root`,
   each projected to `{root, index, ignored, files}` and then `okfVersion`, `title`,
   `description` appended in that order only when they are strings; its files sorted by `path`
   and projected to `{path, ignored, size, hash}` and then `meta` only when it is an object, its
   keys projected in the fixed order `frontMatter, hasGenerated, hasTimestamp, type, status,
   superseded_by, stale_after` (absent or wrongly typed keys omitted, unknown keys dropped).
   Nothing else enters the id — never an mtime — so the id is independent of input and key order
   and changes on any change of a file's content, path, size, ignored flag or metadata. A
   snapshot without the new fields has exactly the id it had before hook 3.1.0.

**Size guard** (hook 3.1.0+):

9a. When `Buffer.byteLength(JSON.stringify(snapshot))` exceeds `OKF_SNAPSHOT_META_BUDGET_BYTES`
    = 8 MiB, every bundle field of rule 3b and every file `meta` is stripped, the id recomputed
    (= the pre-3.1.0 id of rule 9) and one line is logged:
    `okf-snapshot: body with metadata is <n> bytes, over the <budget> budget — metadata dropped`.
    So a huge KB still fits the server's 10 MiB `OKF_SNAPSHOT_MAX_BYTES` instead of being
    rejected and resent on every upload (real KBs cost ~80 B of `meta` per file).
10. A repository without any bundle still gets a snapshot with `bundles: []`, so the server can
    tell "no KB" from "hook too old to say".

**Timing** (DD-18): detection runs only at upload (`send-logs-hook.js`), never at `SessionStart`.
Over `OKF_DETECTION_BUDGET_MS` = 300 ms it is logged (a measurement threshold, not a cut-off).
Measured on Windows: this repo (2 bundles, 84 files) ~55–60 ms with or without the cache; a
generated tree of 5 002 `.md` files in 2 bundles ~1.4 s without the cache (read + sha256 ≈
1.35 s of it) and ~0.14 s with a warm cache. Detection-only probes on this repo: the fs walk ~80
ms, `git check-ignore --stdin` ~70 ms; `git ls-files -o -i --exclude-standard` (~500 ms) is not
used.

## Edge cases

- Two bundles, files outside every bundle dropped: OS-01.
- A nested `index.md` without `okf_version` is a file of the parent bundle: OS-02; with
  `okf_version` it roots its own, deeper bundle: OS-03.
- `tmp/` excluded by default: OS-04; `okf.exclude` drops a bundle and the default still applies:
  OS-05.
- A link from an index to `../private_kb` outside the repository is not followed: OS-06.
- Front matter not at the start, `okf_version` after the closing `---` and under
  `node_modules`; a BOM and CRLF accepted; `okf_version` past byte 512 detected: OS-07.
- A 1 KB `description` before `okf_version` detected, `description` capped at 200: OS-15;
  `okf_version` past byte 8192 not detected: OS-16.
- `okf_version` empty, `0.1`, quoted `"0.2"`, `0.3`, numeric, unknown with a comment, and a
  malformed-YAML head — all detected, bundle fields as parsed: OS-17.
- File `meta` of an article with all keys, no front matter, a v0.1 `timestamp`, an unclosed
  block and the index: OS-18.
- Quoted / single-quoted / commented values: OS-19; empty, `null`, `~`, block scalars, `""`:
  OS-20; flow `[…]` / `{…}` values and an unclosed quote absent: OS-31; 200-char cap: OS-21; unclosed block: OS-22; BOM + CRLF: OS-23; `generated` /
  `timestamp` booleans, first key wins, non-whitelisted key: OS-24; indented (nested) keys are
  not top-level: OS-25; no front matter: OS-26.
- Legacy id kept without the new fields: OS-27; a bundle `title` changes the id: OS-28; file
  `meta` changes it: OS-29; `meta` key order and unknown keys do not: OS-30.
- The 3-element → 4-element cache upgrade is checked by scenario `s-hook-09` (the table has no
  `workDir` input); the size guard (rule 9a) by code review only — a > 8 MiB fixture is not worth
  a row.
- Gitignored file and gitignored bundle flagged: OS-08; not a git repository → everything
  ignored: OS-09.
- No bundle → `bundles: []`: OS-10.
- Id stable under an mtime-only change: OS-11; changes on content: OS-12; changes on an ignored
  flag: OS-13; independent of bundle and file order (an extra field ignored): OS-14.

## Examples

Five `kind`s. In `detect` and `compare` rows a `tree` maps a path to file content; it is written
under a fresh temporary directory `<tmp>/repo` used as `projectRoot` (a key starting `../` lands
beside it, outside the repository). Unless the row says `"git": false`, `git init` runs in
`<tmp>/repo` first; with `"git": false` the temporary directory must not be inside any git
repository.

- **`detect`**: `buildOkfSnapshot({projectRoot, config: input.config})`. `expected.bundles` lists
  each bundle as `{root, index, files}` with `files` the paths in order; `expected.ignored` is the
  list of file paths flagged `ignored: true` (bundle order, then file order);
  `expected.ignoredBundles` the roots of bundles flagged `ignored: true`. Optional
  `expected.bundleFields` maps a root to its `{okfVersion?, title?, description?}`, compared
  exactly (a key not listed must be absent); optional `expected.fileMeta` maps a file path to a
  subset of its `meta`, where a `null` value means "this key is absent".
- **`compare`**: `{before, after}`, each a `{tree, mtimeOverride?}` written to its own directory
  (`mtimeOverride` re-stamps a file's mtime, in ms, after writing). `expected.sameId` says whether
  the two `okfSnapshotId`s are equal.
- **`order`**: `computeOkfSnapshotId(input.bundles)` and the same call on the bundles in reverse
  order, each with its files reversed. `expected.sameId` compares the two; `expected.id` is the id
  of the first call.
- **`meta`**: `parseOkfFrontMatter(input.head)`; every key listed in `expected`
  (`frontMatter`, `hasGenerated`, `hasTimestamp`, `fields`) is compared exactly.
- **`id`**: `computeOkfSnapshotId(input.bundles)`; `expected.id` is the id it must equal,
  `expected.differsFrom` an id it must not equal (either or both).

Rows (30): [`docs/algorithm-examples/okf-snapshot.json`](../../algorithm-examples/okf-snapshot.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Files assigned to the shallowest instead of the deepest root -> OS-03.
- A nested index without `okf_version` treated as a bundle -> OS-02.
- `tmp/**` not applied, or replaced by the user's list -> OS-04, OS-05.
- The front-matter check scanning the whole file or past the closing `---` -> OS-07 (`b`), OS-16;
  BOM or CRLF not handled -> OS-07 (`c` missing); `node_modules` entered -> OS-07.
- Index links followed -> OS-06.
- `git check-ignore` failure read as "nothing ignored" (fail open) -> OS-09; exit 0 output not
  applied -> OS-08.
- mtime in the id -> OS-11; size-only instead of content hash -> OS-12; `ignored` left out of the
  canon -> OS-13; canon not sorted, or extra fields kept -> OS-14.
- No snapshot when there is no bundle -> OS-10.
- The old 512-byte window kept -> OS-07 (`d`), OS-15; the whole file scanned -> OS-16.
- Quotes not stripped, or a `#` inside quotes cut -> OS-17, OS-19; empty / block markers kept
  as values -> OS-20; no 200-char cap -> OS-15, OS-21; an unclosed block parsed -> OS-18 (`d`),
  OS-22; indented keys treated as top-level -> OS-25; the last duplicate key winning -> OS-24.
- New fields always in the canon (even when absent), breaking the legacy id -> OS-27; meta or
  bundle fields left out of the canon -> OS-28, OS-29; meta keys in input order or unknown keys
  kept -> OS-30.

## Where the result is visible

- Session pane → **OKF** tab: bundle cards (tracked / gitignored chip, file count), the "not in
  KB at start" chip, the "No KB snapshot for this session" banner when absent.
- Repository → **OKF** tab: bundle select, KB FILES and NOT READ tiles, the not-read list, the
  "No longer in KB" group, the team view's hiding of ignored files.
- API: `POST /api/v2/logs` `okfSnapshotId` / `okfSnapshotFull` and `unknownOkfSnapshotId`;
  `okf_snapshots.body`.
- Hook 3.1.0+ metadata: bundle card title / description / "OKF x.y" chip, the deprecated,
  past-`stale_after` and can-improve chips (derived on the server, see
  [okf-metadata](okf-metadata.md)).
