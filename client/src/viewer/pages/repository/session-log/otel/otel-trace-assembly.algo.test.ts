/**
 * Table test for `assembleOtelTraces`, `splitOtelTurnTime` and `orderOtelTurns` against the rows
 * of docs/knowledgebase/algorithms/otel-trace-assembly.md. The compact span / call format and
 * the `tree` notation are the doc's "Input and output" section.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type {
  OtelCallRow,
  OtelSpanRow,
} from '../../../../../models/repositories';
import {
  assembleOtelTraces,
  orderOtelTurns,
  splitOtelTurnTime,
  type OtelTraceNode,
  type OtelTurn,
  type OtelTurnOrder,
} from './otel-trace-assembly';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../../scripts/algo-docs/load-examples.cjs',
  );

/** The doc's compact span. */
interface SpanSpec {
  t: string;
  id: string;
  p: string | null;
  n: string;
  s: number;
  e: number | null;
  cost?: number;
  rollup?: number;
  req?: string;
  hidden?: boolean;
}

type AssemblyInput =
  | {
      kind: 'assemble';
      spans: SpanSpec[];
      calls: { req: string; out: number }[];
    }
  | {
      kind: 'split';
      turn: number;
      spans: SpanSpec[];
      calls: { req: string; out: number }[];
    }
  | { kind: 'order'; order: OtelTurnOrder; spans: SpanSpec[] };

const T0 = Date.parse('2026-10-30T10:00:00.000Z');

const NAMES: Record<string, string> = {
  interaction: 'claude_code.interaction',
  llm: 'claude_code.llm_request',
  tool: 'claude_code.tool',
  blocked: 'claude_code.tool.blocked_on_user',
  exec: 'claude_code.tool.execution',
};

const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function toSpan(s: SpanSpec): OtelSpanRow {
  const rollup = s.rollup ?? s.cost;
  return {
    traceId: s.t,
    spanId: s.id,
    parentSpanId: s.p,
    name: NAMES[s.n] ?? s.n,
    startTime: at(s.s),
    endTime: s.e === null ? null : at(s.e),
    requestId: s.req ?? null,
    agentId: null,
    querySource: null,
    context: null,
    costUsdMicros: s.cost === undefined ? null : String(s.cost),
    rollupCostUsdMicros: rollup === undefined ? null : String(rollup),
    hidden: s.hidden ?? null,
    confirmed: true,
    attributes: {},
    changeKind: 'new',
  };
}

function toCall(c: { req: string; out: number }): OtelCallRow {
  return {
    callKey: c.req,
    requestId: c.req,
    querySource: null,
    model: null,
    eventTime: at(0),
    structure: 'main',
    provisional: false,
    confirmed: true,
    costUsdMicros: null,
    inputTokens: 0,
    outputTokens: c.out,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    agentId: null,
    promptId: null,
    changeKind: 'new',
  };
}

/** The doc's `tree` notation of one row: key, `*` standalone, `?` orphan, `[children]`. */
function treeOf(node: OtelTraceNode): string {
  const mark = `${node.standalone ? '*' : ''}${node.orphan ? '?' : ''}`;
  const children = node.children.length
    ? `[${node.children.map(treeOf).join(',')}]`
    : '';
  return `${node.key}${mark}${children}`;
}

function project(turn: OtelTurn) {
  const { startMs, endMs, ...rest } = turn.header;
  return {
    traceId: turn.traceId,
    inProgress: turn.inProgress,
    standaloneOnly: turn.standaloneOnly,
    tree: turn.rows.map(treeOf).join('|'),
    header: {
      ...rest,
      startS: (startMs - T0) / 1000,
      endS: (endMs - T0) / 1000,
    },
  };
}

it.each(
  loader.loadExamples<AssemblyInput, Record<string, unknown>>(
    'otel-trace-assembly',
  ),
)('$id', ({ input, expected }) => {
  const spans = input.spans.map(toSpan);
  const calls = input.kind === 'order' ? [] : input.calls.map(toCall);
  const turns = assembleOtelTraces(spans, calls);
  switch (input.kind) {
    case 'assemble':
      expect({ turns: turns.map(project) }).toMatchObject(expected);
      return;
    case 'split':
      expect(splitOtelTurnTime(turns[input.turn])).toEqual(expected);
      return;
    case 'order':
      expect({
        order: orderOtelTurns(turns, input.order).map((t) => t.traceId),
      }).toEqual(expected);
  }
});
