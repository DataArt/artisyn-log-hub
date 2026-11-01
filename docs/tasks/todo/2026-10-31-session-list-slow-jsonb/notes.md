# Notes: 2026-10-31-session-list-slow-jsonb

## 2026-10-31 — Investigation findings (moved from requirements.md)

Measured on a production Docker build of commit `1cffcbc` (local prod):

- `GET /api/v1/repositories/1/sessions` takes **10.4–12.8 s** (3 runs, 117 KB response).
  `/sessions/ids` takes 17 ms and `/sessions/branches` 0.27 s on the same repo.
- Data: 809 sessions, 171 `claude` logs with **169 MB** of jsonb bodies (`logs` table 459 MB).
- Sampling `pg_stat_activity` during the request shows two hot queries in
  `getRepositorySessions` (`server/src/logs/repositories.controller.ts`):
  1. **Cost query, `assistant_lines` + `session_events_jsonb` CTEs** — `EXPLAIN ANALYZE` of that
     part alone: **10.5 s**. It runs `jsonb_array_elements` over every claude body of the listed
     sessions (≈17.6 k assistant events), sorts them with `DISTINCT ON (session, message.id)`, and
     only uses the result to pick the first non-null main-thread model per session. Cost itself
     already comes from the stored `session_costs` / `tree_costs`.
  2. **`hasWorkflow` query** — `body @> '[{…"name":"Workflow"…}]'` plus an `EXISTS` over
     `jsonb_array_elements`: **2.7 s**.
- Both costs grow linearly with the total transcript volume of the repo, not with the number of
  sessions, and are recomputed on every list load / refresh.

Why `npm run perf` did not catch it:

- The perf seed (`server/perf-tests/run.ts` → `seedTestData`) uploads one session with a 5–20 line
  transcript, so the jsonb scans cost milliseconds.
- The gate is only relative to `baseline.json` (±20 %), so a query that is slow on real data
  volume, or already slow in the baseline, never trips it.

## 2026-11-01 — Verification (chunk 7)

On a scratch copy of the local-prod DB (809 `session_stats` rows, 176 claude logs, 171 MB of
jsonb), restored into the dev Postgres:

- **Parity (AC-1/AC-2):** list JSON of repos 1 and 56 from the pre-change server (`git archive
  HEAD`) and from the changed server on the same copy — 148 listed sessions, `totalCost`,
  `computedCost`, `costBreakdown`, `costUnavailableReason`, `hasWorkflow` identical (in fact the
  whole rows were identical); 39 sessions with `hasWorkflow: true`.
- **Backfill (AC-4):** first start logged `backfilled 809 session_stats row(s) in 12257ms`;
  `list_flags_version IS NULL` count 0 afterwards; the second start logged no backfill.
- **Latency (AC-5):** repo 1 list 12.9–15.2 s before, 0.25–0.29 s after (`curl` time_total).
  `EXPLAIN ANALYZE` of the new cost query: 224 ms, no scan of `logs.body`; the only
  `jsonb_array_elements` left is over `model_pricing.tiers`.
- **Perf (AC-7..AC-10):** the first heavy seed (30 × 1 MB, repeated-words padding) did NOT fail on
  the pre-change code (p95 396–461 ms): each body fitted in the 4 MB `work_mem`, so the old
  per-line scan stayed in memory. The seed is now 12 × ~5 MB with random (incompressible)
  padding and Write tool_use blocks of ~4 KB: pre-change `repos:sessions-heavy` p95 3154 ms →
  budget FAIL, exit 1; changed code p95 22.7 ms → PASS, exit 0.
  Read-only run against local prod (`PERF_REPO_ID=1`, `PERF_ITERATIONS=10 PERF_WARMUP=1
  PERF_PARALLEL=1` — the default 500 × 10 parallel would hammer a real instance whose list takes
  ~11 s) reported `repos:sessions` FAIL (p95 30 s, 4/10 timeouts) and skipped
  `repos:sessions-heavy`; row counts of `sessions`, `logs`, `repositories`, `teams`, `api_keys`,
  `upload_queue` unchanged.
- **Contract fixture:** world-v1 is loaded with raw SQL after the startup backfill ran on the empty
  schema, so its `session_stats` rows had no list flags and F17 list rows lost their cost.
  `recomputeWorldSessionCosts` now also runs `backfillSessionListFlags`, as a server start would.

## Follow-up: heavy perf coverage and the analytics timeline (2026-11-01)

- The perf harness now runs a `-heavy` twin of every read endpoint of a repository and of one session
  against the heavy seed (`repoReadScenarios` / `sessionReadScenarios` in `server/perf-tests/scenarios.ts`),
  each with a 500 ms p95 budget. The first run found `repos:analytics-timeline-heavy` at p95 5659 ms; every
  other endpoint stayed under 75 ms.
- Cause: `getAnalyticsTimeline` counted `logLineCount` with `jsonb_array_length(logs.body)` (2.7 s alone for
  12 x 5 MB, cold) and ran its raw-JSONB fallback CTEs (model/tokens, Edit/Write lines, images, work time) for
  every session although `session_stats` wins every column but `model`.
- Fix: migration 0081 adds `session_stats.claude_line_count` (list flags version 2, same writer and backfill;
  0081 resets version-1 rows to pending), and the timeline scans the body only for `raw_sessions` (no stats
  row, `NULL` model or `NULL` line count).
- Results: heavy timeline p95 5659 ms -> 37 ms; local prod repo 1 timeline 28.8 s -> 0.33 s. Parity on local
  prod (148 rows, before vs after the redeploy): identical except the session that was live during the
  capture and `totalCost` differences in the 15th significant digit (float summation order).
- Local prod v2 backfill: 812 rows in 36.8 s (the v1 run took 14.9 s; the line count detoasts every body).
- New perf baseline: `tmp/perftests/baseline.json` from the 13:34 run (old one kept as
  `baseline.prev-2026-11-01.json`).
