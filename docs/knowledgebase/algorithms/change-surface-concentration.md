---
reviewed: 2026-10-15
reviewer: ai
---

# Concentration: how focused a change is

## Purpose

One number from 0 to 100 answers "how close together are the files this session changed". 100
means every file sits in one folder; low values mean the change is spread over unrelated folders
and modules (more merge conflicts, harder review). The Change surface tab, the Summary tile, the
Analytics chart and the Change Surface report all show it, and all take the number from one
function. Only the Analytics chart colours its bars with a client copy of the band rule (its
buckets carry no band).

## Code

- Implementation: `server/src/logs/change-surface/change-surface-metrics.ts`
  (`computeChangeSurface`, `concentrationBand`).
- Twins:
  - the merge rule (rule 1) has a server copy, `mergeFileRows` in
    `server/src/logs/change-surface/change-surface.service.ts`, which builds the tab's file list; it
    runs the `facts` rows that pin `changedFiles`, `byChangeKind` or line counts (one file per
    path key, lines summed, the same change-kind precedence). It differs on purpose for a row
    with no repo-relative path that is not marked outside: the file list shows it as its own
    file (keyed by `pathKey`), while the metric leaves it out; the rows do not feed it such rows;
  - the band rule (rule 8) has a client copy, `zoneOf` / `BAND_ZONES` in
  `client/src/viewer/lib/change-surface-ui.ts`, used for the Analytics chart's bar colours; it
  runs the `band` rows except `null` (the chart draws no bar then). Everything else the client
  renders from the server's numbers
  (`client/src/viewer/pages/repository/session-log/tree-code-impact.ts` only re-labels them).
- Tests:
  - `server/src/logs/change-surface/change-surface-metrics.algo.spec.ts` (all rows, and the
    `facts` rows again against `mergeFileRows`);
  - `client/src/viewer/lib/change-surface-ui.algo.test.ts` (`band` rows).

## Input and output

Input: a list of changed-path facts, one row per logical path per session. Paths are already
normalized relative to the repo root **before** this function: the writer
(`session-changed-paths-writer.ts`, `path-normalise.ts`) fills each row's case-folded keys
(`relPathKey`, `folderKey`, `topModuleKey`) next to the original-case `relPath` and `folder`,
and line counts arrive as numbers. This function only compares those keys; a missing folder
or module key is read as the root `.`, and empty segments inside a folder key are ignored when
counting depth (`a//b` has depth 2). The writer never writes an empty folder key `''` (a root
file gets `.`), so the code's handling of it is not part of the rule. A folder whose first
segment is empty gets the module label `.`; the writer drops empty segments, so an empty module
key does not occur. `pathKey` (the identity of
an outside row) is also built by the writer, from the case-folded path. The writer also keeps its
own per-session counters in `session_stats` (`countersFor`), which count differently and are not
this algorithm.
The module's display label is the first segment of the original-case `folder` of the first file
seen in it.

Options: `computed` (default `true`) is passed through to the output; the read services pass
`false` for a session never recomputed, so it shows "no data". `repoRootKnown` can be passed to
override the derivation in rule 10 (CS-34); no caller does today. A row is **outside
the repo** when it has `outsideRepo` set, or has no repo-relative path because no repo root was
known; such rows never take part in the spread numbers. The writer never gives a row marked
outside a repo-relative path, so checking either condition alone would behave the same on real
input.

Output (the fields the rows pin): `changedFiles`, `foldersTouched`, `concentration` (integer
0..100 or `null`), `band` (`focused`, `mixed`, `scattered` or `null`), `filesPerFolder`,
`largestFolderShare`, `folderEntropyNorm`, `meanPathDistanceHops`, `commonAncestorDepth`,
`topLevelModules`, `linesAdded`, `linesRemoved`, `byChangeKind`, `outsideRepoFiles`,
`outsideRepoLinesAdded`, `outsideRepoLinesRemoved`, `repoRootKnown`. The table-style outputs
(`byExtension`, `byFileKind`, `folderDistribution`, `singleFileFolders`, `diffCoveredFiles`) are
plain counts and are not part of this doc. `null`, not 0, means "nothing in the repo changed": 0 would read as
"maximally scattered".

## Rules

1. **Merge.** In-repo rows are merged by path, ignoring case: a file counts once even if several
   sessions changed it. Lines added and removed are summed. The change kind: `added` wins over
   everything; `deleted` wins over `modified` but not over `added`.
