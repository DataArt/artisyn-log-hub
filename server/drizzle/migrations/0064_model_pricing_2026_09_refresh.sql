-- Refresh model_pricing against Anthropic's published rates as of 2026-09-23.
--
-- Sources (fetched directly, per docs/knowledgebase/model-pricing-research.md):
--   * https://platform.claude.com/docs/en/docs/about-claude/pricing
--   * https://platform.claude.com/docs/en/docs/about-claude/models/overview
--
-- Reference table only — no user, session or stats row is touched, and no DDL runs here.
-- Every statement is an idempotent upsert, so re-running the file converges on the same
-- table state.
--
-- Column rules this file follows (see 0051_cache_write_ttl_pricing.sql):
--   * price_cache_w_5m = 1.25 x price_in, price_cache_w_1h = 2 x price_in for every
--     Claude model, and BOTH must be written explicitly — their DEFAULT 0 would price
--     1h cache writes at zero.
--   * price_cache_w (deprecated, no readers) carries the 5m rate, as everywhere else.
--   * price_cache_r is normally 0.1 x price_in, but Anthropic now publishes two
--     exceptions: 0.025x on Fable/Mythos 5.1 ($0.25) and 0.05x on Opus 5.5 ($0.20).
--     Those are taken from the pricing page verbatim, not derived.
--   * price_web_search is USD per web-search REQUEST ($10 / 1,000 searches = $0.01).
--   * chars_per_token: 2.700 for the tokenizer introduced with Opus 4.7 (the pricing
--     page states it emits ~30% more tokens for the same text: 3.5 / 1.3 ~= 2.7);
--     3.500 for Sonnet 4.6 and earlier, which keep the previous tokenizer.
--   * context_length: 1,000,000 for Claude 4.6 and later at standard pricing,
--     200,000 for everything older.
--
-- Model ids are stored in their dateless (alias) form on purpose: every cost query and
-- both client parsers normalise a model id with REGEXP_REPLACE / .replace(/-\d{8}$/, ''),
-- so a dated row can never be hit by a lookup that the alias row does not already serve.

-- 1) Claude Sonnet 5 — the scheduled price increase never happened.
--
--    Anthropic's pricing page now states: the $2/$10 per MTok rate "announced at launch
--    as introductory pricing through August 31, 2026, is now the standard price. The
--    previously scheduled increase to $3/$15 ... on September 1, 2026 will not occur."
--
--    The existing 2026-07-20 row ($3/$15/$0.30, written by 0043) is DELIBERATELY LEFT
--    IN PLACE: 0040/0042 anchored it to real OTEL evidence (session 3c82c7e4-…,
--    2026-08-07, whose Anthropic-reported cost_usd reconstructed exactly at those
--    rates), and rewriting an evidence-backed historical row on the strength of a docs
--    note that only speaks to today would trade one unverifiable claim for another.
--    Instead this adds a row from 2026-09-01 — the date the increase would have taken
--    effect and from which the published rate is unambiguous. Resolution is "newest row
--    with effective_from <= CURRENT_DATE", so Sonnet 5 prices at $2/$10 from now on and
--    the August window keeps whatever 0042/0043 concluded.
--
--    (0034 originally inserted a 2026-09-01 row at $3/$15 and 0040/0042 both deleted it;
--    this INSERT reuses that date with the correct rates, and the ON CONFLICT branch
--    rewrites it on any database where that row somehow survived.)
INSERT INTO model_pricing (
  model_id, price_in, price_out, price_cache_r, price_cache_w,
  price_cache_w_5m, price_cache_w_1h, price_web_search,
  chars_per_token, context_length, currency, effective_from
) VALUES
  ('claude-sonnet-5', 2.000000, 10.000000, 0.200000, 2.500000,
   2.500000, 4.000000, 0.010000, 2.700, 1000000, 'USD', DATE '2026-09-01')
ON CONFLICT (model_id, effective_from) DO UPDATE
SET price_in         = EXCLUDED.price_in,
    price_out        = EXCLUDED.price_out,
    price_cache_r    = EXCLUDED.price_cache_r,
    price_cache_w    = EXCLUDED.price_cache_w,
    price_cache_w_5m = EXCLUDED.price_cache_w_5m,
    price_cache_w_1h = EXCLUDED.price_cache_w_1h,
    price_web_search = EXCLUDED.price_web_search,
    chars_per_token  = EXCLUDED.chars_per_token,
    context_length   = EXCLUDED.context_length;

