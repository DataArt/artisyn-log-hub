/**
 * Query-param parsing shared by the budget / spend routes (2026-11-05 budgets-threshold-alerts).
 * Only shape checks live here (400s); range clamping and time-zone validation stay in the
 * services, so every caller of a service gets the same rules.
 */
import { BadRequestException } from '@nestjs/common';
import { isBudgetPeriod } from './budget-scope';
import type { BudgetPeriod, SpendSessionsSlice } from './budgets.types';

const SPEND_SESSIONS_SLICES: readonly SpendSessionsSlice[] = [
  'model',
  'user',
  'repo',
  'branch',
  'subagent',
  'skill',
  'mcp',
  'day',
  'costly',
];

/** 400 for a `teamId` query param that is present but not a positive integer. */
export function assertPositiveTeamId(teamId: number | undefined): void {
  if (teamId !== undefined && teamId <= 0) {
    throw new BadRequestException('teamId must be a positive integer');
  }
}

/** The Spend period params: `period` (default `month`), `offset` (default 0, ≤ 0) and `tz`. */
export function parseSpendPeriodQuery(raw: {
  period?: string;
  offset?: string;
  tz?: string;
}): { period: BudgetPeriod; offset: number; tz: string } {
  const period =
    raw.period === undefined || raw.period === '' ? 'month' : raw.period;
  if (!isBudgetPeriod(period)) {
    throw new BadRequestException('period must be one of day, week, month');
  }
  let offset = 0;
  if (raw.offset !== undefined && raw.offset !== '') {
    if (!/^-?\d+$/.test(raw.offset)) {
      throw new BadRequestException('offset must be an integer ≤ 0');
    }
    offset = Number(raw.offset);
  }
  return { period, offset, tz: raw.tz ?? '' };
}

/** The `spend/sessions` `slice` param. */
export function parseSpendSessionsSlice(
  slice: string | undefined,
): SpendSessionsSlice {
  const found = SPEND_SESSIONS_SLICES.find((s) => s === slice);
  if (!found) {
    throw new BadRequestException(
      `slice must be one of ${SPEND_SESSIONS_SLICES.join(', ')}`,
    );
  }
  return found;
}

/** A required ISO 8601 date param (`startDate` / `endDate`), as the other `reports/*` routes. */
export function parseRequiredDate(
  name: string,
  value: string | undefined,
): Date {
  if (!value) throw new BadRequestException(`${name} is required`);
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new BadRequestException(`${name} must be a valid ISO 8601 date`);
  }
  return date;
}