2. Let `F` = number of files, `K` = number of distinct folders (case-insensitive), `n_i` = files
   in folder `i`, `T` = number of distinct top-level modules (the first segment of the folder; a
   file in the repo root is module `.`). `d(f)` = segment count of folder `f` (the root `.` has
   0), `c(u, v)` = number of leading segments folders `u` and `v` share.
3. If `F = 0`: `concentration`, `band` and every spread number are `null`. Stop.
4. Four components, each 0..1, higher = more focused:
   - entropy: `H = -sum((n_i / F) * ln(n_i / F))`; `folderEntropyNorm = H / ln K`, shown as 0
     when `K = 1`; `E = 1 - folderEntropyNorm`, and `E = 1` by definition when `K = 1`;
   - largest share: `S = max(n_i) / F`;
   - module focus: `M = 1 / T`;
   - proximity: for each pair of folders `sep(u, v) = ((d(u) - c) + (d(v) - c)) / (d(u) + d(v))`
     (0 if both are the root); `D = 1 - mean(sep)` over all pairs, `D = 1` when `K < 2`.
5. **Small-change blend** (`SMALL_CHANGE_MAX_FILES = 6`): if `F <= 6`,
   `smallness = 1 - (F - 1) / 6`, `closeness = smallness * D`,
   `E' = E + closeness * (1 - E)`, `S' = S + closeness * (1 - S)`; otherwise `E' = E`, `S' = S`.
6. `score = 0.40 * E' + 0.25 * S' + 0.20 * M + 0.15 * D`;
   `concentration = clamp(round(100 * score), 0, 100)` with `round` = round half up.
7. **Small-change floor** (`FOCUSED_SMALL_CHANGE_MAX_FILES = 5`): if `1 <= F <= 5`,
   `concentration = max(concentration, 60)`.
8. **Band**: `>= 60` focused, `>= 40` mixed, otherwise scattered; `null` gives `null`.
9. Displayed numbers use the **raw** values, never the blended ones: `filesPerFolder = F / K`,
   `largestFolderShare = S`, `folderEntropyNorm` as in rule 4 (all rounded half up to 6
   decimals);
   `meanPathDistanceHops` = mean of `(d(u) - c) + (d(v) - c)` over pairs, rounded half up to
   1 decimal (0 when `K < 2`); `commonAncestorDepth` = number of leading segments shared by every folder.
   `topLevelModules` lists each module once, in the original case of the first file seen in it,
   sorted by the case-folded module key (so `alpha` comes before `Zed`).
10. Outside-repo rows are counted separately: `outsideRepoFiles` is the number of distinct
    `pathKey`s, and `outsideRepoLinesAdded` / `outsideRepoLinesRemoved` sum their lines (several
    rows of one path add up). `repoRootKnown` is false only when there are rows and every one of
    them lacks a repo-relative path without being marked outside the repo.

## Edge cases

- Nothing in the repo: CS-13.
- One folder, any `F`: CS-01, CS-02 (with `F > 6` only "E = 1 when K = 1" keeps it at 100).
- Small change in far-apart folders: floor 60 (CS-04, CS-05) vs no floor at `F = 6` (CS-06).
- Blend boundary `F = 6` / `F = 7`: CS-07, CS-08.
- Band boundaries 60/59 and 40/39, the ends 0 and 100, and `null`: CS-10a..CS-10g.
- Nested folders at different depths: CS-22. Folders are a union across sessions: CS-23.
- No repo root known at all: CS-24.
- One file in two sessions, path case: CS-11.
- File outside the repo: CS-12.
- Rounding on .5: CS-06 and CS-18. In CS-06 the exact value of `100 * score` is 7.5 and the
  floating-point sum the code makes also lands on 7.5 (observed, not guaranteed by the formula),
  which rounds half up to 8; no epsilon is added in code. In CS-18 the sum 0.125 + 0.1
  rounds to 0.225 and times 100 to exactly 22.5 in floating point (also observed), which tells
  half up (23) from half to even (22). CS-06 also sits on the `F = 6` floor boundary that
  scenario S-SESS-09 checks end to end; the row is that boundary at unit level.
- Change kinds merged across sessions: CS-11, CS-15, CS-16, CS-17.
- Several rows of one outside path, and a row with no known repo root: CS-19, CS-20.
- One folder with `F > 6`, displayed spread numbers: CS-02. Module order: CS-21.
- Display rounding half up on an exact tie: `round6` CS-36, `round1` CS-38.
- Equivalent on real input: dropping the `outsideRepo` check (see Input and output).
- Unreachable guards (no row): `M = 1` with no module, `p > 0` in the entropy, the clamp to
  0..100 (the score is always within 0..1), `sep = 0` for two root folders (only `''` and `.`
  could both have depth 0, and the writer never writes `''`), `commonAncestorDepth` of no folders
  and `ln` of zero folders (both behind the `F = 0` stop).
