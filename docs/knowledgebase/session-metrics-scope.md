---
type: "Reference"
title: "Session Metric Scope (root vs tree)"
description: "The rule that every additive session metric — cost, tokens, lines changed, files, tool calls — must be aggregated over the root session AND all its recursive sub-agent descendants; the canonical helpers, the metric classification table (including the change-surface union/set class, whose members are unioned rather than summed), and the known violations."
tags:
  - metrics
  - sub-agents
  - aggregation
timestamp: "2026-08-22T00:00:00+04:00"
---

# Session Metric Scope (root vs tree)

Read this **before adding, changing or displaying any session-level metric**.

A "session" in this app is not one transcript. It is a **tree**: one root session plus every
sub-agent session it spawned, at any depth (`Task`-tool agents, `Workflow` agents, agents spawned
by agents). Each node is its own `sessions` row with its own `session_stats` row and its own
uploaded transcript.

The consequence is the whole point of this article:

> **A metric computed from the root transcript alone does not measure the session.**
> It measures the orchestrator's own typing. For a delegating session that number is near zero
> while the real work sits in the children.

## 1. The rule

**Every additive metric a user sees for a session MUST be the sum over the root and all its
recursive descendants.** No exceptions, no "good enough for now" root-only figures on a
user-facing surface.

This applies to — non-exhaustively — cost, tokens (all seven counters), lines changed, lines
added/removed, files edited/written, tool calls, MCP calls, images, commits, PRs, skill
invocations, and any counter added to `session_stats` later.

Three corollaries, each of which has already been violated in this codebase (the first two caused
zero line counts on agent-driven sessions; they are fixed, and they are quoted here as the shape to watch for, not as open
issues):

1. **Never mix scopes inside one derived figure.** A ratio whose numerator is tree-scoped and
   whose denominator is root-scoped is not a wrong number, it is a meaningless one.
   `costPerLine = treeCost / rootLines` reports dollars-per-line an order of magnitude too high,
   or `null`, depending only on how much the root happened to delegate.
2. **Never put a root-only and a tree-scoped figure side by side on the same tile** without
   labelling both. The Summary tab's Executive band used to do exactly that: the *Delegation*
   tile (`% of cost` — tree-scoped) two tiles away from *Code impact* (`N lines` — root-only),
   so the same session was 95% delegated and had changed 0 lines. Both are tree-scoped now.
3. **A depth-1 `WHERE parent_session_id = X` match is not "all children".** Agents spawn
   agents. Use the recursive CTE.

## 2. Metric classification — not everything is a SUM

The rule above says *additive*. Three classes, three different rollups:

| Class | Examples | Correct rollup over the tree |
|---|---|---|
| **Additive** | tokens, cost, lines changed / added / removed, files edited, tool calls, MCP calls, image count/bytes, commits, PRs, turn/prompt counts | `SUM` over `depth >= 0` |
| **Temporal (wall-clock)** | `work_time_ms`, session duration, start/end time | **Union of intervals** — never `SUM`. Summing double-counts, since children run *inside* the parent's span and often in parallel with each other. In practice the root's own span already contains its children, so the root value is the correct tree value. See §5 for the one case where it isn't. |
| **Identity / descriptive** | model, branch, first prompt, user, repo | Root-only **by definition**. A tree has many models; the session's model is the root's. |
| **Ratios** | cache-read ratio, cost/line, lines/hour, cost/hour, delegation share | Recompute from **tree-scoped numerator and tree-scoped denominator**. Never average per-node ratios, never mix scopes. |
| **Union / set** | change surface: distinct changed files, folders touched, top-level modules, and every metric derived from them (concentration, entropy, largest-folder share) | **Set union over the tree**, then recompute the derived value from the union. Never `SUM` — a file two nodes both edited is one changed file. See §2b. |

