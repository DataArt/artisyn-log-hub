/**
 * Budget constants (2026-11-05 budgets-threshold-alerts, DD-22). The client mirrors the limits
 * as `BUDGET_LIMITS` in `budget-format.ts`.
 */

/** Thresholds (percent of the amount) a new budget gets when none are given. */
export const BUDGET_DEFAULT_THRESHOLDS: readonly number[] = [75, 90, 100];

/** Most thresholds one budget may carry. */
export const BUDGET_MAX_THRESHOLDS = 10;

/** Smallest threshold percent. */
export const BUDGET_THRESHOLD_MIN = 1;

/** Largest threshold percent. */
export const BUDGET_THRESHOLD_MAX = 200;

/** Largest budget amount in USD. */
export const BUDGET_MAX_AMOUNT_USD = 1_000_000;

/** Most decimals a budget amount in USD may have. */
export const BUDGET_AMOUNT_DECIMALS = 2;

/** Oldest period offset the ‹ › picker may reach (`offset` is clamped to `[-400, 0]`). */
export const BUDGET_MIN_OFFSET = -400;

/** Event-log page size: default and maximum. */
export const BUDGET_EVENTS_PAGE = { default: 50, max: 100 } as const;

/** Notice-tray page size: default and maximum. */
export const BUDGET_NOTICES_PAGE = { default: 20, max: 100 } as const;

/** A day's spend is an anomaly when it reaches this multiple of the period's daily average. */
export const BUDGET_ANOMALY_DAY_FACTOR = 2;

/** Fewest priced trees in a period before costly sessions are marked (2σ / 3σ). */
export const BUDGET_COSTLY_MIN_TREES = 5;

/** Default threshold-job interval (`BUDGET_CHECK_INTERVAL_MS`). */
export const BUDGET_CHECK_DEFAULT_INTERVAL_MS = 300_000;

/** Most root sessions `spend/sessions` returns; beyond it the response says `truncated`. */
export const BUDGET_SESSIONS_LIMIT = 200;

/** Longest accepted IANA time-zone name (the `time_zone` column is varchar(64)). */
export const BUDGET_TZ_MAX_LENGTH = 64;

/** Subject line of a budget notice email. */
export function budgetMailSubject(
  threshold: number,
  budgetLabel: string,
  scopeLabel: string,
): string {
  return `Log Hub budget: ${threshold} % of ${budgetLabel} reached (${scopeLabel})`;
}
