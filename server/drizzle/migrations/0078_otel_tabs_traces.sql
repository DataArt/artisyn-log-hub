-- OTEL tabs, traces and realtime facts (2026-10-30 otel-tabs-traces, GH-66).
--
-- logs_otel.otel_projection_version is the projection marker of a raw OTEL chunk: NULL = pending,
-- -1 = projection failed (re-marked NULL on the next startup), N = projected by projection
-- version N. The partial index covers exactly the pending rows the background drain claims
-- (FOR UPDATE SKIP LOCKED).
--
-- Five new tables hold the projected per-root-session OTEL facts (the OTEL session.id is always
-- the root session, DD-1): otel_calls (one row per api_request call, keyed by request_id or a
-- stable record hash), otel_spans (one row per trace span), otel_cost_buckets (5-minute UTC
-- rollups per structure / query_source / model / cc_version), otel_session_state (per-root
-- ingest cursor `seq`, realtime/chunk timestamps, the writers' lock row) and otel_reclass_queue
-- (roots whose transcript request ids changed and must be reclassified). All five cascade away
-- with their sessions row; user_id columns are SET NULL on a user delete.
--
-- Additive only: no existing column, table, constraint or row is altered, renamed or deleted.
-- Every statement is guarded (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS), so the
-- file is re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). Older server builds ignore the new tables and column.
--
-- Implicit backfill: otel_projection_version starts NULL on every existing logs_otel row, which
-- marks all OTEL history as pending. After deploy the projection drain walks it in batches
-- (OTEL_PROJECTION_BATCH per OTEL_PROJECTION_INTERVAL_MS), each session in its own transaction,
-- never blocking ingest (SKIP LOCKED). No data is rewritten by this file itself.
--
-- Lock/rewrite profile: the five new tables are new and empty, so their CREATE TABLE takes only
-- instant catalog locks. The ADD COLUMN is nullable WITH NO DEFAULT, so PostgreSQL only updates
-- the catalog (no table rewrite). The partial index on logs_otel takes a brief ShareLock to
-- build over every existing row (all NULL at first). CONCURRENTLY is never used here, since
-- Drizzle wraps every migration file in BEGIN/COMMIT and Postgres forbids CONCURRENTLY in a
-- transaction.

ALTER TABLE logs_otel ADD COLUMN IF NOT EXISTS otel_projection_version smallint;

CREATE INDEX IF NOT EXISTS idx_logs_otel_projection_pending
  ON logs_otel (id)
  WHERE otel_projection_version IS NULL;

CREATE TABLE IF NOT EXISTS otel_calls (
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_key varchar(300) NOT NULL,
  request_id varchar(255),
  query_source varchar(255),
  model varchar(255),
  claude_code_version varchar(64),
  prompt_id varchar(255),
  agent_id varchar(255),
  event_time timestamptz NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cost_usd_micros bigint,
  structure varchar(16) NOT NULL,
  provisional boolean NOT NULL,
  source_mask smallint NOT NULL,
  first_seq bigint NOT NULL,
  seq bigint NOT NULL,
  change_kind varchar(8) NOT NULL,
  CONSTRAINT otel_calls_pk PRIMARY KEY (session_id, call_key),
  CONSTRAINT otel_calls_structure_check CHECK (structure IN ('main', 'subagent', 'hidden'))
);

CREATE INDEX IF NOT EXISTS idx_otel_calls_session_seq
  ON otel_calls (session_id, seq);

CREATE INDEX IF NOT EXISTS idx_otel_calls_session_request_id
  ON otel_calls (session_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS otel_spans (
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trace_id varchar(64) NOT NULL,
  span_id varchar(32) NOT NULL,
  parent_span_id varchar(32),
  name varchar(255) NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  request_id varchar(255),
  agent_id varchar(255),
  query_source varchar(255),
  context varchar(32),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd_micros bigint,
  rollup_cost_usd_micros bigint,
  source_mask smallint NOT NULL,
  first_seq bigint NOT NULL,
  seq bigint NOT NULL,
  change_kind varchar(8) NOT NULL,
  CONSTRAINT otel_spans_pk PRIMARY KEY (session_id, trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_otel_spans_session_seq
  ON otel_spans (session_id, seq);

CREATE INDEX IF NOT EXISTS idx_otel_spans_session_request_id
  ON otel_spans (session_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS otel_cost_buckets (
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  bucket_start timestamptz NOT NULL,
  structure varchar(16) NOT NULL,
  query_source varchar(255) NOT NULL DEFAULT '',
  model varchar(255) NOT NULL DEFAULT '',
  cc_version varchar(64) NOT NULL DEFAULT '',
  calls integer NOT NULL DEFAULT 0,
  cost_usd_micros bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  seq bigint NOT NULL,
  change_kind varchar(8) NOT NULL,
  CONSTRAINT otel_cost_buckets_pk
    PRIMARY KEY (session_id, bucket_start, structure, query_source, model, cc_version)
);

CREATE INDEX IF NOT EXISTS idx_otel_cost_buckets_session_seq
  ON otel_cost_buckets (session_id, seq);

CREATE INDEX IF NOT EXISTS idx_otel_cost_buckets_user_id
  ON otel_cost_buckets (user_id);

CREATE TABLE IF NOT EXISTS otel_session_state (
  session_id integer PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  seq bigint NOT NULL DEFAULT 0,
  transcript_seq bigint,
  otel_hook_version varchar(32),
  has_spans boolean NOT NULL DEFAULT false,
  has_provisional boolean NOT NULL DEFAULT false,
  rt_last_at timestamptz,
  chunk_last_at timestamptz,
  rt_gap_at timestamptz,
  rt_receiver_id varchar(64),
  rt_batch_seq bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otel_session_state_user_id
  ON otel_session_state (user_id);

CREATE INDEX IF NOT EXISTS idx_otel_session_state_created_at
  ON otel_session_state (created_at);

CREATE TABLE IF NOT EXISTS otel_reclass_queue (
  session_id integer PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  queued_at timestamptz NOT NULL DEFAULT now()
);