Where a surface genuinely wants to show the split (how much of this session was delegated?), the
established pattern is the **scope pair** — report root-only and root+descendants side by side,
never one blended number and never one of the two alone. See
[`llm-call-math.md`](llm-call-math.md) § "The root / descendant scope pair", which already
mandates this for tokens and cost.

## 2b. The union class in detail

The fourth class is the newest and the easiest to get wrong, because its members *look* additive:
`changedFiles`, `foldersTouched`, `topLevelModules`. They are not counters, they are the
**cardinalities of sets**, and a tree's set is the union of its nodes' sets:

> A file that a sub-agent and its grandparent both edited is **one** changed file in the tree, not
> two. `SUM` over the tree would report two. The union reports one.

Everything derived from those sets — the 0–100 concentration score, folder entropy, largest-folder
share, mean path distance — inherits the same rule: it is **recomputed from the union**, never
combined from per-node values. Concentration in particular has no meaningful average: the mean of
two per-session scores is not the score of their combined change surface.

The same rule applies *sideways*, not only up the tree: a report period, an analytics bucket and a
`groupBy` group are each their own union recomputation. That is why the change-surface report prints
an inline caveat that its group rows do **not** sum to its repo row — two branches that both touched
`src/app.ts` each legitimately count it.

### Why the `cs_*` columns are absent from `treeMetricsSumColumns()`

`session_stats` carries four change-surface columns — `cs_changed_files`, `cs_folders_touched`,
`cs_outside_repo_files` and the `cs_computed_at` marker — and **none of them is in
`treeMetricsSumColumns()`** (`session-tree-metrics.sql.ts`). That is deliberate, not an oversight
waiting to be "fixed":

