---
type: "Reference"
title: "Change Surface"
description: "The change-surface metric: the exact concentration formula and its four components, the union (never SUM) aggregation rule, the two percentage denominators from repo_code_inventory, the five surfaces that render it, and the tables/routes/modules behind them."
tags:
  - metrics
  - change-surface
  - concentration
  - aggregation
timestamp: "2026-08-27T00:00:00+04:00"
---

# Change Surface

Read this **before touching anything that counts changed files, folders or modules**, and before
adding a sixth surface for the metric.

"Change surface" answers *where in the repository did this session actually write?* — as opposed to
*how much* did it write (that is the line family: `lines_added` / `lines_removed`, see
[`session-metrics-scope.md`](session-metrics-scope.md)). It is built from **distinct changed
paths**, not from edit/write call counts: ten `Edit` calls against one file are one changed file.
The pre-existing `files_edited_written` counter is a *call* counter and was relabelled
**"Edit/write calls"** in the UI precisely so the two can never be read as the same thing.

## 1. Where the code is

| Concern | File |
|---|---|
| Shared contracts (wire + internal), caps, bucket thresholds | `server/src/logs/change-surface/change-surface.types.ts` |
| **The metric** — concentration + every spread component | `server/src/logs/change-surface/change-surface-metrics.ts` |
| Path normalisation / identity | `server/src/logs/change-surface/path-normalise.ts` |
| Fixed file-kind taxonomy | `server/src/logs/change-surface/file-kind.ts` |
| Per-session writer + renormalisation | `server/src/logs/change-surface/session-changed-paths-writer.ts` |
| Scoped path loader (SQL) | `server/src/logs/change-surface/changed-paths.sql.ts` |
| Code-inventory (denominator) writer | `server/src/logs/change-surface/repo-code-inventory.ts` |
| One session's read service | `server/src/logs/change-surface/change-surface.service.ts` |
| Report + chart shared fold | `server/src/logs/change-surface/change-surface-aggregate.service.ts` |
| Report assembly on top of the fold | `server/src/logs/reports/change-surface-report.service.ts` |
| Client band label/colour mapping | `client/src/viewer/lib/change-surface-ui.ts` |

**There is exactly one implementation of the metric** (`computeChangeSurface(facts)`). Ingest, one
session, a report period, a chart bucket and a group inside one all call that same function on a
different subset of facts. Do not add a second fold anywhere — that is what makes the five surfaces
structurally unable to disagree, rather than agreeing by test discipline.

## 2. The concentration formula

All inputs are computed over the **in-repo distinct changed paths in scope**. Let `F` = distinct
changed files, `n_1..n_K` = per-folder file counts over `K` distinct folders, `T` = distinct
top-level modules.

Four components, each in `[0, 1]`, `1` = maximally focused:

| Component | Definition | `K === 1` |
|---|---|---|
| `E` — distribution concentration | `1 − H / ln(K)`, where `H = −Σ (n_i/F)·ln(n_i/F)` | `1` (`ln 1 = 0` is undefined; defined as `1`) |
| `S` — largest-folder share | `max(n_i) / F` | `1` |
| `M` — module focus | `1 / T` | — |
| `D` — proximity | `1 − meanSep` | `1` (no pairs) |

`meanSep` is the arithmetic mean, over all `K·(K−1)/2` unordered pairs of distinct folders `(u, v)`,
of the **depth-normalised** separation

```
sep(u, v) = ((d_u − c) + (d_v − c)) / (d_u + d_v)
```

where `d` is the folder's segment count (the repo-root folder `.` has depth `0`) and `c` is the
segment count of the two folders' common ancestor. Normalising by `d_u + d_v` is the whole point:
`a/b/c` ↔ `a/b/d` (`sep = 2/6 = 0.3333`) scores closer than `a` ↔ `z` (`sep = 2/2 = 1.0`), which raw
hop distance cannot express — both are 2 hops apart.

```
concentration = clamp(round(100 × (0.40·E' + 0.25·S' + 0.20·M + 0.15·D)), 0, 100)
```

`null` when `F === 0`. Bands: **`focused ≥ 60`**, **`mixed 40–59`**, **`scattered < 40`**.

### Small-change leniency — two tiers

**Tier 1 — the focused floor** (`FOCUSED_SMALL_CHANGE_MAX_FILES`, `5`). After the clamp/round, a
scope of 1–5 changed files is floored to the focused boundary:

```
1 ≤ F ≤ 5  ⇒  concentration = max(score, 60)
```

so any change of up to five files bands `focused` no matter how its files land. `E` and `S` are
*proportional* measures — a 2-file change split one-per-folder scores exactly as "maximally
spread" as a 200-file change split evenly across 200 folders — but a change of up to five files
is trivially small however it lands (server API + client form + doc is a very focused change),
while a 200-file one genuinely is spread out. The floor never lowers a score already ≥ 60, and a
0-file scope still yields `null` (no band). From `F = 6` up, banding is purely score-based.

**Tier 2 — the closeness blend** (`SMALL_CHANGE_MAX_FILES`, `6`). Below this many files, `E` and
`S` are blended toward their fully-concentrated value of `1`, scaled by smallness and gated by
`D` (folder proximity). With the floor covering everything up to 5 files, the blend's remaining
job is shaping the score of the `F = 6` case — and of any small change already above the floor:

```
smallness = F <= 6 ? 1 - (F - 1) / 6 : 0
closeness = smallness × D
E' = E + closeness × (1 - E)
S' = S + closeness × (1 - S)
```

**`S` itself — the displayed "largest folder share" tile — is never blended.** Only the score's
internal `S'` uses the leniency; the tile keeps reporting the true, unadjusted share (the
"displayed ≠ formula input" split, below).

Worked checks (exact — these are the pinned unit-test cases):

| Case | E | S | M | D | `E'`/`S'` (if `F ≤ 6`) | score |
|---|---|---|---|---|---|---|
| any `F` in 1 folder | 1 | 1 | 1 | 1 | — (already 1) | **100** |
| `F = 1` | 1 | 1 | 1 | 1 | — (already 1) | **100** |
| 6 files, 6 folders, 6 modules | 0 | 0.166667 | 0.166667 | 0 | no change (`D = 0`) | **8** |
| `a/b/c` + `a/b/d`, 1 file each | 0 | 0.5 | 1 | 0.666667 | `E'=0.555556`, `S'=0.777778` | **72** |
| `a/x` + `z/y`, 1 file each | 0 | 0.5 | 0.5 | 0 | no change (`D = 0`, unrelated modules) | **60** (raw 23, floored: `F ≤ 5` ⇒ focused) |
| `srv/api` (2 files) + `srv/web` (1 file) | 0.081704 | 0.666667 | 1 | 0.5 | `E'=0.387803`, `S'=0.777778` | **62** |
| `F = 0` | — | — | — | — | — | **null** |

The `1/T` module term contributes nothing in a single-top-level-root layout (`src/` in a Java repo,
`T = 1` always) — that is intended: `E`, `S` and `D` carry the discrimination there.

Cost: the pairwise loop is `O(K²)` with `K ≤ F`; a 300-file session is 44,850 pair evaluations at
ingest, computed exactly — no sampling, no cap, so the value is deterministic.

### Displayed spread components are NOT the formula inputs

The tab and the report show human-readable siblings of the inputs, not the inputs themselves. Do
not "simplify" one into the other:

