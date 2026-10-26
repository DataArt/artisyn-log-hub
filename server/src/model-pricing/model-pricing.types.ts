import type { PricingTier } from '@loghub/pricing';

/** One prompt-length price tier — defined in the shared package, used by the client too. */
export type { PricingTier };

/** Origin of one price version, as stored in `model_pricing.source`. */
export type StoredPricingSource =
  | 'anthropic'
  | 'openrouter'
  | 'manual'
  | 'override';

/**
 * Resolved source of a model. An override shows as its base source plus
 * `overrideActive = true`; a model with no effective row is `unpriced`.
 */
export type PricingSource = 'anthropic' | 'openrouter' | 'manual' | 'unpriced';

/** Source a hidden override base may carry (`model_pricing_meta.override_base_source`). */
export type OverrideBaseSource = 'anthropic' | 'openrouter';

/**
 * One model's rates. Token rates are USD per million tokens; `priceWebSearch` is USD per
 * request. `priceCacheW5m` / `priceCacheW1h` are the TTL-split cache-write rates.
 */
export interface ModelPricingRates {
  priceIn: number;
  priceOut: number;
  priceCacheR: number;
  priceCacheW5m: number;
  priceCacheW1h: number;
  priceWebSearch: number;
  charsPerToken: number | null;
  contextLength: number | null;
  /** Prompt-length tiers, ascending by `aboveTokens`; null when the model has none. */
  tiers: PricingTier[] | null;
}

/** One row of `GET /api/v1/admin/model-pricing`. */
export interface AdminModelPricingRow {
  modelId: string;
  source: PricingSource;
  overrideActive: boolean;
  /** The current effective price version; null when unpriced. `effectiveFrom` is `YYYY-MM-DD`. */
  effective: (ModelPricingRates & { effectiveFrom: string }) | null;
  /** The fetched/imported price hidden under an override; non-null only when overridden. */
  base: ModelPricingRates | null;
  /** ISO timestamp of auto-registration; null for models never auto-registered. */
  firstSeenAt: string | null;
}

/** Status line state of one pricing source (`model_pricing_fetch_state`). */
export interface PricingFetchStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastResult: 'changed' | 'unchanged' | 'imported' | 'failed' | null;
  lastCounts: Record<string, number> | null;
  lastError: string | null;
  /**
   * When the scheduled check is next due (ISO): Anthropic only, null for OpenRouter (manual
   * import) and when the fetch is disabled. The hourly scheduler tick picks it up within the
   * hour after; a past value means "at the next tick".
   */
  nextCheckAt: string | null;
}

/** Response of `GET /api/v1/admin/model-pricing`. */
export interface AdminModelPricingResponse {
  anthropic: PricingFetchStatus;
  openrouter: PricingFetchStatus;
  unpricedCount: number;
  models: AdminModelPricingRow[];
}

/** Response of `POST /api/v1/admin/model-pricing/fetch-anthropic`. */
export interface AnthropicFetchNowResult {
  /** `skipped`: another attempt started moments ago. */
  result: 'changed' | 'unchanged' | 'failed' | 'skipped';
}

/** Response of `POST /api/v1/admin/model-pricing/import-openrouter`. */
export interface OpenRouterImportResult {
  updated: number;
  added: number;
  unchanged: number;
  skippedOverride: number;
  skippedAnthropic: number;
  skippedOther: number;
}
