import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import type { SessionAttributionRunOutcome } from '../session-attribution/session-attribution.service';
import {
  dayKey,
  num,
  scopedUserFilterSql,
  textList,
} from '../analytics/scoped-sessions.sql';
import type { TeamScope } from '../team-scope';

/**
 * Attribution Usage report.
 *
 * `supportsAttributeFilter: false` for this report — unlike Attribution
 * Breakdown, its population is `session_attribution_runs` (every evaluation *attempt*), not
 * sessions carrying resolved `values`. A `failed` run never wrote any `values`, so an
 * `attr=` filter would silently hide the very failures this report exists to surface.
 *
 * The runs table already carries its own cost/token columns (never joined via
 * `session_stats`, same shape as the advisor's `turn_end_advisor_runs`), so this report is a
 * single-query scan — no Phase A/B split needed the way a `session_attribution.values` scan
 * (Attribution Breakdown) or a `session_stats` cost rollup (Attribution Breakdown's Phase B,
 * `cache-read-ratio`) would need.
 *
 * Date/branch/user scope is applied against the run's OWN `started_at` and the *invoking*
 * session's `logs` row — not the invoking session's own `start_time` — because the report's
 * population is evaluation events, which can span many days for one repeatedly-re-evaluated
 * session (see `evaluationCount` vs. `distinctSessionCount` below).
 */

export const ATTRIBUTION_USAGE_OUTCOMES: readonly SessionAttributionRunOutcome[] =
  ['applied', 'ignored_stale', 'failed'];

/** Ranked-list cutoff for "most re-evaluated sessions". */
export const ATTRIBUTION_USAGE_TOP_N = 10;

export interface AttributionUsageOutcomeRow {
  outcome: SessionAttributionRunOutcome;
  count: number;
  costUsd: number;
}

export interface AttributionUsageDayPoint {
  /** UTC `YYYY-MM-DD`. */
  date: string;
  count: number;
}

export interface AttributionUsageTopSession {
  /** `sessions.session_id` — the invoking session's own transcript id. */
  sessionId: string;
  evaluationCount: number;
  costUsd: number;
}

export interface AttributionUsageReportData {
  /**
   * Every run row in scope, i.e. every evaluation ATTEMPT — including `failed` ones.
   * `evaluationCount >= distinctSessionCount` is expected and normal, not a data-quality
   * signal: a session is re-evaluated at each new prompt watermark, so the same session
   * contributes one run per evaluation, not one run total.
   */
  evaluationCount: number;
  /** Distinct invoking sessions among those runs — always `<= evaluationCount`. */
  distinctSessionCount: number;
  totalCostUsd: number;
  /** `totalCostUsd / evaluationCount`, `0` when there are no runs in scope. */
  avgCostUsd: number;
  /** Always all 3 fixed outcomes, `count: 0` for one with no runs in scope. */
  outcomeBreakdown: AttributionUsageOutcomeRow[];
  /** Ascending by date; only days with at least one run appear (no gap-filling). */
  byDay: AttributionUsageDayPoint[];
  /** Top `ATTRIBUTION_USAGE_TOP_N` sessions by evaluation count, ties broken by cost desc. */
  topReevaluatedSessions: AttributionUsageTopSession[];
}

export interface AttributionUsageOptions {
  teamId?: number;
  requesterUserId: number;
  /** The caller's resolved team access-mode scope — see `AnalyticsScope.scope`. */
  scope: TeamScope;
  startDate: Date;
  endDate: Date;
  branches: string[];
  users: string[];
  /** `outcome=` narrowing (API changes) — empty means no filter (all 3 outcomes). */
  outcomes: SessionAttributionRunOutcome[];
}

/** One raw run row, already joined back to its invoking session's transcript id. */
export interface AttributionUsageRunRow {
  sessionId: string;
  startedAt: string;
  outcome: SessionAttributionRunOutcome;
  costUsd: number;
}

interface RawRunRow {
  session_id: string;
  started_at: string | Date;
  outcome: string;
  cost_usd: string | number | null;
}

// --- Pure helpers (exported for unit tests) ----------------------------------------------

/** Fixed-order, always-3-rows outcome breakdown. */
export function buildOutcomeBreakdown(
  rows: AttributionUsageRunRow[],
): AttributionUsageOutcomeRow[] {
  const byOutcome = new Map<
    SessionAttributionRunOutcome,
    { count: number; cost: number }
  >();
  for (const outcome of ATTRIBUTION_USAGE_OUTCOMES) {
    byOutcome.set(outcome, { count: 0, cost: 0 });
  }

  for (const row of rows) {
    const entry = byOutcome.get(row.outcome);
    if (!entry) continue;
    entry.count += 1;
    entry.cost += row.costUsd;
  }

  return ATTRIBUTION_USAGE_OUTCOMES.map((outcome) => {
    const entry = byOutcome.get(outcome)!;
    return { outcome, count: entry.count, costUsd: entry.cost };
  });
}