- They are **own-scope, per-node** values (§4's rule), and summing them across a tree would
  double-count every file two nodes touched. There is no `SUM` that produces the tree value.
- The tree value comes from `session_changed_paths` instead: `loadScopedChangedPaths()` selects the
  scope's rows via `descendantSessionsCte`, and `computeChangeSurface()` folds them once, taking
  distinctness on `rel_path_key`. The union is therefore the natural result of the read, not a
  correction applied on top of a rollup.
- **Concentration is not stored at all** — not per node, not per tree. A stored value would be a
  second source that disagrees with every rendered one, since no per-node score can be composed
  into a scope's score.

So: adding a `cs_*` column to the sum rollup is always wrong. A new surface that needs tree-scoped
change-surface numbers calls the change-surface read path (`ChangeSurfaceService` /
`ChangeSurfaceAggregateService`), which already walks the tree. Full detail in
[`change-surface.md`](change-surface.md).

## 3. The canonical helpers — do not hand-roll the walk

### Server (authoritative)

`server/src/logs/session-tree.sql.ts` — the walk itself

- `descendantSessionsCte(rootIdsArray): SQL` — the `WITH RECURSIVE` CTE body. Emits one row per
  tree node with `root_id` and `depth` (`0` = the root itself). Caps at `depth < 50`, because
  `parent_session_id` has no FK and no cycle check.
- `getDescendantSessionIds(db, rootIds)` — the same walk for Drizzle query-builder call sites;
  returns descendants only (`depth > 0`).

`server/src/logs/session-tree-metrics.sql.ts` — **the one definition of the `session_stats`
counter rollup**. Do not write a second one; a surface needing another column adds it
here, not in a copy of the query.

- `treeMetricsCte(extraSumColumns?): SQL` — the CTE body, named by the exported
  `SESSION_TREE_METRICS_CTE` (`'session_tree_metrics'`). For a caller that already builds
  `descendant_sessions` inside its own `WITH RECURSIVE`: the analytics timeline
  (`repositories.controller.ts`), the executive summary's Phase B
  (`reports/executive-summary.service.ts`) and `productivity-analytics.service.ts` →
  `loadTreeCounters()`, whose hand-written twin of this rollup was refactored onto it so exactly
  one definition survives. Embed it after the `descendant_sessions` CTE and
  `LEFT JOIN session_tree_metrics tm ON tm.root_id = <the root's session row id>`.
- `loadTreeMetricsByRoot(db, rootIds)` — the same rollup as a standalone batched query, for a
  caller that has no such CTE (the branch summary). One round trip for all roots, never per-root
  N+1.
- `mapTreeMetricsRow(row)`, `EMPTY_TREE_METRICS` — raw SQL row (`bigint` sums arrive as strings)
  → the typed `SessionTreeMetrics`.
- `withOwnFallback(tree, own)` — **the only sanctioned way to combine a tree total with the
  root's own figure** (see the double-count trap below).

Counters it sums: `lines_changed`, `files_edited_written`, `lines_added`, `lines_removed`,
`diff_lines_covered_calls`, `diff_lines_total_calls`, `image_count`, `mcp_calls_total` — each as
`COALESCE(SUM(...), 0)` — plus `BOOL_OR(ds.depth = 0) AS root_counted` and
`COUNT(*) FILTER (WHERE ds.depth > 0) AS descendant_count`. The shape, if you ever need to read
it rather than call it:

```sql
WITH RECURSIVE <descendantSessionsCte(ids)>
SELECT ds.root_id, COALESCE(SUM(ss.<column>), 0) AS <column>
FROM descendant_sessions ds
JOIN session_stats ss ON ss.session_id = ds.id
  -- An OTEL-only session_stats row (no transcript ever uploaded) is not a real
  -- tree node and must not contribute.
  AND EXISTS (
    SELECT 1 FROM logs tl
    WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
  )
GROUP BY ds.root_id
```

Three details that are easy to get wrong:

- **`depth >= 0` vs `depth > 0`.** The cost rollups use `WHERE ds.depth > 0` because the root's
  own cost is computed separately and added in TS. A counter rollup that replaces the root value
  outright must include the root, i.e. **no `depth` filter at all** — which is what
  `treeMetricsCte()` does. Getting this backwards silently drops or doubles the root's
  contribution.
- **The double-count trap.** Precisely because there is no `depth` filter, the totals
  **already contain the root**. Never add the root's own `session_stats` (or raw-JSONB fallback)
  value on top of them. The one legitimate reason to add an own value is a root the rollup never
  saw — no `session_stats` row, or a row the OTEL-only guard excluded — which is what `root_counted`
  reports and what `withOwnFallback(tree, own)` handles: `tree + (rootCounted ? 0 : own)`. Call
  sites must not re-derive that by hand, because both figures are in scope at every call site
  (the payloads expose `linesChanged` **and** `linesChangedOwn`).
- **The OTEL-only guard.** Without the `EXISTS`, a `session_stats` row created from OTEL
  telemetry for a session whose transcript was never uploaded becomes a phantom tree node. The
  `/logs` endpoint's `subagentStats` select carries the same guard, which is what makes the
  client-side sum and this server-side rollup unable to disagree.

### Client

`client/.../session-log/usage/session-usage-derive.ts` → `deriveSessionUsage(main, subagentLogs)`
already walks the root transcript **and every descendant transcript** in one pass, accumulating
into a `shared` object. Its own docstring states the principle: sub-agent work is included "so a
session driven by agents does not report zeros". **This is the client-side hook for any new
tree-scoped counter** — the walk is already there, add the accumulator to it rather than writing a
second traversal. The code-impact pair does exactly that: `productivity` now carries
`linesWritten` / `filesEditedWritten` (tree) next to `linesWrittenOwn` /
`filesEditedWrittenOwn` (root transcript only), gated on the same `isSubagentLog` flag the walk
already receives.

`client/.../session-log/tree-code-impact.ts` → `computeTreeCodeImpact({ usage, subagentStats })`
is the one place the session-detail page turns that walk plus the `/logs` payload into the
own/tree pair (`linesTree`/`linesOwn`, `filesTree`/`filesOwn`, `descendants`, and the
diff-coverage pair). For the written-lines/files figures it prefers `subagentStats` when the map
is non-empty (`source: 'stats'`, the same `session_stats` data the server rollups sum, so the Info
tab and the analytics pages cannot disagree) and falls back to the walked tree totals otherwise
(`source: 'walk'`). The **diff pair** (`linesAdded`, `linesRemoved`, `diffCoveredCalls`,
`diffTotalCalls`) is never walked — it is always server-sourced (`/logs` `rootStats` plus the
`subagentStats` sum, see §5). It is derived once per render in `SessionDetailPane.tsx` and
threaded into the tabs — do not recompute it per tab.

The raw material is available on the session page: the `/logs` endpoint returns `main` plus
`subagents[]` (every descendant, with its DB-authoritative `parentSessionId`) plus
`subagentStats` (per-child `session_stats` figures). `subagentStats` carries the
token fields **plus** `linesChanged`, `filesEditedWritten`, `linesAdded`, `linesRemoved`,
`diffLinesCoveredCalls`, `diffLinesTotalCalls`, each strictly that child's own transcript (never
its own descendants), so summing the map counts every node exactly once — extending it further
is still the cheap way to give the client a tree-scoped counter without re-parsing child
transcripts.

