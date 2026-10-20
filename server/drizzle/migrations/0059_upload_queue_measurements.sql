-- T-111: per-attempt upload-queue worker measurements, backing the admin Upload Queue
-- load/throughput stats block.
--
-- Additive only: one brand-new table plus its two indexes. No existing table is touched, no
-- data is rewritten or backfilled, so this migration is safe to apply to a live database.
--
-- Append-only — one row per completed processing attempt, success or failure. The table is
-- needed because the `upload_queue` row is deleted on success and each of the 3-15 cluster
-- workers runs its own scheduler, so neither the queue table nor in-process counters can
-- report worker throughput.
--
-- `session_id` deliberately carries NO foreign key into `sessions(id)` (Design Decision 2,
-- same precedent as `turn_end_advisor_runs`): the parent session may never have been
-- ingested (a failed attempt) or may already have been purged by retention while the
-- measurement is still inside the stats window.

CREATE TABLE IF NOT EXISTS upload_queue_measurements (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,   -- raw id, no FK (see above)
  log_type VARCHAR(50) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,   -- the stats-window and retention-prune key
  duration_ms INTEGER NOT NULL,       -- active parse time
  queue_latency_ms BIGINT NOT NULL,   -- finished_at - received_at, end-to-end wait
  size_bytes BIGINT NOT NULL,         -- copied verbatim on both outcomes
  outcome VARCHAR(20) NOT NULL        -- 'success' | 'failure'
);

-- Serves the 15-minute stats window, the 7-day average-speed window, and the retention
-- prune (DELETE ... WHERE finished_at < cutoff).
CREATE INDEX IF NOT EXISTS idx_upload_queue_measurements_finished_at
  ON upload_queue_measurements (finished_at);

-- Serves the per-session test-cleanup delete and ad-hoc per-session diagnostics.
CREATE INDEX IF NOT EXISTS idx_upload_queue_measurements_session_id
  ON upload_queue_measurements (session_id);
