/**
 * Client-side validation of the budget form, mirroring the server rules (DD-12). The server
 * stays the authority (400 / 409); this only gives inline hints before the request.
 * A pure module: no React imports.
 */
import type {
  BudgetInput,
  BudgetPeriod,
  BudgetScopeKind,
} from '../../../models/budgets';
import { BUDGET_LIMITS } from './budget-format';

export interface BudgetFormValues {
  period: BudgetPeriod;
  amount: string;
  timeZone: string;
  thresholds: number[];
}

export interface BudgetFormErrors {
  amount?: string;
  timeZone?: string;
  thresholds?: string;
}

const AMOUNT_RE = new RegExp(
  `^\\d+(\\.\\d{1,${BUDGET_LIMITS.amountDecimals}})?$`,
);

/** True when `tz` is an IANA zone the browser knows. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A threshold the "+ Add" box accepts: an integer 1–200. */
export function isValidThreshold(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= BUDGET_LIMITS.thresholdMin &&
    value <= BUDGET_LIMITS.thresholdMax
  );
}

/** The input to send, or the field errors. */
export function validateBudgetForm(
  v: BudgetFormValues,
):
  | { input: BudgetInput; errors: null }
  | { input: null; errors: BudgetFormErrors } {
  const errors: BudgetFormErrors = {};
  const amountText = v.amount.trim();
  const amountUsd = Number(amountText);
  if (!AMOUNT_RE.test(amountText) || !(amountUsd > 0)) {
    errors.amount = `Enter an amount greater than 0 with at most ${BUDGET_LIMITS.amountDecimals} decimals.`;
  } else if (amountUsd > BUDGET_LIMITS.maxAmountUsd) {
    errors.amount = `The amount can be at most $${BUDGET_LIMITS.maxAmountUsd.toLocaleString('en-US')}.`;
  }
  const tz = v.timeZone.trim();
  if (
    tz === '' ||
    tz.length > BUDGET_LIMITS.tzMaxLength ||
    !isKnownTimeZone(tz)
  ) {
    errors.timeZone = 'Choose a valid time zone.';
  }
  const thresholds = [...new Set(v.thresholds)].sort((a, b) => a - b);
  if (
    thresholds.length < 1 ||
    thresholds.length > BUDGET_LIMITS.maxThresholds ||
    !thresholds.every(isValidThreshold)
  ) {
    errors.thresholds = `Set 1–${BUDGET_LIMITS.maxThresholds} whole-number thresholds between ${BUDGET_LIMITS.thresholdMin} and ${BUDGET_LIMITS.thresholdMax}.`;
  }
  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    input: { period: v.period, amountUsd, thresholds, timeZone: tz },
    errors: null,
  };
}

/** The read-only scope text of the form. */
export function budgetScopeText(kind: BudgetScopeKind): string {
  if (kind === 'repo') return 'Personal repository';
  if (kind === 'team-repo') return 'Team repository';
  return 'Team';
}

/** Who gets the threshold notices (DD-10). */
export function budgetRecipientsText(kind: BudgetScopeKind): string {
  const who =
    kind === 'repo' ? 'the repository owner' : 'the team owner and managers';
  return `Recipients: ${who} — in-app (bell tray and banner), and email when the mail service is configured.`;
}

/** The amount box text of a budget (`80.00`). */
export function amountInputText(amountMicros: number): string {
  return (amountMicros / 1e6).toFixed(BUDGET_LIMITS.amountDecimals);
}

/** Every IANA zone the browser lists, for the time-zone combobox. */
export function timeZoneOptions(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
}