| Displayed | Definition |
|---|---|
| `filesPerFolder` | `F / K` |
| `largestFolderShare` | `S` — the **raw, unblended** share; the small-change leniency's `S'` feeds only the score |
| `folderEntropyNorm` | **raw** `H / ln(K)` — *not* `E`; `0` when `K === 1` |
| `meanPathDistanceHops` | **raw** mean of `(d_u − c) + (d_v − c)` — a hop count, not the normalised `sep` |
| `singleFileFolders` | `count(n_i === 1)` |
| `topLevelModules` | distinct first segments |
| `commonAncestorDepth` | segment count of the common ancestor of all in-repo changed paths |

### The band boundaries live in one place

`concentrationBand()` on the server produces the payload's `band` field. **No client code recomputes
a boundary.** `lib/change-surface-ui.ts` maps `band` → label/colour, and the `change-surface-spread`
detector fires on `band === 'scattered'`, never on a client-side `< 40`. The wireframes' printed
`≥ 60 / 40–59 / < 40` legend is display copy only.

Detector firing guards (client-side, `summary/detectors/thresholds.ts`) sit *on top* of the band:
`CHANGE_SURFACE_SCATTERED_MIN_FOLDERS = 5`, `CHANGE_SURFACE_MAX_TOP_MODULES = 4`,
`CHANGE_SURFACE_SINGLE_FILE_FOLDER_SHARE = 0.5`, `CHANGE_SURFACE_SINGLE_FILE_MIN_FOLDERS = 4`. A
2-file/2-folder session now scores 60 (`focused`) via the small-change floor, so the band check
alone already keeps CS-1 quiet on trivially small changes; the folder floors remain as the extra
guard for scattered-band sessions (6+ files, sub-40 score) that touch only a few folders. None of
the change-surface detectors use `critical` — a scattered spread or a multi-module session is
routine cross-cutting work, not an emergency.

## 3. The union rule — never a SUM

**Change surface is a set metric.** Every scope (a session tree, a report period, a chart bucket, a
`groupBy` group) recomputes from the **union of the distinct changed paths** of the sessions in
that scope. Distinctness is on `rel_path_key` (case-folded repo-relative path).

Consequences that are easy to get wrong:

- A file two sessions both touched is **one** changed file in the pair's union, and a file a
  sub-agent and its grandparent both touched is **one** changed file in the tree.
- Group rows **do not sum to the repo row**. Two branches that both touched `src/app.ts` each count
  it. The report prints that caveat inline (AC-6b) rather than leaving the reader to discover it.
- A bucket's concentration is **not** an average of its sessions' concentrations — it is a fresh
  `computeChangeSurface()` over that bucket's union.
- Concentration is **not composable at all**, which is why it is never stored (see §5).

## 4. The five surfaces

All five read one of the four routes; none of them recomputes a metric.

| # | Surface | Where | Reads |
|---|---|---|---|
| 1 | **Summary tile** — `Change surface` stat tile in the executive band | `session-log/summary/SummaryStatTile` via `SessionSummaryTab` | session aggregate route |
| 2 | **Detected issues** — the three `Change surface`-grouped findings (`change-surface-spread`, `-modules`, `-single-file-folders`) | `session-log/summary/detectors/change-surface-*.ts` | the same aggregate payload |
| 3 | **Change surface tab** — headline, 5 spread cards, breakdowns, folder distribution, file tree | `session-log/change-surface/SessionChangeSurfaceTab.tsx` | aggregate **and** files routes |
| 4 | **Analytics chart** — `Change Surface` metric in Repository → Analytics | `analytics/ChangeSurfaceBarChart.tsx` | analytics route |
| 5 | **Report** — Reports → Code → `Change Surface` | `reports/ChangeSurfaceReport.tsx` | report route |

Surfaces 4 and 5 go through **the same** `ChangeSurfaceAggregateService.build()` call; the report
just pins `bucket: 'week'`. That is why report ≡ chart holds structurally.

**Never render an absent value as `0`.** Three distinct states, three distinct renders:

| State | Meaning | Render |
|---|---|---|
| `computed: false` | extractor never ran, or no repo root was ever learned | "No change-surface data" |
| `computed: true`, `changedFiles === 0` | a genuine no-change session | `0 files · 0 folders`, `Concentration n/a` |
| loading | in flight | skeleton rows, never a zeroed tree |

## 5. Scope, storage, and what is deliberately not stored

Per-session own-scope columns on `session_stats` (all nullable, `NULL` = not computed):
`cs_changed_files`, `cs_folders_touched`, `cs_outside_repo_files`, `cs_computed_at`.

- `cs_computed_at` is written **whenever the extractor ran, including when it found zero changed
  paths** (the three counters are then `0`, not `NULL`). It is the marker that separates a real
  zero-change session from a never-recomputed one.
- The only case that leaves `cs_computed_at` `NULL` after a successful extraction is the
  unknown-repo-root state, where no path could be normalised and every count would be a lie.
- `computed` in a payload is `cs_computed_at IS NOT NULL` for a root, `BOOL_OR` over a tree/scope.

**Concentration is deliberately not a column.** It is not composable: a per-node value cannot be
summed, averaged or reused for the tree, so storing it would create a second source that disagrees
with every rendered value. The authoritative value for *every* scope — including a single session's
own tree — is recomputed from `session_changed_paths` at read time.

Consequently the four `cs_*` columns are **not** in `treeMetricsSumColumns()`
(`session-tree-metrics.sql.ts`) — see
[`session-metrics-scope.md`](session-metrics-scope.md) § "Union / set metrics".

## 6. Path identity and normalisation

`normaliseChangedPath(rawPath, roots)` → `{ pathKey, relPath, relPathKey, folder, folderKey,
topModuleKey, depth, outsideRepo }`.

- Backslashes → `/`; trailing slash stripped from each root.
- The prefix match is **case-insensitive** and must land on a `/` boundary.
- `relPath` keeps its **original case** (display); `relPathKey` / `folderKey` / `topModuleKey` are
  `toLowerCase()` (identity / `GROUP BY`). Folding the display path would render
  `SessionDetailPane.tsx` as `sessiondetailpane.tsx`.
- **Two roots, longest match wins.** The hook uploads `git.root` (from `--git-common-dir`, i.e. the
  *primary* checkout) **and** `git.worktreeRoot` (`rev-parse --show-toplevel`). Without the second,
  every path in a session run inside a linked worktree would be classified out-of-repo.
- No root matches → `outsideRepo: true`, every normalised field `null`. Those rows are reported
  through `outsideRepo*` and are excluded from every folder, spread, module and percentage figure;
  the tab lists them in an explicit trailing group that is **outside** the root-sum identity (the tree root's `+`/`-` equals the sum of the leaves shown).
- A file at the repo root → `folder = '.'`, `depth = 0`, top module `'.'`.
- `pathKey` is the row identity — `relPathKey` when normalised, else the slash-normalised,
  case-folded, root-less raw path. The writer **aggregates per-call facts by `pathKey` before
  inserting**, so `D:\a\repo\src\X.ts` and `/home/u/repo/src/x.ts` in one session are one row. Both
  `path_key` and `raw_path` are truncated to 1024 chars so the unique btree index cannot hit
  Postgres' 2704-byte index-row limit.
- `raw_path` is always stored verbatim, which is what lets
  `renormaliseSessionChangedPaths()` redo normalisation later without re-parsing the transcript.

`session_file_stats`' Read-path categories use the same root rule: `normaliseReadPath()`
(`claude-extractor.ts`) strips the session's repo roots with `stripRepoRootPreservingCase()` (this
module — longest root, case-insensitive match, original case kept, `null` for a path under no
root, which then stays absolute). The pre-existing `normaliseFilePath()` / `KNOWN_TOP_LEVEL_DIRS`
heuristic is only the fallback for a session with **no** known root. **Change surface never calls
it.**

### Upload-order self-healing

The `claude` and `artisyn` logs are separate uploads and a `claude-subagent` session never has an
artisyn log of its own, so at changed-path write time the repo root may not have arrived yet:

1. `resolveSessionRepoRoots()` reads `logs.git_repo_root` / `git_worktree_root` for
   `log_type = 'artisyn'`, walking up `sessions.parent_session_id` (bounded, `depth < 50`).
2. The artisyn ingest branch, after writing `git_repo_root`, calls
   `renormaliseSessionChangedPaths()` over that session and its descendants, rewriting the
   normalised columns and the `cs_*` aggregates from the stored `raw_path`s.
3. In the same transaction it then calls `rewriteSessionTreeFileStats()`
   (`session-file-stats-writer.ts`), which reparses the tree's stored `claude` /
   `claude-subagent` bodies and rewrites `session_file_stats` with the now-known roots and the
   repo's config scopes — but only when the artisyn log was newly inserted, a repo link was
   inserted, or a root changed, so repeated artisyn chunks do not reparse every body.

That is what makes a claude-before-artisyn upload order self-heal from "no data" to real numbers.

## 7. Change kind and diff coverage

`changeKind` is `added` when any covered result for that path was a creation, otherwise `modified`.
Precedence:

1. `toolUseResult.type === 'create'` in the transcript (object results only) — roots and `Task`
   sub-agents.
2. The hook-supplied `edit_result.changeKind` — the **only** source for workflow-agent transcripts,
   whose `toolUseResult` is never usable (absent, or a plain string).
3. An `Edit` whose `old_string` was `''`.

**`deleted` is never emitted:** deletions happen through `Bash rm`, not through the edit/write
tools. The column and the breakdown accept it for forward compatibility and it reads `0`.

`changeKind` must never be presented as diff *coverage*. A path can be confidently
`modified`-by-default (an un-updated hook install has neither source 1 nor 2 for delegated work)
while its `+`/`−` are honestly uncovered — which is what `diffCoveredCalls === 0` and the tree's
`no diff coverage` chip report.

## 8. File kinds — a fixed, cross-repo taxonomy

`FileKind = 'source' | 'test' | 'config' | 'docs' | 'other'`, evaluated **in this order** against
the case-folded repo-relative path (order matters: `test` before `source` so `foo.test.ts` is a
test; `docs` before `config` so `.md` is not config):

1. `test` — a path segment in `{test, tests, __tests__, spec, specs, e2e}`, or a basename matching
   `\.(test|spec|e2e-spec)\.[a-z0-9]+$`.
2. `docs` — extension in `{md, mdx, rst, txt, adoc}`, or first segment in `{doc, docs}`.
3. `config` — extension in `{json, yaml, yml, toml, ini, env, conf, cfg, properties, xml}`, or
   basename in `{dockerfile, makefile, .gitignore, .dockerignore, .editorconfig, .npmrc}`, or
   basename starting `.eslintrc` / `.prettierrc` / `.babelrc`.
4. `source` — extension in the fixed source list (`ts, tsx, js, java, py, go, rs, sql, sh, css,
   html, vue, …`).
5. `other` — everything else.

This is deliberately **not** the per-repo `fileCategories` / `classifyFile()` pair, so the axis is
comparable *between* repositories. It is server-side only and the kind travels per path in the
payload — there is no client copy to drift. The raw-extension axis alongside it is display-only.

## 9. The two denominators

The report's two `%` indicators divide by a **`repo_code_inventory` snapshot**, never by anything
derived from telemetry:

| Indicator | Numerator | Denominator |
|---|---|---|
| Share of tracked **files** touched | `changedFiles` (in-repo distinct) | `tracked_files` |
| Share of tracked **lines** touched | `linesAdded` (diff-based only) | `tracked_lines` |

The hook measures the snapshot with **one** git call —
`git diff --numstat 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD` (git's well-known empty-tree
object id, a named constant in `code-inventory.js`): `tracked_files` = row count, `tracked_lines` =
sum of column 1 over non-`-` rows, `tracked_binary_files` = count of `-` rows. This reads the object
store rather than the working tree, is git-tracked-only by construction, and needs no per-file
reads. `git ls-files` is **not** used — it reports the *index*, which would disagree with the line
total's HEAD basis. A repo with no commits returns `null` and no event is emitted.

Read side: the newest row with `captured_at <= endDate` wins — **not** today's row, so a report over
March divides by March's codebase. No such row → the indicator reads
`n/a · denominator unavailable`, **never `0%`** (AC-6d), and the rendered caption always names the
snapshot's branch and capture date.

## 10. Limits and truncation

| Constant | Value | Effect when hit |
|---|---|---|
| `CHANGE_SURFACE_MAX_FILE_ROWS` | `5000` | the *files* route caps the listing and reports `total` / `truncated`; the tab says "showing the first N of M paths" |
| `CHANGE_SURFACE_MAX_SCOPE_ROWS` | `400_000` | a report/analytics scope is flagged `truncated` and the surface tells the user to narrow the date range |

The **aggregate** route is never capped — no headline number and no root-sum identity may depend on
a listing limit.

## 11. Checklist when touching this feature

1. Does your change add a second place where a metric is computed? Route it through
   `computeChangeSurface()` instead.
2. Are you summing something that is a set? Union it on `rel_path_key`.
3. Can the value be absent? Render "no data" / `n/a` — never `0`, and never a `0` bar.
4. Are you comparing against `60` / `40` in client code? Use the payload's `band`.
5. Did you add a `session_stats` column? It does **not** go into `treeMetricsSumColumns()` unless it
   is genuinely additive.
6. Did you add a hook field? It is additive and optional — an un-updated install must keep working
   (see [`hook-api-versioning.md`](hook-api-versioning.md)).

## Related

- [`session-metrics-scope.md`](session-metrics-scope.md) — the root-vs-tree rule and the metric
  classification this feature's union class extends
- [`db-tables.md`](db-tables.md) — `session_changed_paths`, `repo_code_inventory` and the six new
  columns
- [`server-endpoint-map.md`](server-endpoint-map.md) / [`api-reference.md`](api-reference.md) — the
  four routes and their payloads
- [`hook-system-overview.md`](hook-system-overview.md) / [`hook-api-versioning.md`](hook-api-versioning.md)
  — the `git.root` / `git.worktreeRoot` fields, the `code-inventory` event and `edit_result`
- [`ui-principles.md`](ui-principles.md) — why a bounded 0–100 ratio uses a fixed axis and fixed
  band colours instead of `zoneColor()`
