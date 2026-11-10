-- Price Claude Fable 5.2 and Claude Mythos 5.2 (Claude Code 2.1.321 made claude-fable-5-2
-- the default Fable model, so new sessions resolved to 'unknown-model' and showed no cost).
--
-- Sources (fetched directly on 2026-11-10, per docs/knowledgebase/model-pricing-research.md):
--   * https://platform.claude.com/docs/en/docs/about-claude/pricing
--   * https://platform.claude.com/docs/en/docs/about-claude/models/overview
--
--   Claude Fable 5.2  — $8 / $40 per MTok, 5m cache write $10, 1h cache write $16,
--                       cache hits $0.20 (0.025x, per the page's footnote), 1M context,
--                       no long-context surcharge. Fast mode is $16 / $80, i.e. the
--                       FAST_MODE_MULTIPLIER = 2 surcharge the cost math already applies.
--   Claude Mythos 5.2 — same rates as Fable 5.2 (limited availability); its id follows the
--                       claude-mythos-5-1 precedent from 0064.
--
-- effective_from follows 0064's rule: retirement is committed at >= 12 months from release,
-- and the overview page says Fable 5.2 retires "not sooner than November 9, 2027", so the
-- row starts 2026-11-09.
--
-- Reference table only — no user, session or stats row is touched, no DDL runs here.
--
-- Online installations may already hold a row for these ids, written by the daily Anthropic
-- fetch (source 'anthropic', effective_from = the fetch day) or by an admin (manual price or
-- override). Rules this file follows so it never fights them:
--   * ON CONFLICT DO NOTHING: an existing row on 2026-11-09 — whatever its source — is kept.
--     A fetch or admin row dated later stays the effective one, as it is newer.
--   * The fetch does not know chars_per_token / context_length for a model it has never
--     seen, so its rows carry NULL there. Step 2 fills only those NULLs; no rate changes.

-- 1) The price rows.
INSERT INTO model_pricing (
  model_id, price_in, price_out, price_cache_r, price_cache_w,
  price_cache_w_5m, price_cache_w_1h, price_web_search,
  chars_per_token, context_length, currency, effective_from, source
) VALUES
  ('claude-fable-5-2',   8.000000, 40.000000, 0.200000, 10.000000,
   10.000000, 16.000000, 0.010000, 2.700, 1000000, 'USD', DATE '2026-11-09', 'anthropic'),
  ('claude-mythos-5-2',  8.000000, 40.000000, 0.200000, 10.000000,
   10.000000, 16.000000, 0.010000, 2.700, 1000000, 'USD', DATE '2026-11-09', 'anthropic')
ON CONFLICT (model_id, effective_from) DO NOTHING;

-- 2) Fill the estimation-only columns on rows the daily fetch wrote before this migration ran.
UPDATE model_pricing
SET chars_per_token = COALESCE(chars_per_token, 2.700),
    context_length  = COALESCE(context_length, 1000000)
WHERE model_id IN ('claude-fable-5-2', 'claude-mythos-5-2')
  AND (chars_per_token IS NULL OR context_length IS NULL);
