-- Store an approximate chars-per-token ratio per model, so the app can estimate
-- token counts from raw text length when an actual token count isn't available.
-- Nullable: third-party models (deepseek/*, moonshotai/*, qwen/*) use a different
-- tokenizer family that hasn't been researched, so they stay NULL rather than
-- guessing.
--
-- Anthropic shipped a new tokenizer starting with Claude Opus 4.7, carried
-- unchanged into Opus 4.8, Opus 5, Sonnet 5, and Fable 5 — it produces ~30% more
-- tokens than the old tokenizer for the same text. Old tokenizer: ~3.5
-- chars/token. New tokenizer: ~2.7 chars/token (3.5 / 1.3). This is a coarse,
-- single blended ratio per tokenizer generation, intended for rough estimation
-- only (see docs/knowledgebase/db-tables.md).
ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS chars_per_token NUMERIC(6, 3);

-- Old-tokenizer models: ~3.5 chars/token.
UPDATE model_pricing SET chars_per_token = 3.5
WHERE model_id IN (
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-5', 'claude-opus-4-5-20251101',
  'claude-opus-4-1', 'claude-opus-4-1-20250805',
  'claude-opus-4-0', 'claude-opus-4-20250514',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'claude-3-5-haiku-20241022'
);

-- New-tokenizer models: ~2.7 chars/token.
UPDATE model_pricing SET chars_per_token = 2.7
WHERE model_id IN (
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5'
);

-- claude-mythos-5 has no model_pricing row at all yet — it shares Fable 5's
-- pricing ($10/$50 per MTok) and tokenizer (2.7 chars/token), so it is seeded
-- here rather than in a separate migration.
INSERT INTO model_pricing (model_id, price_in, price_out, price_cache_r, price_cache_w, currency, effective_from, chars_per_token)
VALUES
  ('claude-mythos-5', 10.00, 50.00, 1.00, 12.50, 'USD', '2026-06-12', 2.7)
ON CONFLICT (model_id, effective_from) DO NOTHING;