/** UTC-day bucketing of the run's own `startedAt` (see file header). */
export function buildByDay(
  rows: AttributionUsageRunRow[],
): AttributionUsageDayPoint[] {
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const key = dayKey(row.startedAt);
    if (key === null) continue;
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count }));
}

/** Top-N most re-evaluated sessions, ties broken by cost descending. */
export function buildTopReevaluatedSessions(
  rows: AttributionUsageRunRow[],
): AttributionUsageTopSession[] {
  const bySession = new Map<
    string,
    { evaluationCount: number; costUsd: number }
  >();
  for (const row of rows) {
    const entry = bySession.get(row.sessionId) ?? {
      evaluationCount: 0,
      costUsd: 0,
    };
    entry.evaluationCount += 1;
    entry.costUsd += row.costUsd;
    bySession.set(row.sessionId, entry);
  }

  return [...bySession.entries()]
    .map(([sessionId, entry]) => ({ sessionId, ...entry }))
    .sort(
      (a, b) => b.evaluationCount - a.evaluationCount || b.costUsd - a.costUsd,
    )
    .slice(0, ATTRIBUTION_USAGE_TOP_N);
}

export function buildAttributionUsageReport(
  rows: AttributionUsageRunRow[],
): AttributionUsageReportData {
  const evaluationCount = rows.length;
  const distinctSessionCount = new Set(rows.map((r) => r.sessionId)).size;
  const totalCostUsd = rows.reduce((sum, r) => sum + r.costUsd, 0);
  const avgCostUsd = evaluationCount > 0 ? totalCostUsd / evaluationCount : 0;

  return {
    evaluationCount,
    distinctSessionCount,
    totalCostUsd,
    avgCostUsd,
    outcomeBreakdown: buildOutcomeBreakdown(rows),
    byDay: buildByDay(rows),
    topReevaluatedSessions: buildTopReevaluatedSessions(rows),
  };
}

@Injectable()
export class AttributionUsageService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    opts: AttributionUsageOptions,
  ): Promise<AttributionUsageReportData> {
    const rows = await this.loadRunRows(repoIds, opts);
    return buildAttributionUsageReport(rows);
  }

  /**
   * Single-query scan (see file header) — `sessionAttributionRuns.sessionId` is the
   * invoking session's own row id, so joining straight to `sessions`/`logs` gets both the
   * transcript id and the repo/branch/user scope in one pass, exactly the way the advisor's
   * Advisor Spend Executive Summary section joins through `turn_end_advisor_runs.session_id`
   * — no `hook_service` marker scan needed here either.
   */
  private async loadRunRows(
    repoIds: number[],
    opts: AttributionUsageOptions,
  ): Promise<AttributionUsageRunRow[]> {
    const repoIdsLiteral = `{${repoIds.join(',')}}`;
    // Team access mode — the ids this caller may read; nothing at all in a
    // `transparent` team. See `scopedUserFilterSql`.
    const ownerFilter = scopedUserFilterSql(opts.scope, 'l');
    const branchFilter =
      opts.branches.length > 0
        ? sql`AND COALESCE(l.git_branch, 'no branch') IN (${textList(opts.branches)})`
        : sql``;
    const userFilter =
      opts.users.length > 0
        ? sql`AND u.email IN (${textList(opts.users)})`
        : sql``;
    const outcomeFilter =
      opts.outcomes.length > 0
        ? sql`AND sar.outcome IN (${textList(opts.outcomes)})`
        : sql``;

    const result = await this.db.execute(sql`
      SELECT
        s.session_id  AS session_id,
        sar.started_at AS started_at,
        sar.outcome    AS outcome,
        sar.cost_usd   AS cost_usd
      FROM session_attribution_runs sar
      INNER JOIN sessions s ON s.id = sar.session_id
      INNER JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      INNER JOIN users u ON u.id = l.user_id
      WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
        AND s.deleted = false
        AND sar.started_at >= ${opts.startDate}
        AND sar.started_at <= ${opts.endDate}
        ${ownerFilter}
        ${branchFilter}
        ${userFilter}
        ${outcomeFilter}
    `);

    return (result.rows as unknown as RawRunRow[]).map((r) => ({
      sessionId: r.session_id,
      startedAt:
        r.started_at instanceof Date
          ? r.started_at.toISOString()
          : new Date(r.started_at).toISOString(),
      outcome: r.outcome as SessionAttributionRunOutcome,
      costUsd: r.cost_usd != null ? num(r.cost_usd) : 0,
    }));
  }
}
