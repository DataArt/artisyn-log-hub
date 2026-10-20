-- Corrects 0047: Claude Opus 4.6 and later (Opus 4.6/4.7/4.8/5, Sonnet 4.6/5,
-- Fable 5, Mythos 5) ship the full 1,000,000-token context window at standard
-- pricing, not the 200K window 0047 defaulted them to. Source: Anthropic's
-- public Models overview and Pricing docs (fetched 2026-08-08):
--   https://platform.claude.com/docs/en/docs/about-claude/models/overview
--   https://platform.claude.com/docs/en/docs/about-claude/pricing
--   ("Claude 4.6 and later models ... include the full 1M token context
--   window at standard pricing.")
-- Models before Opus 4.6 (Opus 4.5/4.1/4.0, Haiku 4.5, Claude 3.5 Haiku) keep
-- the 200K value 0047 set — unaffected by this fix.
UPDATE model_pricing SET context_length = 1000000
WHERE model_id IN (
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5'
);
