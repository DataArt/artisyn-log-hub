/**
 * Budget formatting helpers and limits shared by the Spend tab, the Budgets settings section,
 * the bell tray / banner, the Budget burn view and the Budget report
 * (2026-11-05 budgets-threshold-alerts, DD-15 / DD-22).
 *
 * A pure module: no React imports.
 */
import type { BudgetForecast, BudgetNoticeLink } from '../../../models/budgets';
import { routes } from '../../hooks/useHashRoute';

/**
 * Client mirror of `server/src/logs/budgets/budget.constants.ts` (DD-22). The server enforces
 * the limits; the client uses them for form hints and paging.
 */
export const BUDGET_LIMITS = {
  defaultThresholds: [75, 90, 100] as readonly number[],
  maxThresholds: 10,
  thresholdMin: 1,
  thresholdMax: 200,
  maxAmountUsd: 1_000_000,
  amountDecimals: 2,
  minOffset: -400,
  eventsPage: { default: 50, max: 100 },
  noticesPage: { default: 20, max: 100 },
  sessionsLimit: 200,
  tzMaxLength: 64,
  /** Client only: most notices the global banner stacks. */
  bannerMax: 3,
} as const;

const HOUR_MS = 3_600_000;

/** `$41.20`, `$1,250.00` — a micro-dollar amount with two decimals. */
export function formatUsdMicros(micros: number): string {
  const usd = micros / 1e6;
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Colour band of a percent used (Visual notes): emerald < 75 %, amber 75–99 %, red ≥ 100 %. */
export type BudgetBand = 'emerald' | 'amber' | 'red';

export interface BudgetBandStyle {
  band: BudgetBand;
  /** Bar fill. */
  barClass: string;
  /** Percent text. */
  textClass: string;
  /** Pill / banner background, text and ring. */
  pillClass: string;
}

const BAND_STYLES: Record<BudgetBand, BudgetBandStyle> = {
  emerald: {
    band: 'emerald',
    barClass: 'bg-emerald-500',
    textClass: 'text-emerald-700',
    pillClass: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100',
  },
  amber: {
    band: 'amber',
    barClass: 'bg-amber-500',
    textClass: 'text-amber-700',
    pillClass: 'bg-amber-50 text-amber-700 ring-1 ring-amber-100',
  },
  red: {
    band: 'red',
    barClass: 'bg-red-500',
    textClass: 'text-red-700',
    pillClass: 'bg-red-50 text-red-700 ring-1 ring-red-100',
  },
};

/** The colour band of `percent` (percent of the budget amount, e.g. `82.4`). */
export function budgetBand(percent: number): BudgetBandStyle {
  if (percent >= 100) return BAND_STYLES.red;
  if (percent >= 75) return BAND_STYLES.amber;
  return BAND_STYLES.emerald;
}

/**
 * The "Runs out in" tile:
 * - `exceeded` when the spend reached the amount;
 * - `—` with no forecast, no burn rate or no amount;
 * - `~N days` for a week / month budget (and for a day budget more than a day away);
 * - `~HH:MM` (viewer's clock) for a day budget, counted from now (never before `periodStart`).
 */
export function formatUnitsLeft(
  forecast: BudgetForecast | null,
  periodStart: string,
  now: Date = new Date(),
): string {
  if (forecast === null) return '—';
  if (forecast.status === 'exceeded') return 'exceeded';
  if (forecast.status !== 'ok' || forecast.unitsLeft === null) return '—';
  const left = forecast.unitsLeft;
  if (forecast.unit === 'hour' && left < 24) {
    const startMs = Date.parse(periodStart);
    const base = Number.isNaN(startMs)
      ? now.getTime()
      : Math.max(now.getTime(), startMs);
    const at = new Date(base + left * HOUR_MS);
    const hhmm = at.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `~${hhmm}`;
  }
  const days = forecast.unit === 'hour' ? left / 24 : left;
  if (days < 1) return '<1 day';
  const n = Math.round(days);
  return `~${n} ${n === 1 ? 'day' : 'days'}`;
}

/** The viewer's IANA time zone (the default of a new budget and the `tz` of spend reads). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The router path (no `#`) a budget notice opens (DD-15): the repository Spend tab, the team
 * repository Spend tab, or the team Spend tab when there is no repository row. `null` for a
 * link with neither a repository nor a team.
 */
export function budgetNoticePath(link: BudgetNoticeLink): string | null {
  const q = new URLSearchParams();
  let base: string;
  if (link.repoId != null) {
    base =
      link.teamId != null
        ? routes.teamRepo(link.teamId, link.repoId)
        : routes.repo(link.repoId);
    q.set('mtab', 'spend');
  } else if (link.teamId != null) {
    base = routes.team(link.teamId);
    q.set('ttab', 'spend');
  } else {
    return null;
  }
  q.set('sp', link.period);
  q.set('so', String(link.offset));
  return `${base}?${q.toString()}`;
}

/** The hash URL (`#/repos/…`, `#/teams/…`) of a budget notice, or `null` (see `budgetNoticePath`). */
export function budgetNoticeHref(link: BudgetNoticeLink): string | null {
  const path = budgetNoticePath(link);
  return path === null ? null : `#${path}`;
}
