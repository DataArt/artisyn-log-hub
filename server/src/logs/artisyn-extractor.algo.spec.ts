/**
 * Table test for docs/knowledgebase/algorithms/session-time-span.md: each row's lines become
 * one artisyn upload and run through `extractTimestampRange`.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { extractTimestampRange } from './artisyn-extractor';

/** Every line of one upload carries the same session id, as the hook writes it. */
function toLine(line: Record<string, unknown>): object {
  return { session_id: 'ts-session', ...line };
}

const rows = loadExamples<
  { lines: Record<string, unknown>[] },
  { startTime: string | null; endTime: string | null }
>('session-time-span');

it.each(rows)('$id', ({ input, expected }) => {
  expect(extractTimestampRange(input.lines.map(toLine))).toEqual(expected);
});
