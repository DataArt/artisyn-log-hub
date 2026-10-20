import { MAX_RATE } from './model-pricing.constants';
import { round6 } from './model-pricing-rates';
import type { ModelPricingRates } from './model-pricing.types';

/** One usable OpenRouter catalog entry. */
export interface OpenRouterCatalogEntry {
  /** The catalog id, e.g. `deepseek/deepseek-v4-pro`. */
  fullId: string;
  /** The id after the first `/`, e.g. `deepseek-v4-pro`. */
  strippedId: string;
  rates: ModelPricingRates;
}

export interface OpenRouterCatalog {
  entries: OpenRouterCatalogEntry[];
  /** Entries whose id starts with `anthropic/` (priced from the Anthropic page instead). */
  skippedAnthropic: number;
  /** Variants (`:`), unusable prices, over-limit rates and duplicate stripped ids. */
  skippedOther: number;
}

/** Largest value of a Postgres `integer` column. */
const MAX_INT4 = 2_147_483_647;

/**
 * Pure parser and converter of `GET https://openrouter.ai/api/v1/models`.
 *
 * Per-token USD strings become USD per million tokens (`round6(Number(s) × 1e6)`); the single
 * `input_cache_write` fills both the 5m and 1h cache-write rates; a missing cache-read,
 * cache-write or web-search value becomes 0; `web_search` (USD per request) is kept as-is.
 *
 * Returns null when the payload has no `data` array or yields zero usable entries.
 */
export function parseOpenRouterCatalog(
  json: unknown,
): OpenRouterCatalog | null {
  if (!isRecord(json) || !Array.isArray(json.data)) return null;
  const data: unknown[] = json.data;

  const entries: OpenRouterCatalogEntry[] = [];
  const seenStripped = new Set<string>();
  let skippedAnthropic = 0;
  let skippedOther = 0;

  for (const item of data) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      item.id.trim() === ''
    ) {
      skippedOther++;
      continue;
    }
    const fullId = item.id.trim();
    if (fullId.startsWith('anthropic/')) {
      skippedAnthropic++;
      continue;
    }
    if (fullId.includes(':')) {
      skippedOther++;
      continue;
    }

    const rates = toRates(item);
    if (!rates) {
      skippedOther++;
      continue;
    }

    const slash = fullId.indexOf('/');
    const strippedId = slash >= 0 ? fullId.slice(slash + 1) : fullId;
    if (strippedId === '' || seenStripped.has(strippedId)) {
      skippedOther++;
      continue;
    }
    seenStripped.add(strippedId);
    entries.push({ fullId, strippedId, rates });
  }

  if (entries.length === 0) return null;
  return { entries, skippedAnthropic, skippedOther };
}

function toRates(item: Record<string, unknown>): ModelPricingRates | null {
  const pricing = isRecord(item.pricing) ? item.pricing : {};

  const prompt = readPrice(pricing.prompt, false);
  const completion = readPrice(pricing.completion, false);
  const cacheRead = readPrice(pricing.input_cache_read, true);
  const cacheWrite = readPrice(pricing.input_cache_write, true);
  const webSearch = readPrice(pricing.web_search, true);
  if (
    prompt === null ||
    completion === null ||
    cacheRead === null ||
    cacheWrite === null ||
    webSearch === null
  )
    return null;

  const cacheW = perMillion(cacheWrite);
  const rates: ModelPricingRates = {
    priceIn: perMillion(prompt),
    priceOut: perMillion(completion),
    priceCacheR: perMillion(cacheRead),
    priceCacheW5m: cacheW,
    priceCacheW1h: cacheW,
    priceWebSearch: round6(webSearch),
    charsPerToken: null,
    contextLength: readContextLength(item.context_length),
  };
  const values = [
    rates.priceIn,
    rates.priceOut,
    rates.priceCacheR,
    rates.priceCacheW5m,
    rates.priceCacheW1h,
    rates.priceWebSearch,
  ];
  return values.every((v) => Number.isFinite(v) && v <= MAX_RATE)
    ? rates
    : null;
}

/**
 * A non-negative numeric price (string or number). A missing value is 0 when `optional`,
 * otherwise null; a non-numeric or negative value is always null.
 */
function readPrice(value: unknown, optional: boolean): number | null {
  if (value === undefined || value === null || value === '')
    return optional ? 0 : null;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '')
    n = Number(value.trim());
  else return null;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function perMillion(perToken: number): number {
  return round6(perToken * 1e6);
}

function readContextLength(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_INT4
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