-- 2) Models released since the table was last refreshed.
--
--    Claude Opus 5.5   — $4 / $20 per MTok, cache read $0.20 (0.05x), 1M context.
--    Claude Fable 5.1  — $10 / $50 per MTok, cache read $0.25 (0.025x), 1M context.
--    Claude Mythos 5.1 — same rates as Fable 5.1 (limited availability / Glasswing); its
--      id follows the claude-mythos-5 precedent already in this table, since the models
--      overview page lists ids only for generally-available models.
--
--    effective_from is derived from Anthropic's retirement commitments on the models
--    overview page (retirement is committed at >= 12 months from release): Opus 5.5
--    retires "not sooner than September 22, 2027" -> 2026-09-22; Fable/Mythos 5.1
--    "not sooner than September 1, 2027" -> 2026-09-01. Both dates are already past, so
--    the rows are live immediately; no session in this database reports either model
--    yet, so an inferred release date cannot mis-price existing data.
INSERT INTO model_pricing (
  model_id, price_in, price_out, price_cache_r, price_cache_w,
  price_cache_w_5m, price_cache_w_1h, price_web_search,
  chars_per_token, context_length, currency, effective_from
) VALUES
  ('claude-opus-5-5',    4.000000, 20.000000, 0.200000,  5.000000,
    5.000000,  8.000000, 0.010000, 2.700, 1000000, 'USD', DATE '2026-09-22'),
  ('claude-fable-5-1',  10.000000, 50.000000, 0.250000, 12.500000,
   12.500000, 20.000000, 0.010000, 2.700, 1000000, 'USD', DATE '2026-09-01'),
  ('claude-mythos-5-1', 10.000000, 50.000000, 0.250000, 12.500000,
   12.500000, 20.000000, 0.010000, 2.700, 1000000, 'USD', DATE '2026-09-01')
ON CONFLICT (model_id, effective_from) DO UPDATE
SET price_in         = EXCLUDED.price_in,
    price_out        = EXCLUDED.price_out,
    price_cache_r    = EXCLUDED.price_cache_r,
    price_cache_w    = EXCLUDED.price_cache_w,
    price_cache_w_5m = EXCLUDED.price_cache_w_5m,
    price_cache_w_1h = EXCLUDED.price_cache_w_1h,
    price_web_search = EXCLUDED.price_web_search,
    chars_per_token  = EXCLUDED.chars_per_token,
    context_length   = EXCLUDED.context_length;

-- 3) Older models the pricing page lists but this table never carried, in the dateless
--    form the lookups actually search for.
--
--    claude-sonnet-4-5 / claude-sonnet-4 were simply missing. claude-opus-4 and
--    claude-3-5-haiku close a normalisation gap: the table holds
--    'claude-opus-4-20250514' and 'claude-3-5-haiku-20241022', but every lookup strips
--    the -YYYYMMDD suffix first and then finds nothing, so a session on either model
--    resolves to 'unknown-model' and shows no cost at all today. Their rates are
--    identical to the dated rows, so this adds pricing where there was none and changes
--    no existing figure. ('claude-opus-4-0' stays as-is — a different string a caller
--    may report verbatim.)
--
--    effective_from 2025-01-01 matches every other legacy row in this table.
INSERT INTO model_pricing (
  model_id, price_in, price_out, price_cache_r, price_cache_w,
  price_cache_w_5m, price_cache_w_1h, price_web_search,
  chars_per_token, context_length, currency, effective_from
) VALUES
  ('claude-sonnet-4-5',  3.000000, 15.000000, 0.300000,  3.750000,
    3.750000,  6.000000, 0.010000, 3.500, 200000, 'USD', DATE '2025-01-01'),
  ('claude-sonnet-4',    3.000000, 15.000000, 0.300000,  3.750000,
    3.750000,  6.000000, 0.010000, 3.500, 200000, 'USD', DATE '2025-01-01'),
  ('claude-opus-4',     15.000000, 75.000000, 1.500000, 18.750000,
   18.750000, 30.000000, 0.010000, 3.500, 200000, 'USD', DATE '2025-01-01'),
  ('claude-3-5-haiku',   0.800000,  4.000000, 0.080000,  1.000000,
    1.000000,  1.600000, 0.010000, 3.500, 200000, 'USD', DATE '2025-01-01')
ON CONFLICT (model_id, effective_from) DO UPDATE
SET price_in         = EXCLUDED.price_in,
    price_out        = EXCLUDED.price_out,
    price_cache_r    = EXCLUDED.price_cache_r,
    price_cache_w    = EXCLUDED.price_cache_w,
    price_cache_w_5m = EXCLUDED.price_cache_w_5m,
    price_cache_w_1h = EXCLUDED.price_cache_w_1h,
    price_web_search = EXCLUDED.price_web_search,
    chars_per_token  = EXCLUDED.chars_per_token,
    context_length   = EXCLUDED.context_length;

-- 4) Report the rates the refreshed table resolves to for every Claude model, so an
--    operator upgrading a long-lived database can see them in the server log. NOTICEs
--    are not printed by node-postgres by default, so a quiet `npm run migrate` is
--    expected (same caveat as 0051).
DO $$
DECLARE
  summary TEXT;
BEGIN
  SELECT STRING_AGG(
           FORMAT('%s: in %s / out %s / cache read %s (effective %s)',
                  model_id, price_in, price_out, price_cache_r, effective_from),
           E'\n  ' ORDER BY model_id)
    INTO summary
  FROM (
    SELECT DISTINCT ON (model_id)
           model_id, price_in, price_out, price_cache_r, effective_from
    FROM model_pricing
    WHERE effective_from <= CURRENT_DATE
      AND model_id LIKE 'claude%'
    ORDER BY model_id, effective_from DESC
  ) effective_rows;

  RAISE NOTICE '0064 model_pricing refresh — effective Claude rates today:%  %', E'\n', summary;
END $$;
