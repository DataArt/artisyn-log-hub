/**
 * Table test for docs/knowledgebase/algorithms/rebuild-load-governor.md: each row is one
 * `decideRebuildPace` call (`input`) and its full decision (`expected`).
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import {
  decideRebuildPace,
  RebuildPaceDecision,
  RebuildPaceInput,
} from './rebuild-pace';

const rows = loadExamples<RebuildPaceInput, RebuildPaceDecision>(
  'rebuild-load-governor',
);

it.each(rows)('$id', ({ input, expected }) => {
  expect(decideRebuildPace(input)).toEqual(expected);
});
