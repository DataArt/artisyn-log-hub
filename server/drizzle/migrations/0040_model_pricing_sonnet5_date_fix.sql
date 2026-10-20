-- Fix the claude-sonnet-5 effective-date inversion in the model_pricing reference table.
--
-- Evidence (T-85 OTEL ingest, session 3c82c7e4-cf26-45a7-a354-80c8fc863b5c, 2026-08-07):
-- Anthropic's own per-request cost_usd totals $0.286395 and reconstructs EXACTLY from
--   input $3.00 / output $15.00 / cache-read $0.30 per Mtok
-- while the row that was effective on that date (2026-07-20) charged $2.00 / $10.00 / $0.20,
-- understating the session by ~43%. The correct base rates were present but future-dated to
-- 2026-09-01, i.e. the two effective dates were inverted.
--
-- Fix: put the correct rates on the earlier (currently active) row and drop the future-dated
-- duplicate, so there is exactly one claude-sonnet-5 price row and it is correct today.
--
-- This is a reference/lookup table only — no user or session data is touched. The DELETE is
-- intentional and required: leaving the 2026-09-01 row would re-apply the same wrong split on
-- that date.
--
-- NOTE: price_cache_w stays at the 5m/1.25x rate (3.75). Observed billing for this session was
-- $6.00/Mtok = 2x base, because Claude Code used the 1h cache TTL. Pricing cache writes by TTL
-- needs a schema split (5m vs 1h) and is deliberately left to T-87 — encoding a single blended
-- value here would just trade one wrong number for another.

UPDATE model_pricing
SET price_in = 3.000000,
    price_out = 15.000000,
    price_cache_r = 0.300000,
    price_cache_w = 3.750000
WHERE model_id = 'claude-sonnet-5'
  AND effective_from = DATE '2026-07-20';

DELETE FROM model_pricing
WHERE model_id = 'claude-sonnet-5'
  AND effective_from = DATE '2026-09-01';
