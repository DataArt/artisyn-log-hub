/**
 * Table test for `detectOutputFormat`, `realignTable` and `markAgentSeenLines` against the rows
 * of docs/knowledgebase/algorithms/tool-output-format.md. Rows with `input.lines` check format
 * detection (and the re-aligned table when the row lists it); rows with `input.full` check the
 * agent-seen line marks.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  detectOutputFormat,
  markAgentSeenLines,
  realignTable,
} from './output-format';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface FormatInput {
  lines?: string[];
  full?: string[];
  agentSaw?: string[];
}

interface FormatExpected {
  format?: string;
  headers?: string[];
  rows?: string[][];
  seen?: number[];
}

const rows = loader.loadExamples<FormatInput, FormatExpected>(
  'tool-output-format',
);

it.each(rows)('$id', ({ input, expected }) => {
  if (input.lines) {
    const text = input.lines.join('\n');
    const format = detectOutputFormat(text);
    expect(format).toBe(expected.format);
    if (expected.headers !== undefined || expected.rows !== undefined) {
      const table = realignTable(text, format);
      if (expected.headers !== undefined) {
        expect(table.headers).toEqual(expected.headers);
      }
      if (expected.rows !== undefined) {
        expect(table.rows).toEqual(expected.rows);
      }
    }
    return;
  }
  const seen = markAgentSeenLines(
    (input.full ?? []).join('\n'),
    (input.agentSaw ?? []).join('\n'),
  );
  expect(seen).toEqual(expected.seen);
});
