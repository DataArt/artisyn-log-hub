-- Claude Sonnet 5 (introductory pricing in effect through 2026-08-31; standard
-- pricing of $3/$15 takes effect 2026-09-01 and will need a manual price update
-- then, since model_pricing has one row per model_id with no versioning by date).
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-sonnet-5', 2.00, 10.00, 0.20, 2.50, 'USD', '2026-07-20')
ON CONFLICT (model_id) DO NOTHING;

-- Opus 4.6 / 4.7 bare aliases (same $5/$25 pricing as Opus 4.8, just missing from the table).
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-opus-4-7', 5.00, 25.00, 0.50, 6.25, 'USD', '2025-01-01'),
  ('claude-opus-4-6', 5.00, 25.00, 0.50, 6.25, 'USD', '2025-01-01')
ON CONFLICT (model_id) DO NOTHING;

-- Opus 4.5 / 4.1 / 4.0: API responses report the dated snapshot ID for these
-- (same pattern as Haiku 4.5 below), so the dated ID is the one that must match
-- session_stats.model. Bare aliases are added too as a fallback in case any
-- integration path logs the alias instead of the resolved snapshot ID.
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-opus-4-5-20251101', 5.00,  25.00, 0.50,  6.25,  'USD', '2025-01-01'),
  ('claude-opus-4-5',          5.00,  25.00, 0.50,  6.25,  'USD', '2025-01-01'),
  ('claude-opus-4-1-20250805', 15.00, 75.00, 1.50,  18.75, 'USD', '2025-01-01'),
  ('claude-opus-4-1',          15.00, 75.00, 1.50,  18.75, 'USD', '2025-01-01'),
  ('claude-opus-4-20250514',   15.00, 75.00, 1.50,  18.75, 'USD', '2025-01-01'),
  ('claude-opus-4-0',          15.00, 75.00, 1.50,  18.75, 'USD', '2025-01-01')
ON CONFLICT (model_id) DO NOTHING;

-- Haiku 4.5: session_stats.model has been logging the dated snapshot ID since
-- this app went live, which never matched the bare 'claude-haiku-4-5' row —
-- every Haiku session has priced out as null cost until now.
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-haiku-4-5-20251001', 1.00, 5.00, 0.10, 1.25, 'USD', '2025-01-01')
ON CONFLICT (model_id) DO NOTHING;

-- Haiku 3.5 (retired on the first-party API; still reachable via Bedrock/Google Cloud).
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-3-5-haiku-20241022', 0.80, 4.00, 0.08, 1.00, 'USD', '2025-01-01')
ON CONFLICT (model_id) DO NOTHING;

-- Third-party models already appearing in session_stats.model with date-suffixed
-- IDs that don't match the bare entries added in 0014_add_model_pricing.sql.
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('deepseek/deepseek-v4-pro-20260423',      0.435, 0.87, 0.003625, 0.00, 'USD', '2026-06-17'),
  ('deepseek/deepseek-v4-flash-20260423',    0.09,  0.18, 0.02,     0.00, 'USD', '2026-06-17'),
  ('moonshotai/kimi-k2-thinking-20251106',   0.60,  2.50, 0.00,     0.00, 'USD', '2026-06-17')
ON CONFLICT (model_id) DO NOTHING;
