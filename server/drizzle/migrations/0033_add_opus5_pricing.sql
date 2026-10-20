-- Claude Opus 5 ($5 / $25 per MTok — same tier as Opus 4.8, which it succeeds).
-- Cache read is 0.1x input, cache write (5-minute TTL) is 1.25x input, matching
-- the convention used for every other row in this table.
--
-- Sessions have been logging `claude-opus-5` since the model shipped, but the
-- pricing row was never added, so every Opus 5 session priced out as null cost.
-- Claude Opus 5 has no dated-snapshot ID (same fixed-alias scheme as
-- claude-opus-4-8), and the logs confirm the bare ID is what lands in
-- session_stats.model — no `-YYYYMMDD` or context-variant suffix to cover.
--
-- effective_from is only an activation gate here (the controller filters on
-- `effective_from <= CURRENT_DATE`; the table keeps one row per model_id with
-- no versioning by date), so a launch-era date is sufficient.
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-opus-5', 5.00, 25.00, 0.50, 6.25, 'USD', '2026-07-01')
ON CONFLICT (model_id) DO NOTHING;
