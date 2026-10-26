import { Inject, Injectable } from '@nestjs/common';
import { eq, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import * as schema from '../../database/schema';
import {
  num,
  scopedUserFilterSql,
  textList,
} from '../analytics/scoped-sessions.sql';
import {
  attributeFilterSql,
  type ParsedAttributeFilter,
} from '../attribute-filter.sql';
import { descendantSessionsCte } from '../session-tree.sql';
import {
  readTreeCost,
  TREE_COST_COLUMNS_SQL,
  treeCostCtes,
  type SessionTreeCost,
  type TreeCostSqlRow,
} from '../session-tree-cost.sql';
import {
  SESSION_TREE_METRICS_CTE,
  mapTreeMetricsRow,
  treeMetricsCte,
  withOwnFallback,
  type SessionTreeMetrics,
  type TreeMetricsSqlRow,
} from '../session-tree-metrics.sql';
import type { TeamScope } from '../team-scope';

export interface ExecutiveSummaryWeekBucket {
  weekStart: string;
  sessionCount: number;
  totalCost: number;
}

export interface ExecutiveSummaryModelMixEntry {
  model: string;
  sessionCount: number;
  share: number;
  cost: number;
  costShare: number;
}

export interface ExecutiveSummaryTopSession {
  startTime: string;
  userEmail: string;
  branch: string | null;
  workTimeMs: number;
  cost: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * `'unknown-model'` when this session reports a model that has no `model_pricing` row,
   * so the report and its PDF can show the no-pricing badge on the row instead of a
   * figure that silently omits this session's spend. `null` whenever the cost is trustworthy
   * — including a session with no stats at all, which has nothing to price.
   *
   * Independent of the report-level `excludedSessionCount` / `excludedModels`, which stay the
   * aggregate disclosure over the same underlying signal.
   */
  costUnavailableReason: 'unknown-model' | null;
  /**
   * The model ids of this session's tree with no price in Log Hub (sorted; empty when
   * everything is priced) — named by the `$???` hint. Added later; optional for consumers.
   */
  unpricedModels: string[];
}

export interface ExecutiveSummaryEngineerEntry {
  userEmail: string;
  sessionCount: number;
  share: number;
  totalCost: number;
  avgCostPerSession: number;
  avgSessionLengthMs: number;
  costPerLine: number;
  linesPerHour: number;
  subAgentsPerSession: number;
}

// Previous-period window is [startDate - windowLengthMs,
// startDate - 1ms], i.e. the immediately preceding window of equal length.
// Populated with the same four headline metrics the KPI tiles compare
// against; `null` on the report exactly when this window has 0 sessions.
export interface ExecutiveSummaryPreviousPeriod {
  totalCost: number;
  totalSessions: number;
  activeUsers: number;
  avgCostPerSession: number;
}

// Sits alongside (not inside) totalCost — its own KPI
// tile, scoped by joining `turn_end_advisor_runs.session_id` directly to sessions/logs
// for the same branch/user/date filters the rest of the report uses, no marker scan.
export interface ExecutiveSummaryAdvisorSpend {
  evaluationCount: number;
  distinctInvokingSessions: number;
  costUsd: number;
}

// Sibling KPI tile to `advisorSpend`, never
// merged into one figure. Unlike the advisor, `session_attribution_runs.session_id` is the
// invoking session directly too, but the section's contract is defined in terms of the
// `hook_service` marker's own `invoking_session_id` field (the spawned eval session has no
// branch/user of its own) — `invoking_session_id` on the run row is the same string,
// stored there purely so this query can use it without re-scanning `logs.body`
// (`docs/knowledgebase/db-tables.md`'s `session_attribution_runs` entry). A run row with no
// `invoking_session_id` (a marker written before the field existed) is excluded rather than
// guessed at.
export interface ExecutiveSummaryAttributionSpend {
  evaluationCount: number;
  distinctInvokingSessions: number;
  costUsd: number;
}

export interface ExecutiveSummaryReport {
  totalCost: number;
  totalSessions: number;
  activeUsers: number;
  teamSize: number | null;
  avgCostPerSession: number;
  totalLinesChanged: number;
  avgCostPerLine: number;
  avgLinesPerHour: number;
  avgSessionLengthMs: number;
  excludedSessionCount: number;
  excludedModels: string[];
  previousPeriod: ExecutiveSummaryPreviousPeriod | null;
  weeklyBuckets: ExecutiveSummaryWeekBucket[];
  modelMix: ExecutiveSummaryModelMixEntry[];
  topSessions: ExecutiveSummaryTopSession[];
  engineerBreakdown: ExecutiveSummaryEngineerEntry[];
  advisorSpend: ExecutiveSummaryAdvisorSpend;
  attributionSpend: ExecutiveSummaryAttributionSpend;
}

export interface ExecutiveSummaryOptions {
  teamId?: number;
  requesterUserId: number;
  /** The caller's resolved team access-mode scope — see `AnalyticsScope.scope`. */
  scope: TeamScope;
  startDate: Date;
  endDate: Date;
  branches: string[];
  users: string[];
  /** Applied to Phase A only (both windows). */
  attributeFilters?: ParsedAttributeFilter[];
}

// Raw Phase A row shape, straight off the eligibility SELECT. The cost comes from
// Phase B (the complete computed tree cost).
interface SessionRow {
  session_row_id: string;
  start_time: string;
  user_email: string;
  model: string | null;
  branch: string | null;
  lines_changed: string | null;
  work_time_ms: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
}

// Phase B rollup row — per-root sub-agent cost SUM and descendant-session
// COUNT, keyed by Phase A's `session_row_id`.
//
// The same query now also carries the `session_tree_metrics` columns (the
// tree-scoped `session_stats` rollup, root included), so `lines_changed` can be made
// tree-scoped without a second round trip. Every tree column is nullable here because
// `session_tree_metrics` is one arm of a FULL OUTER JOIN — `root_counted !== null`
// is the test for "this root had a tree row at all".
interface SubagentRollupRow
  extends
    Omit<TreeMetricsSqlRow, 'root_id'>,
    Omit<TreeCostSqlRow, 'session_row_id'> {
  session_row_id: string;
}

// Raw row off the Advisor Spend join — `turn_end_advisor_runs`
// straight to `sessions`/`logs`, no marker scan.
interface AdvisorSpendRow {
  evaluation_count: string | number | null;
  distinct_invoking_sessions: string | number | null;
  cost_usd: string | number | null;
}

// Raw row off the Attribution Spend join — same shape as
// `AdvisorSpendRow`, `session_attribution_runs` joined through its own `invoking_session_id`
// to `sessions`/`logs`.
interface AttributionSpendRow {
  evaluation_count: string | number | null;
  distinct_invoking_sessions: string | number | null;
  cost_usd: string | number | null;
}

// Merged row consumed by every downstream builder. `total_cost` is the complete
// computed tree cost, resolved once (0 for an unpriced session, which
// `cost_unavailable_reason` marks), so every aggregate downstream reads this single value.
interface SessionAggRow {
  start_time: string;
  user_email: string;
  model: string | null;
  branch: string | null;
  // Tree-scoped (root + every sub-agent at any depth), resolved once in the merge
  // below via `withOwnFallback`, hence a plain number — never re-parse it.
  lines_changed: number;
  work_time_ms: string | null;
  total_cost: number;
  cost_unavailable_reason: 'unknown-model' | null;
  unpriced_models: string[];
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  subagentCount: number;
}

// ISO week (Monday–Sunday, UTC) end for the week containing `d`.
function isoWeekEndUTC(d: Date): Date {
  const day = d.getUTCDay();
  const isoDay = day === 0 ? 7 : day;
  const end = new Date(d);
  end.setUTCDate(d.getUTCDate() + (7 - isoDay));
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function dateOnlyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Splits [startDate, endDate] into ISO weeks; edge weeks that don't fully fall
// inside the range are shortened to the range boundary, per the "partial edge
// weeks included as short buckets, labeled by their start date" convention.
function buildWeeklyBuckets(
  startDate: Date,
  endDate: Date,
  rows: SessionAggRow[],
): ExecutiveSummaryWeekBucket[] {
  const buckets: {
    start: Date;
    end: Date;
    sessionCount: number;
    totalCost: number;
  }[] = [];

  let cursor = new Date(startDate);
  while (cursor <= endDate) {
    const weekEnd = new Date(
      Math.min(isoWeekEndUTC(cursor).getTime(), endDate.getTime()),
    );
    buckets.push({
      start: new Date(cursor),
      end: weekEnd,
      sessionCount: 0,
      totalCost: 0,
    });
    cursor = new Date(weekEnd.getTime() + 1);
  }

  for (const row of rows) {
    const t = new Date(row.start_time).getTime();
    const bucket = buckets.find(
      (b) => t >= b.start.getTime() && t <= b.end.getTime(),
    );
    if (bucket) {
      bucket.sessionCount += 1;
      bucket.totalCost += row.total_cost;
    }
  }

  return buckets.map((b) => ({
    weekStart: dateOnlyUTC(b.start),
    sessionCount: b.sessionCount,
    totalCost: b.totalCost,
  }));
}

// Model Mix cost/cost-share is keyed by the row's own
// (first-observed) model — a root session's rolled-up total, including its
// sub-agents' cost, is attributed whole to that one model, same as
// share/sessionCount already are.
function buildModelMix(
  rows: SessionAggRow[],
  totalSessions: number,
  totalCost: number,
): ExecutiveSummaryModelMixEntry[] {
  const counts = new Map<string, number>();
  const costs = new Map<string, number>();
  for (const row of rows) {
    const model = row.model ?? 'unknown';
    counts.set(model, (counts.get(model) ?? 0) + 1);
    costs.set(model, (costs.get(model) ?? 0) + row.total_cost);
  }
  return Array.from(counts.entries())
    .map(([model, sessionCount]) => ({
      model,
      sessionCount,
      share: totalSessions > 0 ? sessionCount / totalSessions : 0,
      cost: costs.get(model) ?? 0,
      costShare: totalCost > 0 ? (costs.get(model) ?? 0) / totalCost : 0,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount);
}

// Top 5 sessions by cost — date/engineer/branch/duration/cost/model/tokens,
// no prompt text, matching the "Top 5 Sessions by Cost" table in the
// tmp/exec-report/img_1.png mockup. `total_cost` is always numeric here
// (an unpriced session is 0 and carries `cost_unavailable_reason`).
function buildTopSessions(rows: SessionAggRow[]): ExecutiveSummaryTopSession[] {
  return [...rows]
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, 5)
    .map((r) => ({
      startTime: r.start_time,
      userEmail: r.user_email,
      branch: r.branch,
      workTimeMs: r.work_time_ms != null ? parseFloat(r.work_time_ms) : 0,
      cost: r.total_cost,
      model: r.model,
      inputTokens: r.input_tokens != null ? parseFloat(r.input_tokens) : 0,
      outputTokens: r.output_tokens != null ? parseFloat(r.output_tokens) : 0,
      cacheReadTokens:
        r.cache_read_tokens != null ? parseFloat(r.cache_read_tokens) : 0,
      cacheWriteTokens:
        r.cache_write_tokens != null ? parseFloat(r.cache_write_tokens) : 0,
      costUnavailableReason: r.cost_unavailable_reason,
      unpricedModels: r.unpriced_models,
    }));
}

// Per-engineer breakdown, grouped by user_email (no display-name lookup
// available). costPerLine/linesPerHour
// use the exact same formulas as the report-level avgCostPerLine/avgLinesPerHour.
// subAgentsPerSession = sum(descendant-session count
// across that engineer's root sessions) / engineer.sessionCount.
function buildEngineerBreakdown(
  rows: SessionAggRow[],
  totalCost: number,
): ExecutiveSummaryEngineerEntry[] {
  const groups = new Map<
    string,
    {
      sessionCount: number;
      totalCost: number;
      linesChanged: number;
      workTimeMs: number;
      subagentCount: number;
    }
  >();

  for (const row of rows) {
    const entry = groups.get(row.user_email) ?? {
      sessionCount: 0,
      totalCost: 0,
      linesChanged: 0,
      workTimeMs: 0,
      subagentCount: 0,
    };
    entry.sessionCount += 1;
    entry.totalCost += row.total_cost;
    entry.linesChanged += row.lines_changed;
    entry.workTimeMs +=
      row.work_time_ms != null ? parseFloat(row.work_time_ms) : 0;
    entry.subagentCount += row.subagentCount;
    groups.set(row.user_email, entry);
  }

  return Array.from(groups.entries())
    .map(([userEmail, g]) => ({
      userEmail,
      sessionCount: g.sessionCount,
      share: totalCost > 0 ? g.totalCost / totalCost : 0,
      totalCost: g.totalCost,
      avgCostPerSession: g.sessionCount > 0 ? g.totalCost / g.sessionCount : 0,
      avgSessionLengthMs:
        g.sessionCount > 0 ? g.workTimeMs / g.sessionCount : 0,
      costPerLine: g.linesChanged > 0 ? g.totalCost / g.linesChanged : 0,
      linesPerHour:
        g.workTimeMs > 0 ? g.linesChanged / (g.workTimeMs / 3_600_000) : 0,
      subAgentsPerSession:
        g.sessionCount > 0 ? g.subagentCount / g.sessionCount : 0,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);
}

// Phase A + Phase B (plus the own + sub-agent cost merge and
// excluded-session computation) are extracted into this
// one reusable method so it can be called twice per report load — once for
// the requested range, once for the previous-period range — keeping the
// endpoint at a small, fixed number of round trips regardless of session
// count.
interface PeriodAggregates {
  aggRows: SessionAggRow[];
  totalCost: number;
  totalSessions: number;
  activeUsers: number;
  avgCostPerSession: number;
  excludedSessionCount: number;
  excludedModels: string[];
}

@Injectable()
export class ExecutiveSummaryService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async computePeriodAggregates(
    repoIdsLiteral: string,
    startDate: Date,
    endDate: Date,
    ownerFilter: SQL,
    branchFilter: SQL,
    userFilter: SQL,
    attrFilter: SQL,
  ): Promise<PeriodAggregates> {
    // Phase A: eligibility and each root's own figures (the cost comes from Phase B).
    const result = await this.db.execute(sql`
      SELECT
        s.id               AS session_row_id,
        l.start_time      AS start_time,
        u.email            AS user_email,
        l.git_branch       AS branch,
        ss.model           AS model,
        ss.lines_changed   AS lines_changed,
        ss.work_time_ms    AS work_time_ms,
        ss.input_tokens    AS input_tokens,
        ss.output_tokens   AS output_tokens,
        ss.cache_read_tokens  AS cache_read_tokens,
        ss.cache_write_tokens AS cache_write_tokens
      FROM sessions s
      INNER JOIN logs l ON l.session_id = s.id
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      INNER JOIN users u ON u.id = l.user_id
      LEFT JOIN session_stats ss ON ss.session_id = s.id
      WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
        AND l.log_type = 'artisyn'
        AND l.first_prompt IS NOT NULL
        AND s.deleted = false
        AND EXISTS (
          SELECT 1 FROM logs cl
          WHERE cl.session_id = l.session_id AND cl.log_type = 'claude'
        )
        AND l.start_time >= ${startDate}
        AND l.start_time <= ${endDate}
        ${ownerFilter}
        ${branchFilter}
        ${userFilter}
        ${attrFilter}
    `);

    const rows = result.rows as unknown as SessionRow[];

    // Phase B: the complete computed tree cost (own + sub-agents + utility calls,
    // session-tree-cost.sql.ts) and the descendant COUNT, keyed off Phase A's
    // session_row_ids, plus the per-root tree rollup of session_stats from the same round
    // trip.
    const treeCostByRow = new Map<number, SessionTreeCost>();
    const treeMetricsByRow = new Map<number, SessionTreeMetrics>();
    if (rows.length > 0) {
      const sessionRowIds = rows.map((r) => r.session_row_id);
      const idsLiteral = `{${sessionRowIds.join(',')}}`;
      const idsArray = sql`${idsLiteral}::bigint[]`;
      const modelByRow = new Map(
        rows.map((r) => [Number(r.session_row_id), r.model]),
      );
      const rollupResult = await this.db.execute(sql`
        WITH RECURSIVE ${descendantSessionsCte(idsArray)},
        ${treeMetricsCte()},
        ${treeCostCtes(idsArray)}
        SELECT
          tc.session_row_id,
          ${TREE_COST_COLUMNS_SQL},
          tm.lines_changed,
          tm.files_edited_written,
          tm.lines_added,
          tm.lines_removed,
          tm.diff_lines_covered_calls,
          tm.diff_lines_total_calls,
          tm.image_count,
          tm.mcp_calls_total,
          tm.root_counted,
          tm.descendant_count
        -- tree_costs has exactly one row per Phase A root; session_tree_metrics only one
        -- for a root that counted anything at all.
        FROM tree_costs tc
        LEFT JOIN ${sql.raw(SESSION_TREE_METRICS_CTE)} tm ON tm.root_id = tc.session_row_id
      `);
      for (const row of rollupResult.rows as unknown as SubagentRollupRow[]) {
        const rowId = Number(row.session_row_id);
        treeCostByRow.set(
          rowId,
          readTreeCost(row, modelByRow.get(rowId) ?? null),
        );
        if (row.root_counted != null) {
          treeMetricsByRow.set(
            rowId,
            mapTreeMetricsRow({ ...row, root_id: row.session_row_id }),
          );
        }
      }
    }

    // excludedSessionCount/excludedModels: the sessions whose complete computed cost is
    // null because some model of the tree (root, sub-agent or utility call) has no price,
    // and those model ids. Such a session adds nothing to any sum below — it is disclosed
    // as excluded, never counted as a $0 session.
    const excludedModelsSet = new Set<string>();
    let excludedSessionCount = 0;
    for (const r of rows) {
      const tree = treeCostByRow.get(Number(r.session_row_id));
      if (tree?.total == null) {
        excludedSessionCount += 1;
        const models = tree?.unpricedModels ?? [];
        if (models.length === 0) excludedModelsSet.add(r.model ?? 'unknown');
        for (const m of models) excludedModelsSet.add(m);
      }
    }
    const excludedModels = Array.from(excludedModelsSet);

    // total_cost is the complete computed tree cost (session-tree-cost.sql.ts), defined
    // once here; every downstream aggregate (totalCost, weekly buckets, model-mix cost,
    // top sessions, engineer totals) reads this single value. An unpriced session is 0
    // here so it adds nothing, and cost_unavailable_reason marks it.
    const aggRows: SessionAggRow[] = rows.map((r) => {
      const rowId = Number(r.session_row_id);
      const tree = treeCostByRow.get(rowId);
      // The tree rollup already contains the root whenever it
      // had a counted session_stats row, so Phase A's own value is a *fallback*, added
      // only when the root is absent from the rollup — never on top of it.
      const treeLinesChanged = withOwnFallback(treeMetricsByRow.get(rowId), {
        linesChanged: r.lines_changed != null ? parseFloat(r.lines_changed) : 0,
        filesEditedWritten: 0,
      }).linesChanged;
      return {
        start_time: r.start_time,
        user_email: r.user_email,
        model: r.model,
        branch: r.branch,
        lines_changed: treeLinesChanged,
        work_time_ms: r.work_time_ms,
        total_cost: tree?.total ?? 0,
        // 'unknown-model' only when some model of the tree has no price. A session with
        // no `session_stats` row and no model has nothing to price, so its reason stays
        // null — the missing figure there is "no stats yet".
        cost_unavailable_reason: tree?.costUnavailableReason ?? null,
        unpriced_models: tree?.unpricedModels ?? [],
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        subagentCount: tree?.subagentCount ?? 0,
      };
    });

    const totalSessions = aggRows.length;
    const totalCost = aggRows.reduce((sum, r) => sum + r.total_cost, 0);
    const activeUsers = new Set(aggRows.map((r) => r.user_email)).size;
    const avgCostPerSession = totalSessions > 0 ? totalCost / totalSessions : 0;

    return {
      aggRows,
      totalCost,
      totalSessions,
      activeUsers,
      avgCostPerSession,
      excludedSessionCount,
      excludedModels,
    };
  }

  // Advisor Spend section. Joins
  // `turn_end_advisor_runs.session_id` directly to `sessions`/`logs` for the SAME
  // repo/date/owner/branch/user scope Phase A above applies (the advisor's
  // run table already stores the invoking session directly, so unlike the
  // Attribution Spend there is no `hook_service` marker to scan for first). Counts every
  // run row in scope regardless of `outcome` — rows only ever exist for actual evaluation
  // attempts, so a `'failed'` attempt's own incurred cost still
  // belongs in this section's total. Never touches `totalCost` / `computePeriodAggregates`.
  private async computeAdvisorSpend(
    repoIdsLiteral: string,
    startDate: Date,
    endDate: Date,
    ownerFilter: SQL,
    branchFilter: SQL,
    userFilter: SQL,
  ): Promise<ExecutiveSummaryAdvisorSpend> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(*)                AS evaluation_count,
        COUNT(DISTINCT s.id)     AS distinct_invoking_sessions,
        COALESCE(SUM(tear.cost_usd), 0) AS cost_usd
      FROM turn_end_advisor_runs tear
      INNER JOIN sessions s ON s.session_id = tear.session_id
      INNER JOIN logs l ON l.session_id = s.id
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      INNER JOIN users u ON u.id = l.user_id
      WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
        AND l.log_type = 'artisyn'
        -- Only runs recorded by the session
        -- owner count; a NULL user_id never matches.
        AND tear.user_id = l.user_id
        AND l.first_prompt IS NOT NULL
        AND s.deleted = false
        AND l.start_time >= ${startDate}
        AND l.start_time <= ${endDate}
        ${ownerFilter}
        ${branchFilter}
        ${userFilter}
    `);

    const row = result.rows[0] as unknown as AdvisorSpendRow | undefined;
    return {
      evaluationCount: num(row?.evaluation_count ?? null),
      distinctInvokingSessions: num(row?.distinct_invoking_sessions ?? null),
      costUsd: num(row?.cost_usd ?? null),
    };
  }

  // Attribution Spend section, the sibling
  // KPI tile to `advisorSpend` above — never merged into one figure. Unlike the advisor's run
  // table, `session_attribution_runs.session_id` is the attribution run's own invoking session too, but
  // the section is defined in terms of the `hook_service` marker's `invoking_session_id`
  // field (the spawned eval session carries no branch/user of its own); `invoking_session_id`
  // is stored as its own column on the run row precisely so this query can use it directly
  // instead of re-scanning `logs.body` for the marker on every report load
  // (`docs/knowledgebase/db-tables.md`'s `session_attribution_runs` entry) — both copies are
  // written from the same hook-side value (the Executive Summary's Attribution Spend section).
  // `session_attribution_runs` is itself the exclusively `session-attribution` population
  // (the Turn-End Cost Advisor never writes to this table), so no extra
  // `hook_service_type` discriminator is needed here the way a combined marker scan across
  // all three sub-types would require. A run row with `invoking_session_id IS NULL` is a
  // marker written before the field existed (or never resolved) and is excluded, per the
  // Hook API backward-compatibility rule. Counts every run row in scope regardless of
  // `outcome` (rows only exist for actual evaluation attempts) and never touches `totalCost`
  // / `computePeriodAggregates`.
  private async computeAttributionSpend(
    repoIdsLiteral: string,
    startDate: Date,
    endDate: Date,
    ownerFilter: SQL,
    branchFilter: SQL,
    userFilter: SQL,
  ): Promise<ExecutiveSummaryAttributionSpend> {
    const result = await this.db.execute(sql`
      SELECT
        COUNT(*)                AS evaluation_count,
        COUNT(DISTINCT inv.id)   AS distinct_invoking_sessions,
        COALESCE(SUM(sar.cost_usd), 0) AS cost_usd
      FROM session_attribution_runs sar
      INNER JOIN sessions inv ON inv.session_id = sar.invoking_session_id
      INNER JOIN logs l ON l.session_id = inv.id
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      INNER JOIN users u ON u.id = l.user_id
      WHERE sar.invoking_session_id IS NOT NULL
        AND lr.repo_id = ANY(${repoIdsLiteral}::int[])
        AND l.log_type = 'artisyn'
        AND l.first_prompt IS NOT NULL
        AND inv.deleted = false
        AND l.start_time >= ${startDate}
        AND l.start_time <= ${endDate}
        ${ownerFilter}
        ${branchFilter}
        ${userFilter}
    `);

    const row = result.rows[0] as unknown as AttributionSpendRow | undefined;
    return {
      evaluationCount: num(row?.evaluation_count ?? null),
      distinctInvokingSessions: num(row?.distinct_invoking_sessions ?? null),
      costUsd: num(row?.cost_usd ?? null),
    };
  }

  async build(
    repoIds: number[],
    opts: ExecutiveSummaryOptions,
  ): Promise<ExecutiveSummaryReport> {
    const repoIdsLiteral = `{${repoIds.join(',')}}`;
    // Team access mode — the ids this caller may read; nothing at all in a
    // `transparent` team. See `scopedUserFilterSql`.
    const ownerFilter = scopedUserFilterSql(opts.scope, 'l');
    // `IN (list of bound params)` rather than `= ANY($n::text[])`: drizzle expands an
    // array placeholder into a comma-separated *parameter list*, so the `::text[]` form
    // reaches Postgres as `($6)::text[]` with a plain string bound to it and fails with
    // `malformed array literal`. Each value stays a bound parameter here, so a branch or
    // e-mail containing a quote or a comma is still handled safely. Same fix already
    // applied in `cache-read-ratio.service.ts` and `scoped-sessions.sql.ts`.
    const branchFilter =
      opts.branches.length > 0
        ? sql`AND COALESCE(l.git_branch, 'no branch') IN (${textList(opts.branches)})`
        : sql``;
    const userFilter =
      opts.users.length > 0
        ? sql`AND u.email IN (${textList(opts.users)})`
        : sql``;
    // Applied to Phase A only — Phase B's sub-agent rollup is keyed
    // off Phase A's own session_row_ids, so a root excluded here never has its descendants
    // rolled up either.
    const attrCondition = attributeFilterSql(
      opts.attributeFilters ?? [],
      sql`s.id`,
    );
    const attrFilter = attrCondition ? sql`AND ${attrCondition}` : sql``;

    const {
      aggRows,
      totalCost,
      totalSessions,
      activeUsers,
      avgCostPerSession,
      excludedSessionCount,
      excludedModels,
    } = await this.computePeriodAggregates(
      repoIdsLiteral,
      opts.startDate,
      opts.endDate,
      ownerFilter,
      branchFilter,
      userFilter,
      attrFilter,
    );

    const totalLinesChanged = aggRows.reduce(
      (sum, r) => sum + r.lines_changed,
      0,
    );
    const totalWorkTimeMs = aggRows.reduce(
      (sum, r) =>
        sum + (r.work_time_ms != null ? parseFloat(r.work_time_ms) : 0),
      0,
    );
    const avgCostPerLine =
      totalLinesChanged > 0 ? totalCost / totalLinesChanged : 0;
    const avgLinesPerHour =
      totalWorkTimeMs > 0
        ? totalLinesChanged / (totalWorkTimeMs / 3_600_000)
        : 0;
    const avgSessionLengthMs =
      totalSessions > 0 ? totalWorkTimeMs / totalSessions : 0;

    let teamSize: number | null = null;
    if (opts.teamId !== undefined) {
      const [row] = await this.db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(schema.teamMembers)
        .where(eq(schema.teamMembers.teamId, opts.teamId));
      teamSize = row?.count ?? 0;
    }

    // Previous-period window = [startDate -
    // windowLengthMs, startDate - 1ms] — the immediately preceding window of
    // equal length, using the same repo/owner/branch/user filters. `null`
    // exactly when that window's session count is 0.
    const windowLengthMs = opts.endDate.getTime() - opts.startDate.getTime();
    const previousEndDate = new Date(opts.startDate.getTime() - 1);
    const previousStartDate = new Date(
      opts.startDate.getTime() - windowLengthMs,
    );
    const previousAggregates = await this.computePeriodAggregates(
      repoIdsLiteral,
      previousStartDate,
      previousEndDate,
      ownerFilter,
      branchFilter,
      userFilter,
      attrFilter,
    );
    const previousPeriod: ExecutiveSummaryPreviousPeriod | null =
      previousAggregates.totalSessions === 0
        ? null
        : {
            totalCost: previousAggregates.totalCost,
            totalSessions: previousAggregates.totalSessions,
            activeUsers: previousAggregates.activeUsers,
            avgCostPerSession: previousAggregates.avgCostPerSession,
          };

    const advisorSpend = await this.computeAdvisorSpend(
      repoIdsLiteral,
      opts.startDate,
      opts.endDate,
      ownerFilter,
      branchFilter,
      userFilter,
    );

    const attributionSpend = await this.computeAttributionSpend(
      repoIdsLiteral,
      opts.startDate,
      opts.endDate,
      ownerFilter,
      branchFilter,
      userFilter,
    );

    return {
      totalCost,
      totalSessions,
      activeUsers,
      teamSize,
      avgCostPerSession,
      totalLinesChanged,
      avgCostPerLine,
      avgLinesPerHour,
      avgSessionLengthMs,
      excludedSessionCount,
      excludedModels,
      previousPeriod,
      weeklyBuckets: buildWeeklyBuckets(opts.startDate, opts.endDate, aggRows),
      modelMix: buildModelMix(aggRows, totalSessions, totalCost),
      topSessions: buildTopSessions(aggRows),
      engineerBreakdown: buildEngineerBreakdown(aggRows, totalCost),
      advisorSpend,
      attributionSpend,
    };
  }
}
