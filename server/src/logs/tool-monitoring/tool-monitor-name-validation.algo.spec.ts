/**
 * Table test for docs/knowledgebase/algorithms/tool-monitor-name-validation.md: the shared
 * `@loghub/tool-monitor` name rules (`validateToolName`, `denylistRole`) against each row. The
 * hook's plain-JS twin runs the same rows in its own `node --test` file.
 */
import { denylistRole, validateToolName } from '@loghub/tool-monitor';
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';

interface RowInput {
  name?: string;
  repeat?: string;
  times?: number;
}

const rows = loadExamples<RowInput, Record<string, unknown>>(
  'tool-monitor-name-validation',
);

/** The typed name of a row, as described in the doc's Examples preamble. */
function nameOf(input: RowInput): string {
  if (input.repeat !== undefined) return input.repeat.repeat(input.times ?? 0);
  return input.name ?? '';
}

it.each(rows)('$id', ({ input, expected }) => {
  const name = nameOf(input);
  const actual = { ...validateToolName(name), role: denylistRole(name) };
  expect(actual).toEqual(expect.objectContaining(expected));
});
