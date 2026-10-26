import type { PricingTier } from '@loghub/pricing';

/**
 * One `model_pricing` row as served by `GET /api/v1/model-pricing`.
 *
 * All four `price*` token rates are **USD per million tokens**; `priceWebSearch` is the
 * odd one out — USD **per web-search request**, so it is never divided by 1e6.
 *
 * The split TTL pricing replaced the single flat `priceCacheW` with the two TTL rates: a 1h cache write
 * costs ~1.6x a 5m one, and pricing both at the 5m rate under-reported every session that
 * used 1h caching. There is deliberately no fast-mode rate here — fast tokens are priced
 * at `FAST_MODE_MULTIPLIER` x the standard `priceIn`/`priceOut` (see `viewer/lib/format.ts`).
 */
/**
 * One prompt-length tier: a call whose prompt (`input + cacheRead + cacheWrite5m +
 * cacheWrite1h`) is strictly greater than `aboveTokens` is priced at these rates instead of
 * the base rates. All rates are USD per million tokens; a tier has no web-search price.
 * Defined in the shared `@loghub/pricing` package (also used by the server).
 */
export type { PricingTier };

export interface ModelPricingEntry {
  priceIn: number;
  priceOut: number;
  priceCacheR: number;
  /** USD per million cache-write tokens with the 5-minute TTL. */
  priceCacheW5m: number;
  /** USD per million cache-write tokens with the 1-hour TTL (~1.6x the 5m rate). */
  priceCacheW1h: number;
  /** USD per web-search **request** — a per-request price, NOT per million tokens. */
  priceWebSearch: number;
  charsPerToken: number | null;
  contextLength: number | null;
  /**
   * Prompt-length tiers, ascending by `aboveTokens`. Absent for an untiered model (the
   * server emits the field only when non-null).
   */
  tiers?: PricingTier[];
}

export type ModelPricingMap = Record<string, ModelPricingEntry>;

/**
 * Default multipliers for a blank cache-write field in the admin price dialog: the 5m / 1h
 * cache-write rate defaults to `priceIn` x these. They are defaults for blank input, not
 * stored rates — twins of the server's `model-pricing.constants.ts`.
 */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * Resolved source of a model, as the admin API reports it. An override shows as its base
 * source plus `overrideActive = true`; a model with no effective price is `unpriced`.
 */
export type PricingSource = 'anthropic' | 'openrouter' | 'manual' | 'unpriced';

/**
 * One model's rates. Token rates are USD per million tokens; `priceWebSearch` is USD per
 * request. Mirrors the server's `ModelPricingRates` (`model-pricing.types.ts`).
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

/** Status of one pricing source (the daily Anthropic fetch or the OpenRouter import). */
export interface PricingFetchStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastResult: 'changed' | 'unchanged' | 'imported' | 'failed' | null;
  lastCounts: Record<string, number> | null;
  lastError: string | null;
  /** When the daily Anthropic check is next due (ISO); null for OpenRouter or when disabled. */
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
  /** `skipped`: another check started moments ago. */
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

/**
 * Body of `PUT /api/v1/admin/model-pricing/price` and `/override`. Only `priceIn` /
 * `priceOut` are required; the server fills blank fields with its defaults.
 */
export interface ModelPriceInput {
  modelId: string;
  priceIn: number;
  priceOut: number;
  priceCacheR?: number;
  priceCacheW5m?: number;
  priceCacheW1h?: number;
  priceWebSearch?: number;
  charsPerToken?: number;
  contextLength?: number;
  /** Omitted keeps the current tiers; `null` or `[]` clears them. */
  tiers?: PricingTier[] | null;
}
