/**
 * Table test for docs/knowledgebase/algorithms/mcp-call-extraction.md: `extractMcpCalls` over
 * each row's transcript, compared with `expected.calls` (each listed object a subset of the call
 * record plus its stored `agentSaw`). Transcript lines are built the way
 * `okf/okf-access-extractor.algo.spec.ts` builds them (`toEntries`).
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import { extractMcpCalls } from './mcp-call-extractor';

interface CallInput {
  id?: string;
  name: string;
  input?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  noResult?: boolean;
  resultAfterMs?: number;
  toolUseResult?: Record<string, unknown>;
  sidechain?: boolean;
}

interface RowInput {
  calls: CallInput[];
  subagent?: boolean;
}

const BASE_MS = Date.parse('2026-10-28T10:00:00.000Z');
const CALL_STEP_MS = 10_000;
const DEFAULT_RESULT_AFTER_MS = 1000;

const rows = loadExamples<RowInput, { calls: Record<string, unknown>[] }>(
  'mcp-call-extraction',
);

/** The transcript lines of one row, as described in the doc's Examples preamble. */
function toEntries(input: RowInput): object[] {
  const entries: object[] = [];
  input.calls.forEach((call, k) => {
    const id = call.id ?? `t${k + 1}`;
    const sidechain = call.sidechain === true ? { isSidechain: true } : {};
    const assistantMs = BASE_MS + k * CALL_STEP_MS;
    entries.push({
      type: 'assistant',
      timestamp: new Date(assistantMs).toISOString(),
      ...sidechain,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id, name: call.name, input: call.input ?? {} },
        ],
      },
    });
    if (call.noResult === true) return;
    const isError =
      call.isError === undefined ? {} : { is_error: call.isError };
    const toolUseResult =
      call.toolUseResult === undefined
        ? {}
        : { toolUseResult: call.toolUseResult };
    entries.push({
      type: 'user',
      timestamp: new Date(
        assistantMs + (call.resultAfterMs ?? DEFAULT_RESULT_AFTER_MS),
      ).toISOString(),
      ...sidechain,
      ...toolUseResult,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            content: call.result,
            ...isError,
          },
        ],
      },
    });
  });
  return entries;
}

it.each(rows)('$id', ({ input, expected }) => {
  const subagent = input.subagent === true;
  const result = extractMcpCalls(toEntries(input), {
    agentId: subagent ? 'agent-1' : null,
    agentKind: subagent ? 'subagent' : 'root',
    isSubagentLog: subagent,
  }).map(({ call, output }) => ({
    ...call,
    agentSaw: output.agentSaw ?? null,
  }));
  expect(result).toEqual(
    expected.calls.map((c): unknown => expect.objectContaining(c)),
  );
});
