/**
 * Table test for the client twin of the band rule: `zoneOf` (the Analytics change-surface chart's
 * bar colour) against the `band` rows of docs/knowledgebase/algorithms/change-surface-concentration.md.
 * The `null` row is skipped: the chart draws no bar for a bucket without a concentration.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { zoneOf } from './change-surface-ui';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../scripts/algo-docs/load-examples.cjs',
  );

const bandRows = loader
  .loadExamples<
    { band?: number | null },
    { band?: string | null }
  >('change-surface-concentration')
  .filter(
    (row): row is typeof row & { input: { band: number } } =>
      typeof row.input.band === 'number',
  );

it.each(bandRows)('$id', ({ input, expected }) => {
  expect({ band: zoneOf(input.band).band }).toEqual(expected);
});
