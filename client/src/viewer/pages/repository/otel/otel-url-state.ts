/**
 * URL state of the repository OTEL tab (2026-10-30 otel-tabs-traces). Every filter and chart
 * control lives in an `otel*` search param so a view can be linked and survives a reload;
 * `setMainTab` drops all of them (`OTEL_PARAM_KEYS`) when the user leaves the tab.
 *
 * | Param | Meaning | Absent means |
 * |---|---|---|
 * | `otelPeriod` | `24h` / `7d` / `30d` / `90d`, or a custom `YYYY-MM-DD..YYYY-MM-DD` | `7d` |
 * | `otelModel`, `otelCcVersion` | model / Claude Code version filter, repeatable | all |
 * | `otelCalls` | `hidden` / `transcript` | `all` |
 * | `otelMetric` | `calls` / `tokens` (applied on the client) | `cost` |
 * | `otelInterval` | `5m` / `1h` / `1d` | `auto` |
 * | `otelStackBy` | `querySource` / `model` / `ccVersion` | `structure` |
 * | `otelView` | `percent` (100 % stacked) | `absolute` |
 * | `otelCumulative` | `1` — cumulative line on the right axis | off |
 *
 * Defaults are left out of the URL, so an untouched tab adds no params.
 */
import type {
  OtelCallsFilter,
  OtelInterval,
  RepoOtelStackBy,
} from '../../../../models/repositories';

export type OtelPeriodPreset = '24h' | '7d' | '30d' | '90d';
export type OtelMetric = 'cost' | 'calls' | 'tokens';
export type OtelChartView = 'absolute' | 'percent';

/** A preset ending now, or a custom range of whole local days (both ends inclusive). */
export type OtelPeriod =
  | { kind: 'preset'; preset: OtelPeriodPreset }
  | { kind: 'custom'; startDate: string; endDate: string };

export interface RepoOtelUrlState {
  period: OtelPeriod;
  models: string[];
  ccVersions: string[];
  calls: OtelCallsFilter;
  metric: OtelMetric;
  interval: 'auto' | OtelInterval;
  stackBy: RepoOtelStackBy;
  view: OtelChartView;
  cumulative: boolean;
}

/** Every param the tab owns; `setMainTab` deletes these when leaving the tab. */
export const OTEL_PARAM_KEYS = [
  'otelPeriod',
  'otelModel',
  'otelCcVersion',
  'otelCalls',
  'otelMetric',
  'otelInterval',
  'otelStackBy',
  'otelView',
  'otelCumulative',
] as const;

export const OTEL_PERIOD_PRESETS: readonly OtelPeriodPreset[] = [
  '24h',
  '7d',
  '30d',
  '90d',
];

export const OTEL_DEFAULT_PERIOD: OtelPeriod = { kind: 'preset', preset: '7d' };

/** The longest period the facts route accepts (server `OTEL_MAX_PERIOD_DAYS`). */
export const OTEL_MAX_PERIOD_DAYS = 93;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const PRESET_MS: Record<OtelPeriodPreset, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
  '90d': 90 * DAY_MS,
};

const CALLS_VALUES: readonly OtelCallsFilter[] = [
  'all',
  'hidden',
  'transcript',
];
const METRIC_VALUES: readonly OtelMetric[] = ['cost', 'calls', 'tokens'];
const INTERVAL_VALUES: readonly ('auto' | OtelInterval)[] = [
  'auto',
  '5m',
  '1h',
  '1d',
];
const STACK_BY_VALUES: readonly RepoOtelStackBy[] = [
  'structure',
  'querySource',
  'model',
  'ccVersion',
];

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return raw !== null && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/** Parses an `otelPeriod` value; anything unreadable gives the default. */
export function parseOtelPeriod(raw: string | null): OtelPeriod {
  if (raw === null) return OTEL_DEFAULT_PERIOD;
  if ((OTEL_PERIOD_PRESETS as readonly string[]).includes(raw)) {
    return { kind: 'preset', preset: raw as OtelPeriodPreset };
  }
  const [startDate, endDate, ...rest] = raw.split('..');
  if (
    rest.length === 0 &&
    startDate !== undefined &&
    endDate !== undefined &&
    DATE_ONLY_RE.test(startDate) &&
    DATE_ONLY_RE.test(endDate) &&
    startDate <= endDate
  ) {
    return { kind: 'custom', startDate, endDate };
  }
  return OTEL_DEFAULT_PERIOD;
}

