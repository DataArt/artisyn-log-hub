-- Corrects migration 0040, which overreached.
--
-- 0040 read the two claude-sonnet-5 rows as a swapped pair and consolidated onto one. That was
-- wrong: per 0034, the $2/$10 row was a deliberate INTRODUCTORY rate meant to run until the
-- standard $3/$15 row took over on 2026-09-01. 0040 therefore erased a real historical price
-- period and would have overpriced every Sonnet 5 session in that window.
--
-- What the evidence actually shows: OTEL's authoritative api_request.cost_usd for session
-- 3c82c7e4-cf26-45a7-a354-80c8fc863b5c on 2026-08-07 reconstructs EXACTLY at $3.00 / $15.00 /
-- $0.30 per Mtok. So the introductory period had already ended by 2026-08-07 — earlier than the
-- 2026-09-01 the table assumed. The dates were not inverted; the intro END DATE was too late.
--
-- Minimal fix consistent with all available evidence: restore the introductory row on its
-- original effective date, and start the standard rate at the earliest date we can actually
-- prove it was in force (2026-08-07). Resolution is `effective_from <= CURRENT_DATE ORDER BY
-- effective_from DESC LIMIT 1`, so this yields intro rates before 2026-08-07 and standard rates
-- from then on.
--
-- OPEN QUESTION for the maintainer: the true intro end date is unknown — it lies somewhere in
-- [2026-07-20, 2026-08-07]. Sessions in that window are still priced at the introductory rate
-- and are understated if standard pricing actually began earlier. Move this row's
-- effective_from back once the real date is known.
--
-- Reference table only; no user or session data is touched.

INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES ('claude-sonnet-5', 2.000000, 10.000000, 0.200000, 2.500000, 'USD', DATE '2026-07-20')
ON CONFLICT (model_id, effective_from) DO UPDATE
SET price_in = EXCLUDED.price_in,
    price_out = EXCLUDED.price_out,
    price_cache_r = EXCLUDED.price_cache_r,
    price_cache_w = EXCLUDED.price_cache_w;

INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES ('claude-sonnet-5', 3.000000, 15.000000, 0.300000, 3.750000, 'USD', DATE '2026-08-07')
ON CONFLICT (model_id, effective_from) DO UPDATE
SET price_in = EXCLUDED.price_in,
    price_out = EXCLUDED.price_out,
    price_cache_r = EXCLUDED.price_cache_r,
    price_cache_w = EXCLUDED.price_cache_w;

-- 0040 already dropped the 2026-09-01 row; this keeps a fresh-DB run consistent with an
-- upgraded one, since the standard rate now starts on 2026-08-07 instead.
DELETE FROM model_pricing
WHERE model_id = 'claude-sonnet-5'
  AND effective_from = DATE '2026-09-01';
