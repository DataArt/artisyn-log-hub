-- T-101 Part B: AI Session Attribution — 3 new tables + this codebase's first GIN index.
--
-- Additive only: no existing table is touched, no column rewrite. All three tables are
-- created together (Design Decision 26) because they are created and read together and have
-- no reason to be split across migration files.

-- 1) session_attribution: one row per session, current resolved attribute values, written
-- only by the conditional upsert in session-attribution.service.ts (higher prompt_watermark
-- wins, Design Decision 22).
CREATE TABLE IF NOT EXISTS session_attribution (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_watermark INTEGER NOT NULL,
  values JSONB NOT NULL,              -- keyed by attribute `key`
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- This repo's first GIN index (Design Decision 25). jsonb_path_ops is a smaller, faster
-- opclass than the default jsonb_ops, but it only supports the containment operator (`@>`)
-- -- which is exactly and exclusively what attributeFilterSql()'s eq/is/any/isnull forms use
-- against this column (Design Decision 21); it does not support key-existence (`?`) or path
-- queries, which this feature never needs. Table is empty at creation time, so build cost is
-- negligible now -- see the migration safety review below for the growth caveat.
CREATE INDEX IF NOT EXISTS idx_session_attribution_values_gin
  ON session_attribution USING GIN (values jsonb_path_ops);

-- 2) session_attribution_runs: append-only, one row per evaluation attempt. Unlike
-- turn_end_advisor_runs, session_id here is not necessarily the invoking session's own row
-- (the evaluation runs as a separate spawned session) -- invoking_session_id carries the
-- string session id it was invoked on behalf of, for the Attribution Spend Executive
-- Summary section's join-back (Design Decision 16).
CREATE TABLE IF NOT EXISTS session_attribution_runs (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_watermark INTEGER NOT NULL,
  eval_session_id VARCHAR(255),
  invoking_session_id VARCHAR(255),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  outcome VARCHAR(20) NOT NULL,        -- 'applied' | 'ignored_stale' | 'failed'
  model VARCHAR(64),
  cost_usd NUMERIC(12, 6),
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_attribution_runs_session_id
  ON session_attribution_runs (session_id);

-- 3) session_prompt_watermark: one row per session, written only by the combined
-- config-resolution GET's side effect, monotonically (GREATEST) -- what evaluationRequired
-- (Design Decision 29) compares the attribution branch's own evaluatedWatermark against.
CREATE TABLE IF NOT EXISTS session_prompt_watermark (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_watermark INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
