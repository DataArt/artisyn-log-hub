INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-fable-5', 10.00, 50.00, 1.00, 12.50, 'USD', '2026-06-12')
ON CONFLICT (model_id) DO NOTHING;
