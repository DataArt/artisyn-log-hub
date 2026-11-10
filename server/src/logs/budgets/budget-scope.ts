/**
 * Budget scope vocabulary (2026-11-05 budgets-threshold-alerts, DD-1 / DD-2 / DD-12 / DD-22):
 * the scope union, the resolved access of a caller, labels and the input validator. Pure — no DB.
 */
import { BadRequestException } from '@nestjs/common';
import { isValidOtelTimeZone } from '../otel/otel-classify';
import type { TeamScope } from '../team-scope';
import {
  BUDGET_AMOUNT_DECIMALS,
  BUDGET_DEFAULT_THRESHOLDS,
  BUDGET_MAX_AMOUNT_USD,
  BUDGET_MAX_THRESHOLDS,
  BUDGET_THRESHOLD_MAX,
  BUDGET_THRESHOLD_MIN,
  BUDGET_TZ_MAX_LENGTH,
} from './budget.constants';
import type {
  BudgetDto,
  BudgetInput,
  BudgetPeriod,
  BudgetRow,
  BudgetSnapshot,
  PeriodBounds,
} from './budgets.types';

/** A budget's scope (DD-1). */
export type BudgetScope =
  | { kind: 'repo'; userId: number; repoUrl: string }
  | { kind: 'team-repo'; teamId: number; repoUrl: string }
  | { kind: 'team'; teamId: number };

/** What a caller may do with a scope (DD-2), resolved by `BudgetAccessService`. */
export interface ScopeAccess {
  scope: BudgetScope;
  /** May create / edit / delete budgets of the scope. */
  canManage: boolean;
  /** Sees the whole scope's spend; `false` = the DD-9 restricted (own-spend) view. */
  fullView: boolean;
  /** The caller's team scope, used to mask other members' prompts. */
  teamScope: TeamScope;
}

export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['day', 'week', 'month'];

export function isBudgetPeriod(value: unknown): value is BudgetPeriod {
  return (
    typeof value === 'string' &&
    (BUDGET_PERIODS as readonly string[]).includes(value)
  );
}

/** The scope a stored budget row belongs to. */
export function scopeOfBudget(row: BudgetRow): BudgetScope {
  if (row.scopeKind === 'repo' && row.userId != null && row.repoUrl != null) {
    return { kind: 'repo', userId: row.userId, repoUrl: row.repoUrl };
  }
  if (
    row.scopeKind === 'team-repo' &&
    row.teamId != null &&
    row.repoUrl != null
  ) {
    return { kind: 'team-repo', teamId: row.teamId, repoUrl: row.repoUrl };
  }
  if (row.scopeKind === 'team' && row.teamId != null) {
    return { kind: 'team', teamId: row.teamId };
  }
  // The `budgets_scope_shape` CHECK makes this unreachable.
  throw new Error(`Budget ${row.id} has an invalid scope shape`);
}

/** The scope columns (`scope_kind`, `user_id`, `team_id`, `repo_url`) of a scope. */
export function scopeColumns(scope: BudgetScope): {
  scopeKind: BudgetScope['kind'];
  userId: number | null;
  teamId: number | null;
  repoUrl: string | null;
} {
  switch (scope.kind) {
    case 'repo':
      return {
        scopeKind: 'repo',
        userId: scope.userId,
        teamId: null,
        repoUrl: scope.repoUrl,
      };
    case 'team-repo':
      return {
        scopeKind: 'team-repo',
        userId: null,
        teamId: scope.teamId,
        repoUrl: scope.repoUrl,
      };
    case 'team':
      return {
        scopeKind: 'team',
        userId: null,
        teamId: scope.teamId,
        repoUrl: null,
      };
  }
}

const PERIOD_WORD: Record<BudgetPeriod, string> = {
  day: 'Daily',
  week: 'Weekly',
  month: 'Monthly',
};

/** `$1,234.50` — US dollars from integer micro-USD, two decimals. */
export function formatUsdMicros(micros: number): string {
  return `$${(micros / 1e6).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** `Monthly $50.00` — the `budget_label` snapshot of a budget. */
export function budgetLabel(
  period: BudgetPeriod,
  amountMicros: number,
): string {
  return `${PERIOD_WORD[period]} ${formatUsdMicros(amountMicros)}`;
}

/**
 * The display name of a repository URL: `owner/name` for a git URL (`https://host/owner/name.git`,
 * `git@host:owner/name.git`), otherwise its last path segment.
 */
export function repoSegment(repoUrl: string): string {
  const trimmed = repoUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const isGit =
    /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ||
    /^[^/\s]+@[^/\s]+:/.test(trimmed);
  const parts = trimmed.split(/[/\\:]/).filter((p) => p !== '');
  if (parts.length === 0) return repoUrl;
  if (isGit && parts.length >= 3) return parts.slice(-2).join('/');
  return parts[parts.length - 1];
}

/**
 * `repo` → the repository segment; `team-repo` → `<team name> / <repo segment>`;
 * `team` → `<team name>` (DD-22). A missing team name falls back to `Team <id>`.
 */
