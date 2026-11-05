/**
 * Carousel pages of the Live view (2026-11-04 otel-live-view, DD-13). The server sends raw
 * 5-minute rows (`view.buckets`, `view.latency`) of the selected node over the last 2 h; this
 * module derives the pages from them. Pages 1–5 map rows to `OtelBucket` so they render with the
 * existing `OtelCostChart`; page 6 is the latency line chart. A page whose rows are all zero is
 * skipped, except "Cost over time", which is always shown.
 */
import type {
  OtelLiveBucket,
  OtelLiveLatencyBucket,
  OtelLiveView,
} from '../../models/otel-live';
import type { OtelBucket } from '../../models/repositories';
import type { OtelMetric } from '../pages/repository/otel/otel-url-state';

/** One stack variant of a bucket page (page 5 has two: skill / MCP server). */
export interface LiveChartVariant {
  value: string;
  label: string;
  stackBy: string;
  buckets: OtelBucket[];
}

export interface LiveBucketChartPage {
  kind: 'buckets';
  id: 'cost' | 'tokens' | 'model' | 'structure' | 'attribution';
  title: string;
  /** Metrics the page offers; the first is the default (page 3 toggles cost / calls). */
  metrics: readonly OtelMetric[];
  variants: LiveChartVariant[];
}

export interface LiveLatencyPoint {
  start: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  failed: number;
}

export interface LiveLatencyChartPage {
  kind: 'latency';
  id: 'latency';
  title: string;
  llm: LiveLatencyPoint[];
  tool: LiveLatencyPoint[];
  /** Failed tool spans over the window. */
  failedTools: number;
}

export type LiveChartPage = LiveBucketChartPage | LiveLatencyChartPage;

function toBigInt(v: string | null | undefined): bigint {
  if (!v) return 0n;
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

interface Acc {
  start: string;
  key: string;
  calls: number;
  cost: bigint;
  tokens: bigint;
}

function rowTokens(r: OtelLiveBucket): bigint {
  return (
    toBigInt(r.inputTokens) +
    toBigInt(r.outputTokens) +
    toBigInt(r.cacheReadTokens) +
    toBigInt(r.cacheWriteTokens)
  );
}

/** Rows summed per `(start, keyOf(row))` into `OtelBucket`s. */
function rollUp(
  rows: readonly OtelLiveBucket[],
  keyOf: (r: OtelLiveBucket) => string,
): OtelBucket[] {
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const key = keyOf(r);
    const id = `${r.start}|${key}`;
    const a = acc.get(id) ?? {
      start: r.start,
      key,
      calls: 0,
      cost: 0n,
      tokens: 0n,
    };
    a.calls += r.calls;
    a.cost += toBigInt(r.costUsdMicros);
    a.tokens += rowTokens(r);
    acc.set(id, a);
  }
  return [...acc.values()].map((a) => ({
    start: a.start,
    key: a.key,
    calls: a.calls,
    costUsdMicros: a.cost.toString(),
    tokens: a.tokens.toString(),
    changeKind: 'confirm',
  }));
}

const TOKEN_KINDS: readonly [
  string,
  (r: OtelLiveBucket) => string | null | undefined,
][] = [
  ['input', (r) => r.inputTokens],
  ['output', (r) => r.outputTokens],
  ['cacheRead', (r) => r.cacheReadTokens],
  ['cacheWrite', (r) => r.cacheWriteTokens],
];

/** Each row yields 4 buckets, one per token kind, with `tokens` = that kind's sum. */
function tokenBuckets(rows: readonly OtelLiveBucket[]): OtelBucket[] {
  const acc = new Map<string, OtelBucket & { sum: bigint }>();
  for (const r of rows) {
    for (const [key, pick] of TOKEN_KINDS) {
      const id = `${r.start}|${key}`;
      const a = acc.get(id) ?? {
        start: r.start,
        key,
        calls: 0,
        costUsdMicros: '0',
        tokens: '0',
        changeKind: 'confirm' as const,
        sum: 0n,
      };
      a.sum += toBigInt(pick(r));
      acc.set(id, a);
    }
  }
  return [...acc.values()].map(({ sum, ...b }) => ({
    ...b,
    tokens: sum.toString(),
  }));
}

function hasValue(
  buckets: readonly OtelBucket[],
  metrics: readonly OtelMetric[],
): boolean {
  return buckets.some((b) =>
    metrics.some((m) =>
      m === 'calls'
        ? b.calls !== 0
        : toBigInt(m === 'cost' ? b.costUsdMicros : b.tokens) !== 0n,
    ),
  );
}

function bucketPage(
  id: LiveBucketChartPage['id'],
  title: string,
  metrics: readonly OtelMetric[],
  variants: LiveChartVariant[],
): LiveBucketChartPage {
  return { kind: 'buckets', id, title, metrics, variants };
}

function latencyPoints(
  rows: readonly OtelLiveLatencyBucket[],
  kind: 'llm' | 'tool',
): LiveLatencyPoint[] {
  return rows
    .filter((r) => r.kind === kind)
    .map((r) => ({
      start: r.start,
      count: r.count,
      p50Ms: r.p50Ms,
      p95Ms: r.p95Ms,
      failed: r.failed,
    }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** The carousel pages of a node view, in DD-13 order. */
export function buildLiveChartPages(view: OtelLiveView): LiveChartPage[] {
  const rows = view.buckets;
  const pages: LiveChartPage[] = [];

  pages.push(
    bucketPage(
      'cost',
      'Cost over time',
      ['cost'],
      [
        {
          // A named single series: the chart reads the '' key as "(unknown)".
          value: 'total',
          label: 'Total',
          stackBy: 'total',
          buckets: rollUp(rows, () => 'Total'),
        },
      ],
    ),
  );

  const candidates: LiveBucketChartPage[] = [
    bucketPage(
      'tokens',
      'Tokens over time',
      ['tokens'],
      [
        {
          value: 'tokenKind',
          label: 'Token kind',
          stackBy: 'tokenKind',
          buckets: tokenBuckets(rows),
        },
      ],
    ),
    bucketPage(
      'model',
      'Calls and cost by model',
      ['cost', 'calls'],
      [
        {
          value: 'model',
          label: 'Model',
          stackBy: 'model',
          buckets: rollUp(rows, (r) => r.model),
        },
      ],
    ),
    bucketPage(
      'structure',
      'Cost by structure',
      ['cost'],
      [
        {
          value: 'structure',
          label: 'Structure',
          stackBy: 'structure',
          buckets: rollUp(rows, (r) => r.structure),
        },
      ],
    ),
    bucketPage(
      'attribution',
      'Cost by skill / MCP server',
      ['cost'],
      [
        {
          value: 'skill',
          label: 'Skill',
          stackBy: 'skill',
          buckets: rollUp(rows, (r) => r.skill),
        },
        {
          value: 'mcpServer',
          label: 'MCP server',
          stackBy: 'mcpServer',
          buckets: rollUp(rows, (r) => r.mcpServer),
        },
      ],
    ),
  ];
  for (const p of candidates) {
    if (p.variants.some((v) => hasValue(v.buckets, p.metrics))) pages.push(p);
  }

  if (view.hasSpans) {
    const llm = latencyPoints(view.latency, 'llm');
    const tool = latencyPoints(view.latency, 'tool');
    if ([...llm, ...tool].some((p) => p.count > 0)) {
      pages.push({
        kind: 'latency',
        id: 'latency',
        title: 'Latency p50 / p95',
        llm,
        tool,
        failedTools: tool.reduce((s, p) => s + p.failed, 0),
      });
    }
  }
  return pages;
}
