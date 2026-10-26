import type { PricingTier } from './tiers.ts';

/**
 * The single definition of the LLM cost formula, shared by the server (stored session costs,
 * `server/src/logs/cost.sql.ts`) and the client (per-turn and per-session costs from the
 * transcript, `client/src/viewer/lib/format.ts`). The hook keeps its own plain-JS copy
 * (`computeLocalSessionCost` in `hook/`), checked against the same table
 * (`docs/knowledgebase/algorithms/cost-formula.md`).
 *
 * The aggregate formula (all six rates come from `model_pricing`; none is ever a literal in
 * source — see `docs/knowledgebase/llm-call-math.md`):
 *
 * ```
 * F = FAST_MODE_MULTIPLIER - 1                       // 1 today
 *
 * cost = (input  + inputFast  * F) / 1e6 * priceIn
 *      + (output + outputFast * F) / 1e6 * priceOut
 *      +  cacheRead               / 1e6 * priceCacheR
 *      +  cacheWrite5m            / 1e6 * priceCacheW5m
 *      +  cacheWrite1h            / 1e6 * priceCacheW1h
 *      +  webSearchRequests             * priceWebSearch   // per REQUEST, not per 1e6
 * ```
 *
 * Two invariants worth restating because both are load-bearing:
 * - `cacheWrite5m + cacheWrite1h = cacheWrite`, so the formula must never also add a flat
 *   `cacheWrite * priceCacheW` term.
 * - `inputFast` / `outputFast` are **subsets** of `input` / `output`, not extra tokens. That
 *   is why fast mode is a *surcharge* on the grand total
 *   (`(total - fast)*r + fast*M*r = (total + fast*(M-1))*r`) rather than separate
 *   standard/fast terms; adding `fast * M * r` on top would double-bill every fast token.
 *
 * **Per-call rule (prompt-length tiers).** When per-call token data is present **and** the
 * model has a non-empty `tiers` list, the formula is applied per call `c`:
 *
 * ```
 * P_c    = input_c + cacheRead_c + cacheWrite5m_c + cacheWrite1h_c
 * r_c    = rates of the LAST tier with P_c > aboveTokens (strictly), else the base rates
 * cost_c = the formula above for call c's tokens at r_c, without the web-search term
 * cost   = Σ cost_c + webSearchRequests * base.priceWebSearch
 * ```
 *
 * Without per-call data, or without tiers, the aggregate formula at base rates applies; for a
 * model without tiers both paths give the same number. Web search is never tiered.
 */

/**
 * Multiplier applied to the standard per-token rate for tokens billed in fast mode
 * (`usage.speed = "fast"`). Fast rates are **derived, not stored**: `model_pricing` holds only
 * the standard `price_in` / `price_out`. Cache reads/writes and web-search requests have no
 * fast-mode surcharge. The hook's copy must carry the same value.
 */
export const FAST_MODE_MULTIPLIER = 2;

/** Token counts of one LLM call. `inputFast` / `outputFast` are subsets of `input` / `output`. */
export interface CallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  inputFast: number;
  outputFast: number;
}

/** Tokens to price: the aggregates, plus optional per-call rows whose sums equal them. */
export interface CostTokens extends CallTokens {
  webSearchRequests: number;
  /** Per-call rows; used instead of the aggregates only when the rates carry tiers. */
  calls?: readonly CallTokens[] | null;
}

/** Rates to price with — a `model_pricing` row's shape. Token rates are USD/MTok. */
export interface CostRates {
  priceIn: number;
  priceOut: number;
  priceCacheR: number;
  priceCacheW5m: number;
  priceCacheW1h: number;
  /** USD per web-search request — a per-request price, NOT per million tokens. */
  priceWebSearch: number;
  /** Prompt-length tiers, ascending by `aboveTokens`; null/absent/empty means none. */
  tiers?: readonly PricingTier[] | null;
}

/**
 * Cost terms in USD. They sum to the total: token terms are priced at each call's chosen
 * (tier or base) rates; `input` / `output` cover all tokens at the standard rate,
 * `fastSurcharge` the extra `(M - 1)` share of fast tokens.
 */
export interface CostTerms {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  fastSurcharge: number;
}

