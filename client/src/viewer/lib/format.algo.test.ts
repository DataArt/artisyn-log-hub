/**
 * Table tests for the client twins in `format.ts`, against the same doc rows as the server:
 * - docs/knowledgebase/algorithms/cost-formula.md -> `computeCost` (rows marked
 *   `"only": "server"` use inputs the client never receives and are skipped);
 * - docs/knowledgebase/algorithms/cache-ratio-and-causes.md, `ratio` rows -> `cacheReadRatio`.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ModelPricingEntry } from '../../models/pricing';
import type { TokenBreakdown } from '../pages/repository/session-log/types';
import { cacheReadRatio, computeCost } from './format';

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
>;

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

/** The doc speaks in `session_stats` column names; the client's breakdown names differ. */
function breakdown(t: ServerTokens): TokenBreakdown {
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
  };
}

describe('cost-formula (client twin computeCost)', () => {
  const rows = loader
    .loadExamples<
      { tokens: ServerTokens; pricing: PriceRow },
      { cost: number }
    >('cost-formula')
    .filter((row) => row.only !== 'server');

  it.each(rows)('$id', (row) => {
    const pricing: ModelPricingEntry = {
      ...row.input.pricing,
      charsPerToken: null,
      contextLength: null,
    };
    const cost = computeCost(breakdown(row.input.tokens), pricing);
    expect(Math.abs(cost - row.expected.cost)).toBeLessThan(1e-9);
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
