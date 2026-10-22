/**
 * Table test for the server twin of docs/knowledgebase/algorithms/tool-call-outcome.md:
 * `classifyToolOutcome` against each row's `expected.outcome`. The client-only status fields
 * (`status`, `interrupted`, `denialKind`) are not checked here — the server has no status; the
 * client twin's test is `client/src/viewer/pages/repository/session-log/tool-outcome.algo.test.ts`.
 */
import { loadExamples } from '../../../scripts/algo-docs/load-examples.cjs';
import {
  classifyToolOutcome,
  type ToolOutcome,
  type ToolResultInfo,
} from './tool-stats';

const rows = loadExamples<
  { result: ToolResultInfo | null },
  { outcome: ToolOutcome }
>('tool-call-outcome');

it.each(rows)('$id', ({ input, expected }) => {
  expect(classifyToolOutcome(input.result)).toBe(expected.outcome);
});
