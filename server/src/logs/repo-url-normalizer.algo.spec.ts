/**
 * Table test for docs/knowledgebase/algorithms/repo-url-normalization.md. Each row also checks
 * the doc's fixed-point rule: normalizing the expected value again leaves it unchanged, unless the
 * row says `fixedPoint: false` (an input past the pass limit).
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { normalizeRepoUrl } from './repo-url-normalizer';

const rows = loadExamples<
  { url: string },
  { normalized: string; fixedPoint?: boolean }
>('repo-url-normalization');

it.each(rows)('$id', ({ input, expected }) => {
  const normalized = normalizeRepoUrl(input.url);
  expect(normalized).toBe(expected.normalized);
  expect(normalizeRepoUrl(normalized) === normalized).toBe(
    expected.fixedPoint ?? true,
  );
});