export function scopeLabel(
  scope: BudgetScope,
  teamName?: string | null,
): string {
  switch (scope.kind) {
    case 'repo':
      return repoSegment(scope.repoUrl);
    case 'team-repo':
      return `${teamName ?? `Team ${scope.teamId}`} / ${repoSegment(scope.repoUrl)}`;
    case 'team':
      return teamName ?? `Team ${scope.teamId}`;
  }
}

function localParts(
  date: Date,
  timeZone: string,
): { day: number; month: string; monthLong: string; year: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).formatToParts(date);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const monthLong = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    month: 'long',
  }).format(date);
  return {
    day: Number(get('day')),
    month: get('month'),
    monthLong,
    year: Number(get('year')),
  };
}

/**
 * A period in local dates of its time zone (DD-22): month → `November 2026`, week →
 * `9–15 Nov 2026` (or `30 Nov – 6 Dec 2026` across months), day → `10 Nov 2026`.
 */
export function periodLabel(
  bounds: Pick<PeriodBounds, 'start' | 'end' | 'period' | 'timeZone'>,
): string {
  const first = localParts(bounds.start, bounds.timeZone);
  if (bounds.period === 'month') return `${first.monthLong} ${first.year}`;
  if (bounds.period === 'day') {
    return `${first.day} ${first.month} ${first.year}`;
  }
  // `end` is exclusive: the last day is the one just before it.
  const last = localParts(new Date(bounds.end.getTime() - 1), bounds.timeZone);
  if (first.year !== last.year) {
    return `${first.day} ${first.month} ${first.year} – ${last.day} ${last.month} ${last.year}`;
  }
  if (first.month !== last.month) {
    return `${first.day} ${first.month} – ${last.day} ${last.month} ${last.year}`;
  }
  return `${first.day}–${last.day} ${last.month} ${last.year}`;
}

/** The `edited`-event snapshot of a budget row (DD-11). */
export function budgetSnapshot(row: BudgetRow): BudgetSnapshot {
  return {
    period: row.period,
    amountMicros: row.amountMicros,
    thresholds: [...row.thresholds],
    timeZone: row.timeZone,
  };
}

/**
 * A budget row as the API returns it. `current` is the budget's current period (offset 0 in its
 * own time zone); without it `currentPeriod` carries empty strings.
 */
export function budgetRowToDto(
  row: BudgetRow,
  current?: Pick<PeriodBounds, 'start' | 'end'>,
): BudgetDto {
  return {
    id: row.id,
    scopeKind: row.scopeKind,
    period: row.period,
    amountMicros: row.amountMicros,
    thresholds: [...row.thresholds],
    timeZone: row.timeZone,
    label: budgetLabel(row.period, row.amountMicros),
    currentPeriod: {
      start: current ? current.start.toISOString() : '',
      end: current ? current.end.toISOString() : '',
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a create / update body (DD-12) and returns it normalised: thresholds distinct and
 * sorted ascending, `[75, 90, 100]` when omitted. Throws `BadRequestException` (400) on any
 * invalid field. The duplicate-period 409 is the service's job (unique index).
 */
export function validateBudgetInput(body: unknown): BudgetInput {
  if (!isRecord(body)) throw new BadRequestException('Body must be an object');

  const { period, amountUsd, thresholds, timeZone } = body;
  if (!isBudgetPeriod(period)) {
    throw new BadRequestException('period must be one of day, week, month');
  }

  if (
    typeof amountUsd !== 'number' ||
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0 ||
    amountUsd > BUDGET_MAX_AMOUNT_USD
  ) {
    throw new BadRequestException(
      `amountUsd must be a number greater than 0 and at most ${BUDGET_MAX_AMOUNT_USD}`,
    );
  }
  const scale = 10 ** BUDGET_AMOUNT_DECIMALS;
  if (Math.abs(amountUsd * scale - Math.round(amountUsd * scale)) > 1e-6) {
    throw new BadRequestException(
      `amountUsd may have at most ${BUDGET_AMOUNT_DECIMALS} decimals`,
    );
  }

  let list: number[];
  if (thresholds === undefined || thresholds === null) {
    list = [...BUDGET_DEFAULT_THRESHOLDS];
  } else {
    if (
      !Array.isArray(thresholds) ||
      thresholds.length < 1 ||
      thresholds.length > BUDGET_MAX_THRESHOLDS
    ) {
      throw new BadRequestException(
        `thresholds must be 1–${BUDGET_MAX_THRESHOLDS} integers`,
      );
    }
    list = [];
    for (const t of thresholds as unknown[]) {
      if (
        typeof t !== 'number' ||
        !Number.isInteger(t) ||
        t < BUDGET_THRESHOLD_MIN ||
        t > BUDGET_THRESHOLD_MAX
      ) {
        throw new BadRequestException(
          `thresholds must be integers ${BUDGET_THRESHOLD_MIN}–${BUDGET_THRESHOLD_MAX}`,
        );
      }
      list.push(t);
    }
    if (new Set(list).size !== list.length) {
      throw new BadRequestException('thresholds must be distinct');
    }
    list.sort((a, b) => a - b);
  }

  if (
    typeof timeZone !== 'string' ||
    timeZone.length > BUDGET_TZ_MAX_LENGTH ||
    !isValidOtelTimeZone(timeZone)
  ) {
    throw new BadRequestException('timeZone must be a valid IANA time zone');
  }

  return { period, amountUsd, thresholds: list, timeZone };
}
