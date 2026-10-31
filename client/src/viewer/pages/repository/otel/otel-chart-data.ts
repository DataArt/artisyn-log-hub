/**
 * Pure data shaping of the OTEL cost chart (2026-10-30 otel-tabs-traces): rolled buckets → one
 * row per bucket start with a value per stack key, the series order and colours, the 100 % view
 * and the cumulative line. Also the per-start sums the KPI sparklines are drawn from (DD-28).
 */
import type { OtelBucket, OtelInterval } from '../../../../models/repositories';
import { microsToUsd } from './otel-format';
import type { OtelMetric } from './otel-url-state';

export interface OtelSeries {
  key: string;
  label: string;
  color: string;
  /** Sum over the whole chart, for the series order and the legend. */
  total: number;
}

export interface OtelChartRow {
  start: string;
  /** Metric value per series key (absolute, before the 100 % view). */
  values: Record<string, number>;
  total: number;
  cumulative: number;
}

const STRUCTURE_LABELS: Record<string, string> = {
  main: 'Main thread',
  subagent: 'Sub-agents',
  hidden: 'Hidden calls',
};

const STRUCTURE_COLORS: Record<string, string> = {
  main: '#3b82f6',
  subagent: '#8b5cf6',
  hidden: '#ef4444',
};

/** A categorical palette for the non-structure stack keys. */
export const OTEL_SERIES_PALETTE = [
  '#3b82f6',
  '#8b5cf6',
  '#14b8a6',
  '#f59e0b',
  '#ec4899',
  '#22c55e',
  '#6366f1',
  '#f97316',
  '#06b6d4',
  '#a855f7',
  '#84cc16',
  '#64748b',
];

export function otelSeriesLabel(stackBy: string, key: string): string {
  if (key === '') return '(unknown)';
  if (stackBy === 'structure') return STRUCTURE_LABELS[key] ?? key;
  return key;
}

/** The metric value of one bucket. */
export function otelBucketValue(b: OtelBucket, metric: OtelMetric): number {
  if (metric === 'calls') return b.calls;
  if (metric === 'tokens') return Number(b.tokens) || 0;
  return microsToUsd(b.costUsdMicros) ?? 0;
}

/** Series sorted by total, largest first (structure keeps main / sub-agents / hidden). */
export function buildOtelSeries(
  buckets: readonly OtelBucket[],
  metric: OtelMetric,
  stackBy: string,
): OtelSeries[] {
  const totals = new Map<string, number>();
  for (const b of buckets) {
    totals.set(b.key, (totals.get(b.key) ?? 0) + otelBucketValue(b, metric));
  }
  const keys = [...totals.keys()];
  if (stackBy === 'structure') {
    const order = ['main', 'subagent', 'hidden'];
    keys.sort(
      (a, b) =>
        (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) ||
        a.localeCompare(b),
    );
  } else {
    keys.sort(
      (a, b) =>
        (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b),
    );
  }
  return keys.map((key, i) => ({
    key,
    label: otelSeriesLabel(stackBy, key),
    color:
      stackBy === 'structure' && STRUCTURE_COLORS[key]
        ? STRUCTURE_COLORS[key]
        : OTEL_SERIES_PALETTE[i % OTEL_SERIES_PALETTE.length],
    total: totals.get(key) ?? 0,
  }));
}

/** The next bucket start after `iso` for an interval (local calendar day for `1d`). */
function nextStart(iso: string, interval: OtelInterval): string {
  const d = new Date(iso);
  if (interval === '1d') {
    const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return n.toISOString();
  }
  const step = interval === '5m' ? 5 * 60_000 : 60 * 60_000;
  return new Date(d.getTime() + step).toISOString();
}

/** Cap of the gap filling, so a malformed interval never loops for long. */
const MAX_FILLED_ROWS = 2000;

/**
 * One row per bucket start, oldest first, with empty starts between the first and the last
 * filled in (so an idle hour shows as a gap, not as a squeezed axis). Values are absolute; the
 * cumulative value is the running total of the visible series.
 */
export function buildOtelChartRows(
  buckets: readonly OtelBucket[],
  metric: OtelMetric,
  interval: OtelInterval,
  visibleKeys?: ReadonlySet<string>,
): OtelChartRow[] {
  const byStart = new Map<string, Record<string, number>>();
  for (const b of buckets) {
    const start = new Date(b.start).toISOString();
    const row = byStart.get(start) ?? {};
    row[b.key] = (row[b.key] ?? 0) + otelBucketValue(b, metric);
    byStart.set(start, row);
  }
  const starts = [...byStart.keys()].sort();
  if (starts.length === 0) return [];
  const all: string[] = [];
  const last = starts[starts.length - 1];
  let idx = 0;
  for (let s = starts[0]; s <= last && all.length < MAX_FILLED_ROWS; ) {
    all.push(s);
    while (idx < starts.length && starts[idx] <= s) idx += 1;
    const n = nextStart(s, interval);
    // A DST day may land between two server starts; jump to the next real start then.
    const nextReal = idx < starts.length ? starts[idx] : undefined;
    s = nextReal !== undefined && nextReal < n ? nextReal : n;
  }
  let cumulative = 0;
  return all.map((start) => {
    const values = byStart.get(start) ?? {};
    let total = 0;
    for (const [k, v] of Object.entries(values)) {
      if (!visibleKeys || visibleKeys.has(k)) total += v;
    }
    cumulative += total;
    return { start, values, total, cumulative };
  });
}

/** A row's value of a series in the current view (absolute or share of the visible total). */
export function otelViewValue(
  row: OtelChartRow,
  key: string,
  view: 'absolute' | 'percent',
): number {
  const v = row.values[key] ?? 0;
  if (view === 'absolute') return v;
  return row.total > 0 ? (v / row.total) * 100 : 0;
}

/** Per-start sums for a KPI sparkline (all keys, or only `key`). */
export function otelSparkline(
  buckets: readonly OtelBucket[],
  pick: (b: OtelBucket) => number,
  key?: string,
): number[] {
  const byStart = new Map<string, number>();
  for (const b of buckets) {
    if (key !== undefined && b.key !== key) continue;
    const start = new Date(b.start).toISOString();
    byStart.set(start, (byStart.get(start) ?? 0) + pick(b));
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}

/** Per local day sums of a sparkline source (the "per day" tile). */
export function otelDailySparkline(
  buckets: readonly OtelBucket[],
  pick: (b: OtelBucket) => number,
): number[] {
  const byDay = new Map<string, number>();
  for (const b of buckets) {
    const d = new Date(b.start);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    byDay.set(day, (byDay.get(day) ?? 0) + pick(b));
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}
