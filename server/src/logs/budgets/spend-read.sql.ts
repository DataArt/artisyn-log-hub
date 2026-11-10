/**
 * The budget spend read (2026-11-05 budgets-threshold-alerts, DD-3 / DD-4 / DD-6 / DD-8 / DD-21):
 * period bounds, the scope's budgets, the scope's rows, the period's root trees with their cost
 * inputs, and the per-call parts the cost slices are built from. DI-free functions over a
 * `DrizzleDb`, shared by `SpendService`, `BudgetsService` and the threshold job.
 */
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { budgets } from '../../database/schema';
import { textList } from '../analytics/scoped-sessions.sql';
import {
  TREE_COST_COLUMNS_SQL,
  treeCostCtes,
  type TreeCostSqlRow,
} from '../session-tree-cost.sql';
import { descendantSessionsCte } from '../session-tree.sql';
import { BUDGET_MIN_OFFSET } from './budget.constants';
import type { BudgetScope } from './budget-scope';
import type { BudgetPeriod, BudgetRow, PeriodBounds } from './budgets.types';

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** `{…}::int[]` literal of integer ids that come from the DB (see `scopedUserFilterSql`). */
function intArray(ids: readonly number[]): SQL {
  return sql`${`{${ids.map((n) => Math.trunc(n)).join(',')}}`}::int[]`;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

function toNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** Clamps a period offset into `[BUDGET_MIN_OFFSET, 0]` (DD-6). */
export function clampPeriodOffset(offset: number): number {
  const n = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  return Math.min(0, Math.max(BUDGET_MIN_OFFSET, n));
}

// ── Period bounds (DD-6) ─────────────────────────────────────────────────────────────────────

const PERIOD_UNIT_SQL: Record<BudgetPeriod, SQL> = {
  day: sql.raw(`'day'`),
  week: sql.raw(`'week'`),
  month: sql.raw(`'month'`),
};

const PERIOD_INTERVAL_SQL: Record<BudgetPeriod, SQL> = {
  day: sql.raw(`interval '1 day'`),
  week: sql.raw(`interval '1 week'`),
  month: sql.raw(`interval '1 month'`),
};

interface PeriodBoundsSqlRow {
  off: unknown;
  ps: unknown;
  pe: unknown;
  total_days: unknown;
  elapsed_days: unknown;
  total_hours: unknown;
  elapsed_hours: unknown;
}

/**
 * The bounds of every period with an offset in `[fromOffset, toOffset]` (both clamped to
 * `[BUDGET_MIN_OFFSET, 0]`), newest first, in one round trip. `tz` must already be a valid IANA
 * name (`isValidOtelTimeZone`).
 */
export async function loadPeriodBoundsSeries(
  db: DrizzleDb,
  q: { period: BudgetPeriod; tz: string; fromOffset: number; toOffset: number },
): Promise<PeriodBounds[]> {
  const from = clampPeriodOffset(Math.min(q.fromOffset, q.toOffset));
  const to = clampPeriodOffset(Math.max(q.fromOffset, q.toOffset));
  const unit = PERIOD_UNIT_SQL[q.period];
  const step = PERIOD_INTERVAL_SQL[q.period];
  const tz = sql`${q.tz}::text`;
  const result = await db.execute(sql`
    SELECT b.off, b.ps, b.pe,
      ((b.pe AT TIME ZONE ${tz})::date - (b.ps AT TIME ZONE ${tz})::date) AS total_days,
      ((now() AT TIME ZONE ${tz})::date - (b.ps AT TIME ZONE ${tz})::date + 1) AS elapsed_days,
      round(extract(epoch FROM b.pe - b.ps) / 3600) AS total_hours,
      floor(extract(epoch FROM now() - b.ps) / 3600) + 1 AS elapsed_hours
    FROM (
      SELECT o.off,
        (date_trunc(${unit}, now() AT TIME ZONE ${tz}) + o.off * ${step}) AT TIME ZONE ${tz} AS ps,
        (date_trunc(${unit}, now() AT TIME ZONE ${tz}) + (o.off + 1) * ${step}) AT TIME ZONE ${tz} AS pe
      FROM generate_series(${from}::int, ${to}::int) AS o(off)
    ) b
    ORDER BY b.off DESC
  `);
  const hourly = q.period === 'day';
  return (result.rows as unknown as PeriodBoundsSqlRow[]).map((r) => {
    const offset = toNumber(r.off);
    const totalUnits = Math.max(
      1,
      toNumber(hourly ? r.total_hours : r.total_days),
    );
    const rawElapsed = toNumber(hourly ? r.elapsed_hours : r.elapsed_days);
    const isCurrent = offset === 0;
    return {
      start: toDate(r.ps),
      end: toDate(r.pe),
      isCurrent,
      elapsedUnits: isCurrent
        ? Math.max(1, Math.min(totalUnits, rawElapsed))
        : totalUnits,
      totalUnits,
      unit: hourly ? 'hour' : 'day',
      offset,
      period: q.period,
      timeZone: q.tz,
    };
  });
}

/** The bounds of one period (DD-6): `offset` 0 is the current one, −1 the previous, … */
export async function loadPeriodBounds(
  db: DrizzleDb,
  q: { period: BudgetPeriod; tz: string; offset: number },
): Promise<PeriodBounds> {
  const [bounds] = await loadPeriodBoundsSeries(db, {
    period: q.period,
    tz: q.tz,
    fromOffset: q.offset,
    toOffset: q.offset,
  });
  return bounds;
}

// ── Budgets of a scope ───────────────────────────────────────────────────────────────────────

function scopeWhere(scope: BudgetScope): SQL | undefined {
  switch (scope.kind) {
    case 'repo':
      return and(
        eq(budgets.scopeKind, 'repo'),
        eq(budgets.userId, scope.userId),
        eq(budgets.repoUrl, scope.repoUrl),
      );
    case 'team-repo':
      return and(
        eq(budgets.scopeKind, 'team-repo'),
        eq(budgets.teamId, scope.teamId),
        eq(budgets.repoUrl, scope.repoUrl),
      );
    case 'team':
      return and(
        eq(budgets.scopeKind, 'team'),
        eq(budgets.teamId, scope.teamId),
        isNull(budgets.repoUrl),
      );
  }
}

/** The budgets of one scope (at most one per period), oldest first. */
export async function loadScopeBudgets(
  db: DrizzleDb,
  scope: BudgetScope,
): Promise<BudgetRow[]> {
  return db
    .select()
    .from(budgets)
    .where(scopeWhere(scope))
    .orderBy(asc(budgets.id));
}

/** Every budget, for the threshold job. */
export async function loadAllBudgets(db: DrizzleDb): Promise<BudgetRow[]> {
  return db.select().from(budgets).orderBy(asc(budgets.id));
}

// ── Scope rows (DD-3) ────────────────────────────────────────────────────────────────────────

/** The repositories and users a scope's spend is read from. `userIds: null` = no user filter. */
export interface ScopeRows {
  repoIds: number[];
  userIds: number[] | null;
}

/**
 * The caller-independent rows of a scope (DD-3):
 *
 * - `repo`: the owner's `repositories` row for the URL; users `[owner]`;
 * - `team-repo`: every team member's `repositories` row with the URL (the
 *   `RepositoriesService.resolveRepoIds` join); users = the export-visible members
 *   (`resolveExportVisibleUserIds`: `null` for a transparent team, else the owner plus every
 *   member who acknowledged the disclosure);
 * - `team`: the same over every URL in the team's `team_repositories`.
 *
 * `userFilterOverride` replaces the user filter (the DD-9 own-spend view passes `[callerId]`).
 */
export async function resolveScopeRows(
  db: DrizzleDb,
  scope: BudgetScope,
  userFilterOverride?: number[],
): Promise<ScopeRows> {
  if (scope.kind === 'repo') {
    const result = await db.execute(sql`
      SELECT r.id FROM repositories r
      WHERE r.user_id = ${scope.userId} AND r.repo_url = ${scope.repoUrl}
    `);
    return {
      repoIds: (result.rows as { id: unknown }[]).map((r) => toNumber(r.id)),
      userIds: userFilterOverride ?? [scope.userId],
    };
  }

  const urlFilter =
    scope.kind === 'team-repo'
      ? sql`r.repo_url = ${scope.repoUrl}`
      : sql`r.repo_url IN (
          SELECT tr.repo_url FROM team_repositories tr WHERE tr.team_id = ${scope.teamId}
        )`;
  const repoResult = await db.execute(sql`
    SELECT DISTINCT r.id
    FROM repositories r
    INNER JOIN team_members tm ON tm.user_id = r.user_id AND tm.team_id = ${scope.teamId}
    WHERE ${urlFilter}
  `);
  const repoIds = (repoResult.rows as { id: unknown }[]).map((r) =>
    toNumber(r.id),
  );
  if (userFilterOverride) return { repoIds, userIds: userFilterOverride };

  const teamResult = await db.execute(sql`
    SELECT t.access_mode, t.owner_id,
      COALESCE((
        SELECT array_agg(tm.user_id) FROM team_members tm
        WHERE tm.team_id = t.id AND tm.disclosure_acknowledged_at IS NOT NULL
      ), '{}'::int[]) AS acknowledged
    FROM teams t WHERE t.id = ${scope.teamId}
  `);
  const team = teamResult.rows[0] as
    | { access_mode: string; owner_id: unknown; acknowledged: unknown[] | null }
    | undefined;
  if (team === undefined || team.access_mode === 'transparent') {
    return { repoIds, userIds: null };
  }
  const userIds = [
    ...new Set([
      toNumber(team.owner_id),
      ...(team.acknowledged ?? []).map(toNumber),
    ]),
  ];
  return { repoIds, userIds };
}

// ── Period trees (DD-4 / DD-5) ───────────────────────────────────────────────────────────────

/** One root session tree of a budget period, with its two cost inputs. */
export interface PeriodTree {
  /** `sessions.id` of the root. */
  id: number;
  sessionId: string;
  repoId: number;
  repoUrl: string;
  userId: number;
  userEmail: string;
  branch: string | null;
  firstPrompt: string | null;
  /** `logs.start_time` of the root's `artisyn` log. */
  startTime: Date;
  /** DD-4 anchor: decides the period the tree belongs to. */
  anchor: Date;
  /** Local `YYYY-MM-DD` (unit `day`) or `HH` (unit `hour`) of the anchor in the bounds' tz. */
  bucketKey: string;
  /** The root has a `claude` transcript log (false = OTEL-only root). */
  hasClaudeLog: boolean;
  /** The `tree_costs` row (`readTreeCost` input); undefined when absent. */
  treeCost: TreeCostSqlRow | undefined;
  /** `otel_session_totals.cost_usd_micros`, null without a row. */
  otelMicros: number | null;
}

interface PeriodTreeSqlRow extends Partial<TreeCostSqlRow> {
  id: unknown;
  session_id: string;
  repo_id: unknown;
  repo_url: string;
  user_id: unknown;
  user_email: string;
  branch: string | null;
  first_prompt: string | null;
  start_time: unknown;
  anchor: unknown;
  bucket_key: string;
  has_claude_log: boolean;
  otel_micros: unknown;
}

/**
 * The root session trees of a period (DD-4): `sessions` with an `artisyn` log linked to one of
 * `rows.repoIds`, a first prompt, not deleted — no `claude`-log requirement, so OTEL-only roots
 * count once linked — whose anchor (`l.start_time` with a `claude` log, else
 * `COALESCE(otel_session_totals.first_call_at, l.start_time)`) falls in `[start, end)`. Each
 * row carries its `tree_costs` row ({@link treeCostCtes}) and the root's OTEL total, the two
 * inputs of `selectBudgetTreeCostMicros`.
 *
 * `filters` narrow like `loadScopedRootSessions` does for `branches` / `users` (branch name or
 * `no branch`, user e-mail); empty lists narrow nothing.
 */
export async function loadPeriodTrees(
  db: DrizzleDb,
  rows: ScopeRows,
  bounds: Pick<PeriodBounds, 'start' | 'end' | 'unit' | 'timeZone'>,
  filters?: { branches: string[]; userEmails: string[] },
): Promise<PeriodTree[]> {
  if (rows.repoIds.length === 0) return [];
  if (rows.userIds !== null && rows.userIds.length === 0) return [];

  const userFilter =
    rows.userIds === null
      ? sql``
      : sql`AND l.user_id = ANY(${intArray(rows.userIds)})`;
  const branchFilter =
    filters && filters.branches.length > 0
      ? sql`AND COALESCE(l.git_branch, 'no branch') IN (${textList(filters.branches)})`
      : sql``;
  const emailFilter =
    filters && filters.userEmails.length > 0
      ? sql`AND u.email IN (${textList(filters.userEmails)})`
      : sql``;
  const start = bounds.start;
  const end = bounds.end;
  const keyFormat = bounds.unit === 'hour' ? 'HH24' : 'YYYY-MM-DD';
  const rootIds = sql`ARRAY(SELECT id FROM period_roots)`;

  const result = await db.execute(sql`
    WITH RECURSIVE scope_roots AS (
      SELECT DISTINCT ON (s.id)
        s.id,
        s.session_id,
        lr.repo_id,
        r.repo_url,
        l.user_id,
        u.email AS user_email,
        l.git_branch AS branch,
        l.first_prompt,
        l.start_time,
        EXISTS (
          SELECT 1 FROM logs cl WHERE cl.session_id = s.id AND cl.log_type = 'claude'
        ) AS has_claude_log,
        ost.cost_usd_micros AS otel_micros,
        ost.first_call_at
      FROM sessions s
      INNER JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      INNER JOIN repositories r ON r.id = lr.repo_id
      INNER JOIN users u ON u.id = l.user_id
      LEFT JOIN otel_session_totals ost ON ost.session_id = s.id
      WHERE lr.repo_id = ANY(${intArray(rows.repoIds)})
        AND l.first_prompt IS NOT NULL
        AND s.deleted = false
        AND (
          (l.start_time >= ${start} AND l.start_time < ${end})
          OR (ost.first_call_at >= ${start} AND ost.first_call_at < ${end})
        )
        ${userFilter}
        ${branchFilter}
        ${emailFilter}
      ORDER BY s.id, lr.repo_id
    ),
    anchored_roots AS (
      SELECT sr.*,
        CASE WHEN sr.has_claude_log THEN sr.start_time
          ELSE COALESCE(sr.first_call_at, sr.start_time) END AS anchor
      FROM scope_roots sr
    ),
    period_roots AS (
      SELECT * FROM anchored_roots ar
      WHERE ar.anchor >= ${start} AND ar.anchor < ${end}
    ),
    ${descendantSessionsCte(rootIds)},
    ${treeCostCtes(rootIds)},
    -- MATERIALIZED: an inlined tree_costs is re-planned as the inner side of a nested loop
    -- over period_roots, recomputing every root's utility-call cost once per root (42 s
    -- instead of 0.4 s for ~100 roots on real data).
    period_tree_costs AS MATERIALIZED (SELECT * FROM tree_costs)
    SELECT
      pr.id, pr.session_id, pr.repo_id, pr.repo_url, pr.user_id, pr.user_email, pr.branch,
      pr.first_prompt, pr.start_time, pr.anchor, pr.has_claude_log, pr.otel_micros,
      to_char(pr.anchor AT TIME ZONE ${bounds.timeZone}::text, ${keyFormat}::text) AS bucket_key,
      tc.session_row_id, ${TREE_COST_COLUMNS_SQL}
    FROM period_roots pr
    LEFT JOIN period_tree_costs tc ON tc.session_row_id = pr.id
    ORDER BY pr.anchor, pr.id
  `);

  return (result.rows as unknown as PeriodTreeSqlRow[]).map((r) => ({
    id: toNumber(r.id),
    sessionId: r.session_id,
    repoId: toNumber(r.repo_id),
    repoUrl: r.repo_url,
    userId: toNumber(r.user_id),
    userEmail: r.user_email,
    branch: r.branch,
    firstPrompt: r.first_prompt,
    startTime: toDate(r.start_time),
    anchor: toDate(r.anchor),
    bucketKey: r.bucket_key,
    hasClaudeLog: r.has_claude_log === true,
    treeCost:
      r.session_row_id === null || r.session_row_id === undefined
        ? undefined
        : {
            session_row_id: r.session_row_id,
            main_cost: r.main_cost ?? null,
            main_model: r.main_model ?? null,
            subagent_cost: r.subagent_cost ?? null,
            subagent_count: r.subagent_count ?? null,
            subagent_pricing_missing: r.subagent_pricing_missing ?? null,
            subagent_unpriced_models: r.subagent_unpriced_models ?? null,
            subagent_cost_from_otel: r.subagent_cost_from_otel ?? null,
            utility_cost: r.utility_cost ?? null,
            utility_pricing_missing: r.utility_pricing_missing ?? null,
            utility_unpriced_models: r.utility_unpriced_models ?? null,
          },
    otelMicros: toNumberOrNull(r.otel_micros),
  }));
}

// ── Slice parts (DD-8) ───────────────────────────────────────────────────────────────────────

/** One hook sub-agent of a tree, priced like `tree_subagent_costs` does. */
export interface HookSubagentPart {
  rootId: number;
  model: string | null;
  /** `sessions.agent_description` of the sub-agent (null when unknown). */
  description: string | null;
  /** USD; null when the sub-agent is unpriced. */
  costUsd: number | null;
}

/** OTEL call costs of a root, summed per (model, main/sub-agent, agent, skill, MCP server). */
export interface OtelCallPart {
  rootId: number;
  model: string | null;
  /** `agent_id IS NULL` — a main-agent call. */
  isMain: boolean;
  agentName: string | null;
  skillName: string | null;
  mcpServerName: string | null;
  micros: number;
}

export interface SliceParts {
  subagents: HookSubagentPart[];
  otel: OtelCallPart[];
}

/**
 * The per-part costs the model / sub-agent / skill / MCP slices are built from (DD-8):
 * the hook sub-agents of each root (from `tree_subagent_rows`) and the OTEL per-call sums of
 * `otel_calls` selected by `session_id = ANY(rootIds)` — never by call time.
 */
export async function loadSliceParts(
  db: DrizzleDb,
  rootIds: readonly number[],
): Promise<SliceParts> {
  if (rootIds.length === 0) return { subagents: [], otel: [] };
  const idsArray = intArray(rootIds);

  const [subResult, otelResult] = await Promise.all([
    db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)},
      ${treeCostCtes(idsArray)}
      SELECT
        tsr.root_id,
        tsr.model_id::text AS model,
        sub.agent_description AS description,
        (CASE WHEN tsr.otel_cost IS NOT NULL
          THEN GREATEST(COALESCE(tsr.cost, 0.0), tsr.otel_cost)
          ELSE tsr.cost END)::float AS cost
      FROM tree_subagent_rows tsr
      LEFT JOIN sessions sub ON sub.id = tsr.stats_session_id
    `),
    db.execute(sql`
      SELECT
        c.session_id AS root_id,
        c.model,
        (c.agent_id IS NULL) AS is_main,
        c.agent_name,
        c.skill_name,
        c.mcp_server_name,
        SUM(c.cost_usd_micros)::text AS micros
      FROM otel_calls c
      WHERE c.session_id = ANY(${idsArray})
        AND c.cost_usd_micros IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5, 6
    `),
  ]);

  const subagents = (
    subResult.rows as {
      root_id: unknown;
      model: string | null;
      description: string | null;
      cost: unknown;
    }[]
  ).map((r) => ({
    rootId: toNumber(r.root_id),
    model: r.model,
    description: r.description,
    costUsd: toNumberOrNull(r.cost),
  }));
  const otel = (
    otelResult.rows as {
      root_id: unknown;
      model: string | null;
      is_main: boolean;
      agent_name: string | null;
      skill_name: string | null;
      mcp_server_name: string | null;
      micros: unknown;
    }[]
  ).map((r) => ({
    rootId: toNumber(r.root_id),
    model: r.model,
    isMain: r.is_main === true,
    agentName: r.agent_name,
    skillName: r.skill_name,
    mcpServerName: r.mcp_server_name,
    micros: toNumber(r.micros),
  }));
  return { subagents, otel };
}