export function formatOtelPeriod(period: OtelPeriod): string {
  return period.kind === 'preset'
    ? period.preset
    : `${period.startDate}..${period.endDate}`;
}

/** Local midnight of a `YYYY-MM-DD` date. */
function localMidnight(dateOnly: string): Date {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The `[from, to)` bounds the facts route gets for a period. A preset ends at `now`; a custom
 * range runs from the start day's local midnight to the midnight after its end day. The range is
 * clipped to the route's longest period, keeping its end.
 */
export function otelPeriodRange(
  period: OtelPeriod,
  now: Date = new Date(),
): { from: Date; to: Date } {
  let from: Date;
  let to: Date;
  if (period.kind === 'preset') {
    to = now;
    from = new Date(now.getTime() - PRESET_MS[period.preset]);
  } else {
    from = localMidnight(period.startDate);
    const end = localMidnight(period.endDate);
    to = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  }
  const maxMs = OTEL_MAX_PERIOD_DAYS * DAY_MS;
  if (to.getTime() - from.getTime() > maxMs) {
    from = new Date(to.getTime() - maxMs);
  }
  return { from, to };
}

/** The repository / team tabs poll only while their period includes now (DD-20). */
export function otelPeriodIncludesNow(
  period: OtelPeriod,
  now: Date = new Date(),
): boolean {
  return otelPeriodRange(period, now).to.getTime() >= now.getTime();
}

export function otelStateFromParams(p: URLSearchParams): RepoOtelUrlState {
  return {
    period: parseOtelPeriod(p.get('otelPeriod')),
    models: p.getAll('otelModel').filter(Boolean),
    ccVersions: p.getAll('otelCcVersion').filter(Boolean),
    calls: oneOf(p.get('otelCalls'), CALLS_VALUES, 'all'),
    metric: oneOf(p.get('otelMetric'), METRIC_VALUES, 'cost'),
    interval: oneOf(p.get('otelInterval'), INTERVAL_VALUES, 'auto'),
    stackBy: oneOf(p.get('otelStackBy'), STACK_BY_VALUES, 'structure'),
    view: p.get('otelView') === 'percent' ? 'percent' : 'absolute',
    cumulative: p.get('otelCumulative') === '1',
  };
}

/** A copy of `p` with every `otel*` param rewritten from `s` (defaults are left out). */
export function writeOtelState(
  p: URLSearchParams,
  s: RepoOtelUrlState,
): URLSearchParams {
  const next = new URLSearchParams(p);
  for (const key of OTEL_PARAM_KEYS) next.delete(key);
  const period = formatOtelPeriod(s.period);
  if (period !== formatOtelPeriod(OTEL_DEFAULT_PERIOD)) {
    next.set('otelPeriod', period);
  }
  for (const m of s.models) next.append('otelModel', m);
  for (const v of s.ccVersions) next.append('otelCcVersion', v);
  if (s.calls !== 'all') next.set('otelCalls', s.calls);
  if (s.metric !== 'cost') next.set('otelMetric', s.metric);
  if (s.interval !== 'auto') next.set('otelInterval', s.interval);
  if (s.stackBy !== 'structure') next.set('otelStackBy', s.stackBy);
  if (s.view === 'percent') next.set('otelView', 'percent');
  if (s.cumulative) next.set('otelCumulative', '1');
  return next;
}
