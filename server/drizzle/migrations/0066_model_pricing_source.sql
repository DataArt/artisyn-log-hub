-- Model pricing fetch and admin overrides: a `source` column on model_pricing plus two
-- small side tables (per-model meta, per-source fetch state).
--
-- Additive only. No column or table is dropped, renamed or retyped, no price value is
-- rewritten, and no row is deleted. Every DDL statement is IF NOT EXISTS / ADD COLUMN IF
-- NOT EXISTS and every INSERT is ON CONFLICT DO NOTHING, so the whole file is re-runnable
-- (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md).
--
-- Lock/rewrite profile:
--   * `ADD COLUMN source ... NOT NULL DEFAULT 'manual'` uses a constant default, so on
--     PostgreSQL >= 11 it is metadata-only -- no table rewrite.
--   * The inline CHECK constraint is validated by a scan of model_pricing, and step 2's
--     backfill UPDATE rewrites its rows. model_pricing is tiny (tens of rows), so the
--     AccessExclusiveLock it takes is held for milliseconds.
--   * The session_stats backfill (step 4) is a read-only SELECT DISTINCT/GROUP BY; it takes
--     only an AccessShareLock on session_stats and never blocks ingest writes.
--   * Both new tables are created empty in this same transaction.
--
-- Backfill:
--   * model_pricing.source on existing rows: 'anthropic' for claude-*, 'openrouter' for
--     provider/model ids, 'manual' otherwise. Rows inserted later without an explicit
--     source get 'manual' from the default.
--   * model_pricing_meta: one row (first_seen_at = now()) per distinct normalized
--     session_stats.model that has no effective model_pricing row -- the "unpriced" set.
--   * model_pricing_fetch_state: the 'anthropic' and 'openrouter' rows, all NULLs.

-- 1) model_pricing.source: origin of each price version.
ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS source varchar(16) NOT NULL DEFAULT 'manual'
  CONSTRAINT model_pricing_source_check
  CHECK (source IN ('anthropic', 'openrouter', 'manual', 'override'));

-- 2) Backfill the origin of existing rows. Only rows still at the default are touched,
--    so a re-run never rewrites a source set after this migration first ran.
UPDATE model_pricing
SET source = CASE
  WHEN model_id LIKE 'claude-%' THEN 'anthropic'
  WHEN model_id LIKE '%/%' THEN 'openrouter'
  ELSE 'manual'
END
WHERE source = 'manual'
  AND (model_id LIKE 'claude-%' OR model_id LIKE '%/%');

-- 3) New side tables.
-- model_pricing_meta: per-model facts that do not belong to a price version -- when an
-- unpriced model was first seen, and the base price hidden under an active override.
-- An unpriced model has a meta row and NO model_pricing row.
CREATE TABLE IF NOT EXISTS model_pricing_meta (
  model_id                       varchar(255) PRIMARY KEY,
  first_seen_at                  timestamptz,
  override_base_source           varchar(16)
    CONSTRAINT model_pricing_meta_override_base_source_check
    CHECK (override_base_source IN ('anthropic', 'openrouter')),
  override_base_price_in         numeric(10, 6),
  override_base_price_out        numeric(10, 6),
  override_base_price_cache_r    numeric(10, 6),
  override_base_price_cache_w_5m numeric(10, 6),
  override_base_price_cache_w_1h numeric(10, 6),
  override_base_price_web_search numeric(10, 6),
  override_base_chars_per_token  numeric(6, 3),
  override_base_context_length   integer,
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

-- model_pricing_fetch_state: one row per price source ('anthropic', 'openrouter') with the
-- last attempt/success timestamps and outcome. Also the cluster claim row for the daily
-- Anthropic fetch.
CREATE TABLE IF NOT EXISTS model_pricing_fetch_state (
  source          varchar(16) PRIMARY KEY,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_result     varchar(16),
  last_counts     jsonb,
  last_error      text
);

-- 4) Register models already seen in session_stats that have no effective price.
--    Normalization matches the runtime registry: trim, then strip a trailing -YYYYMMDD
--    date suffix. Empty / '<synthetic>' ids are dropped, and ids longer than the
--    varchar(255) key are skipped rather than failing the migration (session_stats.model
--    is an unbounded varchar).
INSERT INTO model_pricing_meta (model_id, first_seen_at)
SELECT n.model_id, now()
FROM (
  SELECT REGEXP_REPLACE(BTRIM(s.model), '-[0-9]{8}$', '') AS model_id
  FROM session_stats s
  WHERE s.model IS NOT NULL
  GROUP BY 1
) n
WHERE n.model_id NOT IN ('', '<synthetic>')
  AND char_length(n.model_id) <= 255
  AND NOT EXISTS (
    SELECT 1 FROM model_pricing mp
    WHERE mp.model_id = n.model_id
      AND mp.effective_from <= CURRENT_DATE
  )
ON CONFLICT (model_id) DO NOTHING;

-- 5) Seed the two fetch-state rows (all NULLs until the first fetch / import).
INSERT INTO model_pricing_fetch_state (source)
VALUES ('anthropic'), ('openrouter')
ON CONFLICT (source) DO NOTHING;
