/**
 * Table test for docs/knowledgebase/algorithms/ingest-hash-skip.md: each row is one
 * `decideIngestSkip(stored, incoming)` call and its decision.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  decideIngestSkip,
  IngestSkipDecision,
  IngestSkipIncoming,
  IngestSkipStored,
} from './ingest-skip';

const rows = loadExamples<
  { stored: IngestSkipStored | null; incoming: IngestSkipIncoming },
  IngestSkipDecision
>('ingest-hash-skip');

it.each(rows)('$id', ({ input, expected }) => {
  expect(decideIngestSkip(input.stored, input.incoming)).toBe(expected);
});
