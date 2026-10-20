import type {
  AdminModelPricingRow,
  ModelPricingRates,
  OverrideBaseSource,
  StoredPricingSource,
} from './model-pricing.types';

/**
 * Pure, DB-free pricing helpers. Kept free of any DB import so the parsers and
 * unit tests can use them without pulling in the database layer.
 */

/** Rounds to the 6 decimals `numeric(10,6)` stores. */
export function round6(x: number): number {
  return Number(x.toFixed(6));
}

function nullableEqual(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return round6(a) === round6(b);
}

/** True when every rate (all six prices plus chars-per-token and context length) is equal at 6 decimals. */
export function ratesEqual(
  a: ModelPricingRates,
  b: ModelPricingRates,
): boolean {
  return (
    round6(a.priceIn) === round6(b.priceIn) &&
    round6(a.priceOut) === round6(b.priceOut) &&
    round6(a.priceCacheR) === round6(b.priceCacheR) &&
    round6(a.priceCacheW5m) === round6(b.priceCacheW5m) &&
    round6(a.priceCacheW1h) === round6(b.priceCacheW1h) &&
    round6(a.priceWebSearch) === round6(b.priceWebSearch) &&
    nullableEqual(a.charsPerToken, b.charsPerToken) &&
    nullableEqual(a.contextLength, b.contextLength)
  );
}

/** One stored price version of a model. `effectiveFrom` is `YYYY-MM-DD`. */
export interface PriceVersion extends ModelPricingRates {
  modelId: string;
  effectiveFrom: string;
  source: StoredPricingSource;
}

/** One `model_pricing_meta` row, parsed. `overrideBase` is null when no base is stored. */
export interface ModelPricingMeta {
  modelId: string;
  /** ISO timestamp. */
  firstSeenAt: string | null;
  overrideBaseSource: OverrideBaseSource | null;
  overrideBase: ModelPricingRates | null;
}

/** Resolved state of one model — the admin row shape. */
export type ModelState = AdminModelPricingRow;

function pickRates(row: ModelPricingRates): ModelPricingRates {
  return {
    priceIn: row.priceIn,
    priceOut: row.priceOut,
    priceCacheR: row.priceCacheR,
    priceCacheW5m: row.priceCacheW5m,
    priceCacheW1h: row.priceCacheW1h,
    priceWebSearch: row.priceWebSearch,
    charsPerToken: row.charsPerToken,
    contextLength: row.contextLength,
  };
}

/**
 * Derives a model's resolved state:
 * - no effective row → `unpriced`, no override, no base;
 * - an `override` effective row → `overrideActive`, base and source from the meta base; when the
 *   meta base is missing (data drift) from `fallback` — the newest non-override row — with its
 *   source, or, when there is none either, the override's own rates as a `manual` base;
 * - any other source → that source, no override, no base (the effective price is the base).
 *
 * `fallback` is only consulted for an override row without a stored meta base.
 */
export function deriveModelState(
  effectiveRow: PriceVersion | null,
  meta: ModelPricingMeta | null,
  modelId: string,
  fallback: PriceVersion | null = null,
): ModelState {
  const firstSeenAt = meta?.firstSeenAt ?? null;
  if (!effectiveRow) {
    return {
      modelId,
      source: 'unpriced',
      overrideActive: false,
      effective: null,
      base: null,
      firstSeenAt,
    };
  }

  const effective = {
    ...pickRates(effectiveRow),
    effectiveFrom: effectiveRow.effectiveFrom,
  };

  if (effectiveRow.source !== 'override') {
    return {
      modelId,
      source: effectiveRow.source,
      overrideActive: false,
      effective,
      base: null,
      firstSeenAt,
    };
  }

  if (meta?.overrideBase && meta.overrideBaseSource) {
    return {
      modelId,
      source: meta.overrideBaseSource,
      overrideActive: true,
      effective,
      base: pickRates(meta.overrideBase),
      firstSeenAt,
    };
  }

  if (fallback && fallback.source !== 'override') {
    return {
      modelId,
      source: fallback.source,
      overrideActive: true,
      effective,
      base: pickRates(fallback),
      firstSeenAt,
    };
  }

  return {
    modelId,
    source: 'manual',
    overrideActive: true,
    effective,
    base: pickRates(effectiveRow),
    firstSeenAt,
  };
}
