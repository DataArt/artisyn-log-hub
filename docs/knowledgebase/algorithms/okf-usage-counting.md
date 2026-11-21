---
type: "Algorithm"
title: "OKF usage counting: reads, tokens, KB cost, files, folders, versions and format of the OKF tabs"
description: "Every number of the session and repository OKF tabs: which access rows count as a KB read, sessions / agents that read the KB, tokens, the KB cost estimate, the file and folder lists against the reference snapshot, the reference-snapshot choice, the team filter, versions and wrong-format groups, and the client's display formats."
tags: [algorithm, okf]
generated: { by: "ai:claude", at: "2026-11-21T23:20:00+04:00" }
reviewed: no
reviewer: none
---

# OKF usage counting: reads, tokens, KB cost, files, folders, versions and format of the OKF tabs

## Purpose

The OKF tabs show one summary line ("KB read in N of M sessions · ≈ X tokens of context · ≈ $Y")
and four views: Versions, Wrong format, Hot files, Explorer. Every number on them comes from one
pure function over the stored access rows ([okf-access-extraction](okf-access-extraction.md)) and
one KB snapshot ([okf-snapshot](okf-snapshot.md)). A wrong rule shows up at once as numbers that
contradict each other on one screen — a file total that is not the sum of its files, a session
counted twice, a cost that does not add up — or as a private (gitignored) KB path leaking into a
team view. The rules below are the whole definition; the service only loads rows.

## Code

- Implementation: `server/src/logs/okf/okf-usage-counting.ts` — `buildOkfUsageView(input)`,
  `pickReferenceRoot(roots)`.
- Path helpers: `server/src/logs/okf/okf-paths.ts` — `bundleOfPath`, `bundleArticles`,
  `isReservedOkfName`, `isDotPathUnderRoot`, `isFolderKey`, `rootPrefix`, `rootFolderKey`,
  `isUnderPrefix`, row type `OkfUsageRow`.
- Team filter: `server/src/logs/okf/okf-team-filter.ts` — `applyOkfTeamFilter(trees, bundles)`.
- Constants: `server/src/logs/okf/okf-constants.ts` — `OKF_BYTES_PER_TOKEN` (4),
  `OKF_DEFAULT_BRANCH_NAMES` (`main`, `master`).
- Metadata rules it calls (`hasHookMeta`, `okfVersionHint`, `articleMetaFlags`,
  `OKF_CURRENT_FORMAT_VERSION`): `okf-metadata.ts`, documented in [okf-metadata](okf-metadata.md).
- Caller: `server/src/logs/okf/okf-usage.service.ts` (`getRepoOkfUsage`, `getSessionOkfUsage`,
  `emptyUsage`) — it loads the rows, the snapshots and the cost figures (rules 13–15) and holds
  no counting rule. Response type `OkfUsageResponse`: `okf-usage.types.ts`.
- Display formats (rules 24–27): `client/src/viewer/lib/okf/okf-format.ts` — `formatApproxTokens`,
  `formatApproxCost`, `formatSpend`, `formatKbShare`.
- Twins: none. The client's explorer tree (`okf/view/okf-explorer-tree.ts`) only sums server
  values and has no rows; scenario `@S-REPO-16` checks its sums.
- Tests: `server/src/logs/okf/okf-usage-counting.algo.spec.ts` (jest; kinds `view`, `teamFilter`,
  `reference`) and `client/src/viewer/lib/okf/okf-format.algo.test.ts` (vitest; kind `format`).

## Rules

Terms. A **path key** is a repo-relative path with `/` separators; a **folder key** ends in `/`
and the repo root is `/`. A **bundle root** has no trailing slash (`docs/kb`; the repo root is
`.` or `''`). A **unit** is a root session on the repo route (`unit: 'sessions'`) and a tree node
— an agent — on the session route (`unit: 'agents'`). A **node** is one session row of a tree
(the root or one sub-agent) with its access rows, `ctxTokens` and `ctxCost`.

