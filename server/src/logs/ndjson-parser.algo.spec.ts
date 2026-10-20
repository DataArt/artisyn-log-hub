/**
 * Table test for docs/knowledgebase/algorithms/ndjson-tolerance.md, server side: every row
 * with `side: "server"` runs against `parseNdjsonLinesTolerant` (default ratio), or against the
 * strict `parseNdjsonLines` when the row says `strict`. The hook
 * rows run in hook/.claude/telemetry_tool/__tests__/ndjson-tolerance.algo.test.js.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { parseNdjsonLines, parseNdjsonLinesTolerant } from './ndjson-parser';

const serverRows = loadExamples<
  { side: 'hook' | 'server'; body: string; strict?: boolean },
  Record<string, unknown>
>('ndjson-tolerance').filter((row) => row.input.side === 'server');

function outcome(body: string, strict: boolean): Record<string, unknown> {
  try {
    if (strict) {
      return { accepted: true, kept: parseNdjsonLines(body).length };
    }
    const result = parseNdjsonLinesTolerant(body);
    return {
      accepted: true,
      kept: result.lines.length,
      dropped: result.dropped.map((d) => d.lineNo),
      totalLines: result.totalLines,
      values: result.lines,
    };
  } catch (err) {
    return {
      accepted: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

it.each(serverRows)('$id', ({ input, expected }) => {
  const actual = outcome(input.body, input.strict === true);
  if (expected.accepted === false) {
    expect(actual.accepted).toBe(false);
    expect(actual.error).toEqual(
      expect.stringContaining(String(expected.error)),
    );
    if (typeof expected.errorNot === 'string') {
      expect(actual.error).not.toEqual(
        expect.stringContaining(expected.errorNot),
      );
    }
    return;
  }
  // `values` (the parsed lines) is compared only where the row pins it.
  if (!('values' in expected)) delete actual.values;
  expect(actual).toEqual(expected);
});
