/**
 * Table test for docs/knowledgebase/algorithms/cost-formula.md: every row of the doc's
 * examples block runs against `computeSessionCostBreakdown` (and its scalar wrapper
 * `computeSessionCost`). The numbers live only in the doc.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  computeSessionCost,
  computeSessionCostBreakdown,
  type SessionCallTokens,
  type SessionCostPricing,
  type SessionCostTokens,
} from './cost.sql';

type CallKey = keyof SessionCallTokens;

/** One call of the doc's row-wise `input.calls`; an omitted count is 0. */
type DocCall = Partial<Record<CallKey, number>>;

interface CostInput {
  tokens: Partial<SessionCostTokens>;
  calls?: DocCall[];
  pricing?: SessionCostPricing | null;
}

interface CostExpected {
  cost: number | null;
  tierDelta?: number;
}

const CALL_KEYS: readonly CallKey[] = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'inputTokensFast',
  'outputTokensFast',
];

/** The doc's row-wise call list -> the columnar `session_call_tokens.calls` shape. */
function columnar(calls: DocCall[]): SessionCallTokens {
  const out: SessionCallTokens = {};
  for (const key of CALL_KEYS) {
    out[key] = calls.map((c) => c[key] ?? 0);
  }
  return out;
}

/** Omitted counts are 0 (doc prose); explicit `null`s are kept, they are part of the row. */
function fullTokens(input: CostInput): SessionCostTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    webSearchRequests: 0,
    inputTokensFast: 0,
    outputTokensFast: 0,
    ...input.tokens,
    ...(input.calls ? { calls: columnar(input.calls) } : {}),
  };
}

const rows = loadExamples<CostInput, CostExpected>('cost-formula');

it.each(rows)('$id', ({ input, expected }) => {
  const tokens = fullTokens(input);
  const cost = computeSessionCost(tokens, input.pricing);
  if (expected.cost === null) {
    expect(cost).toBeNull();
    return;
  }
  expect(cost).not.toBeNull();
  expect(Math.abs((cost ?? NaN) - expected.cost)).toBeLessThan(1e-9);

  if (expected.tierDelta !== undefined) {
    const breakdown = computeSessionCostBreakdown(tokens, input.pricing);
    expect(breakdown).not.toBeNull();
    expect(
      Math.abs((breakdown?.tierDelta ?? NaN) - expected.tierDelta),
    ).toBeLessThan(1e-9);
  }
});