### Path helpers

1. **Deepest bundle** (`bundleOfPath(pathKey, bundles)`): among the bundles whose root contains
   the path (root `''` / `.` contains everything; otherwise the path equals the root or starts
   with `root/`; a folder key is compared without its trailing `/`), the one with the longest
   root. `null` when there is none, or when the path taken relative to that deepest root has a
   segment starting with `.` (rule 2).
2. **Dot-path** (`isDotPathUnderRoot`): only the segments below the bundle root count, so a bundle
   rooted at `.claude/kb` owns `.claude/kb/a.md`, while `kb/.drafts/a.md` is not KB.
3. **Index files** (`isReservedOkfName`): a file whose base name, lower-cased, is `index.md` or
   `log.md`, at any depth.
4. **Articles** (`bundleArticles(bundle)`): the bundle's listed files without its own `index`,
   without index files (rule 3) and without dot-paths (rule 2).

### Reads and units

5. **Read row.** An access row counts when its `op` is `read` or `grep`, its `pathKey` has none
   of the characters `* ? [ ] { }` (older extractor versions stored glob paths as keys), and
   rule 1 gives a bundle of the reference snapshot. `afterOwnEdit` rows count. `list` and `write`
   rows, dot-paths under a root and paths outside every bundle count nowhere. A folder key counts
   by the same test, so a search over a folder above every bundle root counts nowhere.
6. **Reads and tokens.** `reads` = Σ `calls`; `tokens` = Σ `bytes` / 4 (`OKF_BYTES_PER_TOKEN`),
   never rounded on the server.
7. **Units.** `summary.unitsRead` = distinct units with at least one read row (after the bundle
   filter, rule 19). `summary.unitsTotal` and `summary.spend` are inputs (rules 13, 14) and are
   passed through unchanged.

### KB cost

8. **Node KB cost.** `kbTokens` = Σ tokens of the node's read rows over **every** bundle of the
   snapshot (the bundle filter does not change it). The node is **priced** when `ctxCost` is not
   `null` and `ctxTokens > 0`; then node KB cost = `min(1, kbTokens / ctxTokens) × ctxCost`. An
   unpriced node has no cost.
9. **Row cost.** On a priced node a row's cost = node KB cost × row tokens / `kbTokens` (`0` when
   `kbTokens` is `0`); on an unpriced node the row has no cost. `summary.readsWithoutCost` =
   Σ `calls` of the counted read rows on unpriced nodes.
10. **Sums.** The cost of a file, of a folder's search and of the summary is the sum of its rows'
    costs, so they add up exactly: Σ `files[].cost` + Σ `folders[].search.cost` =
    `summary.cost`. A cost is `null` only when the item has read rows and none of them has a
    cost; it is `0` when it has no read rows.

### Files and folders

11. **Files.** `files[]` holds every file of the shown bundles' lists, each under its deepest
    bundle (rule 1; a file whose deepest bundle is not shown is left out) with `inSnapshot: true`
    and zero numbers when never read; plus every file path with a read row that is not in the
    snapshot, with `inSnapshot: false` and `bundle` = its deepest root. `index` = rule 3.
    `units` = distinct units with a read row on the file. Sorted by `path` ascending (code-unit
    order).
12. **Folders.** `folders[]` has one entry per shown bundle root, per folder between a snapshot
    file and its bundle root, and per folder that has a folder-level read row of its own. A
    folder belongs to the bundle of the file / row that created it. `units` = distinct units with
    a read row on an in-snapshot file under the folder, or a folder-level row on the folder or
    below it — a union, not a sum. `search` = the totals (`units`, `reads`, `tokens`, `cost`) of
    the folder-level read rows whose key is exactly this folder; `null` when there are none.
    Folder-level rows are in no file's numbers. Reads of `inSnapshot: false` files add to no
    folder; `notInSnapshotUnits` = distinct units with such a read. Sorted by `path` ascending.

