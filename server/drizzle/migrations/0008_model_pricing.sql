CREATE TABLE model_pricing (
  model_id       VARCHAR PRIMARY KEY,
  price_in       NUMERIC(10, 6) NOT NULL,
  price_out      NUMERIC(10, 6) NOT NULL,
  price_cache_r  NUMERIC(10, 6) NOT NULL,
  price_cache_w  NUMERIC(10, 6) NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  effective_from DATE NOT NULL
);

INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from)
VALUES
  ('claude-sonnet-4-6', 3.00, 15.00, 0.30, 3.75, 'USD', '2025-01-01'),
  ('claude-opus-4-8',   5.00, 25.00, 0.50, 6.25, 'USD', '2025-01-01'),
  ('claude-haiku-4-5',  1.00,  5.00, 0.10, 1.25, 'USD', '2025-01-01');