## 4. Why rollup happens at read time, not at ingest

Tempting alternative: when a sub-agent's log arrives, add its counters into the parent's
`session_stats` row. **Do not.**

- Upload order is not guaranteed. A child can arrive minutes after the root, or after the root has
  already been recomputed.
- It makes a stored column depend on other rows: deleting or re-uploading one child silently
  invalidates the parent, with no way to detect the drift.
- `recomputeAllSessions` would have to become tree-ordered.

`session_stats` stays strictly **per-node, own-transcript-only** — that is its contract. Every
tree figure is derived at read time via the recursive CTE. This also keeps the "scope pair"
(§2) possible: you cannot show root-only next to tree if the stored value has already been
polluted with children.

### Recomputing a repo must walk the tree

`POST :repoId/recompute-all-sessions` → `recomputeAllSessionStats(repoId)` is the only
repo-scoped way to refresh those per-node rows after an extraction fix. It gathers sessions
through `sessions ⋈ logs ⋈ log_repositories`, and **`log_repositories` only ever links the
`artisyn` log** — measured 0 repo links across all 603 workflow-agent sessions in this DB. A
repo-scoped walk reaches *roots only*: measured, it reported `recomputed: 115` for a repo whose tree holds
320 more nodes, leaving every sub-agent's `session_stats` frozen at whatever logic wrote it
at upload time.

It now expands the gather with `getDescendantSessionIds` (`session-tree.sql.ts`) — the same
canonical helper the read paths use — so the recompute covers exactly the tree the reads roll
up (same repo: `recomputed: 435`). If you add another per-node column, this is the endpoint that
backfills it, and it only works because of that expansion. The artisyn timestamp-reprocessing
loop in the same method deliberately stays on roots: a descendant has no artisyn log, which is
precisely why it had no repo link to begin with.

### What read-time rollup costs

Read-time rollup is the right call for every reason above, but it is not free, and the price is
concentrated in one endpoint. `GET :repoId/analytics/timeline` went **11.3 ms → 58.1 ms mean**
(`npm run perf`, `repos:analytics-timeline`) when `descendant_sessions` +
`session_tree_metrics` were added to it. Measured in isolation on a 1 677-root repo (1 997 tree nodes), the
rollup alone is ~16 ms of execution, which accounts for the delta on the ~3 000-session perf
repo.

This was reviewed and **accepted**: the recursive rollup *is* the feature, the endpoint still
answers in under 60 ms, and correctness was never in question. It is recorded here so the next
person reading a perf report does not re-litigate it — and so that if this endpoint ever needs
to get faster, the known levers are the per-node OTEL-only `EXISTS` guard, the `session_stats` join
width, and caching the rollup per repo rather than deriving it per request. The perf baseline
(`docs/perftests/baseline.json`) was refreshed after the tree rollup so later runs compare against
the post-rollup world.

