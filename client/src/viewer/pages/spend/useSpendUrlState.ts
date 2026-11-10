import { useSearchParams } from 'react-router-dom';
import type { BudgetPeriod } from '../../../models/budgets';
import { BUDGET_LIMITS } from '../budgets/budget-format';

/** Spend tab period when `sp` is absent or unknown (DD-15). */
export const DEFAULT_SPEND_PERIOD: BudgetPeriod = 'month';

const PERIODS: readonly BudgetPeriod[] = ['day', 'week', 'month'];

/** Parses `sp` into a period; `month` for a missing or unknown value. */
export function parseSpendPeriod(value: string | null): BudgetPeriod {
  return PERIODS.find((p) => p === value) ?? DEFAULT_SPEND_PERIOD;
}

/** Parses `so` into an offset clamped to `[BUDGET_LIMITS.minOffset, 0]`; 0 when not an integer. */
export function parseSpendOffset(value: string | null): number {
  if (value === null || !/^-?\d+$/.test(value)) return 0;
  const n = Number(value);
  return Math.min(0, Math.max(BUDGET_LIMITS.minOffset, n));
}

/**
 * URL-backed Spend tab state (DD-15): the period (`sp`, default `month`) and the period offset
 * (`so`, ≤ 0, default 0). Writes replace the history entry; defaults are dropped from the URL.
 * Changing the period resets the offset to the current period.
 */
export function useSpendUrlState() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = parseSpendPeriod(searchParams.get('sp'));
  const offset = parseSpendOffset(searchParams.get('so'));

  function write(nextPeriod: BudgetPeriod, nextOffset: number) {
    const next = new URLSearchParams(searchParams);
    if (nextPeriod === DEFAULT_SPEND_PERIOD) next.delete('sp');
    else next.set('sp', nextPeriod);
    const clamped = Math.min(0, Math.max(BUDGET_LIMITS.minOffset, nextOffset));
    if (clamped === 0) next.delete('so');
    else next.set('so', String(clamped));
    setSearchParams(next, { replace: true });
  }

  function setPeriod(next: BudgetPeriod) {
    write(next, 0);
  }

  function setOffset(next: number) {
    write(period, next);
  }

  return { period, offset, setPeriod, setOffset };
}
