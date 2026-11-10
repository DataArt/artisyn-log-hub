/**
 * Chart rows of the Analytics › Budget burn view (2026-11-05 budgets-threshold-alerts, DD-19).
 * A pure module: no React imports.
 *
 * The server returns the cumulative points only up to the elapsed bucket; the x axis must span
 * the whole budget period, so the remaining bucket keys are synthesized here in the budget's
 * time zone (`YYYY-MM-DD` per day, `HH` per hour for a day budget — the server key formats).
 */
import type { BudgetBurnView } from '../../../../models/budgets';

export interface BudgetBurnRow {
  key: string;
  /** USD; `null` past the elapsed bucket. */
  cumulative: number | null;
  /** The previous period's cumulative USD at the same bucket index. */
  previous: number | null;
  /** The dashed forecast from the last elapsed bucket to the period end, USD. */
  forecast: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function partsInZone(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatPart[] {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      ...options,
      timeZone,
    }).formatToParts(date);
  } catch {
    return new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
  }
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** Every bucket key of `[start, end)`: local dates, or local hours when `hourly`. */
export function periodBucketKeys(
  start: string,
  end: string,
  hourly: boolean,
  timeZone: string,
): string[] {
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return [];
  const unit = hourly ? HOUR_MS : DAY_MS;
  const n = Math.round((e - s) / unit);
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    if (hourly) {
      const p = partsInZone(new Date(s + i * HOUR_MS), timeZone, {
        hour: '2-digit',
        hourCycle: 'h23',
      });
      keys.push(part(p, 'hour').padStart(2, '0'));
    } else {
      // Mid-day sample: a 23 / 25-hour DST day still lands on the right local date.
      const p = partsInZone(new Date(s + i * DAY_MS + 12 * HOUR_MS), timeZone, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      keys.push(`${part(p, 'year')}-${part(p, 'month')}-${part(p, 'day')}`);
    }
  }
  return keys;
}

/** Rows over the whole period: the elapsed cumulative line, the previous period, the forecast. */
export function buildBudgetBurnRows(
  view: BudgetBurnView,
  timeZone: string,
): BudgetBurnRow[] {
  const hourly = view.budget?.period === 'day';
  const synthesized = periodBucketKeys(
    view.periodStart,
    view.periodEnd,
    hourly,
    timeZone,
  );
  const n = Math.max(synthesized.length, view.points.length);
  const last = view.points.length - 1;
  const canForecast = view.forecastMicros !== null && last >= 0 && last < n - 1;
  const rows: BudgetBurnRow[] = [];
  for (let i = 0; i < n; i++) {
    const point = view.points[i];
    const prev = view.previousCumulative[i];
    let forecast: number | null = null;
    if (canForecast && view.forecastMicros !== null && i >= last) {
      const from = view.spendMicros;
      const t = (i - last) / (n - 1 - last);
      forecast = (from + (view.forecastMicros - from) * t) / 1e6;
    }
    rows.push({
      key: point?.key ?? synthesized[i] ?? String(i + 1),
      cumulative: point ? point.cumulativeMicros / 1e6 : null,
      previous: prev ? prev.cumulativeMicros / 1e6 : null,
      forecast,
    });
  }
  return rows;
}
