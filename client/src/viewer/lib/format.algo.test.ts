/**
 * Table tests for the client twins in `format.ts`, against the same doc rows as the server:
 * - docs/knowledgebase/algorithms/cost-formula.md -> `computeCost` (rows marked
 *   `"only": "server"` use inputs the client never receives and are skipped);
 * - docs/knowledgebase/algorithms/cache-ratio-and-causes.md, `ratio` rows -> `cacheReadRatio`.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ModelPricingEntry, PricingTier } from '../../models/pricing';
import type {
  CallTokens,
  TokenBreakdown,
} from '../pages/repository/session-log/types';
import { cacheReadRatio, computeCost, computeCostBreakdown } from './format';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../scripts/algo-docs/load-examples.cjs',
  );

type PriceRow = Pick<
  ModelPricingEntry,
  | 'priceIn'
  | 'priceOut'
  | 'priceCacheR'
  | 'priceCacheW5m'
  | 'priceCacheW1h'
  | 'priceWebSearch'
> & { tiers?: PricingTier[] | null };

/** One call of the doc's row-wise `input.calls` (no web search); an omitted count is 0. */
type DocCall = Omit<ServerTokens, 'webSearchRequests'>;

interface ServerTokens {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  webSearchRequests?: number;
  inputTokensFast?: number;
  outputTokensFast?: number;
}

/** One doc call (`session_stats` column names) -> the client's `CallTokens`. */
function callTokens(c: DocCall): CallTokens {
  return {
    input: c.inputTokens ?? 0,
    output: c.outputTokens ?? 0,
    cacheRead: c.cacheReadTokens ?? 0,
    cacheWrite5m: c.cacheWrite5mTokens ?? 0,
    cacheWrite1h: c.cacheWrite1hTokens ?? 0,
    inputFast: c.inputTokensFast ?? 0,
    outputFast: c.outputTokensFast ?? 0,
  };
}

/** The doc speaks in `session_stats` column names; the client's breakdown names differ. */
function breakdown(t: ServerTokens, calls?: DocCall[]): TokenBreakdown {
  const cacheWrite5m = t.cacheWrite5mTokens ?? 0;
  const cacheWrite1h = t.cacheWrite1hTokens ?? 0;
  return {
    input: t.inputTokens ?? 0,
    output: t.outputTokens ?? 0,
    cacheRead: t.cacheReadTokens ?? 0,
    cacheWrite: cacheWrite5m + cacheWrite1h,
    cacheWrite5m,
    cacheWrite1h,
    webSearchRequests: t.webSearchRequests ?? 0,
    inputFast: t.inputTokensFast ?? 0,
    outputFast: t.outputTokensFast ?? 0,
    ...(calls ? { calls: calls.map(callTokens) } : {}),
  };
}

describe('cost-formula (client twin computeCost)', () => {
  const rows = loader
    .loadExamples<
      { tokens: ServerTokens; calls?: DocCall[]; pricing: PriceRow },
      { cost: number; tierDelta?: number }
    >('cost-formula')
    .filter((row) => row.only !== 'server');

  it.each(rows)('$id', (row) => {
    const { tiers, ...rates } = row.input.pricing;
    // The API omits `tiers` for an untiered model; the doc's `null` means the same.
    const pricing: ModelPricingEntry = {
      ...rates,
      charsPerToken: null,
      contextLength: null,
      ...(tiers ? { tiers } : {}),
    };
    const tokens = breakdown(row.input.tokens, row.input.calls);
    const cost = computeCost(tokens, pricing);
    expect(Math.abs(cost - row.expected.cost)).toBeLessThan(1e-9);

    if (row.expected.tierDelta !== undefined) {
      const { tierDelta } = computeCostBreakdown(tokens, pricing);
      expect(Math.abs(tierDelta - row.expected.tierDelta)).toBeLessThan(1e-9);
    }
  });
});

describe('cache-ratio-and-causes, ratio rows (client twin cacheReadRatio)', () => {
  const rows = loader
    .loadExamples<
      { kind: string; read: number; write: number },
      { ratio: number | null }
    >('cache-ratio-and-causes')
    .filter((row) => row.input.kind === 'ratio');

  it.each(rows)('$id', ({ input, expected }) => {
    const ratio = cacheReadRatio(input.read, input.write);
    if (expected.ratio === null) {
      expect(ratio).toBeNull();
      return;
    }
    expect(ratio).toBeCloseTo(expected.ratio, 6);
  });
});
