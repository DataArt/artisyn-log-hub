---
reviewed: no
reviewer: none
---

# OKF access extraction: which KB paths a tree node read, searched, listed or wrote

## Purpose

The OKF tabs (session and repo) answer "which knowledge-base articles did the agents actually
read, how much of them went into the context, and did they find them through the index or by
searching". Agents mostly read the KB through Bash in fragments (`sed -n`, `grep -n`, `cat`), not
through the Read tool, so a Read-only count misses most of the use. This algorithm turns one
transcript (one tree node: the root session or one sub-agent) into `session_okf_access` rows —
per repo path, per operation — with the result bytes, the call count, whether the read followed
the node's own edit, and the order of first access. For the value signals (whether an article
pointed the agent at code it then used, see [okf-value-signals](okf-value-signals.md)) the same
walk also yields the node's code events (`session_okf_event`), the pointers its KB reads handed
out (`session_okf_pointer`) and the ordered access sequence of the facts route.

## Code

- Implementation: `server/src/logs/okf/okf-access-extractor.ts` (`extractOkfDetail`,
  `extractOkfAccess` = its `.access`, `toolResultBytes`, `toAbsolute`, `globStaticPrefix`).
- Pointers: `server/src/logs/okf/okf-pointers.ts` (`extractPointers`, `isNewPointer`,
  `isPartialResult`).
- Fixed limits: `server/src/logs/okf/okf-constants.ts` (`OKF_EXTRACT_VERSION`,
  `OKF_EVENT_SKIP_SEGMENTS`, `OKF_PATTERN_MAX_CHARS`, `OKF_EVENT_CAP_PER_NODE`,
  `OKF_POINTER_CAP_PER_NODE`, `OKF_POINTER_MAX_CHARS`, `OKF_PATH_MAX_CHARS`).
- Helpers it relies on:
  - `server/src/logs/change-surface/path-normalise.ts` — `resolveRepoPath(absPath, roots)` (rule 3)
    and `truncateChangedPath` (`CHANGED_PATH_MAX_LENGTH` = 1024);
  - `packages/bash-view/src/bash-analyze.ts` — `analyzeBash` and its `readAccess` field (rule 5,
    documented in [bash-command-view](bash-command-view.md) rule 5.9);
  - `server/src/logs/okf/server-bash-parser.ts` — `getServerBashParser()`, the server's
    `tree-sitter-bash` loader (WASM from `dist/wasm/`, else `node_modules`).
- Callers: `server/src/logs/okf/okf-access-writer.ts` (`writeSessionOkfAccess`,
  `rebuildOkfAccessForNodes`) from ingest, import, the file-stats heal and
  `recompute-all-sessions`; `okf-facts.service.ts` for the facts route.
- Twins: none.
- Test: `server/src/logs/okf/okf-access-extractor.algo.spec.ts` (jest, with the real server
  parser).

## Input and output

`extractOkfDetail(entries, roots, parser, { isSubagentLog, snapshotFiles })` takes the parsed
NDJSON lines of one `claude` / `claude-subagent` log, the session's candidate repo roots, the Bash
parser (`null` skips Bash calls only) and, optionally, `snapshotFiles` — the files of the root's
bound OKF snapshot as `repoRelPath → { size, hash }`. It returns
`{ access, events, pointers, seq, truncated }`:

- `access`: `{pathKey, op, afterOwnEdit, bytes, calls, seq, rangedCalls, rangedBytes, searchHits}[]`
  in the order the rows were first created; one stored row per `(pathKey, op, afterOwnEdit)` of
  the node. `extractOkfAccess(...)` returns only this list.
- `events`: `{ord, op: 'read'|'search'|'write', path, rangeFrom, rangeTo, pattern}[]` (rule 13).
- `pointers`: `{articlePath, articleHash, readOrd, pointer, isNew, followed, partial}[]` (rules
  14-16).
- `seq`: `{ord, op, path, offset?, limit?, pattern?, newPointers?, hit?}[]`, `op` one of `kb_read`,
  `kb_search`, `kb_write`, `read`, `search`, `write` (rule 17).
- `truncated`: an event or pointer cap was hit (rule 18).

## Rules

1. **Lines.** In a root log (`isSubagentLog` false) lines with `isSidechain: true` are skipped
   (they belong to a sub-agent, which has its own log); in a sub-agent log every line counts. The
   current directory is the `cwd` of the latest line that has one.
2. **Bytes (DD-1).** A call's bytes = UTF-8 bytes of its `tool_result` content: the string, or
   the sum of the `text` blocks (image and other blocks count 0). The first `tool_result` of a
   `tool_use_id` wins. Not `computeToolResultBytes` (UTF-16, Read only).
