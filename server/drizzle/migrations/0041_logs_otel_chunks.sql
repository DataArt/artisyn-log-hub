-- OTEL chunk storage (T-85 follow-up).
--
-- The receiver writes one file per inbound OTLP HTTP request; the uploader ships those files in
-- time order; each uploaded chunk lands here as exactly one row, raw. The per-session `logs` row
-- with log_type='otel' holds the NORMALIZED result derived from these chunks (currently just the
-- session cost), so analytics never has to walk the raw OTLP envelopes.
--
-- cost_usd_micros is an integer on purpose: costs are summed as bigint micros and divided once at
-- the end, so a report over thousands of chunks carries no float drift. It is nullable because a
-- chunk may legitimately carry no api_request records (metrics-only, or hook/tool events).
--
-- (session_id, chunk_key) is UNIQUE so a re-uploaded chunk upserts instead of double-counting —
-- the uploader re-ships files whose size changed, and cost must not accumulate on re-ingest.

CREATE TABLE IF NOT EXISTS logs_otel (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chunk_key VARCHAR(255) NOT NULL,
  received_at TIMESTAMPTZ,
  body JSONB NOT NULL,
  cost_usd_micros BIGINT,
  record_count INTEGER,
  processed_at TIMESTAMPTZ,
  CONSTRAINT logs_otel_session_chunk_unique UNIQUE (session_id, chunk_key)
);

CREATE INDEX IF NOT EXISTS idx_logs_otel_session_id ON logs_otel (session_id);
CREATE INDEX IF NOT EXISTS idx_logs_otel_user_id ON logs_otel (user_id);
-- Chunks are replayed in arrival order when the normalized per-session record is recomputed.
CREATE INDEX IF NOT EXISTS idx_logs_otel_session_received_at ON logs_otel (session_id, received_at);

-- Clean out the pre-chunk otel rows. These were written by the original T-85 design (one appended
-- file per session, whole file re-uploaded each Stop) and are not convertible into chunk rows:
-- the per-request arrival boundaries they would need were never recorded. Explicitly requested,
-- and safe -- otel rows are a derived telemetry copy, reproducible by re-uploading, and nothing
-- consumes them yet.
DELETE FROM logs WHERE log_type = 'otel';
