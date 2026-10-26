/**
 * Markdown rendering of the official Anthropic pricing page. The HTML page is ~1 MB and
 * redirects; the `.md` variant is ~50 KB and needs no HTML parser.
 */
export const ANTHROPIC_PRICING_URL =
  'https://platform.claude.com/docs/en/about-claude/pricing.md';

/** OpenRouter public model catalog. No auth required. */
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** Timeout for the daily Anthropic pricing-page fetch. */
export const ANTHROPIC_FETCH_TIMEOUT_MS = 15_000;

/** Timeout for the synchronous OpenRouter catalog fetch behind the admin button. */
export const OPENROUTER_FETCH_TIMEOUT_MS = 20_000;

/** The Anthropic parser rejects a page yielding fewer models than this (layout change guard). */
export const MIN_PARSED_MODELS = 5;

// Largest rate `numeric(10,6)` can hold, most tiers per model and largest tier threshold —
// defined in the shared package, which the client's price dialog validates against too.
export {
  MAX_PRICING_TIERS,
  MAX_RATE,
  MAX_TIER_THRESHOLD,
} from '@loghub/pricing';

/** Rows per multi-row `INSERT … ON CONFLICT` in batched price writes. */
export const IMPORT_BATCH_SIZE = 500;

/**
 * Key of the transaction-scoped advisory lock that serializes every price-writing
 * transaction. Arbitrary, but must stay unique across the codebase.
 */
export const MODEL_PRICING_LOCK_KEY = 7_211_066;

/** Default 5m cache-write rate = price_in × this, used when the admin leaves it blank. */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;

/** Default 1h cache-write rate = price_in × this, used when the admin leaves it blank. */
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/** A successful fetch older than this is re-fetched (bound via `make_interval(hours => ...)`). */
export const STALE_AFTER_HOURS = 24;

/** Minimum gap after the last attempt before another worker may retry (bound via `make_interval(hours => ...)`). */
export const RETRY_AFTER_HOURS = 1;

/** A manual "Fetch now" is refused when any fetch attempt started less than this many seconds ago. */
export const MANUAL_FETCH_MIN_GAP_SECONDS = 30;

/** Name of the interval registered in NestJS `SchedulerRegistry`. */
export const SCHEDULER_NAME = 'model-pricing-fetch';

const DEFAULT_FETCH_INTERVAL_MS = 3_600_000;

/**
 * Scheduler tick interval. Reads env `MODEL_PRICING_FETCH_INTERVAL_MS` at call time;
 * falls back to 1 h when unset or not a positive integer.
 */
export function getFetchIntervalMs(): number {
  const raw = process.env.MODEL_PRICING_FETCH_INTERVAL_MS;
  if (raw === undefined || !/^\d+$/.test(raw.trim()))
    return DEFAULT_FETCH_INTERVAL_MS;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_FETCH_INTERVAL_MS;
}

/** The daily pricing fetch is on unless env `MODEL_PRICING_FETCH_ENABLED` is exactly `'false'`. */
export function isFetchEnabled(): boolean {
  return process.env.MODEL_PRICING_FETCH_ENABLED !== 'false';
}