- `computed: false` passed through: CS-30. Empty segments: CS-31. Missing keys read as root:
  CS-32.

## Examples

Input forms:

- `{"folders": {"<folder>": <files>}}`: the test creates `<files>` files `f1.ts`, `f2.ts`, ...
  in each folder (`.` = repo root), one session, kind `modified`, no line counts;
- `{"facts": [...]}`: explicit rows `{path, added, removed, kind}` (several rows for one path
  stand for the same file changed in several sessions of the scope);
- `"outside": [{path, added, removed}]` next to `folders` (`removed` defaults to 0): extra
  outside-repo rows (`"unrooted": true`
  makes it a row with no repo-relative path that is not marked outside, as written before a
  repo root was known);
- `{"band": <value>}`: calls the band rule alone, `expected.band` is its result;
- `"options": {...}` next to the other forms: passed as the function's options; a fact may set
  `"noKeys": true` to leave its folder and module keys `null`.

`expected` lists only the fields the row pins; numbers are compared exactly (the code already
rounds them).

Rows (44): [`docs/algorithm-examples/change-surface-concentration.json`](../../algorithm-examples/change-surface-concentration.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `E = 0` instead of 1 when `K = 1` -> CS-02 (60).
- No blend at `F = 6` (`<` instead of `<=`) -> CS-07 (40).
- Blend at every `F` (no `F <= 6` condition; `smallness` turns negative above 7) -> CS-09 (28).
- Entropy normalised by `ln F` instead of `ln K` -> CS-08 (73).
- Equivalent: blending also at `F = 7` (`smallness` is exactly 0 there).
- Floor up to 6 files -> CS-06 (60); no floor -> CS-04, CS-05.
- Blended share displayed -> CS-03 (`largestFolderShare` 0.777778).
- `sep` not divided by `d(u) + d(v)` -> CS-03.
- Band boundaries `>` instead of `>=` -> CS-10a, CS-10c.
- Files summed across sessions instead of merged -> CS-11; case-sensitive merge -> CS-11.
- `deleted` beats `added` -> CS-15, CS-16; last write wins -> CS-15; `modified` beats `deleted`
  -> CS-17.
- Round half to even -> CS-18 (22).
- Outside files counted per row -> CS-19; rows without a root left out of the outside count ->
  CS-20.
- `NaN` entropy at `K = 1`, or hops/ancestor wrong for one folder -> CS-02.
- Modules sorted by label -> CS-21; module label from the last file instead of the first ->
  CS-27; folders compared case-sensitively -> CS-27.
- `modified` replacing an earlier `deleted` -> CS-25.
- Outside removed lines added to `linesRemoved` -> CS-26.
- `foldersTouched` counted per file or per row -> CS-23.
- Marked-outside rows making the root unknown -> CS-28.
- Outside removed lines not summed per path -> CS-33. Option `repoRootKnown` ignored -> CS-34.
  Empty first segment labelled with `''` -> CS-35.
- `folderEntropyNorm` not rounded to 6 places -> CS-08.
- Change-kind precedence written as "the last kind wins unless deleted" or similar -> CS-37.
- `round1` half to even -> CS-38. Band boundaries off at 59/39 or at the ends -> CS-10b, CS-10d,
  CS-10f, CS-10g. Nested folders scored like separate modules -> CS-22. `round6` half to even ->
  CS-36.
- Outside rows counted by raw path -> CS-29. `computed` not defaulted to true -> CS-01; option
  ignored -> CS-30. Empty segments counted -> CS-31. Missing keys not read as root -> CS-32.
- `repoRootKnown` true whenever there are rows -> CS-24.
- Outside-repo rows counted in F -> CS-12.
- `0` instead of `null` for an empty change -> CS-13.
- Root folder `.` counted as one segment -> CS-14 (`meanPathDistanceHops` 2 instead of 1).

## Where the result is visible

- Session -> Change surface tab: headline (Changed files, Folders touched, Concentration,
  Lines +/-, Top-level modules, Common ancestor), the spread cards and the file tree.
- Session -> Summary: the Code impact tile and "Detected issues" (detectors read `band`).
- Analytics -> Change Surface chart and the Change Surface report: the same numbers per period.
- API: `GET /api/v1/repositories/:repoId/sessions/:sid/change-surface`.
