INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('deepseek/deepseek-v4-pro',     0.435,   0.87,   0.003625, 0.00, 'USD', '2026-06-17'),
  ('deepseek/deepseek-v4-flash',   0.09,    0.18,   0.02,     0.00, 'USD', '2026-06-17'),
  ('moonshotai/kimi-k2-thinking',  0.60,    2.50,   0.00,     0.00, 'USD', '2026-06-17'),
  ('moonshotai/kimi-k2.5',         0.375,   2.025,  0.00,     0.00, 'USD', '2026-06-17'),
  ('qwen/qwen3.6-35b-a3b',        0.15,    1.00,   0.05,     0.00, 'USD', '2026-06-17'),
  ('qwen/qwen3-coder-next',        0.11,    0.80,   0.07,     0.00, 'USD', '2026-06-17')
ON CONFLICT (model_id) DO NOTHING;