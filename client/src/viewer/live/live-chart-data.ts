/**
 * Carousel pages of the Live view (2026-11-04 otel-live-view, DD-13). The server sends raw
 * 5-minute rows (`view.buckets`, `view.latency`) of the selected node over the last 2 h; this
 * module derives the pages from them. Pages 1–5 map rows to `OtelBucket` so they render with the
 * existing `OtelCostChart`; page 6 is the latency line chart. A page whose rows are all zero is
 * skipped, except "Cost over time", which is always shown.
 *
 * 2026-11-21 cloudwatch-cai-parity: the builder returns the full ordered page list (Share included)
 * for both the carousel and tile mode, and adds "Over time by team" / "Over time by user" (per-root
 * `view.rootSeries` folded by first placement, with an "Other" remainder against `view.buckets`)
 * and "Edits by tool" (`view.editsByTool`; "not reported" without spans).
 */
import type {
  OtelLiveBucket,
  OtelLiveLatencyBucket,
  OtelLiveNode,
  OtelLiveView,
} from '../../models/otel-live';
import type { OtelBucket } from '../../models/repositories';
import type { OtelMetric } from '../pages/repository/otel/otel-url-state';
import { liveNodeLabel } from './LiveTree';
import {
  buildLiveShare,
  rootsUnder,
  type RootPlacement,
} from './live-share-data';

/** One stack variant of a bucket page (page 5 has two: skill / MCP server). */
export interface LiveChartVariant {
  value: string;
  label: string;
  stackBy: string;
  buckets: OtelBucket[];
}

export interface LiveBucketChartPage {
  kind: 'buckets';
  id:
    | 'cost'
    | 'tokens'
    | 'model'
    | 'structure'
    | 'attribution'
    | 'team-time'
    | 'user-time'
    | 'edits-by-tool';
  title: string;
  /** Metrics the page offers; the first is the default (page 3 toggles cost / calls). */
  metrics: readonly OtelMetric[];
  variants: LiveChartVariant[];
  /** "Edits by tool" without spans in the window: a "not reported" note instead of the chart. */
  notReported?: boolean;
}