## 5. Known limitations to state, not hide

- **Diff-based counters are recovered by diffing the Edit input when no patch is present
 .** `lines_added` / `lines_removed` are parsed from `toolUseResult.structuredPatch` on
  Edit/Write results. **Workflow-spawned** agent transcripts
  (`subagents/workflows/<wf-id>/agent-*.jsonl`) carry the `tool_use` block and a bare
  confirmation string as the `tool_result`, but no top-level `toolUseResult` at all — measured
  0 of 894 edit calls covered across 92 such agents, against **43 of 43** for regular `Task`
  sub-agents, which do carry patches. So the original "sub-agent transcripts cannot be
  recovered" claim was wrong twice over: it was specific to workflow agents, and it was
  recoverable.
  `countEditInputPatchLines` (`tool-stats.ts`) now fills the gap by running a real line diff of
  `old_string` against `new_string` — validated at **99.6 % exact agreement with the native
  patch counts over 1 878 real calls**. Three rules make this safe, and none may be dropped:
  the native patch always wins when present; the fallback only applies to a call whose outcome
  is `success`, so a rejected/errored/unresolved edit is never credited; and `Write` is excluded
  entirely, because its input has no prior content and an overwrite's removals are unknowable
  (a real one measured `+142 / −164`). This is *not* the rejected "count the new text" fallback
  — that reproduced the native counts on 0 % of the same calls.
  `diff_lines_covered_calls` / `diff_lines_total_calls` therefore stay meaningful: `Write`-heavy
  and rejected calls still show as uncovered, and a surface must keep publishing coverage rather
  than render a confident `+0 / −0`. **Historical rows keep their old values until recomputed** —
  the fix is at ingest.
- **A new-file `Write` counts as covered.** `countPatchLines` (`tool-stats.ts`) treats a `Write`
  result with `type === 'create'` as `+<content lines> / −0`: a new file's `structuredPatch` is
  always empty (measured: all 215 `create` results), but with no prior content its diff is exactly
  its line count. Such a call increments `diff_lines_covered_calls`. The exclusion above applies
  only to `Write` **overwrites** (`type === 'update'` with no patch), whose removals are
  unknowable.
- **The session-detail diff pair is server-sourced.** The `+added / −removed` figures and their
  coverage note on the Summary band, Usage tab and session export are **not** computed from the
  client transcript walk. The client used to carry its own copy of `countPatchLines`, which had
  drifted (it did not count new-file writes) and disagreed with the analytics pages for the same
  session. Now `GET …/sessions/:sessionId/logs` returns a top-level `rootStats` — the root's own
  `session_stats` `linesChanged`, `filesEditedWritten`, `linesAdded`, `linesRemoved`,
  `diffLinesCoveredCalls`, `diffLinesTotalCalls`, behind the same T-100 transcript `EXISTS` guard
  as `subagentStats` — and `computeTreeCodeImpact` sums `rootStats` + every `subagentStats[*]`
  entry. That equals the server tree rollup in `session-tree-metrics.sql.ts` by construction.
  When `rootStats` is `null` (the root has no qualifying `session_stats` row) the pair is `null`
  and renders as "no diff data", never `+0 / −0`. The written-lines/files fields stay walk-based.
- **Background agents can outlive the root's last assistant event.** The "root span already
  contains its children" assumption behind the temporal class holds for synchronous delegation.
  An agent still running when the root session ends is not covered by the root's `work_time_ms`.
- **`files_edited_written` counts Edit/Write/MultiEdit *calls*, not distinct files** despite the
  name. Rolling it up over the tree makes it a tree-wide call count, not a file count.
- **The lines-changed formula is not a diff.** It sums `new_string` / `content` line counts of
  Edit/Write/MultiEdit — i.e. *lines written*. Deleting 80 lines counts ~0; a one-line change
  inside a 200-line replacement counts 200; a `Write` counts the whole file every time. This is
  deliberate and frozen (see the comment on `session_stats.lines_added`), but it means the metric
  is only meaningful *because* it is a consistent proxy — and a root-only proxy of delegated work
  is not consistent with anything.

