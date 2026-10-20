-- Collapse claude-sonnet-5 to a single, correct price row.
--
-- 0042 preserved the introductory $2/$10 rate for [2026-07-20, 2026-08-07) because the real end
-- of the introductory period was unknown and rewriting it would have overpriced sessions in that
-- window. The maintainer has since confirmed that data and pricing older than one week are not of
-- interest, which removes the reason to model that period at all.
--
-- So: keep one row, carrying the rates OTEL proves were in force on 2026-08-07
-- ($3.00 / $15.00 / $0.30 per Mtok), effective from the original 2026-07-20 date so every session
-- inside the window anyone cares about resolves to it.
--
-- Net effect vs 0042: sessions between 2026-07-20 and 2026-08-06 now price at standard rates
-- instead of introductory ones. Deliberate, and explicitly sanctioned.
--
-- Reference table only; no user or session data is touched.

INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES ('claude-sonnet-5', 3.000000, 15.000000, 0.300000, 3.750000, 'USD', DATE '2026-07-20')
ON CONFLICT (model_id, effective_from) DO UPDATE
SET price_in = EXCLUDED.price_in,
    price_out = EXCLUDED.price_out,
    price_cache_r = EXCLUDED.price_cache_r,
    price_cache_w = EXCLUDED.price_cache_w;

-- Drop the now-redundant second row added by 0042; the 2026-07-20 row above carries the same
-- rates from an earlier date, so resolution is unchanged from today onward.
DELETE FROM model_pricing
WHERE model_id = 'claude-sonnet-5'
  AND effective_from = DATE '2026-08-07';
