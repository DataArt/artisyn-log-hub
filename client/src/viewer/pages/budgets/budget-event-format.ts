/**
 * Labels and detail lines of the Budget event log (2026-11-05 budgets-threshold-alerts,
 * DD-11). A pure module: no React imports.
 */
import type { BudgetEventType, BudgetPeriod } from '../../../models/budgets';
import { formatUsdMicros } from './budget-format';

export const BUDGET_EVENT_LABELS: Record<BudgetEventType, string> = {
  created: 'Created',
  edited: 'Edited',
  deleted: 'Deleted',
  threshold_crossed: 'Threshold crossed',
  threshold_superseded: 'Threshold superseded',
  email_sent: 'Email sent',
  email_skipped: 'Email skipped',
  email_failed: 'Email failed',
};

export const BUDGET_EVENT_TYPES = Object.keys(
  BUDGET_EVENT_LABELS,
) as BudgetEventType[];

export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

/** The label of an event type; an unknown (newer server) type is shown as is. */
export function budgetEventLabel(eventType: string): string {
  return (
    (BUDGET_EVENT_LABELS as Record<string, string>)[eventType] ?? eventType
  );
}

interface Snapshot {
  period?: unknown;
  amountMicros?: unknown;
  thresholds?: unknown;
  timeZone?: unknown;
}

function asSnapshot(value: unknown): Snapshot | null {
  return typeof value === 'object' && value !== null ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function thresholdsText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const nums = value.filter((v): v is number => typeof v === 'number');
  return nums.length > 0 ? `${nums.join(' · ')} %` : null;
}

function snapshotText(s: Snapshot): string {
  const parts: string[] = [];
  const period = str(s.period);
  if (period) parts.push(period);
  const amount = num(s.amountMicros);
  if (amount !== null) parts.push(formatUsdMicros(amount));
  const th = thresholdsText(s.thresholds);
  if (th) parts.push(`at ${th}`);
  const tz = str(s.timeZone);
  if (tz) parts.push(tz);
  return parts.join(' · ');
}

/** `amount $80.00 → $100.00; thresholds …` — only the fields that changed. */
function editedText(before: Snapshot, after: Snapshot): string {
  const changes: string[] = [];
  const pair = (label: string, a: string | null, b: string | null) => {
    if (a !== b) changes.push(`${label} ${a ?? '—'} → ${b ?? '—'}`);
  };
  pair('period', str(before.period), str(after.period));
  const am = (v: unknown) => {
    const n = num(v);
    return n === null ? null : formatUsdMicros(n);
  };
  pair('amount', am(before.amountMicros), am(after.amountMicros));
  pair(
    'thresholds',
    thresholdsText(before.thresholds),
    thresholdsText(after.thresholds),
  );
  pair('time zone', str(before.timeZone), str(after.timeZone));
  return changes.length > 0 ? changes.join('; ') : 'no changes';
}

/** The DETAILS column of one event (DD-11 `details` shapes). */
export function budgetEventDetails(
  eventType: string,
  details: Record<string, unknown>,
): string {
  switch (eventType) {
    case 'created': {
      const after = asSnapshot(details.after);
      return after ? snapshotText(after) : '';
    }
    case 'deleted': {
      const before = asSnapshot(details.before);
      return before ? snapshotText(before) : '';
    }
    case 'edited': {
      const before = asSnapshot(details.before);
      const after = asSnapshot(details.after);
      return before && after ? editedText(before, after) : '';
    }
    case 'threshold_crossed':
    case 'threshold_superseded': {
      const threshold = num(details.threshold);
      const spend = num(details.spendMicros);
      const by = num(details.supersededBy);
      const parts: string[] = [];
      if (threshold !== null) parts.push(`${threshold} %`);
      if (spend !== null) parts.push(`spend ${formatUsdMicros(spend)}`);
      if (by !== null) parts.push(`superseded by ${by} %`);
      return parts.join(' · ');
    }
    case 'email_sent': {
      const to = str(details.recipientEmail);
      return to ? `→ ${to}` : '';
    }
    case 'email_failed': {
      const to = str(details.recipientEmail);
      const error = str(details.error);
      return [to ? `→ ${to}` : null, error].filter(Boolean).join(' · ');
    }
    case 'email_skipped':
      return 'mail not configured';
    default:
      return '';
  }
}
