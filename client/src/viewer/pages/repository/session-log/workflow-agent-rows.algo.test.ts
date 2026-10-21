/**
 * Table test for `orderAgentRows` and `agentRowLabel` against the rows of
 * docs/knowledgebase/algorithms/workflow-agent-rows.md. Rows with `input.forest` check the
 * ordering and numbering; rows with `input.label` check the label.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { SubAgentNode } from './types';
import { agentRowLabel, orderAgentRows } from './workflow-agent-rows';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface ForestNode {
  id: string;
  startMs?: number;
  children?: ForestNode[];
}

interface RowsInput {
  forest?: ForestNode[];
  label?: { agentId: string; prompt: string };
}

interface RowsExpected {
  rows?: { id: string; number: string; depth: number }[];
  label?: string;
}

/** A doc node as an agent node; `startMs` stays absent (never 0) when the row omits it. */
function toNode(spec: ForestNode): SubAgentNode {
  return {
    agentId: spec.id,
    prompt: '',
    ...(spec.startMs !== undefined && { startMs: spec.startMs }),
    children: (spec.children ?? []).map(toNode),
  };
}

const rows = loader.loadExamples<RowsInput, RowsExpected>(
  'workflow-agent-rows',
);

it.each(rows)('$id', ({ input, expected }) => {
  if (input.label) {
    expect(
      agentRowLabel({
        agentId: input.label.agentId,
        prompt: input.label.prompt,
        children: [],
      }),
    ).toBe(expected.label);
    return;
  }
  const out = orderAgentRows((input.forest ?? []).map(toNode));
  expect(
    out.map((r) => ({ id: r.node.agentId, number: r.number, depth: r.depth })),
  ).toEqual(expected.rows);
});
