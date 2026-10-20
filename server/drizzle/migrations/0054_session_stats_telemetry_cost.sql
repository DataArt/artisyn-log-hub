-- T-100: session_stats.telemetry_cost as the denormalized OTEL cost source of truth.
--
-- Additive only: no column or table is dropped, renamed or retyped. ADD COLUMN has no
-- DEFAULT, so PostgreSQL records it in the catalog only (no full-table rewrite / no
-- blocking AccessExclusiveLock hold beyond the instant catalog update).
--
-- Re-runnable: the backfill recomputes telemetry_cost from SUM(logs_otel.cost_usd_micros)
-- (falling back to the otel-summary JSONB body only when a session has zero logs_otel
-- rows) on every run and upserts it, so a re-run can never regress a live-ingest value
-- with a stale figure.

ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS telemetry_cost BIGINT;

-- Backfill: one unbatched pass, matching 0051_cache_write_ttl_pricing.sql's precedent
-- (Drizzle wraps every migration file in a single BEGIN/COMMIT, so batching would buy
-- nothing here, and the corpus is small).
--
-- otel_sums is the authoritative source for any session with logs_otel rows.
-- jsonb_fallback covers the rare claude-otel `logs` row with NO logs_otel rows at all
-- (pre-dates the logs_otel table, or a chunk that failed to persist its detail rows) by
-- reading the same otel-summary JSONB body the live read path used before T-100.
-- combined UNION ALLs the two — they are mutually exclusive by the jsonb_fallback
-- NOT EXISTS guard, so no session can appear in both and no double-count is possible.
--
-- Creates a session_stats row for a historical OTEL-only session (one with a
-- claude-otel log but no claude/claude-subagent log, hence no existing session_stats
-- row) via the INSERT ... ON CONFLICT upsert below, leaving every other NOT NULL
-- counter column at its schema default.
WITH otel_sums AS (
  SELECT session_id, SUM(cost_usd_micros) AS total_micros
  FROM logs_otel
  GROUP BY session_id
),
jsonb_fallback AS (
  SELECT l.session_id, (l.body -> 0 ->> 'costUsdMicros')::bigint AS total_micros
  FROM logs l
  WHERE l.log_type = 'claude-otel'
    AND jsonb_typeof(l.body) = 'array'
    AND jsonb_array_length(l.body) > 0
    AND NOT EXISTS (SELECT 1 FROM logs_otel lo WHERE lo.session_id = l.session_id)
),
combined AS (
  SELECT session_id, total_micros FROM otel_sums
  UNION ALL
  SELECT session_id, total_micros FROM jsonb_fallback
)
INSERT INTO session_stats (session_id, telemetry_cost, updated_at)
SELECT session_id,
       CASE WHEN total_micros IS NULL OR total_micros = 0 THEN NULL ELSE total_micros END,
       now()
FROM combined
ON CONFLICT (session_id) DO UPDATE
  SET telemetry_cost = EXCLUDED.telemetry_cost;