### Inputs loaded by the service

13. **M (`unitsTotal`).** Repo route: the number of root sessions of the scope (period, branch,
    user, attribute filters; the bundle filter does not change it). Session route: the opened
    node plus its descendants that have a `claude` or `claude-subagent` log; the opened node
    always counts.
14. **T (`spend`).** Σ `session_costs.cost` over every node (root and descendants) of the M trees
    (repo) or of the opened tree (session); `null` when no node has a non-null `cost`.
15. **Context figures.** Per node: `ctxTokens` = `input_tokens + cache_write_tokens`
    (`session_stats`; `0` without a row); `ctxCost` = `cost_input + cost_cache_write_5m +
    cost_cache_write_1h + cost_cache_read` (`session_costs`, a NULL part counts as `0`), and
    `null` when `session_costs.cost` is NULL or the row is missing. Stale cost rows are used as
    they are. Output cost is not part of it.

### Snapshot, filters, versions, format

16. **Reference snapshot** (`pickReferenceRoot(roots)`, repo route; `roots` = the scoped roots
    that have a stored snapshot): the newest by `startTime` among those whose `branch` is `main`
    or `master`; when there is none, the newest of all; `null` for an empty list. An unparseable
    `startTime` is older than any date; on a tie the earlier list item wins. Session route: the
    snapshot bound to the tree's root. `snapshot.branch` = that root's branch (may be `null`),
    `snapshot.takenAt` = the snapshot's stored creation time.
17. **No snapshot.** `bundles: null` or `snapshot: null` → `snapshot: null`, every array empty,
    every number `0` (also `unitsTotal`), `cost` and `spend` `null`, `format: null`. `unit` and
    `currentFormat` are still set.
18. **Team filter** (`applyOkfTeamFilter`, team view only, before counting). Let *ignored
    anywhere* = every file path flagged `ignored` — by itself or through its bundle's `ignored`
    — in any tree's own snapshot or in the reference bundles.
    - A tree without its own snapshot keeps no rows (it still counts in M).
    - Otherwise the tree's *visible files* = the files of its own snapshot's non-ignored bundles
      that are not `ignored` and not ignored anywhere. A file row is kept when its path is a
      visible file; a folder row when at least one visible file lies under the folder (`/` =
      any).
    - Reference bundles: ignored bundles are dropped; from the others every file that is
      `ignored` or ignored anywhere is removed.

    In the personal view the filter does not run: a tree without its own snapshot is counted
    against the reference snapshot like any other, and an ignored bundle is listed with
    `versions[].ignored: true`.
19. **Bundle filter** (`bundle`, repo route). A value equal to a bundle root narrows `versions`,
    `format`, `files`, `folders`, `notInSnapshotUnits` and every read number of the summary
    (`unitsRead`, `reads`, `tokens`, `cost`, `readsWithoutCost`) to the rows and files whose
    deepest bundle is that one. `unitsTotal`, `spend` and `bundleRoots` stay those of the whole
    scope, and a row's cost stays what it is without the filter (rule 8). An unknown or absent
    value means all bundles.
20. **`bundleRoots`**: every bundle root of the (team-filtered) snapshot, ascending.
    **`currentFormat`** = `OKF_CURRENT_FORMAT_VERSION`.
21. **`snapshot.hasMeta`** = some bundle of the whole snapshot has a file with `meta`
    (`hasHookMeta`, hook 3.1.0+). Without it `versions` is `[]` and `format` is `null`; files,
    folders and the summary are counted as usual.
22. **Versions** (with `hasMeta`): one row per shown bundle, by `root` ascending — `files` = the
    length of the bundle's file list (index files included), `okfVersion` = the declared version
    or `null`, `older` = `okfVersionHint(okfVersion)` ([okf-metadata](okf-metadata.md) rule 1;
    `true` for an undeclared version), `ignored` = the bundle's flag.
