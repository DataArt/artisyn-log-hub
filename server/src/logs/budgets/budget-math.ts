/**
 * Pure budget math (2026-11-05 budgets-threshold-alerts, DD-7): forecast, anomaly days, costly
 * sessions and threshold-notice selection. Pinned by the `budget-spend-math` algorithm rows —
 * see `docs/knowledgebase/algorithms/budget-spend-math.md`. Money is integer micro-USD.
 */
import {
  BUDGET_ANOMALY_DAY_FACTOR,
  BUDGET_COSTLY_MIN_TREES,
} from './budget.constants';

/** Forecast of one budget period (the API `BudgetForecast` without `unit`). */
export interface BudgetForecastCore {
  burnRateMicrosPerUnit: number;
  forecastMicros: number;
  percentUsed: number | null;
  unitsLeft: number | null;
  status: 'ok' | 'exceeded' | 'no-rate';
  overspendRisk: boolean;
}

export interface BudgetForecastInput {
  spendMicros: number;
  amountMicros: number | null;
  /** Elapsed days (week / month) or hours (day), at least 1 in a current period. */
  elapsedUnits: number;
  totalUnits: number;
  isCurrent: boolean;
}

/**
 * Burn rate, end-of-period forecast, percent used, units left and overspend risk.
 *
 * - `burnRate = spend / elapsedUnits` (0 when `elapsedUnits <= 0`);
 * - `forecast = Math.round(spend + burnRate × (totalUnits − elapsedUnits))`, or `spend` for a
 *   past period;
 * - `percentUsed = spend × 100 / amount`, `null` without an amount;
 * - `status`: `exceeded` when `spend ≥ amount`, else `no-rate` when `burnRate = 0`, else `ok`;
 * - `unitsLeft = (amount − spend) / burnRate` only for `ok` in a current period with an amount;
 * - `overspendRisk = isCurrent && amount != null && forecast > amount`.
 */
export function computeBudgetForecast({
  spendMicros,
  amountMicros,
  elapsedUnits,
  totalUnits,
  isCurrent,
}: BudgetForecastInput): BudgetForecastCore {
  const burnRate = elapsedUnits > 0 ? spendMicros / elapsedUnits : 0;
  const forecastMicros = isCurrent
    ? Math.round(spendMicros + burnRate * (totalUnits - elapsedUnits))
    : spendMicros;
  const hasAmount = amountMicros != null;
  // `spend × 100 / amount` (not `spend / amount × 100`): one rounding, so 82.4 stays 82.4.
  const percentUsed = hasAmount ? (spendMicros * 100) / amountMicros : null;
  const status: BudgetForecastCore['status'] =
    hasAmount && spendMicros >= amountMicros
      ? 'exceeded'
      : burnRate === 0
        ? 'no-rate'
        : 'ok';
  const unitsLeft =
    isCurrent && hasAmount && status === 'ok'
      ? (amountMicros - spendMicros) / burnRate
      : null;
  return {
    burnRateMicrosPerUnit: burnRate,
    forecastMicros,
    percentUsed,
    unitsLeft,
    status,
    overspendRisk: isCurrent && hasAmount && forecastMicros > amountMicros,
  };
}

/**
 * Indices `i < elapsedUnits` of the elapsed buckets whose spend reaches
 * `BUDGET_ANOMALY_DAY_FACTOR ×` the average (`spend / elapsedUnits`). Compared as
 * `daily[i] × elapsedUnits ≥ factor × spend`, so integer micros stay exact. None when
 * `elapsedUnits ≤ 1` or the spend is 0.
 */
export function markAnomalyDays({
  dailyMicros,
  elapsedUnits,
  spendMicros,
}: {
  dailyMicros: number[];
  elapsedUnits: number;
  spendMicros: number;
}): number[] {
  if (elapsedUnits <= 1 || spendMicros <= 0) return [];
  const out: number[] = [];
  const limit = Math.min(elapsedUnits, dailyMicros.length);
  for (let i = 0; i < limit; i++) {
    if (
      dailyMicros[i] * elapsedUnits >=
      BUDGET_ANOMALY_DAY_FACTOR * spendMicros
    ) {
      out.push(i);
    }
  }
  return out;
}

export interface CostlyTree {
  id: number;
  micros: number;
  source: 'hook' | 'otel' | 'none';
}

export interface CostlySessionsResult {
  mean: number;
  sigma: number;
  marks: { id: number; level: 2 | 3 }[];
}

/**
 * Marks the period's unusually expensive trees. Only priced trees (`source ≠ 'none'`) count.
 * Population mean and σ; no marks when fewer than `BUDGET_COSTLY_MIN_TREES` trees (mean and σ
 * are then 0) or σ = 0. `level 3` when `micros ≥ mean + 3σ`, else `level 2` when
 * `micros ≥ mean + 2σ`. Marks keep the input order.
 */
export function markCostlySessions(trees: CostlyTree[]): CostlySessionsResult {
  const priced = trees.filter((t) => t.source !== 'none');
  const n = priced.length;
  if (n < BUDGET_COSTLY_MIN_TREES) return { mean: 0, sigma: 0, marks: [] };
  const mean = priced.reduce((s, t) => s + t.micros, 0) / n;
  const variance =
    priced.reduce((s, t) => s + (t.micros - mean) * (t.micros - mean), 0) / n;
  const sigma = Math.sqrt(variance);
  if (sigma === 0) return { mean, sigma, marks: [] };
  const marks: { id: number; level: 2 | 3 }[] = [];
  for (const t of priced) {
    if (t.micros >= mean + 3 * sigma) marks.push({ id: t.id, level: 3 });
    else if (t.micros >= mean + 2 * sigma) marks.push({ id: t.id, level: 2 });
  }
  return { mean, sigma, marks };
}

export interface ThresholdNoticeSelection {
  notify: number | null;
  superseded: { threshold: number; supersededBy: number }[];
}

/**
 * Which threshold crossing to notify about, and which ones to record as superseded.
 *
 * - `crossed = {t : spend × 100 ≥ t × amount}`, compared in BigInt (micros rounded first);
 * - `fresh = crossed \ existing` (`existing` = thresholds already recorded this period);
 * - `fresh` empty: nothing;
 * - `top = max(fresh)`, `maxExisting = max(existing, 0)`: when `top > maxExisting` notify `top`
 *   and supersede the other fresh ones by `top`; otherwise supersede every fresh one by
 *   `maxExisting`. `superseded` is sorted ascending by threshold.
 */
export function selectThresholdNotices({
  thresholds,
  spendMicros,
  amountMicros,
  existing,
}: {
  thresholds: number[];
  spendMicros: number;
  amountMicros: number;
  existing: number[];
}): ThresholdNoticeSelection {
  const spend100 = BigInt(Math.round(spendMicros)) * 100n;
  const amount = BigInt(Math.round(amountMicros));
  const have = new Set(existing);
  const fresh = [...new Set(thresholds)]
    .filter((t) => spend100 >= BigInt(t) * amount && !have.has(t))
    .sort((a, b) => a - b);
  if (fresh.length === 0) return { notify: null, superseded: [] };
  const top = fresh[fresh.length - 1];
  const maxExisting = Math.max(0, ...existing);
  if (top > maxExisting) {
    return {
      notify: top,
      superseded: fresh
        .filter((t) => t !== top)
        .map((t) => ({ threshold: t, supersededBy: top })),
    };
  }
  return {
    notify: null,
    superseded: fresh.map((t) => ({ threshold: t, supersededBy: maxExisting })),
  };
}