## 6. Scope status

Concrete inventory, so a change here can be scoped. "Tree" = obeys §1. Every
lines/files violation listed here is closed; the counters deliberately left root-only are in
"Still open" below.

| Surface | Metric | Scope today | Where |
|---|---|---|---|
| Session Info tab | Lines changed | tree (own on the secondary line) | `SessionInfoTab.tsx:87-88` ← `computeTreeCodeImpact` |
| Session Info tab | Files edited/written | tree (own on the secondary line) | `session-info-derive.ts:305` ← `codeImpact.filesTree` |
| Session Info tab | lines/hr, cost/line | tree ÷ tree | `session-info-derive.ts:206`, `:398` |
| Session Summary tab | Code impact tile | tree, with diff coverage as the secondary | `session-summary-derive.ts:253`, `SummaryExecutiveBand.tsx:202` |
| Session Summary / Usage tab | lines added/removed, tool calls | tree | `session-usage-derive.ts` (one walk, root + every descendant transcript) |
| Session Info / Summary | cost, tokens, delegation share | tree | server rollup + `session-info-derive.ts` |
| Analytics timeline API | `linesChanged`, `filesEditedWritten` | tree; `*Own` additive | `repositories.controller.ts:2365-2370` ← `treeMetricsCte()` |
| Analytics / Reports pages | linesPerHour, costPerLine | tree ÷ tree | `analytics/metrics.ts:177-193` — unchanged code, fixed by the payload |
| Analytics / Reports pages | lines / files totals | tree | `ProductivityChart.tsx:204`, `ProductivityReport.tsx:76,99`, `FilesBarChart.tsx:49-50`, `HorizontalBarChart.tsx:63-64` |
| Branch summary API | `totalLinesChanged` | tree; `totalLinesChangedOwn` additive | `repositories.controller.ts:1086-1110` ← `loadTreeMetricsByRoot` |
| Branch summary API / list | `totalWorkTimeMs` | root — and that IS the tree value | temporal (§2). Do not "fix" it |
| Executive summary report | `totalLinesChanged`, `costPerLine`, `linesPerHour` | tree ÷ tree | `executive-summary.service.ts:480`, `:580`, `:376-377`, `:790-793` |
| `/logs` `subagentStats` | per-child lines/files/diff counters | per-node **by design** | one entry per recursive descendant, so the client sums each node once |
| Repo productivity analytics | lines added/removed, commits, PRs | tree | `productivity-analytics.service.ts:76-98` (now on `treeMetricsCte()`) |
| Active sessions / token / tool analytics, cache-ratio, harness usage | all | tree | `descendantSessionsCte` consumers |
| Turn-End Cost Advisor prompt | `toolUsage` / `fileUsage` | server: descendants-only (`ds.depth > 0`, excludes the root's own rows); tree-wide is restored on the hook side, which additively merges in the root session's own always-fresh local usage before building the prompt | `turn-end-cost-advisor.service.ts` `loadToolUsage()`/`loadFileUsage()` ← `descendantSessionsCte`; `post-turn-analysis-worker.js` `mergeToolUsage()`/`mergeFileUsage()` |
| Session Summary tile + 3 detectors | change surface | tree — **union**, not `SUM` (§2b) | `change-surface.service.ts` ← `descendantSessionsCte` |
| Change surface tab | change surface + per-path rows | tree — union | `SessionChangeSurfaceTab.tsx` |
| Analytics chart / Change Surface report | change surface | tree — union, one shared fold | `change-surface-aggregate.service.ts` |

Sub-agent **counts** are tree-scoped too, via a separate field. `TokensCostDerived.subAgents`
counts only `Task`-tool activations found in *this* transcript, so a workflow-driven session
reported `0 agents` on the Summary Delegation tile and `0` under the Info tab's "Sub-agents
spawned" — directly beside the new `… in 11 sub-agents` secondary. Every *display* of a
sub-agent count now reads `TokensCostDerived.subAgentsTree` instead
(`session-info-derive.ts`): `max(codeImpact.descendants, subAgents)`, so it never reports fewer
agents than the transcript proves and never loses them in walk mode. The narrow `subAgents`
field is deliberately unchanged — it gates whether a cost gap may be attributed to sub-agents
(`hasSubagentEvidence`), where a workflow agent must not count as direct evidence.

Still open, deliberately — these are the ones to fix next, not
examples to copy:

- **`image_count` / `mcp_calls_total` are still root-only** on every surface: the timeline's
  `imageCount` / `imageTotalBytes` / `mcpCallsTotal` / `mcpCallsByServer`, and the Info tab's
  Vision and MCP Usage sections. `treeMetricsCte()` already *returns* `image_count` and
  `mcp_calls_total`, so the rollup exists and nothing consumes it — wiring it up is a payload +
  UI change, not a SQL one. `image_total_bytes` and the per-server MCP map have no rollup yet.
- **`lines_added` / `lines_removed` now cover delegated `Edit`/`MultiEdit` work, but
  `Write` never will.** The workflow-agent gap is closed at ingest by diffing the Edit input
  (§5). Two things remain: **historical rows keep their old zeros until recomputed**, and a
  `Write` call is permanently uncoverable from a transcript that has no patch, since the input
  carries no prior file contents. Keep publishing coverage
  (`diff_lines_covered_calls` / `diff_lines_total_calls`) rather than a confident `+0 / −0`.

Worked example — session `0f7b2795-…` (row `103657`), a Workflow-driven session:

| | root | tree | root-only figure | shown now |
|---|---|---|---|---|
| Edit/Write/MultiEdit calls | 0 | 116 | 0 | 116 |
| lines changed | 0 | 19 457 | **0** | **19 457** |
| descendant sessions | — | 22 | 22 | 22 |
| lines added/removed (diff-based) | 0 | 0 | `+0 / −0` | `no diff data (0 of 116 calls)` |

The root transcript contains 10 `Bash` calls (all read-only) and 1 `Workflow` call. Every edit
happened in a child. The UI used to show `0`; a regression that reintroduces a root-only read
shows `0` again, which is why every test fixture for these metrics must be a **delegating** one
(§7.6).

## 7. Checklist when adding or touching a session metric

1. Which class is it (§2)? Additive → `SUM` over the tree. Temporal → interval union. Ratio →
   both sides tree-scoped. **Union/set → union the underlying rows and recompute the derived
   value (§2b); never `SUM`, never average, and do not add the column to
   `treeMetricsSumColumns()`.**
2. Server: for a `session_stats` counter, add the column to `session-tree-metrics.sql.ts` and
   call `treeMetricsCte()` / `loadTreeMetricsByRoot()` — do not write a second rollup. For
   anything else, reuse `descendantSessionsCte`: include the root (`no depth filter`) when
   replacing the node value, use `depth > 0` only when the root's contribution is added
   separately, keep the OTEL-only `EXISTS` guard, and combine tree with own only through
   `withOwnFallback` (§3, the double-count trap).
3. Client: fold it into the existing `deriveSessionUsage` walk, or extend `subagentStats` on the
   `/logs` payload and sum it in `computeTreeCodeImpact`. Do not add a third traversal.
4. `session_stats` writes stay per-node (§4).
5. Grep for every consumer of the metric before you ship. Every mixed-scope ratio bug
   came from changing one side of a division; expose the root-only figure additively as
   `*Own` instead of leaving two callers with two meanings for one name (§6).
6. Add a test with a **delegating** fixture: root contributes nothing, children contribute
   everything. A fixture where the root does the work cannot detect a missing rollup.

## Usage analytics charts

The repository Analytics tab's view dropdown offers four transcript-derived views next to the D3
charts. They are **tables**, not charts, and each is backed by its own endpoint rather than the
shared `analytics/timeline` payload: `client/src/viewer/pages/repository/analytics/UsageAnalyticsPanel.tsx`
owns their queries. They honour the tab's date-range, branch and user selectors. The `groupBy`
dropdown and the vertical/horizontal layout toggle are hidden for them, because they aggregate over
the whole filtered set and have no second layout.

Every figure covers the selected root sessions **plus all descendant sub-agents** (§1). Sub-agents
hold most tool calls on delegating sessions, so a root-only figure reads as near zero.

| View (`av` param) | Shows |
|---|---|
| Tool Analytics (`tools`) | Every tool ranked by calls, with success rate, a separate `unresolved` count, ≈median/max with "over N of M calls" coverage, a main-vs-sub-agent toggle and an MCP-per-server rollup |
| Token Breakdown (`tokens`) | Input / output / cache-read / cache-creation, with `ephemeral_5m` and `ephemeral_1h` shown separately and never summed, groupable by `service_tier` (including an `unknown` bucket) or by UTC day |
| Productivity Counters (`productivity-counters`) | Diff-based lines added/removed, commits and pull requests, with a published coverage footnote |
| Active Sessions (`active-sessions`) | Sessions in the range, most recently active first, with per-session work time, turns, tokens, cost, tools, lines and top tool |

Display rules these views follow, and which new views should reuse:

- **`unresolved` is not a failure.** A call with no `tool_result`, or one the user rejected or
  interrupted, gets its own column and is excluded from the success-rate denominator. Counting it
  as a failure (as `log-parser.ts` does for its own purposes) inflates failure rates.
- **No summed "total tool time" anywhere.** One assistant message can issue several `tool_use`
  blocks that run concurrently, so their durations overlap in wall-clock time. Rows with such calls
  get an "overlapping" badge instead (`ToolAnalyticsView.tsx`, `parallelBatchCalls`).
- **Repository-scope medians are approximate and say so.** They are interpolated from fixed
  duration buckets (per-session medians cannot be averaged) and are prefixed `≈`. The session
  Statistics tab (`session-log/usage/`, computed client-side from the already-fetched `/logs`
  payload) computes an exact median from the raw data and shows no prefix.
- **Never mix diff-based and written line counts.** "Lines added/removed (diff-based)" and "Lines
  changed (written)" must never appear on the same view, chart, report page or PDF. They differ by
  roughly 3x and measure different things (see `db-tables.md` § session_stats). This is a hard
  requirement, not a convention.

**Attributes as a Group by dimension.** Any chart or report with a "Group by" control (the
Analytics tab's dropdown and the Reports tab's parameter strip) can also group by a resolved session
attribute, encoded as `attr:<key>` and listed in an "ATTRIBUTES" section populated from
`resolveSessionAttributionDefinitions()` (`client/src/viewer/lib/session-attribution-ui.ts`).
`string[]` attributes **fan out**: a session carrying N values for the chosen attribute counts in
full in each of the N matching buckets, so bucket totals can exceed the session count. Scalar
attribute types (`string` / `number` / `boolean`) produce exactly one bucket per session. See
[turn-end-cost-advisor.md](turn-end-cost-advisor.md#attributes-as-a-chart-dimension).

## Related

- [`llm-call-math.md`](llm-call-math.md) — token/cost formulas and the root/descendant scope pair
- [`change-surface.md`](change-surface.md) — the union/set metric class in full: the concentration
  formula, the distinct-path identity rule and the five surfaces that recompute from it
- [`db-tables.md`](db-tables.md) — `sessions.parent_session_id`, `session_stats` columns
- [`session-log-view.md`](session-log-view.md) — the client log parser and per-turn structures
- [`session-id-vs-sessionid.md`](session-id-vs-sessionid.md) — why `parent_session_id` is the only
  trustworthy linkage key
