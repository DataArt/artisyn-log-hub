/**
 * Table test for docs/knowledgebase/algorithms/anthropic-pricing-parse.md: every row of the
 * doc's examples block runs against `parseAnthropicPricing`. The page snippets and the expected
 * rates live only in the doc.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { parseAnthropicPricing } from './anthropic-pricing-parser';

interface ParseInput {
  /** Page markdown, one string per line. */
  lines: string[];
}

interface ParseExpected {
  /** `null` when the whole parse must fail. */
  result?: null;
  /** Number of merged models. */
  count?: number;
  /** Per model id, the fields it must have (subset match). */
  models?: Record<string, Record<string, unknown>>;
  /** Exactly the model ids whose `tiers` is not null. */
  tiered?: string[];
}

const rows = loadExamples<ParseInput, ParseExpected>('anthropic-pricing-parse');

it.each(rows)('$id', ({ input, expected }) => {
  const parsed = parseAnthropicPricing(input.lines.join('\n'));
  if (expected.result === null) {
    expect(parsed).toBeNull();
    return;
  }
  expect(parsed).not.toBeNull();
  if (parsed === null) return;

  if (expected.count !== undefined) {
    expect(parsed.size).toBe(expected.count);
  }
  for (const [id, fields] of Object.entries(expected.models ?? {})) {
    expect(parsed.get(id)).toEqual(expect.objectContaining(fields));
  }
  if (expected.tiered !== undefined) {
    const tiered = [...parsed]
      .filter(([, rates]) => rates.tiers !== null)
      .map(([id]) => id);
    expect(tiered.sort()).toEqual([...expected.tiered].sort());
  }
});
