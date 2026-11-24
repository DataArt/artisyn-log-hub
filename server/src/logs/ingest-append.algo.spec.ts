/**
 * Table test for docs/knowledgebase/algorithms/ingest-append.md: each row is one
 * `decideIngestAppend({ stored, rowReceivedAt, startLine })` call and its decision. Times are ISO
 * strings in the rows; the test turns them into `Date`s.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import { decideIngestAppend, IngestAppendDecision } from './ingest-append';

const rows = loadExamples<
  {
    stored: { receivedAt: string | null; lineCount: number | null } | null;
    rowReceivedAt: string;
    startLine: number;
  },
  { decision: IngestAppendDecision }
>('ingest-append');

it.each(rows)('$id', ({ input, expected }) => {
  const stored =
    input.stored === null
      ? null
      : {
          receivedAt:
            input.stored.receivedAt === null
              ? null
              : new Date(input.stored.receivedAt),
          lineCount: input.stored.lineCount,
        };
  expect(
    decideIngestAppend({
      stored,
      rowReceivedAt: new Date(input.rowReceivedAt),
      startLine: input.startLine,
    }),
  ).toBe(expected.decision);
});
