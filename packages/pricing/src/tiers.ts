/**
 * Prompt-length price tiers: the type, the limits and the one validator both the server
 * (admin API, page parser) and the client (admin price dialog) apply.
 */

/**
 * One prompt-length price tier (stored in `model_pricing.tiers` /
 * `model_pricing_meta.override_base_tiers`). A call whose prompt size
 * `P = input + cacheRead + cacheWrite5m + cacheWrite1h` is strictly greater than
 * `aboveTokens` is priced at these rates; the last matching tier wins. All rates are
 * USD per million tokens. A tier carries no web-search price — web search always uses
 * the base rate.
 */
export interface PricingTier {
  aboveTokens: number;
  priceIn: number;
  priceOut: number;
  priceCacheR: number;
  priceCacheW5m: number;
  priceCacheW1h: number;
}

/** Upper bound of a stored rate: `numeric(10,6)`. */
export const MAX_RATE = 9999.999999;

/** At most this many tiers per model. */
export const MAX_PRICING_TIERS = 10;

/** Upper bound of a tier's `aboveTokens`. */
export const MAX_TIER_THRESHOLD = 100_000_000;

/** The five token rates of a tier, in display order. */
export const TIER_RATE_KEYS = [
  'priceIn',
  'priceOut',
  'priceCacheR',
  'priceCacheW5m',
  'priceCacheW1h',
] as const satisfies readonly (keyof PricingTier)[];

const TIER_RATE_LABELS: Record<(typeof TIER_RATE_KEYS)[number], string> = {
  priceIn: 'Input',
  priceOut: 'Output',
  priceCacheR: 'Cache read',
  priceCacheW5m: '5m write',
  priceCacheW1h: '1h write',
};

/** Rounds to the 6 decimals `numeric(10,6)` stores. */
export function round6(x: number): number {
  return Number(x.toFixed(6));
}

/** True for a finite rate in `[0, MAX_RATE]` — the range `numeric(10,6)` stores. */
export function isValidRate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RATE
  );
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * Validates a list of prompt-length tiers **in the order given**. Returns an error text
 * (shown as is in the admin dialog and in the API's 400), or null when valid.
 * `null` / `undefined` / `[]` are valid (no tiers). Rules: at most
 * {@link MAX_PRICING_TIERS} tiers; each `aboveTokens` an integer in
 * `[1, MAX_TIER_THRESHOLD]` and strictly increasing; all five rates present and valid
 * per {@link isValidRate}.
 */
export function validatePricingTiers(
  tiers: readonly PricingTier[] | null | undefined,
): string | null {
  if (tiers == null) return null;
  if (!Array.isArray(tiers)) return 'tiers must be an array';
  if (tiers.length > MAX_PRICING_TIERS) {
    return `At most ${MAX_PRICING_TIERS} tiers are allowed`;
  }
  let previous = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i] as Partial<PricingTier> | null;
    if (tier == null || typeof tier !== 'object') {
      return `Tier ${i + 1} must be an object`;
    }
    const above = tier.aboveTokens;
    if (
      typeof above !== 'number' ||
      !Number.isInteger(above) ||
      above < 1 ||
      above > MAX_TIER_THRESHOLD
    ) {
      return `Tier ${i + 1}: Above (tokens) must be a whole number between 1 and ${fmt(MAX_TIER_THRESHOLD)}`;
    }
    if (above === previous) {
      return `Two tiers share the threshold ${fmt(above)}`;
    }
    if (above < previous) {
      return `Tier ${i + 1}: Above (tokens) must be strictly increasing`;
    }
    previous = above;
    for (const key of TIER_RATE_KEYS) {
      if (!isValidRate(tier[key])) {
        return `Tier ${i + 1}: ${TIER_RATE_LABELS[key]} must be a number between 0 and ${MAX_RATE}`;
      }
    }
  }
  return null;
}

/**
 * Canonical stored form of a tier list: sorted ascending by `aboveTokens`, rates rounded to
 * 6 decimals, extra keys dropped; `null` / `undefined` / `[]` become `null`. Does not
 * validate — call {@link validatePricingTiers} first.
 */
export function normalizeTiers(
  tiers: readonly PricingTier[] | null | undefined,
): PricingTier[] | null {
  if (tiers == null || tiers.length === 0) return null;
  return [...tiers]
    .sort((a, b) => a.aboveTokens - b.aboveTokens)
    .map((t) => ({
      aboveTokens: t.aboveTokens,
      priceIn: round6(t.priceIn),
      priceOut: round6(t.priceOut),
      priceCacheR: round6(t.priceCacheR),
      priceCacheW5m: round6(t.priceCacheW5m),
      priceCacheW1h: round6(t.priceCacheW1h),
    }));
}

/** True when both tier lists are equal after {@link normalizeTiers} (rates at 6 decimals). */
export function tiersEqual(
  a: readonly PricingTier[] | null | undefined,
  b: readonly PricingTier[] | null | undefined,
): boolean {
  const na = normalizeTiers(a);
  const nb = normalizeTiers(b);
  if (na === null || nb === null) return na === nb;
  if (na.length !== nb.length) return false;
  return na.every((t, i) => {
    const u = nb[i];
    return (
      t.aboveTokens === u.aboveTokens &&
      TIER_RATE_KEYS.every((key) => t[key] === u[key])
    );
  });
}

/**
 * The tiers a call steps into when the prompt grows from `fromPrompt` (the previous call) to
 * `toPrompt` (this call): those with `fromPrompt <= aboveTokens < toPrompt`. A call is priced at
 * a tier when its prompt is strictly greater than `aboveTokens`, the same rule as
 * `pickCallRates`. Ascending, like `tiers`; empty when the prompt shrank or stayed in its tier.
 */
export function crossedTiers(
  fromPrompt: number,
  toPrompt: number,
  tiers: readonly PricingTier[] | null | undefined,
): PricingTier[] {
  return (tiers ?? []).filter(
    (t) => fromPrompt <= t.aboveTokens && t.aboveTokens < toPrompt,
  );
}
