/**
 * Table test for docs/knowledgebase/algorithms/cost-formula.md: every row of the doc's
 * examples block runs against `computeSessionCost`. The numbers live only in the doc.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  computeSessionCost,
  type SessionCostPricing,
  type SessionCostTokens,
} from './cost.sql';

interface CostInput {
  tokens: Partial<SessionCostTokens>;
  pricing?: SessionCostPricing | null;
}

/** Omitted counts are 0 (doc prose); explicit `null`s are kept, they are part of the row. */
function fullTokens(partial: Partial<SessionCostTokens>): SessionCostTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    webSearchRequests: 0,
    inputTokensFast: 0,
    outputTokensFast: 0,
    ...partial,
  };
}

const rows = loadExamples<CostInput, { cost: number | null }>('cost-formula');

it.each(rows)('$id', ({ input, expected }) => {
  const cost = computeSessionCost(fullTokens(input.tokens), input.pricing);
  if (expected.cost === null) {
    expect(cost).toBeNull();
    return;
  }
  expect(cost).not.toBeNull();
  expect(Math.abs((cost ?? NaN) - expected.cost)).toBeLessThan(1e-9);
});
