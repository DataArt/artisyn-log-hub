-- Prompt-length tiered pricing and stored per-session costs (task 2026-10-26-pricing-fetch-tiered).
--
-- model_pricing.tiers / model_pricing_meta.override_base_tiers: nullable jsonb arrays of
-- PricingTier ({aboveTokens, priceIn, priceOut, priceCacheR, priceCacheW5m, priceCacheW1h},
-- USD/MTok), sorted ascending by aboveTokens. NULL = no tiers. Existing rows keep NULL.
--
-- session_call_tokens: one row per session, `calls` is a columnar object of per-call token
-- arrays (inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens,
-- inputTokensFast, outputTokensFast). Filled by ingest from now on; no backfill (no per-call
-- data exists for old sessions).
--
-- session_costs: one row per session, the stored cost and its breakdown. NULL cost = unpriced.
-- `stale` rows are recomputed by the server's session-cost sweeper.
--
-- Additive only: two new nullable columns, two new tables and a backfill INSERT into one of
-- them. No existing column, table or row is altered, renamed or deleted. Every statement is
-- guarded (ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS, INSERT ... ON CONFLICT DO
-- NOTHING), so the file is re-runnable (migrations here are hand-written, never
-- `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md). The CHECK constraints
-- ride on ADD COLUMN, so a re-run skips them together with the column.
--
-- Lock profile: ADD COLUMN of a nullable jsonb with no default is a catalog-only change
-- (brief AccessExclusiveLock on model_pricing / model_pricing_meta, no rewrite; the CHECK
-- validates instantly because every existing value is NULL). The new tables are empty when
-- their indexes are built (plain CREATE INDEX, no CONCURRENTLY: Drizzle wraps every migration
-- file in BEGIN/COMMIT). The backfill only reads session_stats / sessions / logs /
-- model_pricing (AccessShareLock -- concurrent reads and writes are not blocked).
--
-- Backfill (step 5) is an inline FROZEN copy of the pre-0074 sessionCostSql arithmetic
-- (server/src/logs/cost.sql.ts): base rates, session aggregates, FAST_MODE_MULTIPLIER = 2
-- (surcharge factor 1), priced at the TOP ANCESTOR's sessionPriceDateSql date with the
-- pricingAsOfSql lookup rule. A migration is immutable history, so this copy is not a
-- second live implementation. cost_tier_delta is 0 (no tiers exist yet).
--
-- Edge cases in production data:
--   | Case                                              | Result                                                        |
--   |---------------------------------------------------|---------------------------------------------------------------|
--   | session_stats.model is NULL (or empty)            | cost and terms NULL, unavailable_reason 'unknown-model',      |
--   |                                                   | model_id NULL                                                 |
--   | model has no model_pricing row as of price date   | cost and terms NULL, unavailable_reason 'unknown-model'       |
--   | session with no timed log                         | price_date = CURRENT_DATE (sessionPriceDateSql fallback)      |
--   | parent_session_id cycle                           | walk capped at depth 50; the depth-50 node is the top         |
--   | parent_session_id points to a missing session     | the walk stops; the last found session is the top             |
--   | several ancestors at the same depth               | DISTINCT ON (start) ... ORDER BY depth DESC, id picks one     |
--   | OTEL-only session_stats row (zero tokens)         | cost 0 when priced; readers keep their EXISTS guard           |

-- 1) model_pricing.tiers.
ALTER TABLE model_pricing
  ADD COLUMN IF NOT EXISTS tiers jsonb
    CONSTRAINT model_pricing_tiers_array_chk
    CHECK (tiers IS NULL OR jsonb_typeof(tiers) = 'array');

-- 2) model_pricing_meta.override_base_tiers.
ALTER TABLE model_pricing_meta
  ADD COLUMN IF NOT EXISTS override_base_tiers jsonb
    CONSTRAINT model_pricing_meta_override_base_tiers_array_chk
    CHECK (override_base_tiers IS NULL OR jsonb_typeof(override_base_tiers) = 'array');

-- 3) session_call_tokens.
CREATE TABLE IF NOT EXISTS session_call_tokens (
  session_id integer PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  calls      jsonb NOT NULL CONSTRAINT session_call_tokens_calls_object_chk
               CHECK (jsonb_typeof(calls) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4) session_costs.
CREATE TABLE IF NOT EXISTS session_costs (
  session_id             integer PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  model_id               varchar,
  price_date             date NOT NULL,
  pricing_effective_from date,
  pricing_source         varchar(16),
  cost                   double precision,
  cost_input             double precision,
  cost_output            double precision,
  cost_cache_read        double precision,
  cost_cache_write_5m    double precision,
  cost_cache_write_1h    double precision,
  cost_web_search        double precision,
  cost_fast_surcharge    double precision,
  cost_tier_delta        double precision,
  unavailable_reason     varchar(32),
  stale                  boolean NOT NULL DEFAULT false,
  computed_at            timestamptz NOT NULL DEFAULT now()
);

-- The sweeper's queue: only stale rows are indexed.
CREATE INDEX IF NOT EXISTS idx_session_costs_stale
  ON session_costs (session_id) WHERE stale;

-- Price-change invalidation: model_id = M AND price_date >= E.
CREATE INDEX IF NOT EXISTS idx_session_costs_model_date
  ON session_costs (model_id, price_date);

-- 5) Backfill one session_costs row per session_stats row (frozen pre-0074 formula).
INSERT INTO session_costs (
  session_id, model_id, price_date, pricing_effective_from, pricing_source,
  cost, cost_input, cost_output, cost_cache_read, cost_cache_write_5m, cost_cache_write_1h,
  cost_web_search, cost_fast_surcharge, cost_tier_delta, unavailable_reason, stale, computed_at
)
WITH RECURSIVE ancestry AS (
  -- Walk every session_stats row's session up its parent_session_id chain.
  SELECT s.id AS start_id, s.id AS cur_id, s.parent_session_id, 0 AS depth
  FROM session_stats ss
  JOIN sessions s ON s.id = ss.session_id
  UNION ALL
  SELECT a.start_id, p.id, p.parent_session_id, a.depth + 1
  FROM ancestry a
  JOIN sessions p ON p.session_id = a.parent_session_id
  WHERE a.depth < 50
),
top_ancestor AS (
  SELECT DISTINCT ON (start_id) start_id, cur_id AS top_id
  FROM ancestry
  ORDER BY start_id, depth DESC, cur_id
),
top_price_date AS (
  -- sessionPriceDateSql of the top ancestor.
  SELECT t.top_id,
         COALESCE(
           ((SELECT MIN(pl.start_time) FROM logs pl WHERE pl.session_id = t.top_id) AT TIME ZONE 'UTC')::date,
           CURRENT_DATE
         ) AS price_date
  FROM (SELECT DISTINCT top_id FROM top_ancestor) t
)
SELECT
  ss.session_id,
  NULLIF(REGEXP_REPLACE(COALESCE(ss.model, ''), '-[0-9]{8}$', ''), ''),
  pd.price_date,
  p.effective_from,
  p.source,
  CASE WHEN p.model_id IS NOT NULL THEN (
    ((COALESCE(ss.input_tokens, 0) + COALESCE(ss.input_tokens_fast, 0) * 1)::float / 1000000.0 * p.price_in) +
    ((COALESCE(ss.output_tokens, 0) + COALESCE(ss.output_tokens_fast, 0) * 1)::float / 1000000.0 * p.price_out) +
    (COALESCE(ss.cache_read_tokens, 0)::float / 1000000.0 * p.price_cache_r) +
    (COALESCE(ss.cache_write_5m_tokens, 0)::float / 1000000.0 * p.price_cache_w_5m) +
    (COALESCE(ss.cache_write_1h_tokens, 0)::float / 1000000.0 * p.price_cache_w_1h) +
    (COALESCE(ss.web_search_requests, 0)::float * p.price_web_search)
  ) END,
  CASE WHEN p.model_id IS NOT NULL
    THEN COALESCE(ss.input_tokens, 0)::float / 1000000.0 * p.price_in END,
  CASE WHEN p.model_id IS NOT NULL
    THEN COALESCE(ss.output_tokens, 0)::float / 1000000.0 * p.price_out END,
  CASE WHEN p.model_id IS NOT NULL
    THEN COALESCE(ss.cache_read_tokens, 0)::float / 1000000.0 * p.price_cache_r END,
  CASE WHEN p.model_id IS NOT NULL
    THEN COALESCE(ss.cache_write_5m_tokens, 0)::float / 1000000.0 * p.price_cache_w_5m END,
  CASE WHEN p.model_id IS NOT NULL
    THEN COALESCE(ss.cache_write_1h_tokens, 0)::float / 1000000.0 * p.price_cache_w_1h END,
  CASE WHEN p.model_id IS NOT NULL
    THEN COALESCE(ss.web_search_requests, 0)::float * p.price_web_search END,
  CASE WHEN p.model_id IS NOT NULL
    THEN (COALESCE(ss.input_tokens_fast, 0) * 1)::float / 1000000.0 * p.price_in
       + (COALESCE(ss.output_tokens_fast, 0) * 1)::float / 1000000.0 * p.price_out END,
  CASE WHEN p.model_id IS NOT NULL THEN 0.0::float END,
  CASE WHEN p.model_id IS NULL THEN 'unknown-model' END,
  false,
  now()
FROM session_stats ss
JOIN top_ancestor ta ON ta.start_id = ss.session_id
JOIN top_price_date pd ON pd.top_id = ta.top_id
LEFT JOIN LATERAL (
  -- pricingAsOfSql(ss.model, price_date), plus effective_from / source.
  SELECT DISTINCT ON (model_id) model_id,
         effective_from,
         source,
         price_in::float         AS price_in,
         price_out::float        AS price_out,
         price_cache_r::float    AS price_cache_r,
         price_cache_w_5m::float AS price_cache_w_5m,
         price_cache_w_1h::float AS price_cache_w_1h,
         price_web_search::float AS price_web_search
  FROM model_pricing
  WHERE effective_from <= pd.price_date
    AND model_id = REGEXP_REPLACE(COALESCE(ss.model, ''), '-[0-9]{8}$', '')
  ORDER BY model_id, effective_from DESC
) p ON true
ON CONFLICT (session_id) DO NOTHING;
