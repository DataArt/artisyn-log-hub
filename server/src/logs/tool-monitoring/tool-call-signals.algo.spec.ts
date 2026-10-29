/**
 * Table test for docs/knowledgebase/algorithms/tool-usefulness-signals.md: `computeSignals`
 * against each row's `expected.signals`. The rows hold several agents' calls; like the tree
 * builder (one list per node), the test passes only the subject call's agent's list.
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import type { ToolCallSignal } from '../../database/schema/index';
import {
  computeSignals,
  type SignalSubject,
  type SignalToolUse,
} from './tool-call-signals';

interface UseInput {
  agent?: string;
  name: string;
  calls?: { tool: string; operation: string }[];
  filePath?: string | null;
  output: string | null;
}

interface RowInput {
  index: number;
  uses: UseInput[];
  subject?: SignalSubject;
}

const ROOT_AGENT = 'root';

const rows = loadExamples<RowInput, { signals: ToolCallSignal[] }>(
  'tool-usefulness-signals',
);

function toSignalUse(use: UseInput): SignalToolUse {
  return {
    name: use.name,
    calls: use.calls ?? [],
    filePath: use.filePath ?? null,
    output: use.output,
  };
}

it.each(rows)('$id', ({ input, expected }) => {
  const own = input.uses[input.index];
  const agent = own.agent ?? ROOT_AGENT;
  const agentUses = input.uses.filter((u) => (u.agent ?? ROOT_AGENT) === agent);
  const result = computeSignals(
    agentUses.map(toSignalUse),
    agentUses.indexOf(own),
    input.subject,
  );
  expect(result).toEqual(expected.signals);
});
