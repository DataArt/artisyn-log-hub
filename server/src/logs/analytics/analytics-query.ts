import { BadRequestException } from '@nestjs/common';
import {
  ACTIVE_SESSIONS_DEFAULT_LIMIT,
  ACTIVE_SESSIONS_MAX_LIMIT,
} from './usage-analytics.types';

/**
 * The query parameters every usage-analytics and usage-report route takes.
 *
 * Extracted from the block duplicated in `reports.controller.ts` (executive-summary and
 * cache-read-ratio each validate these five params identically) so the eight new routes
 * cannot drift from each other or from the existing ones.
 */
export interface AnalyticsQuery {
  teamId?: number;
  startDate: Date;
  endDate: Date;
  branches: string[];
  users: string[];
}

export interface RawAnalyticsQuery {
  teamId?: number;
  startDate?: string;
  endDate?: string;
  branches?: string;
  users?: string;
}

/**
 * Validates and normalises the shared query parameters, throwing the same
 * `BadRequestException` messages the existing report routes throw.
 *
 * `startDate`/`endDate` are required — an unbounded scan over every session a repository ever
 * had is never what a caller wants and would blow the repo-scope performance budget.
 */
export function parseAnalyticsQuery(raw: RawAnalyticsQuery): AnalyticsQuery {
  if (raw.teamId !== undefined && raw.teamId <= 0) {
    throw new BadRequestException('teamId must be a positive integer');
  }
  if (!raw.startDate) {
    throw new BadRequestException('startDate is required');
  }
  if (!raw.endDate) {
    throw new BadRequestException('endDate is required');
  }

  const startDate = new Date(raw.startDate);
  const endDate = new Date(raw.endDate);
  if (isNaN(startDate.getTime())) {
    throw new BadRequestException('startDate must be a valid ISO 8601 date');
  }
  if (isNaN(endDate.getTime())) {
    throw new BadRequestException('endDate must be a valid ISO 8601 date');
  }

  return {
    teamId: raw.teamId,
    startDate,
    endDate,
    branches: parseCsvParam(raw.branches),
    users: parseCsvParam(raw.users),
  };
}

/**
 * Splits a comma-separated, percent-encoded filter list. Matches the existing report routes:
 * each value is individually `decodeURIComponent`d, so a branch name containing a comma is
 * passed through encoded and survives the split.
 */
export function parseCsvParam(param?: string): string[] {
  if (param === undefined || param === '') return [];
  return param.split(',').map((value) => decodeURIComponent(value));
}

/**
 * Clamps the active-session list size. An out-of-range value is rejected rather than silently
 * clamped, so a caller asking for 5,000 rows learns the cap instead of wondering why it got
 * 500.
 */
export function parseActiveSessionsLimit(limitParam?: number): number {
  if (limitParam === undefined) return ACTIVE_SESSIONS_DEFAULT_LIMIT;
  if (
    !Number.isInteger(limitParam) ||
    limitParam < 1 ||
    limitParam > ACTIVE_SESSIONS_MAX_LIMIT
  ) {
    throw new BadRequestException(
      `limit must be an integer between 1 and ${ACTIVE_SESSIONS_MAX_LIMIT}`,
    );
  }
  return limitParam;
}
