/**
 * Table test for the client twin of docs/knowledgebase/algorithms/tool-call-outcome.md:
 * `classifyToolOutcome` (the outcome both twins share) and `outcomeToStatus` (the client's
 * `ToolCallDetail` status fields). Keys a row does not list must be absent from the status.
 * The server twin is `server/src/logs/tool-stats.algo.spec.ts`.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import {
  type ToolOutcome,
  type ToolResultInfo,
  classifyToolOutcome,
  outcomeToStatus,
} from './tool-outcome';
import type { ToolCallStatus } from './types';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../scripts/algo-docs/load-examples.cjs',
  );

const rows = loader.loadExamples<
  { result: ToolResultInfo | null },
  {
    outcome: ToolOutcome;
    status: ToolCallStatus;
    interrupted?: true;
    denialKind?: string;
  }
>('tool-call-outcome');

it.each(rows)('$id', ({ input, expected }) => {
  expect({
    outcome: classifyToolOutcome(input.result),
    ...outcomeToStatus(input.result),
  }).toStrictEqual(expected);
});
