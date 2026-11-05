-- OTEL Live view (2026-11-04 otel-live-view).
--
-- otel_session_state gains an expression index on GREATEST(rt_last_at, chunk_last_at): the
-- Live view's candidate filter ("last OTEL activity within the live window") reads it.
--
-- Two derived tables hold the stored lifetime totals of a root session (otel_session_totals)
-- and of each of its agents (otel_agent_totals), so a Live poll reads them by primary key
-- instead of re-summing every live session's otel_calls. They are written only by the OTEL
-- writer (otel-facts-writer.ts) inside the transaction that holds the otel_session_state lock:
-- additive deltas while the session row is current (seq >= MAX(otel_cost_buckets.seq) of the
-- root), and a full GROUP BY rebuild from otel_calls otherwise. Agent rows with no calls left
-- are zeroed, never deleted. Both cascade on a hard delete of the session; the soft-delete purge
-- deletes them explicitly.
--
-- otel_calls (session_id, event_time) and otel_spans (session_id, start_time) indexes serve the
-- Live view's time-window queries (cost per minute, latency, latest calls / events).
--
-- Additive only: no existing column, table or row is changed. Every CREATE is guarded
-- (IF NOT EXISTS), so the file is re-runnable (migrations here are hand-written, never
-- `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md). Older server builds never
-- read or write the new tables; buckets they write while a newer process runs leave the totals
-- row behind the bucket seq, so the next newer write rebuilds it.
--
-- Implicit backfill: none. An existing session gets its totals rows on its next OTEL write (the
-- freshness rule fails without a row and the writer rebuilds); until then the reader computes
-- that root's totals inline, read-only.
--
-- Lock/rewrite profile: no table rewrite. Each CREATE INDEX takes a SHARE lock on its table
-- while it builds (writes wait, reads continue); otel_calls and otel_spans are the largest OTEL
-- tables, so the build time grows with them. CONCURRENTLY is never used here, since Drizzle wraps
-- every migration file in BEGIN/COMMIT (an owner decision for this task).
--
-- Rollback: drop the two tables and the three indexes; nothing else depends on them.

CREATE INDEX IF NOT EXISTS idx_otel_session_state_last_at
  ON otel_session_state ((GREATEST(rt_last_at, chunk_last_at)));

CREATE TABLE IF NOT EXISTS otel_session_totals (
  session_id integer PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  calls integer NOT NULL DEFAULT 0,
  cost_usd_micros bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  first_call_at timestamptz,
  last_call_at timestamptz,
  seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS otel_agent_totals (
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_key varchar(255) NOT NULL,
  agent_name varchar(255),
  calls integer NOT NULL DEFAULT 0,
  cost_usd_micros bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  first_call_at timestamptz,
  last_call_at timestamptz,
  seq bigint NOT NULL DEFAULT 0,
  CONSTRAINT otel_agent_totals_pk PRIMARY KEY (session_id, agent_key)
);

CREATE INDEX IF NOT EXISTS idx_otel_calls_session_event_time
  ON otel_calls (session_id, event_time);

CREATE INDEX IF NOT EXISTS idx_otel_spans_session_start_time
  ON otel_spans (session_id, start_time);

COMMENT ON INDEX idx_otel_session_state_last_at IS 'Last OTEL activity of a root (GREATEST ignores NULLs): the Live view candidate filter.';
COMMENT ON INDEX idx_otel_calls_session_event_time IS 'Time-window reads of a root''s calls (Live view cost per minute, latest calls, agent buckets).';
COMMENT ON INDEX idx_otel_spans_session_start_time IS 'Time-window reads of a root''s spans (Live view latency, top tools, events).';

COMMENT ON TABLE otel_session_totals IS 'Stored lifetime OTEL totals of a root session, derived from otel_calls by the OTEL writer (additive deltas, or a rebuild when stale). Read by the Live view.';
COMMENT ON COLUMN otel_session_totals.session_id IS 'Root session (sessions.id), the session_id of the otel_* tables.';
COMMENT ON COLUMN otel_session_totals.calls IS 'Number of otel_calls of the root, hidden calls included.';
COMMENT ON COLUMN otel_session_totals.cost_usd_micros IS 'Sum of otel_calls.cost_usd_micros (NULL cost counts as 0), in USD micros.';
COMMENT ON COLUMN otel_session_totals.input_tokens IS 'Sum of otel_calls.input_tokens.';
COMMENT ON COLUMN otel_session_totals.output_tokens IS 'Sum of otel_calls.output_tokens.';
COMMENT ON COLUMN otel_session_totals.cache_read_tokens IS 'Sum of otel_calls.cache_read_tokens.';
COMMENT ON COLUMN otel_session_totals.cache_write_tokens IS 'Sum of otel_calls.cache_write_tokens.';
COMMENT ON COLUMN otel_session_totals.first_call_at IS 'Earliest otel_calls.event_time; exact after a rebuild, may be slightly wide after a delta that moved a call time. NULL = no calls.';
COMMENT ON COLUMN otel_session_totals.last_call_at IS 'Latest otel_calls.event_time; exact after a rebuild, may be slightly wide after a delta that moved a call time. NULL = no calls.';
COMMENT ON COLUMN otel_session_totals.seq IS 'otel_session_state.seq of the write that last updated the row; the row is current while seq >= MAX(otel_cost_buckets.seq) of the root.';

COMMENT ON TABLE otel_agent_totals IS 'Stored lifetime OTEL totals per agent of a root session, derived from otel_calls by the OTEL writer. Hidden calls have no row; an agent with no calls left is zeroed, never deleted. Read by the Live view.';
COMMENT ON COLUMN otel_agent_totals.session_id IS 'Root session (sessions.id).';
COMMENT ON COLUMN otel_agent_totals.agent_key IS 'otel_calls.agent_id, or the literal main for calls with no agent_id (structure <> hidden).';
COMMENT ON COLUMN otel_agent_totals.agent_name IS 'Latest reported otel_calls.agent_name of the agent (sub-agent type); NULL = never reported.';
COMMENT ON COLUMN otel_agent_totals.calls IS 'Number of otel_calls of the agent.';
COMMENT ON COLUMN otel_agent_totals.cost_usd_micros IS 'Sum of the agent''s otel_calls.cost_usd_micros (NULL cost counts as 0), in USD micros.';
COMMENT ON COLUMN otel_agent_totals.input_tokens IS 'Sum of the agent''s otel_calls.input_tokens.';
COMMENT ON COLUMN otel_agent_totals.output_tokens IS 'Sum of the agent''s otel_calls.output_tokens.';
COMMENT ON COLUMN otel_agent_totals.cache_read_tokens IS 'Sum of the agent''s otel_calls.cache_read_tokens.';
COMMENT ON COLUMN otel_agent_totals.cache_write_tokens IS 'Sum of the agent''s otel_calls.cache_write_tokens.';
COMMENT ON COLUMN otel_agent_totals.first_call_at IS 'Earliest event_time of the agent''s calls; NULL = no calls left.';
COMMENT ON COLUMN otel_agent_totals.last_call_at IS 'Latest event_time of the agent''s calls (drives agent liveness); NULL = no calls left.';
COMMENT ON COLUMN otel_agent_totals.seq IS 'otel_session_state.seq of the write that last updated the row.';