/** Result of {@link computeCostBreakdown}. */
export interface CostBreakdown {
  total: number;
  terms: CostTerms;
  /**
   * Total minus the same tokens priced at base rates — how much the long-context tiers added.
   * Informational only: `terms` already sum to `total`, so it is never a summand. 0 on the
   * aggregate path.
   */
  tierDelta: number;
}

/** Token-rate set used to price one call (the base rates or one tier's). USD/MTok. */
export interface CallRates {
  in: number;
  out: number;
  cr: number;
  w5: number;
  w1: number;
}

type TokenTerms = Omit<CostTerms, 'webSearch'>;

function ratesOf(t: PricingTier | CostRates): CallRates {
  return {
    in: t.priceIn,
    out: t.priceOut,
    cr: t.priceCacheR,
    w5: t.priceCacheW5m,
    w1: t.priceCacheW1h,
  };
}

/** Prompt size of one call: everything sent to the model. */
export function promptTokens(c: CallTokens): number {
  return c.input + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h;
}

/**
 * Rates for one call with prompt size `prompt`: those of the LAST tier (in the stored
 * ascending order) whose `aboveTokens` is strictly below `prompt`, or the base rates when no
 * tier matches.
 */
export function pickCallRates(prompt: number, rates: CostRates): CallRates {
  let chosen: PricingTier | null = null;
  for (const tier of rates.tiers ?? []) {
    if (prompt > tier.aboveTokens) chosen = tier;
  }
  return ratesOf(chosen ?? rates);
}

function tokenTerms(c: CallTokens, r: CallRates): TokenTerms {
  const fast = FAST_MODE_MULTIPLIER - 1;
  return {
    input: (c.input / 1_000_000) * r.in,
    output: (c.output / 1_000_000) * r.out,
    cacheRead: (c.cacheRead / 1_000_000) * r.cr,
    cacheWrite5m: (c.cacheWrite5m / 1_000_000) * r.w5,
    cacheWrite1h: (c.cacheWrite1h / 1_000_000) * r.w1,
    fastSurcharge:
      ((c.inputFast * fast) / 1_000_000) * r.in +
      ((c.outputFast * fast) / 1_000_000) * r.out,
  };
}

function tokenTermsTotal(t: TokenTerms): number {
  return (
    t.input +
    t.output +
    t.cacheRead +
    t.cacheWrite5m +
    t.cacheWrite1h +
    t.fastSurcharge
  );
}

/**
 * The cost with its per-term split (see the module comment for both paths).
 *
 * - **Per-call path**: `tokens.calls` present **and** `rates.tiers` non-empty — each call at
 *   {@link pickCallRates} for its prompt size, web search at the base rate; `tierDelta` =
 *   total minus the same calls priced at base rates.
 * - **Aggregate path**: otherwise — the aggregates at base rates; `tierDelta` = 0.
 *
 * The seven terms always sum to `total`; `tierDelta` is informational, never a summand.
 */
export function computeCostBreakdown(
  tokens: CostTokens,
  rates: CostRates,
): CostBreakdown {
  const webSearch = tokens.webSearchRequests * rates.priceWebSearch;
  const base = ratesOf(rates);
  const calls = tokens.calls;

  if (calls == null || rates.tiers == null || rates.tiers.length === 0) {
    const t = tokenTerms(tokens, base);
    return {
      total: tokenTermsTotal(t) + webSearch,
      terms: { ...t, webSearch },
      tierDelta: 0,
    };
  }

  const sum: TokenTerms = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    fastSurcharge: 0,
  };
  let baseTokenTotal = 0;
  for (const c of calls) {
    const t = tokenTerms(c, pickCallRates(promptTokens(c), rates));
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheRead += t.cacheRead;
    sum.cacheWrite5m += t.cacheWrite5m;
    sum.cacheWrite1h += t.cacheWrite1h;
    sum.fastSurcharge += t.fastSurcharge;
    baseTokenTotal += tokenTermsTotal(tokenTerms(c, base));
  }
  const tokenTotal = tokenTermsTotal(sum);
  return {
    total: tokenTotal + webSearch,
    terms: { ...sum, webSearch },
    tierDelta: tokenTotal - baseTokenTotal,
  };
}
