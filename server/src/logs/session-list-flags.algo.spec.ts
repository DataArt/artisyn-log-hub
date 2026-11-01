/**
 * Table test for docs/knowledgebase/algorithms/session-list-flags.md: each row's transcript
 * lines run through `computeSessionListFlags` and the full result must equal `expected`.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  computeSessionListFlags,
  SessionListFlags,
} from './session-list-flags';

const rows = loadExamples<unknown[], SessionListFlags>('session-list-flags');

it.each(rows)('$id', ({ input, expected }) => {
  expect(computeSessionListFlags(input)).toEqual(expected);
});
