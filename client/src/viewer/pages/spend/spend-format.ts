/**
 * Labels of the Spend tab (2026-11-05 budgets-threshold-alerts, DD-22 `periodLabel`).
 * A pure module: no React imports.
 */
import type {
  BudgetPeriod,
  SpendSessionDto,
  SpendSliceKind,
} from '../../../models/budgets';
import { routes } from '../../hooks/useHashRoute';

export const SPEND_PERIOD_TITLES: Record<BudgetPeriod, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
};

export const SPEND_PERIOD_NOUNS: Record<BudgetPeriod, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

export const SPEND_SLICE_LABELS: Record<SpendSliceKind, string> = {
  model: 'Model',
  user: 'User',
  repo: 'Repository',
  branch: 'Branch',
  subagent: 'Sub-agent',
  skill: 'Skill',
  mcp: 'MCP server',
};

export const SPEND_SLICE_ORDER: readonly SpendSliceKind[] = [
  'model',
  'user',
  'repo',
  'branch',
  'subagent',
  'skill',
  'mcp',
];

/** Row key of the `Not reported` slice row (server `SLICE_NOT_REPORTED_KEY`). */
export const SLICE_NOT_REPORTED_KEY = '__not_reported__';

/** A time-zone-safe `Intl` formatter: falls back to the browser zone for an unknown name. */
function formatInZone(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return date.toLocaleDateString('en-GB', { ...options, timeZone });
  } catch {
    return date.toLocaleDateString('en-GB', options);
  }
}

/**
 * The period label in the period's time zone: `November 2026`, `9–15 Nov 2026`, `10 Nov 2026`.
 * `end` is exclusive.
 */
export function formatSpendPeriodLabel(
  period: BudgetPeriod,
  start: string,
  end: string,
  timeZone: string,
): string {
  const s = new Date(start);
  const last = new Date(Date.parse(end) - 1);
  if (Number.isNaN(s.getTime()) || Number.isNaN(last.getTime())) return '';
  if (period === 'month') {
    return formatInZone(s, timeZone, { month: 'long', year: 'numeric' });
  }
  if (period === 'day') {
    return formatInZone(s, timeZone, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  const sameMonth =
    formatInZone(s, timeZone, { month: 'short', year: 'numeric' }) ===
    formatInZone(last, timeZone, { month: 'short', year: 'numeric' });
  const from = formatInZone(
    s,
    timeZone,
    sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' },
  );
  const to = formatInZone(last, timeZone, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return `${from}–${to}`;
}

/** `1 Dec 2026` — the local date a period resets on (its exclusive end). */
export function formatResetDate(end: string, timeZone: string): string {
  const d = new Date(end);
  if (Number.isNaN(d.getTime())) return '';
  return formatInZone(d, timeZone, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** A daily bucket key: `YYYY-MM-DD` → `10 Nov`, an hourly `HH` → `14:00`. */
export function formatSpendBucketKey(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
  if (/^\d{1,2}$/.test(key)) return `${key.padStart(2, '0')}:00`;
  return key;
}

/** `82 %` — a whole percent. */
export function formatPercent(value: number): string {
  return `${Math.round(value)} %`;
}

/** The router path (no `#`) that opens a spend session in its repository view, or `null`. */
export function spendSessionPath(s: SpendSessionDto): string | null {
  if (s.repoId === null) return null;
  const base =
    s.teamId !== null
      ? routes.teamRepo(s.teamId, s.repoId)
      : routes.repo(s.repoId);
  return `${base}?${new URLSearchParams({ session: s.sessionId }).toString()}`;
}
