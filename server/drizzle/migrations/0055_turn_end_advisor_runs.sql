-- T-101 Part A: Turn-End Cost Advisor run log.
--
-- Additive only: one brand-new table, no existing table touched, no rewrite. Append-only —
-- one row per evaluation attempt (Design Decision 11); `session_id` is the invoking session
-- directly (Design Decision 16), and this same table doubles as display persistence (the
-- pane reads the latest `outcome='submitted'` row per session, Design Decision 12).

CREATE TABLE IF NOT EXISTS turn_end_advisor_runs (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  eval_session_id VARCHAR(255),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  outcome VARCHAR(20) NOT NULL,          -- 'submitted' | 'failed'
  summary_general TEXT,                  -- set only on 'submitted'
  cost_factors JSONB,                    -- string[]; set only on 'submitted'
  harness_advice JSONB,                  -- string[]; set only on 'submitted'
  failure_reason TEXT,                   -- set only on 'failed'
  model VARCHAR(64),
  cost_usd NUMERIC(12, 6),
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Drives both the run-log scan and the "latest submitted result for this session" lookup
-- (ORDER BY started_at DESC LIMIT 1), and is what the Advisor Spend Executive Summary
-- section (Design Decision 34) joins through.
CREATE INDEX IF NOT EXISTS idx_turn_end_advisor_runs_session_id
  ON turn_end_advisor_runs (session_id);
