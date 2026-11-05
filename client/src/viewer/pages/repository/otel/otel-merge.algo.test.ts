/**
 * Table test for `mergeOtelDelta` and `diffOtelBuckets` against the rows of
 * docs/knowledgebase/algorithms/otel-delta-merge.md. The compact state / delta format is the
 * doc's "Input and output" section.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type {
  OtelBucket,
  OtelCallRow,
  OtelChangeKind,
  OtelSessionKpis,
  OtelSessionPlan,
  OtelSpanRow,
  SessionOtelResponse,
} from '../../../../models/repositories';
import { diffOtelBuckets, mergeOtelDelta, otelBucketKey } from './otel-merge';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../scripts/algo-docs/load-examples.cjs',
  );

interface CompactState {
  full: boolean;
  kpis: number | null;
  calls: { key: string; kind: OtelChangeKind; v: number }[];
  spans: { id: string; kind: OtelChangeKind }[];
  buckets: {
    start: string;
    key: string;
    cost: string;
    calls: number;
    tokens: string;
    kind: OtelChangeKind;
  }[];
  /** The plan string stands for the whole account object; absent = an older server. */
  plan?: string | null;
}

interface MergeInput {
  kind: 'merge' | 'diff';
  state: CompactState | null;
  delta: CompactState;
}

function toCall(c: CompactState['calls'][number]): OtelCallRow {
  return {
    callKey: c.key,
    requestId: c.key,
    querySource: null,
    model: null,
    eventTime: '2026-10-30T10:00:00.000Z',
    structure: 'main',
    provisional: false,
    confirmed: true,
    costUsdMicros: String(c.v),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    agentId: null,
    promptId: null,
    changeKind: c.kind,
  };
}

function toSpan(s: CompactState['spans'][number]): OtelSpanRow {
  return {
    traceId: 't',
    spanId: s.id,
    parentSpanId: null,
    name: 'claude_code.interaction',
    startTime: '2026-10-30T10:00:00.000Z',
    endTime: null,
    requestId: null,
    agentId: null,
    querySource: null,
    context: null,
    costUsdMicros: null,
    rollupCostUsdMicros: null,
    hidden: null,
    confirmed: true,
    attributes: {},
    changeKind: s.kind,
  };
}

function toBucket(b: CompactState['buckets'][number]): OtelBucket {
  return {
    start: b.start,
    key: b.key,
    calls: b.calls,
    costUsdMicros: b.cost,
    tokens: b.tokens,
    changeKind: b.kind,
  };
}

/** The doc's numeric `kpis` stands for a KPI object; its total carries the number. */
function toKpis(value: number | null): OtelSessionKpis | null {
  return value === null
    ? null
    : {
        totalCostUsdMicros: String(value),
        hiddenCostUsdMicros: '0',
        hiddenCalls: 0,
        apiCalls: 0,
        subagentCostUsdMicros: '0',
        subagentShare: 0,
      };
}

/** The doc's `plan` string stands for an account object carrying only that plan. */
function toPlan(value: string | null): OtelSessionPlan | null {
  return value === null
    ? null
    : { plan: value, seatType: null, provider: null, customBaseUrl: null };
}

function toResponse(s: CompactState): SessionOtelResponse {
  const response: SessionOtelResponse = {
    cursor: 'v1.1',
    full: s.full,
    interval: '5m',
    status: {
      hasOtel: true,
      hasSpans: true,
      live: true,
      slowUpdates: false,
      slowReason: null,
      otelHookVersion: '2.29.0',
      attributesMasked: false,
      realtime: {
        active: true,
        unconfirmedCalls: 0,
        unconfirmedSpans: 0,
        lastRealtimeAt: null,
        lastChunkAt: null,
        chunkDelayed: false,
        gap: false,
      },
      otelStatus: null,
      costExcludesUtilityCalls: false,
    },
    buckets: s.buckets.map(toBucket),
    calls: s.calls.map(toCall),
    spans: s.spans.map(toSpan),
    kpis: toKpis(s.kpis),
    querySources: null,
  };
  if (s.plan !== undefined) response.plan = toPlan(s.plan);
  return response;
}

const sorted = (keys: ReadonlySet<string>) => [...keys].sort();

it.each(
  loader.loadExamples<MergeInput, Record<string, unknown>>('otel-delta-merge'),
)('$id', ({ input, expected }) => {
  const state = input.state === null ? null : toResponse(input.state);
  const delta = toResponse(input.delta);
  if (input.kind === 'diff') {
    const result = diffOtelBuckets(state, delta);
    expect({ highlighted: sorted(result.newKeys.buckets) }).toEqual(expected);
    return;
  }
  const result = mergeOtelDelta(state, delta);
  const kpis = result.state.kpis;
  const plan = result.state.plan;
  expect({
    // 'absent' marks a state without the field (only an older server's responses).
    plan: plan === undefined ? 'absent' : (plan?.plan ?? null),
    calls: result.state.calls.map((c) => `${c.callKey}:${c.costUsdMicros}`),
    spans: result.state.spans.map((s) => s.spanId),
    buckets: result.state.buckets.map(otelBucketKey),
    kpis: kpis === null ? null : Number(kpis.totalCostUsdMicros),
    highlighted: {
      calls: sorted(result.newKeys.calls),
      spans: sorted(result.newKeys.spans),
      buckets: sorted(result.newKeys.buckets),
    },
    filled: result.filled,
  }).toMatchObject(expected);
});