3. **Path resolution (DD-5, DD-6).** A path is made absolute against, in order, the Bash
   `workDir` (Bash only) and the line `cwd` (`\` → `/`; an absolute path — `/…` or `X:/…` — is
   kept; a `~` path, or a relative one with no absolute base, is dropped). Then
   `resolveRepoPath(abs, roots)` strips the longest matching root (case-insensitive, on a `/`
   boundary, the rest keeps its case; msys `/d/…` also tried as `D:/…`). The root itself resolves
   to `''`. No match, or no usable root at all, drops the path (FR-2).
4. **Op per tool (DD-3).**

   | Tool call | op | key |
   |---|---|---|
   | Read (`file_path`; `offset` / `limit` make it ranged, see below) | `read` | file |
   | Edit, MultiEdit, Write (`file_path`), NotebookEdit (`notebook_path`) | `write` | file |
   | Grep with `path` that has an extension and no trailing `/` | `grep` | file |
   | Grep with a folder `path`, or no `path` (cwd) | `grep` | folder |
   | Glob (`path` or cwd, plus the static prefix of `pattern`) | `list` | folder |
   | Bash `readAccess` kind `read` | `read` | file |
   | Bash `readAccess` kind `grep` | `grep` | file, or folder when the path ends `/` or has no extension |
   | Bash `readAccess` kind `list` | `list` | folder |
   | Bash `changes` | `write` | file |
   | any other tool | nothing | |

   The static prefix of a glob is its leading segments before the first segment with `* ? [ ] {
   }`; a pattern without any glob character names a file, so its folder is listed.

   **Ranges (DD-4).** A `read` access may carry a line range `{from, to}` (1-based, `to`
   inclusive, `to: null` = to the end, a negative `from` counts from the end):

   | Call | Range |
   |---|---|
   | Read with `offset` and / or `limit` (finite numbers ≥ 0, floored) | `{ from: offset ?? 1, to: limit ? from + limit - 1 : null }` |
   | Bash `sed -n 'a,bp'` | `{ from: a, to: b }` |
   | Bash `head -n N` / `head -N` | `{ from: 1, to: N }` |
   | Bash `tail -n N` | `{ from: -N, to: null }` |

   The Bash ranges come from `BashReadAccess.range` ([bash-command-view](bash-command-view.md)
   rule 5.9). A Read with neither `offset` nor `limit`, and every other Bash read, has no range.
   A ranged access adds `rangedCalls += 1` and `rangedBytes += <its share>` to its row; both are
   also counted in `calls` / `bytes`. Only `read` accesses carry a range.

   **Patterns.** A `grep` access carries the Grep tool's `pattern`, or the Bash
   `BashReadAccess.pattern`; Glob and `list` carry none. Patterns feed only the code events and
   the sequence (rules 13, 17), never the access row.

   **`ls <file>` (FR-8).** A Bash `list` access whose path has an extension and no trailing `/`
   (`ls docs/kb/a.md`) lists one named file: it produces no folder row and no access at all.
5. **Bash.** The command goes through `analyzeBash(parser, command)` (the same analysis the
   client's Bash view runs). With no parser, an empty command or a parse exception the call adds
   nothing.
6. **Keys (DD-4).** A file key is the repo-relative path; a folder key is the repo-relative folder
   plus `/`, the repo root is `/`. Only file keys ending `.md` (any case) are stored; folder keys
   are always stored. Keys longer than 1024 characters are cut to 1024 (`truncateChangedPath`).
7. **Duplicates.** A `tool_use` id seen a second time in the node is skipped whole (DD-8). Inside
   one call a repeated `(key, op)` is kept once.
8. **Byte split (DD-2, value-view DD-7).** The call's bytes are split over its read-side accesses
   (every op except `write`), **before** the `.md` filter. `write` accesses get 0. Each stored
   access adds its share to its row and `calls += 1`.
   - **Proportional:** when `snapshotFiles` is given and every read-side target is a file with a
     known, finite size ≥ 0 in it, and the sizes sum to more than 0, target *i* gets
     `floor(bytes × size_i / Σsize)`; the first in order also gets the remainder.
   - **Even (fallback):** otherwise — no `snapshotFiles`, a folder target (folders never have a
     size), a file missing from the snapshot or a zero size sum — each gets `floor(bytes / N)`,
     the first in order also the remainder.
   - A snapshot that binds to the session after extraction leaves the even split in place until
     the next recompute; binding never re-extracts.
9. **Own edit (DD-7).** Calls are walked in transcript order with the set of keys this node has
   written so far. A `read` / `grep` access of a key already in the set goes to the row with
   `afterOwnEdit = true`; the call's own writes join the set only after the call. `list` and
   `write` rows are always `false`.
10. **Order (DD-27).** `seq` = the 1-based rank of the key's first stored access in the node; every
    row of the same key (any op, own edit or not) carries the same `seq`.
11. **Search hits (DD-6, FR-8).** A `grep` / `list` access adds `searchHits += 1` to its row when
    the call's result is not `is_error: true` and its text, trimmed, is not empty and is neither
    `No files found` nor `No matches found`. A call with no result is no hit.
12. **Call ordinal (DD-2).** `ord` = the 1-based index of a `tool_use` block among the node's tool
    calls in transcript order, after the duplicate-id rule (rule 7); a call that yields no access
    still takes its ordinal. Events, pointer rows and the sequence share this counter.
13. **Code events (DD-5).** For each call, one event per resolved access — `(op, path)` kept once
    per call:
    - **Op:** `read` → `read`, `grep` / `list` → `search`, `write` → `write`.
    - **Path:** the repo-relative key before the `.md` filter (folders end in `/`, the repo root is
      `/`), so code files are kept too.
    - **Skipped:** a `.md` file present in `snapshotFiles` (that is a KB article, already an access
      row); with no `snapshotFiles` nothing is skipped this way. Also any path with a segment in
      `OKF_EVENT_SKIP_SEGMENTS` (`node_modules`, `.git`, `dist`, `build`, `out`, `coverage`,
      `.next`, `target`, `tmp`; case-insensitive) and any path longer than `OKF_PATH_MAX_CHARS`
      (1024) — dropped, not truncated.
    - **Fields:** `rangeFrom` / `rangeTo` from the access range (rule 4), else `null`; `pattern`
      from the access pattern cut to `OKF_PATTERN_MAX_CHARS` (200), else `null`.
14. **Pointers (DD-8).** `extractPointers(text, roots)` takes every back-ticked span
    `` `([^`\n]{1,512})` `` (`OKF_POINTER_MAX_CHARS`) of a KB read's result text and normalises it:
    1. trim; drop it when empty, when it contains whitespace, or when it starts with `http`, `-`,
       `$`, `<` or `@`;
    2. `\` → `/`; strip a trailing `:\d+(-\d+)?`, then a `#…` anchor, then any leading `./`;
    3. a glob (`* ? [ ] { }`) is reduced to its static prefix (rule 4); a trailing `/` is dropped;
    4. drop it when it is empty or starts with `~`; keep it only if it contains `/` or has an
       extension;
    5. an absolute path goes through `resolveRepoPath` (rule 3) and is dropped when it does not
       resolve or resolves to the repo root.
    Pointers are de-duplicated within one text, first occurrence order kept.
15. **Pointer rows (DD-9, DD-10).** Only a call whose stored `read` accesses are exactly one `.md`
    article key yields pointer rows for that article, with `readOrd` = the call's `ord` and
    `articleHash = snapshotFiles.get(path)?.hash ?? null`:
    - **Partial:** the result is `is_error: true`, empty after trimming, or starts with
      `<persisted-output>` (`isPartialResult`). An error result yields no pointers at all.
    - **One row per pointer** of the result text, every row carrying the read's `partial` flag.
    - **New:** the pointer string is not a substring of the node's earlier text — every earlier
      user line (string content, `text` blocks including the sub-agent prompt and
      `system-reminder` text, `tool_result` texts) and every earlier assistant `text` block,
      accumulated in transcript order.
    - **Followed:** some later call of the node (`ord > readOrd`, any op, KB or code) touched the
      pointer path or a path under `pointer + '/'`.
    - **No pointers but partial:** one row with `pointer = ''`, `isNew = false`, `partial = true`,
      so a cut or failed read is still counted.
    - **Multi-file read:** a call that reads more than one `.md` article stores no pointers; each
      article gets one `''` partial row.
16. **Prior text order.** Within an assistant line, `text` blocks join the earlier text in block
    order, so a pointer the agent wrote itself before the read is not new. A read's own result
    joins the earlier text only after the call, so its pointers are judged against what came
    before it.
17. **Sequence (DD-1a).** `seq` lists every access of every call in order, uncapped: a KB article
    (an `.md` file of `snapshotFiles`, or any `.md` file when there is none) as `kb_read` /
    `kb_search` / `kb_write`, a code path kept by rule 13 as `read` / `search` / `write`. A ranged
    item carries `offset = from` and, when `to` is known, `limit = to - from + 1`; a pattern item
    carries `pattern`; a single-article KB read carries `newPointers` (its new pointers); a search
    item (`kb_search` / `search`) carries `hit`, the rule-11 hit test of its call's result (an error,
    empty, `No files found` or `No matches found` result is `false`). `hit` is derived per request
    from the transcript (the trail and facts routes), never stored.
18. **Caps.** At most `OKF_EVENT_CAP_PER_NODE` (3000) events and `OKF_POINTER_CAP_PER_NODE` (5000)
    pointer rows per node. Anything beyond is dropped and `truncated = true`, which the writer
    stores as `sessions.okf_events_truncated`. Access rows and the sequence are not capped.

## Edge cases

- Read with `offset` / `limit` keeps the whole file key, with the bytes actually returned, and
  counts as a ranged read (`rangedCalls`, `rangedBytes`): OA-01, OA-18; Bash `sed -n` is ranged
  too: OA-02.
- `grep` on a file with output is a search hit: OA-03.
- Bash fragments: `sed -n` OA-02, `grep -n` on a file OA-03, `cat` OA-04, `cd <dir> && cat` (Bash
  `workDir`) OA-17.
- Multi-file `cat` splits the bytes, remainder to the first: OA-05; a non-`.md` path takes its
  share and is then dropped: OA-06.
- Folder access: `grep -rn` over a folder OA-07, `ls` OA-08, Glob OA-09, Grep tool with a folder,
  with no path (repo root `/`) and with a file OA-10.
- Edit then Read / grep of the same file: OA-11.
- Paths outside every root, and a sibling folder that only shares a prefix with the root: OA-12;
  no roots at all: OA-16.
- `\` paths and a lower-case drive letter fold onto one key: OA-13.
- **FR-6 — "identical Reads in pairs" in sub-agent data.** Investigated on the dev database
  (`docs/tasks/done/2026-10-27-okf-usage-tab/fr6-investigation.md`): no `tool_use` id repeats in
  any transcript and no sub-agent log is uploaded twice. The pairs are **one call recorded by two
  sources** — the hook's `PostToolUse` record in the root's `artisyn` log (Windows `\` spelling,
  `agent_id` set) and the sub-agent transcript's `tool_use` (mostly `/`), under the same
  `tool_use_id` — which is why they looked like two agents. This extraction reads only
  `claude` / `claude-subagent` transcripts, never `artisyn` records, so the pair is counted once.
  The duplicate-id guard (rule 7) stays as a safety net: OA-14.
- Non-`.md` file: OA-15; upper-case `.MD`: OA-22.
- `text` blocks counted in UTF-8, images 0: OA-19.
- Sidechain lines skipped in a root log, kept in a sub-agent log: OA-20, OA-21.
- Bash write (`sed -i`) and the Write tool: OA-22. No parser: Bash adds nothing, OA-23.
- `head -n` / `tail -n` ranges and their events: OA-24.
- `ls <file>` produces no row (FR-8): OA-25.
- `No files found` / `No matches found` / an error result is no hit, a listing is: OA-26.
- The sequence `hit` of a search item (true, `No matches found`, an error, a blank result): OA-34.
- Size-proportional split: OA-27; even fallback for a file missing from the snapshot and for a
  folder target: OA-28.
- Code events: ranges, patterns (cut to 200), Glob without pattern, skipped segments, snapshot
  `.md` files left out: OA-27, OA-28, OA-29; the event cap: OA-30.
- Pointer normalisation (`:12-20`, `#anchor`, `./`, glob, `http…`, spaces, `-flag`, absolute
  paths), a pointer named in the prompt is not new, followed by a later read or a search under it:
  OA-31.
- Partial reads (`<persisted-output>`, empty, error): OA-32; a multi-file KB read stores only
  `''` partial rows: OA-27, OA-28; the pointer cap: OA-33.

## Examples

Each row is one transcript. `input.calls` are tool calls in order; for call *k* the test emits an
`assistant` line with one `tool_use` block (`id` = the call's `id`, default `t<k>`, `name`,
`input`) and then a `user` line with one `tool_result` for that id whose `content` is the call's
`result` when given, else a string of `resultBytes` ASCII characters. Every line carries
`cwd` = `input.cwd` (default `/work/acme-app`) and `isSidechain: true` when the call says
`sidechain`. `input.roots` defaults to `["/work/acme-app"]`, `input.subagent` (default false) is
`isSubagentLog`, and a row with `noParser: true` passes `parser = null` (otherwise the real server
parser). `input.prompt` (optional) is the string content of a first `user` line before any call; a
call with `isError: true` gets `is_error: true` on its `tool_result`; a call with `repeat: N` is
emitted N times (ids keep counting `t<k>`). `expected.rows` is the exact `access` result, in order. A row may also give
`input.snapshotFiles` (`{ path: { size, hash } }`, passed as the `snapshotFiles` map) and
`expected.events` / `expected.pointers`, which are then compared with `extractOkfDetail`'s lists,
and `expected.eventCount` / `expected.pointerCount` (list lengths), `expected.truncated` and
`expected.seq` (the exact sequence).

Rows (34): [`docs/algorithm-examples/okf-access-extraction.json`](../../algorithm-examples/okf-access-extraction.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Bytes split over stored (`.md`) accesses only instead of all read-side ones -> OA-06 (1000).
- Remainder given to the last path, or dropped -> OA-05 (500 / 501, or a sum of 1000).
- `write` given a share of the bytes -> OA-11 (Edit 50 bytes), OA-22.
- Grep / `rg` path without extension stored as a file -> OA-07; `ls` path stored as a file ->
  OA-08; Glob listing the pattern's own path -> OA-09 (`docs/kb/**/*.md`).
- Grep with no `path` ignored instead of the cwd -> OA-10 (`/` row).
- `afterOwnEdit` set by the same call's write, or never -> OA-11.
- Root matched as a plain string prefix -> OA-12 (`acme-app2`); case-sensitive root match or
  `\` not converted -> OA-13.
- The second occurrence of a `tool_use` id counted -> OA-14 (`b.md`).
- Non-`.md` file rows kept -> OA-15, OA-06.
- Bash `workDir` ignored -> OA-17 (`index.md` resolved against the repo root).
- `seq` per row instead of per key, or reset per op -> OA-11, OA-18.
- UTF-16 length or image bytes counted -> OA-19 (5, or more than 6).
- Sidechain lines read from the root log -> OA-20; skipped in the sub-agent log -> OA-21.
- Read `offset` / `limit` not counted as ranged -> OA-01 (`rangedCalls` 0).
- A `grep` with output not counted as a hit -> OA-03 (`searchHits` 0).
- A pointer judged new against the read's own result, or against nothing -> OA-31
  (`server/src/known.ts` new), OA-33.
- `tail -n N` stored as `from: N` -> OA-24.
- `ls <file>` kept as a folder row -> OA-25.
- `No files found` or an error result counted as a hit -> OA-26 (`searchHits` 3).
- `hit` set on a non-search item, or `true` for an error / blank result -> OA-34.
- Even split with a snapshot -> OA-27 (501 / 500); proportional split with a folder or an unknown
  size -> OA-28.
- Events not skipping `node_modules` / `dist`, or the pattern not cut -> OA-29; no event cap ->
  OA-30.
- A span with spaces, `http…` or `-flag` kept, or anchors / line suffixes not stripped -> OA-31.
- Pointers taken from an error result, or no `''` row for an empty read -> OA-32; pointers stored
  for a multi-file read -> OA-27.

## Where the result is visible

- Session pane → **OKF** tab: bundle cards (FILES READ, BYTES INTO CONTEXT), the tree's READ /
  WRITE columns and `own_edit` / `folder_scan` markers, the Agents panel's "how agents reached the
  KB" (via `seq`).
- Repository → **OKF** tab: every tile, the histogram, hot files, not-read list and the tree.
- API: `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage`,
  `GET /api/v1/repositories/:repoId/reports/okf-usage`, `GET /api/v2/okf-usage/facts` (`kbReads`,
  `kbSeq`).
- Section reads (`§ section ×N`) and the whole-only `coarse_article` ratio (from `rangedCalls` /
  `rangedBytes`); the `entry: search` marker (from `searchHits`).
- Value signals (yield, searched after, routing miss, dead pointers, catalog) on both OKF tabs
  and the article drill-down — computed from the events and pointer rows by
  [okf-value-signals](okf-value-signals.md).
- `GET /api/v2/okf-usage/facts` per-agent `accessSeq` (the sequence, built on demand).
- `GET …/sessions/:sessionId/okf-usage/trail` (the session OKF tab's agent trail: the sequence
  with `hit`, capped, plus in-area marks — see [okf-value-signals](okf-value-signals.md) rule 11).
- Storage: `session_okf_access`, `session_okf_event`, `session_okf_pointer`, and the
  `sessions.okf_extract_version` / `okf_events_truncated` marker (see
  [../okf-usage.md](../okf-usage.md)).