/** The Share page: three doughnuts built from the tree by `LiveSharePage`. */
export interface LiveSharePageRef {
  kind: 'share';
  id: 'share';
  title: string;
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

export type LiveChartPage =
  | LiveBucketChartPage
  | LiveLatencyChartPage
  | LiveSharePageRef;

/** Series key of what the listed roots do not cover (capped roots, roots not in `nodes`). */
export const LIVE_OTHER_SERIES = 'Other';

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

interface Sums {
  calls: number;
  cost: bigint;
  tokens: bigint;
}

function addSums(
  acc: Map<string, Sums>,
  id: string,
  calls: number,
  cost: bigint,
  tokens: bigint,
): void {
  const a = acc.get(id) ?? { calls: 0, cost: 0n, tokens: 0n };
  a.calls += calls;
  a.cost += cost;
  a.tokens += tokens;
  acc.set(id, a);
}

/**
 * `view.rootSeries` folded into one series per `keyOf(first placement)`; roots without a
 * placement under the node, and the per-bucket remainder of `view.buckets` the listed roots do
 * not cover, go to `LIVE_OTHER_SERIES`. Empty when the server sent no per-root rows.
 */
function groupedBuckets(
  view: OtelLiveView,
  roots: readonly RootPlacement[],
  keyOf: (p: RootPlacement) => string,
): OtelBucket[] {
  const series = view.rootSeries ?? [];
  if (series.length === 0) return [];
  const keyByRoot = new Map<number, string>();
  for (const p of roots) {
    if (p.session.rootId !== null) keyByRoot.set(p.session.rootId, keyOf(p));
  }
  const acc = new Map<string, Sums>();
  const listed = new Map<string, Sums>();
  for (const r of series) {
    const key = keyByRoot.get(r.rootId) ?? LIVE_OTHER_SERIES;
    const cost = toBigInt(r.costUsdMicros);
    const tokens = toBigInt(r.tokens);
    addSums(acc, `${r.start}|${key}`, r.calls, cost, tokens);
    addSums(listed, r.start, r.calls, cost, tokens);
  }
  const totals = new Map<string, Sums>();
  for (const b of view.buckets) {
    addSums(totals, b.start, b.calls, toBigInt(b.costUsdMicros), rowTokens(b));
  }
  for (const [start, t] of totals) {
    const l = listed.get(start) ?? { calls: 0, cost: 0n, tokens: 0n };
    const calls = Math.max(0, t.calls - l.calls);
    const cost = t.cost > l.cost ? t.cost - l.cost : 0n;
    const tokens = t.tokens > l.tokens ? t.tokens - l.tokens : 0n;
    if (calls === 0 && cost === 0n && tokens === 0n) continue;
    addSums(acc, `${start}|${LIVE_OTHER_SERIES}`, calls, cost, tokens);
  }
  return [...acc.entries()].map(([id, a]) => {
    const sep = id.indexOf('|');
    return {
      start: id.slice(0, sep),
      key: id.slice(sep + 1),
      calls: a.calls,
      costUsdMicros: a.cost.toString(),
      tokens: a.tokens.toString(),
      changeKind: 'confirm' as const,
    };
  });
}

const TIME_METRICS: readonly OtelMetric[] = ['cost', 'tokens', 'calls'];

/** "Over time by team" / "Over time by user"; none on an agent node, no "by user" on a session. */
function placementPages(
  view: OtelLiveView,
  nodes: readonly OtelLiveNode[],
  selected: OtelLiveNode,
): LiveBucketChartPage[] {
  if (selected.type === 'agent') return [];
  const roots = rootsUnder(nodes, selected.key);
  const pages = [
    bucketPage('team-time', 'Over time by team', TIME_METRICS, [
      {
        value: 'team',
        label: 'Team',
        stackBy: 'team',
        buckets: groupedBuckets(view, roots, (p) =>
          p.team ? liveNodeLabel(p.team) : LIVE_OTHER_SERIES,
        ),
      },
    ]),
  ];
  if (selected.type !== 'session') {
    pages.push(
      bucketPage('user-time', 'Over time by user', TIME_METRICS, [
        {
          value: 'user',
          label: 'User',
          stackBy: 'user',
          buckets: groupedBuckets(
            view,
            roots,
            (p) => p.session.userEmail || '(unknown)',
          ),
        },
      ]),
    );
  }
  return pages.filter((p) =>
    p.variants.some((v) => hasValue(v.buckets, p.metrics)),
  );
}

/**
 * "Edits by tool": span counts per tool as `calls`. Without spans in the window the page is a
 * "not reported" note; with spans but no edits (or every root masked) it is hidden.
 */
function editsPage(view: OtelLiveView): LiveBucketChartPage | null {
  const buckets: OtelBucket[] = (view.editsByTool ?? []).map((r) => ({
    start: r.start,
    key: r.tool,
    calls: r.count,
    costUsdMicros: '0',
    tokens: '0',
    changeKind: 'confirm',
  }));
  const page = bucketPage(
    'edits-by-tool',
    'Edits by tool',
    ['calls'],
    [{ value: 'tool', label: 'Tool', stackBy: 'tool', buckets }],
  );
  if (!view.hasSpans) return { ...page, notReported: true };
  return hasValue(buckets, page.metrics) ? page : null;
}

/** The chart pages of a node view, in DD-13 order, for both the carousel and tile mode. */
export function buildLiveChartPages(
  view: OtelLiveView,
  nodes: readonly OtelLiveNode[],
  selected: OtelLiveNode,
): LiveChartPage[] {
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

  if (buildLiveShare(nodes, selected, 'cost') !== null) {
    pages.push({
      kind: 'share',
      id: 'share',
      title: 'Share by team / repository / user',
    });
  }
  pages.push(...placementPages(view, nodes, selected));
  const edits = editsPage(view);
  if (edits) pages.push(edits);
  return pages;
}
