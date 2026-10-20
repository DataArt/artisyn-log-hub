-- T-84 transcript-derived usage analytics.
--
-- Additive only: no column or table is dropped, renamed or retyped, and no existing value
-- is rewritten. Every new column is NOT NULL with a constant DEFAULT, which PostgreSQL 11+
-- records in the catalog instead of rewriting the table, so none of these ALTERs takes a
-- blocking full-table lock (same pattern as 0049_cache_ratio_stats.sql).
--
-- All new figures are backfilled by POST :repoId/recompute-all-sessions, never by this
-- migration — existing sessions read 0 until that runs, and no re-upload is required.

-- 1) session_stats gains the productivity counters and the service-tier token split.
--
--    These are ADDITIVE to the existing lines_changed column, which measures a different
--    thing (total lines present in Edit new_string / Write content — lines written, with no
--    delta and no removals) and keeps its current definition, values and consumers exactly
--    as they are. In particular `cost per line` continues to divide by lines_changed, so no
--    historical figure shifts. Redefining lines_changed is explicitly out of scope for T-84.
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS lines_added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS lines_removed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS commit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS pr_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS turn_count INTEGER NOT NULL DEFAULT 0;

--    Coverage of the diff-based line counts above, so every surface can state
--    "over N of M Edit/Write calls" instead of implying the figure is complete.
--    Measured on the live DB: sub-agent transcripts omit toolUseResult on ~88% of their
--    Edit/Write calls, and sub-agents hold roughly half of all such calls.
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS diff_lines_covered_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS diff_lines_total_calls INTEGER NOT NULL DEFAULT 0;

--    Per-service_tier token totals: { "<tier>": { input, output, cacheRead,
--    cacheCreation, cacheWrite5m, cacheWrite1h } }. Assistant messages that carry no
--    service_tier field land in the 'unknown' key (3,394 of 43,886 on the live DB).
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS token_by_service_tier JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 2) session_tool_stats: one row per session x tool.
--
--    Unscoped (no team_id / user_id), like session_stats and unlike session_file_stats /
--    session_cause_stats, because nothing about these figures depends on a scoped
--    repo_config field. A real table rather than a jsonb column so repository-scope
--    aggregation is a plain indexed GROUP BY tool_name — the "no logs.body parsing at
--    request time" NFR.
--
--    duration_ms_total exists only to derive an exact mean and must never be surfaced as a
--    "total tool time": one assistant message can issue several tool_use blocks that run
--    concurrently, so their durations overlap in wall clock. parallel_batch_calls records
--    how many of this tool's calls were in such a batch.
--
--    duration_ms_histogram holds counts in the eleven fixed buckets defined by
--    DURATION_BUCKET_LOWER_BOUNDS_MS in server/src/logs/tool-stats.ts
--    ([0,100) [100,250) [250,500) [500,1000) [1000,2500) [2500,5000) [5000,10000)
--     [10000,30000) [30000,60000) [60000,300000) [300000,inf)).
--    Repository-scope p50 is interpolated from the summed histogram and reported as
--    approximate; session-scope p50 is computed exactly on the client. Those bucket bounds
--    are append-only — changing one invalidates every stored histogram.
CREATE TABLE IF NOT EXISTS session_tool_stats (
  session_id             INTEGER      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name              VARCHAR(128) NOT NULL,
  calls                  INTEGER      NOT NULL DEFAULT 0,
  failures               INTEGER      NOT NULL DEFAULT 0,
  unresolved             INTEGER      NOT NULL DEFAULT 0,
  duration_covered_calls INTEGER      NOT NULL DEFAULT 0,
  duration_ms_total      BIGINT       NOT NULL DEFAULT 0,
  duration_ms_max        BIGINT       NOT NULL DEFAULT 0,
  duration_ms_histogram  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  duration_by_source     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  parallel_batch_calls   INTEGER      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_tool_stats_session_id
  ON session_tool_stats (session_id);

-- One row per session x tool. The writer deletes then re-inserts a session's rows, so this
-- is a correctness guard rather than an ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS session_tool_stats_session_tool_unique
  ON session_tool_stats (session_id, tool_name);
