-- Store the model's maximum context window in tokens, so the client can compute
-- accurate "remaining context" numbers instead of relying on a single hardcoded
-- 200,000-token constant. Nullable: values are researched per model_id.
--
-- All first-party Claude models seeded here default to the documented standard
-- 200K context window. Anthropic has historically offered some Sonnet-tier models
-- an opt-in beta 1M-token window via a request-time API header, but that is a
-- per-request choice, not a fixed per-model constant, so it is not reflected here
-- (see docs/tasks/done/2026-08-08-model-context-length/impl-plan.md Design Decisions for
-- the research/confidence caveat behind this value).
ALTER TABLE model_pricing ADD COLUMN IF NOT EXISTS context_length INTEGER;

UPDATE model_pricing SET context_length = 200000
WHERE model_id IN (
  'claude-3-5-haiku-20241022',
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'claude-opus-4-0', 'claude-opus-4-20250514',
  'claude-opus-4-1', 'claude-opus-4-1-20250805',
  'claude-opus-4-5', 'claude-opus-4-5-20251101',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-fable-5',
  'claude-mythos-5'
);

-- Third-party models: researched context windows (see impl-plan.md confidence caveat).
UPDATE model_pricing SET context_length = 1000000
WHERE model_id IN (
  'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-20260423',
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-20260423'
);

UPDATE model_pricing SET context_length = 256000
WHERE model_id IN (
  'moonshotai/kimi-k2-thinking', 'moonshotai/kimi-k2-thinking-20251106'
);

UPDATE model_pricing SET context_length = 262144
WHERE model_id IN (
  'moonshotai/kimi-k2.5',
  'qwen/qwen3-coder-next',
  'qwen/qwen3.6-35b-a3b'
);
