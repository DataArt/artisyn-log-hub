---
reviewed: 2026-10-15
reviewer: ai
---

# Cache read ratio and the causes of cache writes

## Purpose

Prompt caching is cheap to read and expensive to write. The cache read ratio says what share of a
scope's cache traffic was a cheap read; a low ratio means the session kept re-writing its cache.
The cause decomposition then says why the big writes happened: a context compaction, a file read
again, or nothing the transcript explains. Both drive the Cache Read Ratio report. (The "Low cache
reuse" finding on the Summary reads the session's ratio; its own thresholds are the summary
detectors' rules, outside this doc.)

## Code

- Implementation:
  - `server/src/logs/cache-ratio.sql.ts` (`cacheReadRatio`; `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD
    = 25000`). The SQL helper `cacheReadRatioSql` in the same file has no caller at present and is
    not covered here;
  - `server/src/logs/reports/cache-read-ratio.service.ts` (`aggregateScope`, which sums through
    `aggregateTokens` and counts the undefined ratios, and `buildCauses`);
  - `server/src/logs/turn-walk.ts` (`classifyTurnCauses`, the per-session classification
    `buildCauses` sums).
- Twins: `client/src/viewer/lib/format.ts` (`cacheReadRatio`) runs the `ratio` rows;
  `client/src/viewer/pages/repository/analytics/cache-ratio-aggregate.ts` (`aggregateCacheRatio`,
  the Analytics view) runs the `aggregate` rows for the token sums and the ratio. It counts
  sessions differently (timeline root sessions only, even with descendants) and has no
  undefined-ratio count, so those two fields are server-only. There is no
  client copy of the cause rules; the client's own turn detection (`parseSessionLogs`) must agree
  with the server's `walkTurns` (the golden sessions check both sides). Turn detection is input to
  this doc, not part of it.
- Tests:
  - `server/src/logs/cache-ratio.sql.algo.spec.ts` (all rows);
  - `client/src/viewer/lib/format.algo.test.ts` (`ratio` rows);
  - `client/src/viewer/pages/repository/analytics/cache-ratio-aggregate.algo.test.ts`
    (`aggregate` rows).

## Rules

**Ratio.**

1. `ratio = read / (read + write)`. If `read + write <= 0` the ratio is `null` ("n/a"), never 0.
2. Over a scope (several sessions) the ratio is **ratio of sums**: sum reads and writes first,
   divide once. It is never the mean of per-session ratios. A session with no traffic adds 0 to
   both sums and so does not move the ratio, but it still counts in `sessionCount`, and a root
   session whose reads plus writes in the scope are exactly 0 is counted in
   `undefinedRatioSessionCount` ("Sessions
   with undefined ratio (excluded)").
3. Two scopes per root session: `root` uses the session's own tokens and counts 1 session;
   `withDescendants` adds the summed tokens of all its sub-agent sessions (any depth) and counts
   `1 + descendants`.

**Causes of one session** (`classifyTurnCauses`), with a threshold passed in by the caller (the
caller resolves user setting, then team setting, then `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD =
25000`; which values the settings accept is their validation, not part of this doc). A turn's
paths are those of its file tools, and a turn has a compaction boundary when one sits inside it
or right before it; both come from the turn walk:

4. Walk the turns in order with a set of file paths seen so far (paths are compared as exact
   strings). A turn is a **re-read** if any
   of its paths was seen in any earlier turn of the session (not only the previous one, and a
   path listed twice in the same turn does not count); after the check its paths join the set.
5. A turn is **high** if its cache-creation tokens are `>= threshold`.
   - high and the turn has a compaction boundary: compaction (wins over re-read);
   - else high and re-read: file re-read;
   - else: unattributed (every turn below the threshold lands here).
6. Cache-creation tokens the walk could not tie to a turn (orphans) are added to unattributed
   tokens (not to its turn count). So the three token buckets always sum to the session's whole
   cache write.

**Causes over a scope** (`buildCauses`), always on root sessions only:

7. Sum each bucket's tokens and turns over the sessions that have a stored cause row. A session
   without one is counted in `sessionsWithoutCauseData` and adds nothing; a row stored with a
   different threshold than the current one is still summed but counted in `staleSessionCount`.
8. `totalCreationTokens` = the three token sums; each `share` = bucket / total, and all shares
   are 0 when the total is 0.

All token counts are non-negative. The cost fields `aggregateScope` also returns are plain sums
of stored cost terms: each session's `cacheReadCost` is its `session_costs.cost_cache_read` and
its `cacheWriteCost` is `cost_cache_write_5m + cost_cache_write_1h` (both `null` when the session
is unpriced or has no `session_costs` row), and the descendant amounts are the same terms summed
over the sub-agents. The terms themselves are computed at write time by the cost rules
([cost-formula.md](cost-formula.md)), per call when the model has prompt-length tiers, and are not
pinned here. Outside these rules, and not covered by these rows (the report's SQL and its mapping are
exercised end to end by scenario S-REPT-02): the walk
that produces the turns (`walkTurns`) reports orphan tokens as
`max(0, session total - tokens tied to turns)`; the report's SQL mapper turns database values
into the numbers these functions take (`null` -> 0, numeric strings parsed; a session whose
`cause_threshold` is `NULL` has no cause row); the threshold in force is the user's repo setting,
else the team's, else the default; the daily chart groups sessions by UTC day.

## Edge cases

- Ratio zero denominator vs a zero numerator: CR-02, CR-03; all reads: CR-04.
- Ratio of sums vs mean of ratios: CR-05; a no-traffic session: CR-06; all sessions empty: CR-07.
- `root` vs `withDescendants`: CR-08, CR-09.
- Threshold exactly vs one below: CR-11 (compaction), CR-17 (re-read); compaction beats
  re-read: CR-10; re-read is session-wide: CR-12, CR-15 (with a gap); a path twice in one turn:
  CR-16; orphan tokens: CR-10.
- Missing and stale cause rows: CR-13 (stored threshold lower), CR-18 (higher); nothing
  attributed: CR-14.
- Empty input: CR-19 (no sessions), CR-20 (no turns), CR-21 (no rows).

## Examples

Four kinds of rows:

- `"kind": "ratio"`: `read`, `write`. Expects `ratio`.
- `"kind": "aggregate"`: `scope` and `sessions`, each `{read, write}` plus optional
  `descRead`, `descWrite`, `descSessions` (descendant sums, default 0). Expects `sessionCount`,
  `cacheReadTokens`, `cacheWriteTokens`, `ratio`, `undefinedRatioSessionCount`.
- `"kind": "classify"`: `threshold`, `orphan` tokens and `turns`, each
  `{creation, compact, paths}`. Expects the six bucket totals.
- `"kind": "scope-causes"`: `threshold` and `rows`, each a stored cause row
  `{threshold, compaction, reread, unattributed, compactionTurns, rereadTurns, unattributedTurns}`
  or `null` (no row). Expects `totalCreationTokens`, the three shares, the three turn sums,
  `staleSessionCount`, `sessionsWithoutCauseData`.

Ratios and shares are compared to 6 decimal places (a difference below `5e-7`); everything else
exactly.

Rows (29): [`docs/algorithm-examples/cache-ratio-and-causes.json`](../../algorithm-examples/cache-ratio-and-causes.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Zero denominator gives 0 -> CR-02, CR-07.
- Mean of per-session ratios -> CR-05 (0.45).
- An empty session skipped from `sessionCount` -> CR-06.
- `withDescendants` without the descendants (or `root` with them) -> CR-08, CR-09.
- `>` instead of `>=` for high -> CR-11.
- Re-read checked before compaction -> CR-10 (turn 3 becomes a re-read).
- Re-read checked only against the previous turn -> CR-15; low turns not recording paths ->
  CR-12; paths added before the check (a path twice in one turn) -> CR-16.
- `>` instead of `>=` on the re-read branch only -> CR-17.
- Stale only when the stored threshold is lower -> CR-18.
- Empty input crashing or giving `NaN` -> CR-19, CR-20, CR-21.
- Seen paths reset at a compaction -> CR-22.
- Turn counts not summed (or summed into the wrong bucket) -> CR-13.
- Shares rounded -> CR-23.
- Threshold argument ignored (default used) -> CR-26. Paths normalized before comparing -> CR-29. Stale compared with the default instead of
  the current threshold -> CR-27. Undefined count adding tree members -> CR-28.
- Undefined-ratio count taken from the root's own traffic in every scope -> CR-25; from the
  whole tree in the root scope -> CR-24; empty sessions not counted -> CR-06, CR-07.
- Orphan tokens dropped -> CR-10 (54 999 instead of 55 499).
- Stale rows skipped instead of summed -> CR-13 (total 1000).
- Shares `NaN` on total 0 -> CR-14.

## Where the result is visible

- Session -> Info: "Cache read ratio"; Summary: the "Low cache reuse" finding.
- Reports -> Cache Read Ratio: the KPI for root and with sub-agents, the daily chart, the
  per-group table and the causes block (compaction, file re-read, unattributed, stale and
  missing counts).
- API: `GET /api/v1/repositories/:repoId/reports/cache-read-ratio`.