23. **Format** (with `hasMeta`): over the articles (rule 4) of the shown bundles, with
    `articleMetaFlags(file, bundle, refMs)` ([okf-metadata](okf-metadata.md) rules 3–6). `refMs`
    is now on the repo route and the opened session's start on the session route. `articles` =
    their count; `indexFiles` = all listed files − `articles`; an article joins the group of
    every problem it has — `no_front_matter`, `no_type`, `v01_timestamp`, `deprecated` (with
    `supersededBy` when resolved), `past_stale_after`; groups come in this fixed order, empty
    groups are omitted, files inside a group by `path` ascending; `withProblems` = distinct
    articles in at least one group. In a team view (`teamView`) a `supersededBy` is listed only
    when its target is a file of the team-filtered snapshot (any bundle); otherwise the
    article stays in `deprecated` without it, so the path of a hidden file never leaks.

### Display formats (client)

24. **`formatApproxTokens(n)`**: `n ≤ 0` or not finite → `0`; `n ≥ 1,000,000` → `n / 1,000,000`
    with two decimals + `M`; `n ≥ 100,000` → `n / 1000` rounded to an integer + `K`; else
    `n / 1000` with one decimal + `K`. `3771600` → `3.77M`, `270000` → `270K`, `55000` → `55.0K`,
    `600` → `0.6K`.
25. **`formatApproxCost(v, withSign)`**: `null` → `—`; `0 < v < 0.005` → `< 0.01`; else two
    decimals (`0` → `0.00`). `withSign` puts `$` before the number: `$52.61`, `< $0.01`.
26. **`formatSpend(v)`**: `v ≥ 1000` → rounded to an integer with `,` thousands separators; else
    two decimals; always with `$`. `3017.4` → `$3,017`, `45.58` → `$45.58`.
27. **`formatKbShare(cost, spend)`**: `null` when `cost` or `spend` is `null` or `spend ≤ 0`.
    `p = cost / spend × 100`: `p ≤ 0` → `0 %`; `p ≥ 10` → rounded integer + ` %`; `p ≥ 0.1` →
    one decimal + ` %`; else `< 0.1 %`. `52.61 / 3017` → `1.7 %`.

## Edge cases

- `read` and `grep` count, `list` and `write` do not: UC-01; a file touched only by `grep` is
  opened: UC-02.
- Folder-level `grep`: in `folders[].search`, in `unitsRead` and the totals, in no file: UC-03.
- `.md` outside every bundle and a glob path key: UC-04; dot-path under a root: UC-07.
- Nested bundle — deepest root wins, Σ `versions[].files` = in-snapshot files: UC-05.
- `index.md` / `log.md`: `index: true`, in the totals, not in `format.articles`: UC-06.
- Read file absent from the snapshot: UC-08.
- Folder `units` is a union of units, not a sum over files: UC-09.
- Cost: share × context cost and per-file costs adding up to `summary.cost` UC-10; share capped
  at 1 UC-11; a node without a cost (tokens counted, `readsWithoutCost`, `cost: null` when
  nothing is priced) UC-12; `ctxTokens` 0 on a priced node UC-13.
- Bundle filter keeps `unitsTotal` / `spend` / `bundleRoots`: UC-14.
- No snapshot: UC-15.
- `unit: 'agents'` — N of M over nodes: UC-16.
- Format groups, distinct `withProblems`, deprecated with `supersededBy`, `refMs` for
  `stale_after`: UC-17; snapshot without metadata: UC-18; `older` for `0.1` and for an undeclared
  version: UC-19.
- Team filter: ignored bundle and ignored file leave every number UC-20; a tree without its own
  snapshot contributes no reads UC-21; a `supersededBy` pointing at a hidden or unlisted file
  is left out, one pointing at a visible file stays UC-21b.
- Reference snapshot: newest root on `main` wins over a newer feature-branch root UC-22; no
  `main` / `master` → newest of all, empty list → `null` UC-23.
