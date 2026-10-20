-- Claude Sonnet 5 moves from introductory pricing ($2/$10 per MTok, seeded in
-- 0023_add_missing_model_pricing.sql) to standard pricing ($3/$15) on 2026-09-01.
--
-- Every cost query in the codebase already selects pricing as
--   SELECT DISTINCT ON (model_id) ... WHERE effective_from <= CURRENT_DATE
--   ORDER BY model_id, effective_from DESC
-- i.e. "the newest row that has already taken effect" — the table was designed
-- for one row per (model, price change), but the PRIMARY KEY on model_id alone
-- allowed only one row per model, so effective_from could never do its job.
--
-- Widening the PK to (model_id, effective_from) lets us land the price change
-- ahead of time: the new row is invisible to every query until 2026-09-01 and
-- takes over automatically on that date, with no code change and no scheduled
-- manual UPDATE to remember.

-- Step 1: widen the primary key so a model can carry several dated price rows.
-- Both columns are already NOT NULL, so no backfill or rewrite is needed, and
-- the table is tiny (two dozen rows) — the brief AccessExclusiveLock is fine.
ALTER TABLE model_pricing DROP CONSTRAINT IF EXISTS model_pricing_pkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'model_pricing'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE model_pricing
      ADD CONSTRAINT model_pricing_pkey PRIMARY KEY (model_id, effective_from);
  END IF;
END $$;

-- Step 2: future-dated standard pricing. The existing $2/$10 row is left in
-- place on purpose — it stays the effective row until 2026-08-31 inclusive.
--
-- NOTE for future migrations: the conflict target is now the composite key.
-- `ON CONFLICT (model_id)` no longer matches a unique constraint and will fail.
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-sonnet-5', 3.00, 15.00, 0.30, 3.75, 'USD', '2026-09-01')
ON CONFLICT (model_id, effective_from) DO NOTHING;
