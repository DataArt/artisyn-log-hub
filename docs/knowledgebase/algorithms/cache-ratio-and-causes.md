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

```examples
[
  {
    "id": "CR-01",
    "input": {"kind": "ratio", "read": 900, "write": 100},
    "expected": {"ratio": 0.9},
    "note": "Rule 1: 900 / (900 + 100) = 0.9."
  },
  {
    "id": "CR-02",
    "input": {"kind": "ratio", "read": 0, "write": 0},
    "expected": {"ratio": null},
    "note": "Rule 1: denominator 0, so null (n/a), not 0."
  },
  {
    "id": "CR-03",
    "input": {"kind": "ratio", "read": 0, "write": 500},
    "expected": {"ratio": 0},
    "note": "Rule 1: denominator 500 > 0, 0 / 500 = 0 (a real 0, all writes)."
  },
  {
    "id": "CR-04",
    "input": {"kind": "ratio", "read": 500, "write": 0},
    "expected": {"ratio": 1},
    "note": "Rule 1: 500 / 500 = 1."
  },
  {
    "id": "CR-05",
    "input": {"kind":"aggregate","scope":"root","sessions":[{"read":9000,"write":1000},{"read":0,"write":10}]},
    "expected": {"sessionCount":2,"cacheReadTokens":9000,"cacheWriteTokens":1010,"ratio":0.899101,"undefinedRatioSessionCount":0},
    "note": "Rule 2: 9000 / (9000 + 1010) = 0.899101. The mean of the two ratios (0.9 and 0) would be 0.45. S-REPT-02 checks ratio of sums through the report; this row pins the TS helper on its own."
  },
  {
    "id": "CR-06",
    "input": {"kind":"aggregate","scope":"root","sessions":[{"read":900,"write":100},{"read":0,"write":0}]},
    "expected": {"sessionCount":2,"cacheReadTokens":900,"cacheWriteTokens":100,"ratio":0.9,"undefinedRatioSessionCount":1},
    "note": "Rule 2: the empty session adds 0 to both sums (ratio stays 900 / 1000 = 0.9) but counts as a session, and as one with an undefined ratio."
  },
  {
    "id": "CR-07",
    "input": {"kind":"aggregate","scope":"root","sessions":[{"read":0,"write":0},{"read":0,"write":0}]},
    "expected": {"sessionCount":2,"cacheReadTokens":0,"cacheWriteTokens":0,"ratio":null,"undefinedRatioSessionCount":2},
    "note": "Rules 1 and 2: sums are 0, ratio null; both sessions have an undefined ratio."
  },
  {
    "id": "CR-08",
    "input": {"kind":"aggregate","scope":"root","sessions":[{"read":100,"write":100,"descRead":800,"descWrite":0,"descSessions":3}]},
    "expected": {"sessionCount":1,"cacheReadTokens":100,"cacheWriteTokens":100,"ratio":0.5,"undefinedRatioSessionCount":0},
    "note": "Rule 3, root: own tokens only, 100 / 200 = 0.5, one session. (S-REPT-02 shows both scopes end to end; CR-08/09 pin which tokens each scope adds.)"
  },
  {
    "id": "CR-09",
    "input": {"kind":"aggregate","scope":"withDescendants","sessions":[{"read":100,"write":100,"descRead":800,"descWrite":0,"descSessions":3}]},
    "expected": {"sessionCount":4,"cacheReadTokens":900,"cacheWriteTokens":100,"ratio":0.9,"undefinedRatioSessionCount":0},
    "note": "Rule 3, withDescendants: read 100 + 800 = 900, write 100 + 0 = 100, 900 / 1000 = 0.9; sessions 1 + 3 = 4."
  },
  {
    "id": "CR-10",
    "input": {"kind": "classify", "threshold": 25000, "orphan": 500, "turns": [{"creation": 30000, "compact": false, "paths": ["src/a.ts"]}, {"creation": 30000, "compact": false, "paths": ["src/a.ts"]}, {"creation": 40000, "compact": true, "paths": ["src/a.ts"]}, {"creation": 24999, "compact": false, "paths": ["src/a.ts"]}]},
    "expected": {"compactionTokens": 40000, "fileRereadTokens": 30000, "unattributedTokens": 55499, "compactionTurns": 1, "fileRereadTurns": 1, "unattributedTurns": 2},
    "note": "Turn 1: high but a.ts is new, unattributed. Turn 2: high, re-read, file re-read 30000. Turn 3: high, compaction and re-read, compaction wins: 40000. Turn 4: 24999 < 25000, unattributed. Unattributed tokens 30000 + 24999 + orphan 500 = 55499 (2 turns). Total 125499 = all creation + orphan."
  },
  {
    "id": "CR-11",
    "input": {"kind": "classify", "threshold": 25000, "orphan": 0, "turns": [{"creation": 25000, "compact": true, "paths": []}, {"creation": 24999, "compact": true, "paths": []}]},
    "expected": {"compactionTokens": 25000, "fileRereadTokens": 0, "unattributedTokens": 24999, "compactionTurns": 1, "fileRereadTurns": 0, "unattributedTurns": 1},
    "note": "Rule 5 is inclusive: 25000 >= 25000 is high (compaction); 24999 is not, so even with a compaction boundary it is unattributed."
  },
  {
    "id": "CR-12",
    "input": {"kind": "classify", "threshold": 25000, "orphan": 0, "turns": [{"creation": 100, "compact": false, "paths": ["src/a.ts"]}, {"creation": 30000, "compact": false, "paths": ["src/b.ts", "src/a.ts"]}]},
    "expected": {"compactionTokens": 0, "fileRereadTokens": 30000, "unattributedTokens": 100, "compactionTurns": 0, "fileRereadTurns": 1, "unattributedTurns": 1},
    "note": "Rule 4: a.ts was seen in turn 1 (a low turn still adds its paths), so turn 2 is a re-read and high: file re-read 30000."
  },
  {
    "id": "CR-13",
    "input": {"kind":"scope-causes","threshold":25000,"rows":[{"threshold":25000,"compaction":600,"reread":300,"unattributed":100,"compactionTurns":1,"rereadTurns":1,"unattributedTurns":1},null,{"threshold":10000,"compaction":0,"reread":0,"unattributed":1000,"compactionTurns":0,"rereadTurns":0,"unattributedTurns":2}]},
    "expected": {"totalCreationTokens":2000,"compactionShare":0.3,"fileRereadShare":0.15,"unattributedShare":0.55,"compactionTurns":1,"fileRereadTurns":1,"unattributedTurns":3,"staleSessionCount":1,"sessionsWithoutCauseData":1},
    "note": "Rule 7: the null row adds nothing and counts as without data; the 10000-threshold row is summed but stale. Tokens 600 / 300 / 100 + 1000 = 1100, total 2000; shares 0.3, 0.15, 0.55 (sum 1); turns 1 / 1 / 1 + 2 = 3."
  },
  {
    "id": "CR-14",
    "input": {"kind":"scope-causes","threshold":25000,"rows":[{"threshold":25000,"compaction":0,"reread":0,"unattributed":0,"compactionTurns":0,"rereadTurns":0,"unattributedTurns":0}]},
    "expected": {"totalCreationTokens":0,"compactionShare":0,"fileRereadShare":0,"unattributedShare":0,"compactionTurns":0,"fileRereadTurns":0,"unattributedTurns":0,"staleSessionCount":0,"sessionsWithoutCauseData":0},
    "note": "Rule 8: total 0, so every share is 0 (not NaN)."
  },
  {
    "id": "CR-15",
    "input": {"kind":"classify","threshold":25000,"orphan":0,"turns":[{"creation":100,"compact":false,"paths":["src/a.ts"]},{"creation":100,"compact":false,"paths":["src/b.ts"]},{"creation":30000,"compact":false,"paths":["src/a.ts"]}]},
    "expected": {"compactionTokens":0,"fileRereadTokens":30000,"unattributedTokens":200,"compactionTurns":0,"fileRereadTurns":1,"unattributedTurns":2},
    "note": "Rule 4: a.ts was seen two turns earlier (b.ts in between); the high turn 3 is still a re-read: 30000. A check against the previous turn only would call it unattributed."
  },
  {
    "id": "CR-16",
    "input": {"kind":"classify","threshold":25000,"orphan":0,"turns":[{"creation":30000,"compact":false,"paths":["src/a.ts","src/a.ts"]}]},
    "expected": {"compactionTokens":0,"fileRereadTokens":0,"unattributedTokens":30000,"compactionTurns":0,"fileRereadTurns":0,"unattributedTurns":1},
    "note": "Rule 4: the same path twice inside the first turn is not a re-read (paths join the set only after the check): high but unattributed."
  },
  {
    "id": "CR-17",
    "input": {"kind":"classify","threshold":25000,"orphan":0,"turns":[{"creation":100,"compact":false,"paths":["src/a.ts"]},{"creation":25000,"compact":false,"paths":["src/a.ts"]},{"creation":24999,"compact":false,"paths":["src/a.ts"]}]},
    "expected": {"compactionTokens":0,"fileRereadTokens":25000,"unattributedTokens":25099,"compactionTurns":0,"fileRereadTurns":1,"unattributedTurns":2},
    "note": "Rule 5 on the re-read branch: 25000 >= 25000 with a re-read is file re-read; 24999 with a re-read is not high, unattributed. Unattributed 100 + 24999 = 25099."
  },
  {
    "id": "CR-18",
    "input": {"kind":"scope-causes","threshold":25000,"rows":[{"threshold":50000,"compaction":0,"reread":0,"unattributed":500,"compactionTurns":0,"rereadTurns":0,"unattributedTurns":1}]},
    "expected": {"totalCreationTokens":500,"compactionShare":0,"fileRereadShare":0,"unattributedShare":1,"compactionTurns":0,"fileRereadTurns":0,"unattributedTurns":1,"staleSessionCount":1,"sessionsWithoutCauseData":0},
    "note": "Rule 7: a stored threshold above the current one is stale too (any difference counts); its 500 tokens are still summed, all unattributed: share 1."
  },
  {
    "id": "CR-19",
    "input": {"kind":"aggregate","scope":"withDescendants","sessions":[]},
    "expected": {"sessionCount":0,"cacheReadTokens":0,"cacheWriteTokens":0,"ratio":null,"undefinedRatioSessionCount":0},
    "note": "Rules 1-2 on no sessions: sums 0, ratio null, count 0."
  },
  {
    "id": "CR-20",
    "input": {"kind":"classify","threshold":25000,"orphan":0,"turns":[]},
    "expected": {"compactionTokens":0,"fileRereadTokens":0,"unattributedTokens":0,"compactionTurns":0,"fileRereadTurns":0,"unattributedTurns":0},
    "note": "No turns and no orphans: every bucket 0."
  },
  {
    "id": "CR-21",
    "input": {"kind":"scope-causes","threshold":25000,"rows":[]},
    "expected": {"totalCreationTokens":0,"compactionShare":0,"fileRereadShare":0,"unattributedShare":0,"compactionTurns":0,"fileRereadTurns":0,"unattributedTurns":0,"staleSessionCount":0,"sessionsWithoutCauseData":0},
    "note": "Rules 7-8 on no sessions: total 0, shares 0, no stale or missing sessions."
  },
  {
    "id": "CR-22",
    "input": {"kind":"classify","threshold":25000,"orphan":0,"turns":[{"creation":100,"compact":false,"paths":["src/a.ts"]},{"creation":40000,"compact":true,"paths":["src/b.ts"]},{"creation":30000,"compact":false,"paths":["src/a.ts"]}]},
    "expected": {"compactionTokens":40000,"fileRereadTokens":30000,"unattributedTokens":100,"compactionTurns":1,"fileRereadTurns":1,"unattributedTurns":1},
    "note": "Rule 4 does not reset at a compaction: a.ts was seen in turn 1, before the compaction turn 2, and turn 3 (high) is still a re-read: 30000."
  },
  {
    "id": "CR-23",
    "input": {"kind":"scope-causes","threshold":25000,"rows":[{"threshold":25000,"compaction":1,"reread":0,"unattributed":2,"compactionTurns":1,"rereadTurns":0,"unattributedTurns":1}]},
    "expected": {"totalCreationTokens":3,"compactionShare":0.333333,"fileRereadShare":0,"unattributedShare":0.666667,"compactionTurns":1,"fileRereadTurns":0,"unattributedTurns":1,"staleSessionCount":0,"sessionsWithoutCauseData":0},
    "note": "Rule 8 does not round: 1/3 = 0.333333..., 2/3 = 0.666667 (to 6 places). Rounding shares to two places would give 0.33 and 0.67."
  },
  {
    "id": "CR-24",
    "input": {"kind":"aggregate","scope":"root","sessions":[{"read":0,"write":0,"descRead":50,"descWrite":50,"descSessions":1}]},
    "expected": {"sessionCount":1,"cacheReadTokens":0,"cacheWriteTokens":0,"ratio":null,"undefinedRatioSessionCount":1},
    "note": "Rule 2, root scope: the root has no traffic of its own, so its ratio is undefined there (count 1) even though its sub-agent has some."
  },
  {
    "id": "CR-25",
    "input": {"kind":"aggregate","scope":"withDescendants","sessions":[{"read":0,"write":0,"descRead":50,"descWrite":50,"descSessions":1}]},
    "expected": {"sessionCount":2,"cacheReadTokens":50,"cacheWriteTokens":50,"ratio":0.5,"undefinedRatioSessionCount":0},
    "note": "Rule 3, with descendants: 50 / 100 = 0.5, two sessions, and the scope has traffic, so nothing is undefined."
  },
  {
    "id": "CR-26",
    "input": {"kind":"classify","threshold":30000,"orphan":0,"turns":[{"creation":30000,"compact":true,"paths":[]},{"creation":29999,"compact":true,"paths":[]}]},
    "expected": {"compactionTokens":30000,"fileRereadTokens":0,"unattributedTokens":29999,"compactionTurns":1,"fileRereadTurns":0,"unattributedTurns":1},
    "note": "Rule 5 uses the given threshold, here 30000: 30000 is high, 29999 is not (with the default 25000 both would be compaction)."
  },
  {
    "id": "CR-27",
    "input": {"kind":"scope-causes","threshold":10000,"rows":[{"threshold":10000,"compaction":0,"reread":0,"unattributed":10,"compactionTurns":0,"rereadTurns":0,"unattributedTurns":1},{"threshold":25000,"compaction":0,"reread":0,"unattributed":30,"compactionTurns":0,"rereadTurns":0,"unattributedTurns":1}]},
    "expected": {"totalCreationTokens":40,"compactionShare":0,"fileRereadShare":0,"unattributedShare":1,"compactionTurns":0,"fileRereadTurns":0,"unattributedTurns":2,"staleSessionCount":1,"sessionsWithoutCauseData":0},
    "note": "Rule 7 compares with the current threshold, 10000: the first row matches it, the second (25000, the default) is the stale one."
  },
  {
    "id": "CR-28",
    "input": {"kind":"aggregate","scope":"withDescendants","sessions":[{"read":0,"write":0,"descRead":0,"descWrite":0,"descSessions":2}]},
    "expected": {"sessionCount":3,"cacheReadTokens":0,"cacheWriteTokens":0,"ratio":null,"undefinedRatioSessionCount":1},
    "note": "Rules 2-3: a tree of 1 + 2 sessions with no traffic at all: sessionCount 3, ratio null, and the root counts once as undefined (it counts root sessions, not tree members)."
  },
  {
    "id": "CR-29",
    "input": {"kind":"classify","threshold":25000,"orphan":0,"turns":[{"creation":100,"compact":false,"paths":["src/a.ts"]},{"creation":30000,"compact":false,"paths":["src/A.ts"]},{"creation":30000,"compact":false,"paths":["./src/a.ts"]}]},
    "expected": {"compactionTokens":0,"fileRereadTokens":0,"unattributedTokens":60100,"compactionTurns":0,"fileRereadTurns":0,"unattributedTurns":3},
    "note": "Rule 4 compares paths as exact strings: src/A.ts and ./src/a.ts are not src/a.ts, so neither high turn is a re-read: all 100 + 30000 + 30000 = 60100 unattributed."
  }
]
```

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