- Display formats, each with its boundary values: UC-24 … UC-27.

## Examples

Rows carry a `kind` picking the function.

- **`view`**: `buildOkfUsageView(input)`; `input` is an `OkfCountingInput` — `unit`, `bundles`
  (snapshot bundles as `normaliseSnapshot` returns them, or `null`), `snapshot`, optional
  `bundle`, `nodes[]` (`unit`, `rows[]` of `{pathKey, op, bytes, calls}`, `ctxTokens`,
  `ctxCost`), `unitsTotal`, `spend`, `refMs`. Shorthands: a file is a path string or
  `{path, ignored?, meta?}`; a bundle's `index` defaults to `<root>/index.md` and `ignored` to
  `false`; a node's `ctxTokens` defaults to `0` and `ctxCost` to `null`. `expected` lists the
  response keys the row is about — a subset match: listed keys only, arrays whole (same length,
  each element a subset), numbers within the row's `tol` (exact without one).
- **`teamFilter`**: `applyOkfTeamFilter(input.trees, input.bundles)`, then `buildOkfUsageView`
  over the filtered bundles and the filtered trees' nodes (unit = the tree's `rootId`, the other
  fields from `input`); a tree is `{rootId, snapshot: {bundles} | null, nodes: [{rows}]}`;
  `expected` as for `view`.
- **`reference`**: `pickReferenceRoot(input.roots)` (`{id, startTime, branch}`); `expected.id` =
  the chosen root's `id`, or `null` (UC-23b: the empty list).
- **`format`** (client): `input.fn` names one of the four functions of rules 24–27 and
  `input.calls` is a list of argument lists; `expected.results` is the list of returned strings
  (`null` where the function returns `null`).

Rows: [`docs/algorithm-examples/okf-usage-counting.json`](../../algorithm-examples/okf-usage-counting.json) — test data for the table tests; the rules above are enough to understand the algorithm. Rows of kind `format` are run by the client test only, the other kinds by the server test only.

## Mutations

- `list` / `write` rows counted as reads -> UC-01; `grep` rows ignored -> UC-02.
- A folder-level row added to a file or dropped from the totals -> UC-03.
- Paths outside every bundle or glob keys counted -> UC-04; dot-paths counted -> UC-07.
- A nested bundle's file counted in the outer bundle (or in both) -> UC-05.
- Index files left out of the totals, or counted as articles -> UC-06.
- A file missing from the snapshot dropped, or listed as `inSnapshot: true` -> UC-08.
- Folder `units` summed over its files -> UC-09.
- Cost spread by `calls` instead of tokens, or the share taken per file instead of per node ->
  UC-10; share not capped -> UC-11; an unpriced node priced as `0` (`cost: 0` instead of `null`)
  or its tokens dropped -> UC-12; division by a zero `ctxTokens` -> UC-13.
- The bundle filter narrowing `unitsTotal` or `spend` -> UC-14.
- Zero-filled arrays instead of the empty response -> UC-15.
- Units taken per root on the session route -> UC-16.
- `withProblems` counting group entries, groups out of order, `refMs` ignored -> UC-17; versions
  or format built without metadata -> UC-18; an undeclared version not `older` -> UC-19.
- An ignored file kept in a team view, or kept in the file list with zero reads -> UC-20; a
  snapshot-less tree counted against the reference snapshot in a team view -> UC-21.
- The newest root taken regardless of branch -> UC-22; `null` when no default-branch root exists
  -> UC-23.
- Wrong thresholds or rounding in a display format -> UC-24 … UC-27.

## Where the result is visible

- Session pane → **OKF** tab and Repository → **OKF** tab: the summary line, Versions, Wrong
  format, Hot files and the Explorer (all of it).
- API: `GET /api/v1/repositories/:repoId/reports/okf-usage`,
  `GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage` (`OkfUsageResponse`).
- Architecture and compatibility: [../okf-usage.md](../okf-usage.md).
