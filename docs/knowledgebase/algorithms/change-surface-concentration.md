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

```examples
[
  {
    "id": "CS-01",
    "input": {"folders":{"src/api":1}},
    "expected": {"changedFiles":1,"foldersTouched":1,"concentration":100,"band":"focused","computed":true},
    "note": "K = 1: E = 1 by definition, S = 1, M = 1, D = 1; score = 0.40 + 0.25 + 0.20 + 0.15 = 1, 100. computed is true by default (a caller holding facts has run the extractor)."
  },
  {
    "id": "CS-02",
    "input": {"folders": {"src/api": 8}},
    "expected": {"concentration": 100, "band": "focused", "filesPerFolder": 8, "folderEntropyNorm": 0, "meanPathDistanceHops": 0, "commonAncestorDepth": 2},
    "note": "F = 8 > 6, no blend. K = 1 gives E = 1, S = 8/8 = 1, M = 1, D = 1; score 1, 100. If E were 0 at K = 1 the score would be 0.60. Displayed: entropy shown as 0 at K = 1 (not 0/0), no pairs so 0 hops, common ancestor src/api = 2 segments."
  },
  {
    "id": "CS-03",
    "input": {"folders": {"a/b/c": 1, "a/b/d": 1}},
    "expected": {"concentration": 72, "band": "focused", "largestFolderShare": 0.5, "folderEntropyNorm": 1, "meanPathDistanceHops": 2, "commonAncestorDepth": 2},
    "note": "H = ln 2, norm = 1, E = 0; S = 0.5; T = 1 (module a), M = 1; d = 3 each, c = 2, sep = 2/6, D = 0.666667. F = 2: smallness = 1 - 1/6 = 0.833333, closeness = 0.555556; E' = 0.555556, S' = 0.5 + 0.555556 * 0.5 = 0.777778. score = 0.222222 + 0.194444 + 0.2 + 0.1 = 0.716667, round(71.6667) = 72. Displayed share stays 0.5 (raw); hops (1 + 1) = 2; common ancestor a/b = 2."
  },
  {
    "id": "CS-04",
    "input": {"folders": {"a/x": 1, "z/y": 1}},
    "expected": {"concentration": 60, "band": "focused"},
    "note": "E = 0, S = 0.5, T = 2 so M = 0.5; c = 0, sep = (2 + 2)/(2 + 2) = 1, D = 0, closeness = 0. score = 0.125 + 0.1 = 0.225, 23; F = 2 <= 5 so the floor lifts it to 60."
  },
  {
    "id": "CS-05",
    "input": {"folders": {"a": 1, "b": 1, "c": 1, "d": 1, "e": 1}},
    "expected": {"concentration": 60, "band": "focused"},
    "note": "Five equal folders: E = 0, S = 0.2, T = 5 so M = 0.2, every sep = 1, D = 0. score = 0.05 + 0.04 = 0.09, 9; F = 5 <= 5, floor 60."
  },
  {
    "id": "CS-06",
    "input": {"folders":{"a":1,"b":1,"c":1,"d":1,"e":1,"f":1}},
    "expected": {"concentration":8,"band":"scattered"},
    "note": "F = 6: no floor (rule 7 stops at 5). E = 0, S = M = 1/6, D = 0 so closeness = 0. score = 0.25/6 + 0.2/6 = 0.075, 100 * score = 7.5, rounded to 8 (8 is even, so this row does not tell half up from half to even; CS-18 does). It is the floor boundary F = 6 at unit level; S-SESS-09 has the same 6/6/6 case end to end."
  },
  {
    "id": "CS-07",
    "input": {"folders": {"src/api": 3, "src/web": 3}},
    "expected": {"concentration": 44, "band": "mixed"},
    "note": "E = 0, S = 0.5, M = 1, sep = 2/4, D = 0.5. F = 6 still blends: smallness = 1/6, closeness = 0.083333; E' = 0.083333, S' = 0.541667. score = 0.033333 + 0.135417 + 0.2 + 0.075 = 0.44375, 44."
  },
  {
    "id": "CS-08",
    "input": {"folders":{"src/api":5,"src/web":2}},
    "expected": {"concentration":51,"band":"mixed","folderEntropyNorm":0.863121},
    "note": "F = 7: no blend. p = 5/7, 2/7: H = 0.598270, norm = H / ln 2 = 0.8631206..., shown rounded to 6 places as 0.863121, E = 0.136879; S = 0.714286; M = 1; D = 0.5. score = 0.054752 + 0.178571 + 0.2 + 0.075 = 0.508323, 51."
  },
  {
    "id": "CS-09",
    "input": {"folders":{"src/api":4,"src/web":3,"docs":1}},
    "expected": {"concentration":30,"band":"scattered","filesPerFolder":2.666667,"largestFolderShare":0.5,"meanPathDistanceHops":2.7,"commonAncestorDepth":0,"topLevelModules":["docs","src"]},
    "note": "F = 8, K = 3, T = 2. H = 0.974315 (p = 4/8, 3/8, 1/8), ln 3 = 1.098612, norm = 0.886859, E = 0.113141; S = 0.5; M = 0.5; pairs api-web 2/4, api-docs 3/3, web-docs 3/3, mean sep 0.833333, D = 0.166667. score = 0.045256 + 0.125 + 0.1 + 0.025 = 0.295256, 30. Hops (2 + 3 + 3)/3 = 2.67, shown 2.7; no common first segment, depth 0."
  },
  {
    "id": "CS-10a",
    "input": {"band": 60},
    "expected": {"band": "focused"},
    "note": "Rule 8: 60 >= 60."
  },
  {
    "id": "CS-10b",
    "input": {"band": 59},
    "expected": {"band": "mixed"},
    "note": "Rule 8: 59 < 60 and >= 40."
  },
  {
    "id": "CS-10c",
    "input": {"band": 40},
    "expected": {"band": "mixed"},
    "note": "Rule 8: 40 >= 40."
  },
  {
    "id": "CS-10d",
    "input": {"band": 39},
    "expected": {"band": "scattered"},
    "note": "Rule 8: 39 < 40."
  },
  {
    "id": "CS-10e",
    "input": {"band": null},
    "expected": {"band": null},
    "note": "Rule 8: no concentration, no band (not scattered)."
  },
  {
    "id": "CS-10f",
    "input": {"band":0},
    "expected": {"band":"scattered"},
    "note": "Rule 8: 0 < 40."
  },
  {
    "id": "CS-10g",
    "input": {"band":100},
    "expected": {"band":"focused"},
    "note": "Rule 8: 100 >= 60."
  },
  {
    "id": "CS-11",
    "input": {"facts":[{"path":"src/api/a.ts","added":10,"removed":0,"kind":"modified"},{"path":"Src/Api/A.ts","added":5,"removed":2,"kind":"added"}]},
    "expected": {"changedFiles":1,"foldersTouched":1,"linesAdded":15,"linesRemoved":2,"byChangeKind":{"added":1,"modified":0,"deleted":0},"concentration":100},
    "note": "Rule 1: the two rows differ only in path case, so they are one file (as when two sessions changed it); lines 10 + 5 and 0 + 2; added wins. K = 1 gives 100. Counting rows would give changedFiles 2."
  },
  {
    "id": "CS-12",
    "input": {"folders":{"src/api":3},"outside":[{"path":"~/.claude/settings.json","added":5}]},
    "expected": {"changedFiles":3,"outsideRepoFiles":1,"outsideRepoLinesAdded":5,"concentration":100},
    "note": "Rule 10: the outside file is in neither F nor K; F = 3 in one folder gives 100; it is counted on its own with its 5 lines. (S-SESS-09 checks an outside file end to end; CS-19, CS-20 and CS-29 hold the counting details.)"
  },
  {
    "id": "CS-13",
    "input": {"folders":{}},
    "expected": {"changedFiles":0,"concentration":null,"band":null,"filesPerFolder":null,"largestFolderShare":null,"folderEntropyNorm":null,"meanPathDistanceHops":null,"commonAncestorDepth":null,"repoRootKnown":true},
    "note": "Rule 3: F = 0, every spread number is null. Rule 10: with no rows at all the root counts as known (nothing contradicts it)."
  },
  {
    "id": "CS-14",
    "input": {"facts": [{"path": "README.md", "added": 1, "removed": 0, "kind": "modified"}, {"path": "src/a.ts", "added": 1, "removed": 0, "kind": "deleted"}]},
    "expected": {"foldersTouched": 2, "topLevelModules": [".", "src"], "meanPathDistanceHops": 1, "byChangeKind": {"added": 0, "modified": 1, "deleted": 1}, "concentration": 60},
    "note": "Root file: folder '.' (d = 0), module '.'. Pair (., src): c = 0, hops 0 + 1 = 1, sep 1/1 = 1, D = 0. E = 0, S = 0.5, T = 2 so M = 0.5; score = 0.125 + 0.1 = 0.225, 23, floor 60 (F = 2). Modules sorted: '.' before 'src'."
  },
  {
    "id": "CS-15",
    "input": {"facts":[{"path":"src/a.ts","added":5,"removed":0,"kind":"added"},{"path":"src/a.ts","added":0,"removed":5,"kind":"deleted"}]},
    "expected": {"changedFiles":1,"byChangeKind":{"added":1,"modified":0,"deleted":0}},
    "note": "Rule 1: added wins even when the deletion comes later (created and removed inside the scope is still added). Last-write-wins would say deleted."
  },
  {
    "id": "CS-16",
    "input": {"facts":[{"path":"src/a.ts","added":0,"removed":5,"kind":"deleted"},{"path":"src/a.ts","added":5,"removed":0,"kind":"added"}]},
    "expected": {"changedFiles":1,"byChangeKind":{"added":1,"modified":0,"deleted":0}},
    "note": "Rule 1: added wins in the other order too. Deleted-beats-added would say deleted."
  },
  {
    "id": "CS-17",
    "input": {"facts":[{"path":"src/a.ts","added":2,"removed":1,"kind":"modified"},{"path":"src/a.ts","added":0,"removed":9,"kind":"deleted"}]},
    "expected": {"changedFiles":1,"linesRemoved":10,"byChangeKind":{"added":0,"modified":0,"deleted":1}},
    "note": "Rule 1: deleted wins over modified; removed lines 1 + 9 = 10."
  },
  {
    "id": "CS-18",
    "input": {"folders":{"a":4,"b":4}},
    "expected": {"concentration":23,"band":"scattered"},
    "note": "F = 8, no blend, no floor. Two equal folders: E = 0; S = 4/8 = 0.5; T = 2 so M = 0.5; c = 0, sep = 2/2 = 1, D = 0. score = 0.25 * 0.5 + 0.2 * 0.5 = 0.225, 100 * score = 22.5 exactly; half up gives 23 (half to even would give 22)."
  },
  {
    "id": "CS-19",
    "input": {"folders":{"src/api":1},"outside":[{"path":"~/.claude/settings.json","added":5},{"path":"~/.claude/settings.json","added":2}]},
    "expected": {"changedFiles":1,"outsideRepoFiles":1,"outsideRepoLinesAdded":7},
    "note": "Rule 10: two rows of one outside path are one file with 5 + 2 = 7 lines. Counting rows would give 2."
  },
  {
    "id": "CS-20",
    "input": {"folders":{"src/api":1},"outside":[{"path":"C:/elsewhere/notes.md","added":3,"unrooted":true}]},
    "expected": {"changedFiles":1,"foldersTouched":1,"outsideRepoFiles":1,"outsideRepoLinesAdded":3,"concentration":100,"repoRootKnown":true},
    "note": "Input and output: a row with no repo-relative path (no root known) is excluded like an outside row and counted with them; one real in-repo row exists, so the root counts as known."
  },
  {
    "id": "CS-21",
    "input": {"folders":{"Zed":1,"alpha":1}},
    "expected": {"topLevelModules":["alpha","Zed"]},
    "note": "Rule 9: sorted by the case-folded keys alpha < zed, shown in original case. Sorting the labels would put Zed first (upper case sorts before lower case)."
  },
  {
    "id": "CS-22",
    "input": {"folders":{"src":1,"src/api/v2":1}},
    "expected": {"concentration":62,"band":"focused","meanPathDistanceHops":2,"commonAncestorDepth":1},
    "note": "Nested folders at different depths: d = 1 and 3, c = 1, hops 0 + 2 = 2, sep = 2/4 = 0.5, D = 0.5. E = 0, S = 0.5, T = 1 (src) so M = 1. F = 2: smallness 0.833333, closeness 0.416667; E' = 0.416667, S' = 0.708333. score = 0.166667 + 0.177083 + 0.2 + 0.075 = 0.61875, 62: focused on its own, the floor is not needed."
  },
  {
    "id": "CS-23",
    "input": {"facts":[{"path":"src/a/x.ts","added":1,"removed":0,"kind":"modified"},{"path":"src/a/y.ts","added":1,"removed":0,"kind":"modified"}]},
    "expected": {"changedFiles":2,"foldersTouched":1,"concentration":100},
    "note": "Rule 2: two files in one folder (as from two sessions): foldersTouched counts distinct folders, 1, not files or rows (2). K = 1 gives 100."
  },
  {
    "id": "CS-24",
    "input": {"folders":{},"outside":[{"path":"notes/x.ts","added":1,"unrooted":true}]},
    "expected": {"changedFiles":0,"outsideRepoFiles":1,"concentration":null,"repoRootKnown":false},
    "note": "Rule 10: every row lacks a repo-relative path without being outside, so the root counts as unknown; nothing is in the repo, so concentration is null."
  },
  {
    "id": "CS-25",
    "input": {"facts":[{"path":"src/a.ts","added":0,"removed":3,"kind":"deleted"},{"path":"src/a.ts","added":1,"removed":0,"kind":"modified"}]},
    "expected": {"changedFiles":1,"byChangeKind":{"added":0,"modified":0,"deleted":1}},
    "note": "Rule 1: deleted wins over a later modified (CS-17 has the other order)."
  },
  {
    "id": "CS-26",
    "input": {"folders":{"src/api":1},"outside":[{"path":"~/.claude/settings.json","added":1,"removed":4}]},
    "expected": {"outsideRepoFiles":1,"outsideRepoLinesAdded":1,"outsideRepoLinesRemoved":4,"linesRemoved":0},
    "note": "Rule 10: removed lines of outside rows go to outsideRepoLinesRemoved (4), never to linesRemoved (0)."
  },
  {
    "id": "CS-27",
    "input": {"facts":[{"path":"Src/Api/a.ts","added":1,"removed":0,"kind":"modified"},{"path":"src/api/b.ts","added":1,"removed":0,"kind":"modified"}]},
    "expected": {"changedFiles":2,"foldersTouched":1,"topLevelModules":["Src"],"concentration":100},
    "note": "Rules 2 and 9: Src/Api and src/api are one folder and one module (keys are case-folded); the module is shown as written by the first file, Src. K = 1 gives 100."
  },
  {
    "id": "CS-28",
    "input": {"folders":{},"outside":[{"path":"~/.claude/settings.json","added":1}]},
    "expected": {"changedFiles":0,"outsideRepoFiles":1,"concentration":null,"repoRootKnown":true},
    "note": "Rule 10: rows that are marked outside the repo do not make the root unknown (only rows with no path that are not marked outside do), so repoRootKnown stays true with nothing in the repo."
  },
  {
    "id": "CS-29",
    "input": {"folders":{"src/api":1},"outside":[{"path":"~/.Claude/Settings.json","added":1},{"path":"~/.claude/settings.json","added":2}]},
    "expected": {"outsideRepoFiles":1,"outsideRepoLinesAdded":3},
    "note": "Rule 10 counts outside rows by pathKey, which the writer builds from the case-folded path: the two spellings are one file with 1 + 2 = 3 lines. Counting raw paths would give 2."
  },
  {
    "id": "CS-30",
    "input": {"folders":{"src/api":1},"options":{"computed":false}},
    "expected": {"computed":false,"concentration":100},
    "note": "The computed option is passed through to the output unchanged; it does not change the numbers."
  },
  {
    "id": "CS-31",
    "input": {"facts":[{"path":"a//b/f.ts","added":0,"removed":0,"kind":"modified"},{"path":"a/c/g.ts","added":0,"removed":0,"kind":"modified"}]},
    "expected": {"foldersTouched":2,"meanPathDistanceHops":2,"commonAncestorDepth":1},
    "note": "Empty segments do not count: a//b has segments a, b (depth 2). With a/c: c = 1, hops 1 + 1 = 2; common ancestor a = 1. Counting the empty segment would give 3 hops."
  },
  {
    "id": "CS-32",
    "input": {"facts":[{"path":"src/a.ts","added":0,"removed":0,"kind":"modified","noKeys":true},{"path":"b.ts","added":0,"removed":0,"kind":"modified"}]},
    "expected": {"foldersTouched":1,"topLevelModules":["."],"concentration":100},
    "note": "A fact without folder and module keys is read as the root folder and module \".\", so it shares the folder of the root file b.ts: K = 1, one module \".\", 100."
  },
  {
    "id": "CS-33",
    "input": {"folders":{"src/api":1},"outside":[{"path":"~/.claude/settings.json","added":1,"removed":2},{"path":"~/.claude/settings.json","added":0,"removed":3}]},
    "expected": {"outsideRepoFiles":1,"outsideRepoLinesAdded":1,"outsideRepoLinesRemoved":5},
    "note": "Rule 10: two rows of one outside path add their removed lines too: 2 + 3 = 5."
  },
  {
    "id": "CS-34",
    "input": {"folders":{"src/api":1},"options":{"repoRootKnown":false}},
    "expected": {"repoRootKnown":false,"concentration":100},
    "note": "The repoRootKnown option overrides the derivation of rule 10 (which would say true here); the numbers do not change."
  },
  {
    "id": "CS-35",
    "input": {"facts":[{"path":"/x/f.ts","added":0,"removed":0,"kind":"modified"}]},
    "expected": {"topLevelModules":["."]},
    "note": "Input and output: the folder \"/x\" has an empty first segment, so its module label is \".\"."
  },
  {
    "id": "CS-36",
    "input": {"folders":{"m001":1,"m002":1,"m003":1,"m004":1,"m005":1,"m006":1,"m007":1,"m008":1,"m009":1,"m010":1,"m011":1,"m012":1,"m013":1,"m014":1,"m015":1,"m016":1,"m017":1,"m018":1,"m019":1,"m020":1,"m021":1,"m022":1,"m023":1,"m024":1,"m025":1,"m026":1,"m027":1,"m028":1,"m029":1,"m030":1,"m031":1,"m032":1,"m033":1,"m034":1,"m035":1,"m036":1,"m037":1,"m038":1,"m039":1,"m040":1,"m041":1,"m042":1,"m043":1,"m044":1,"m045":1,"m046":1,"m047":1,"m048":1,"m049":1,"m050":1,"m051":1,"m052":1,"m053":1,"m054":1,"m055":1,"m056":1,"m057":1,"m058":1,"m059":1,"m060":1,"m061":1,"m062":1,"m063":1,"m064":1,"m065":1,"m066":1,"m067":1,"m068":1,"m069":1,"m070":1,"m071":1,"m072":1,"m073":1,"m074":1,"m075":1,"m076":1,"m077":1,"m078":1,"m079":1,"m080":1,"m081":1,"m082":1,"m083":1,"m084":1,"m085":1,"m086":1,"m087":1,"m088":1,"m089":1,"m090":1,"m091":1,"m092":1,"m093":1,"m094":1,"m095":1,"m096":1,"m097":1,"m098":1,"m099":1,"m100":1,"m101":1,"m102":1,"m103":1,"m104":1,"m105":1,"m106":1,"m107":1,"m108":1,"m109":1,"m110":1,"m111":1,"m112":1,"m113":1,"m114":1,"m115":1,"m116":1,"m117":1,"m118":1,"m119":1,"m120":1,"m121":1,"m122":1,"m123":1,"m124":1,"m125":1,"m126":1,"m127":1,"m128":1}},
    "expected": {"changedFiles":128,"largestFolderShare":0.007813,"concentration":0,"band":"scattered"},
    "note": "128 one-file top-level folders: S = 1/128 = 0.0078125, exactly halfway at 6 decimals, shown rounded half up as 0.007813 (half to even would give 0.007812). E = 0, M = 1/128, D = 0: score = 0.45 / 128 = 0.003515625, concentration round(0.3515625) = 0, scattered (F > 5, no floor)."
  },
  {
    "id": "CS-37",
    "input": {"facts":[{"path":"src/a.ts","added":1,"removed":0,"kind":"added"},{"path":"src/a.ts","added":2,"removed":0,"kind":"modified"}]},
    "expected": {"changedFiles":1,"linesAdded":3,"byChangeKind":{"added":1,"modified":0,"deleted":0}},
    "note": "Rule 1: a later modified does not replace added: still added, lines 1 + 2 = 3."
  },
  {
    "id": "CS-38",
    "input": {"folders":{"a":1,"b":1,"d":1,"e":1,"f":1,"g":1,"h":1,"c/z":1}},
    "expected": {"foldersTouched":8,"meanPathDistanceHops":2.3},
    "note": "Rule 9: 28 pairs. The 21 pairs of the seven top-level folders have 1 + 1 = 2 hops each (42); the 7 pairs with c/z have 1 + 2 = 3 each (21). Mean 63 / 28 = 2.25, rounded half up to one decimal: 2.3 (half to even would give 2.2)."
  }
]
```

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
