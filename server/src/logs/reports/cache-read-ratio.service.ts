import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import type { SessionAttributionAttributeDef } from '../../database/schema/index';
import {
  attributeFilterSql,
  attributeGroupLabels,
  parseGroupByAttrKey,
  type ParsedAttributeFilter,
} from '../attribute-filter.sql';
import { scopedUserFilterSql } from '../analytics/scoped-sessions.sql';
import { cacheReadRatio } from '../cache-ratio.sql';
import type { CacheThresholdSource } from '../repositories.service';
import type { CauseStatsScope } from '../session-cause-stats-writer';
import { descendantSessionsCte } from '../session-tree.sql';
import type { TeamScope } from '../team-scope';

/** Which of the two always-reported scopes an aggregate covers. */
export type CacheRatioScopeKey = 'root' | 'withDescendants';

/**
 * Optional per-group KPI breakdown, widened
 * to also accept `attr:<key>` — validated by the controller against the
 * repo's resolved attribute definitions via `assertKnownGroupByAttrKey()`, not by this type.
 */
export type CacheRatioGroupBy = 'none' | 'branch' | 'user' | `attr:${string}`;

export interface CacheRatioTokens {
  sessionCount: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Ratio-of-sums; `null` when read + write === 0. */
  ratio: number | null;
}

export interface CacheRatioScopeTotals extends CacheRatioTokens {
  /** `null` when no session in scope had a `model_pricing` match. */
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  undefinedRatioSessionCount: number;
}

export interface CacheRatioCauseEntry {
  turns: number;
  creationTokens: number;
  share: number;
}

export interface CacheRatioBucket {
  /** UTC `YYYY-MM-DD` day key. */
  bucket: string;
  root: CacheRatioTokens;
  withDescendants: CacheRatioTokens;
}

export interface CacheRatioGroup {
  group: string;
  root: CacheRatioScopeTotals;
  withDescendants: CacheRatioScopeTotals;
}

export interface CacheRatioCauses {
  /** Always root-only — the one deliberate asymmetry against the root/withDescendants pair. */
  scope: 'root';
  thresholdTokens: number;
  thresholdSource: CacheThresholdSource;
  /** Sessions whose stored cause row was computed with a different threshold. */
  staleSessionCount: number;
  /** Sessions with no `session_cause_stats` row for the resolved config scope. */
  sessionsWithoutCauseData: number;
  totalCreationTokens: number;
  compaction: CacheRatioCauseEntry;
  fileReread: CacheRatioCauseEntry;
  unattributed: CacheRatioCauseEntry;
}

export interface CacheReadRatioReportData {
  root: CacheRatioScopeTotals;
  withDescendants: CacheRatioScopeTotals;
  buckets: CacheRatioBucket[];
  groups?: CacheRatioGroup[];
  causes: CacheRatioCauses;
}

export interface CacheReadRatioOptions {
  teamId?: number;
  requesterUserId: number;
  /** The caller's resolved team access-mode scope — see `AnalyticsScope.scope`. */
  scope: TeamScope;
  startDate: Date;
  endDate: Date;
  branches: string[];
  users: string[];
  groupBy: CacheRatioGroupBy;
  /** Resolved by the controller via `getEffectiveCacheThreshold()`. */
  thresholdTokens: number;
  thresholdSource: CacheThresholdSource;
  /** Which `session_cause_stats` rows to read. */
  causeScope: CauseStatsScope;
  /** Applied to Phase A. */
  attributeFilters: ParsedAttributeFilter[];
  /** Needed only when `groupBy` is the `attr:<key>` form (orphaned values fold into "Not determined"). */
  resolvedAttributeDefinitions: SessionAttributionAttributeDef[];
}

/** The stored cause decomposition of one root session, for the resolved config scope. */
export interface CacheRatioCauseRow {
  threshold: number;
  compactionTokens: number;
  fileRereadTokens: number;
  unattributedTokens: number;
  compactionTurns: number;
  fileRereadTurns: number;
  unattributedTurns: number;
}

/**
 * One root session, with its own cache figures, its recursive-descendant rollup and its
 * scoped cause row already merged. This is the single input shape of every pure helper
 * below, which is what makes them testable without a database.
 *
 * Costs are carried as already-computed *amounts*, both for the root session and for the
 * descendants. They come from the stored `session_costs` terms (`cost_cache_read`,
 * `cost_cache_write_5m + cost_cache_write_1h`), which are priced per call at write time —
 * so a prompt-length pricing tier is reflected here exactly as in the sessions list.
 * `null` in any position means "this scope contributed nothing priceable".
 */
export interface CacheRatioSessionRow {
  startTime: string;
  branch: string | null;
  userEmail: string;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /**
   * This session's own cache-read cost in USD (stored `session_costs.cost_cache_read`);
   * `null` when the session is unpriced or has no `session_costs` row.
   */
  cacheReadCost: number | null;
  /**
   * This session's own cache-write cost in USD, both TTL buckets each at its own rate
   * (stored `cost_cache_write_5m + cost_cache_write_1h`). `null` together with
   * {@link cacheReadCost}, from the same unpriced session.
   */
  cacheWriteCost: number | null;
  descendantSessionCount: number;
  descendantCacheReadTokens: number;
  descendantCacheWriteTokens: number;
  descendantCacheWrite5mTokens: number;
  descendantCacheWrite1hTokens: number;
  descendantCacheReadCost: number | null;
  descendantCacheWriteCost: number | null;
  cause: CacheRatioCauseRow | null;
  /**
   * The session's whole `session_attribution.values` object (or `null` with no attribution
   * row), carried through only for `groupBy=attr:<key>` bucketing — never for
   * filtering, which is a `WHERE EXISTS` at the SQL level and never reaches TS.
   */
  attributionValues: Record<
    string,
    string | string[] | boolean | number | null
  > | null;
}

// --- Raw SQL row shapes -----------------------------------------------------------------

interface PhaseARow {
  session_row_id: string | number;
  start_time: string | Date;
  user_email: string;
  branch: string | null;
  cache_read_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  cache_write_5m_tokens: string | number | null;
  cache_write_1h_tokens: string | number | null;
  cache_read_cost: string | number | null;
  cache_write_cost: string | number | null;
  cause_threshold: string | number | null;
  compaction_tokens: string | number | null;
  file_reread_tokens: string | number | null;
  unattributed_tokens: string | number | null;
  compaction_turns: string | number | null;
  file_reread_turns: string | number | null;
  unattributed_turns: string | number | null;
  attribution_values: Record<
    string,
    string | string[] | boolean | number | null
  > | null;
}

interface PhaseBRow {
  session_row_id: string | number;
  descendant_session_count: string | number | null;
  cache_read_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  cache_write_5m_tokens: string | number | null;
  cache_write_1h_tokens: string | number | null;
  cache_read_cost: string | number | null;
  cache_write_cost: string | number | null;
  any_priced: boolean | null;
}

/**
 * `bigint` columns come back as strings from node-postgres, `float8` as numbers — this
 * normalizes both without silently turning a missing value into a misleading `0`.
 */
function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : parseFloat(value);
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : parseFloat(value);
}

/** Comma-separated bound parameters for an `IN (...)` list. Never inline the values. */
function textList(values: string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

// --- Pure helpers (exported for unit tests) ----------------------------------------------

interface ScopeTokenCounts {
  read: number;
  write: number;
  write5m: number;
  write1h: number;
  sessionCount: number;
}

/**
 * The token counts one row contributes to `scope`. `root` is the session's own figures;
 * `withDescendants` adds every recursive descendant — never a
 * single-level `parent_session_id` match.
 */
function scopeTokens(
  row: CacheRatioSessionRow,
  scope: CacheRatioScopeKey,
): ScopeTokenCounts {
  if (scope === 'root') {
    return {
      read: row.cacheReadTokens,
      write: row.cacheWriteTokens,
      write5m: row.cacheWrite5mTokens,
      write1h: row.cacheWrite1hTokens,
      sessionCount: 1,
    };
  }
  return {
    read: row.cacheReadTokens + row.descendantCacheReadTokens,
    write: row.cacheWriteTokens + row.descendantCacheWriteTokens,
    write5m: row.cacheWrite5mTokens + row.descendantCacheWrite5mTokens,
    write1h: row.cacheWrite1hTokens + row.descendantCacheWrite1hTokens,
    sessionCount: 1 + row.descendantSessionCount,
  };
}

/**
 * Ratio-of-sums token aggregate over `rows` for one scope: the ratio is
 * computed from the summed tokens, never as a mean of the per-session ratios. A session with
 * no cache traffic contributes 0 to both sums and so is inherently excluded.
 */
export function aggregateTokens(
  rows: CacheRatioSessionRow[],
  scope: CacheRatioScopeKey,
): CacheRatioTokens {
  let sessionCount = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;

  for (const row of rows) {
    const t = scopeTokens(row, scope);
    sessionCount += t.sessionCount;
    cacheReadTokens += t.read;
    cacheWriteTokens += t.write;
    cacheWrite5mTokens += t.write5m;
    cacheWrite1hTokens += t.write1h;
  }

  return {
    sessionCount,
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    ratio: cacheReadRatio(cacheReadTokens, cacheWriteTokens),
  };
}

/**
 * {@link aggregateTokens} plus the two cost figures and the undefined-ratio session count.
 *
 * Costs are `Σ` of each session's stored cache cost amounts; an unpriced session contributes
 * nothing, and both cost fields are `null` when *no* session in the scope was priced (so the
 * client can render `n/a` rather than a fake `$0.00`).
 *
 * `undefinedRatioSessionCount` counts **root** sessions whose scope denominator is zero —
 * the rows the report surfaces as "Sessions with undefined ratio (excluded)".
 */
export function aggregateScope(
  rows: CacheRatioSessionRow[],
  scope: CacheRatioScopeKey,
): CacheRatioScopeTotals {
  const tokens = aggregateTokens(rows, scope);

  let cacheReadCost = 0;
  let cacheWriteCost = 0;
  let anyPriced = false;
  let undefinedRatioSessionCount = 0;

  for (const row of rows) {
    const t = scopeTokens(row, scope);
    if (t.read + t.write === 0) {
      undefinedRatioSessionCount += 1;
    }

    if (row.cacheReadCost !== null) {
      cacheReadCost += row.cacheReadCost;
      anyPriced = true;
    }
    // Already each TTL bucket at its own rate (stored 5m + 1h terms).
    if (row.cacheWriteCost !== null) {
      cacheWriteCost += row.cacheWriteCost;
      anyPriced = true;
    }

    if (scope === 'withDescendants') {
      if (row.descendantCacheReadCost !== null) {
        cacheReadCost += row.descendantCacheReadCost;
        anyPriced = true;
      }
      if (row.descendantCacheWriteCost !== null) {
        cacheWriteCost += row.descendantCacheWriteCost;
        anyPriced = true;
      }
    }
  }

  return {
    ...tokens,
    cacheReadCost: anyPriced ? cacheReadCost : null,
    cacheWriteCost: anyPriced ? cacheWriteCost : null,
    undefinedRatioSessionCount,
  };
}

/**
 * Buckets rows into UTC `YYYY-MM-DD` days (bucketing happens in TS, not
 * SQL, and the day granularity is fixed regardless of `groupBy`). Only days that actually
 * carry a session appear; the result is sorted ascending by day key.
 */
export function bucketByDay(rows: CacheRatioSessionRow[]): CacheRatioBucket[] {
  const byDay = new Map<string, CacheRatioSessionRow[]>();

  for (const row of rows) {
    const time = new Date(row.startTime);
    if (isNaN(time.getTime())) continue;
    const key = time.toISOString().slice(0, 10);
    const existing = byDay.get(key);
    if (existing) {
      existing.push(row);
    } else {
      byDay.set(key, [row]);
    }
  }

  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, dayRows]) => ({
      bucket,
      root: aggregateTokens(dayRows, 'root'),
      withDescendants: aggregateTokens(dayRows, 'withDescendants'),
    }));
}

/**
 * The cause decomposition, built from the root sessions' scoped cause rows only.
 * Shares are computed against `totalCreationTokens`, so the three of
 * them sum to 1 whenever anything was attributed at all.
 */
export function buildCauses(
  rows: CacheRatioSessionRow[],
  thresholdTokens: number,
  thresholdSource: CacheThresholdSource,
): CacheRatioCauses {
  let compactionTokens = 0;
  let fileRereadTokens = 0;
  let unattributedTokens = 0;
  let compactionTurns = 0;
  let fileRereadTurns = 0;
  let unattributedTurns = 0;
  let staleSessionCount = 0;
  let sessionsWithoutCauseData = 0;

  for (const row of rows) {
    const cause = row.cause;
    if (cause === null) {
      sessionsWithoutCauseData += 1;
      continue;
    }
    if (cause.threshold !== thresholdTokens) {
      staleSessionCount += 1;
    }
    compactionTokens += cause.compactionTokens;
    fileRereadTokens += cause.fileRereadTokens;
    unattributedTokens += cause.unattributedTokens;
    compactionTurns += cause.compactionTurns;
    fileRereadTurns += cause.fileRereadTurns;
    unattributedTurns += cause.unattributedTurns;
  }

  const totalCreationTokens =
    compactionTokens + fileRereadTokens + unattributedTokens;
  const share = (tokens: number): number =>
    totalCreationTokens > 0 ? tokens / totalCreationTokens : 0;

  return {
    scope: 'root',
    thresholdTokens,
    thresholdSource,
    staleSessionCount,
    sessionsWithoutCauseData,
    totalCreationTokens,
    compaction: {
      turns: compactionTurns,
      creationTokens: compactionTokens,
      share: share(compactionTokens),
    },
    fileReread: {
      turns: fileRereadTurns,
      creationTokens: fileRereadTokens,
      share: share(fileRereadTokens),
    },
    unattributed: {
      turns: unattributedTurns,
      creationTokens: unattributedTokens,
      share: share(unattributedTokens),
    },
  };
}

/**
 * Per-group KPI tables — the chart stays per-day, so this is purely an
 * extra breakdown. Groups are ordered by root cache traffic descending, so the noisiest
 * branch/engineer is first.
 */
export function buildGroups(
  rows: CacheRatioSessionRow[],
  groupBy: CacheRatioGroupBy,
  resolvedDefinitions: SessionAttributionAttributeDef[] = [],
): CacheRatioGroup[] {
  if (groupBy === 'none') return [];

  const groupByAttrKey = parseGroupByAttrKey(groupBy);

  const byGroup = new Map<string, CacheRatioSessionRow[]>();
  for (const row of rows) {
    // Matches the `COALESCE(l.git_branch, 'no branch')` convention the branch filter uses.
    // Fan-out: a `string[]`-typed attribute's N values push this row's
    // full metric value into N buckets, not one joined bucket.
    const keys =
      groupByAttrKey !== undefined
        ? attributeGroupLabels(
            groupByAttrKey,
            row.attributionValues,
            resolvedDefinitions,
          )
        : [groupBy === 'branch' ? (row.branch ?? 'no branch') : row.userEmail];
    for (const key of keys) {
      const existing = byGroup.get(key);
      if (existing) {
        existing.push(row);
      } else {
        byGroup.set(key, [row]);
      }
    }
  }

  return Array.from(byGroup.entries())
    .map(([group, groupRows]) => ({
      group,
      root: aggregateScope(groupRows, 'root'),
      withDescendants: aggregateScope(groupRows, 'withDescendants'),
    }))
    .sort(
      (a, b) =>
        b.root.cacheReadTokens +
        b.root.cacheWriteTokens -
        (a.root.cacheReadTokens + a.root.cacheWriteTokens),
    );
}

@Injectable()
export class CacheReadRatioService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    opts: CacheReadRatioOptions,
  ): Promise<CacheReadRatioReportData> {
    const rows = await this.loadSessionRows(repoIds, opts);

    return {
      root: aggregateScope(rows, 'root'),
      withDescendants: aggregateScope(rows, 'withDescendants'),
      buckets: bucketByDay(rows),
      ...(opts.groupBy !== 'none'
        ? {
            groups: buildGroups(
              rows,
              opts.groupBy,
              opts.resolvedAttributeDefinitions,
            ),
          }
        : {}),
      causes: buildCauses(rows, opts.thresholdTokens, opts.thresholdSource),
    };
  }

  /**
   * Phase A (+A2) then Phase B, exactly the two-phase shape
   * `executive-summary.service.ts` uses: one query for the eligible root sessions, one for
   * the recursive-descendant rollup keyed on their ids. Two round trips regardless of how
   * many sessions the range holds.
   */
  private async loadSessionRows(
    repoIds: number[],
    opts: CacheReadRatioOptions,
  ): Promise<CacheRatioSessionRow[]> {
    const repoIdsLiteral = `{${repoIds.join(',')}}`;
    // Team access mode — the ids this caller may read; nothing at all in a
    // `transparent` team. See `scopedUserFilterSql`.
    const ownerFilter = scopedUserFilterSql(opts.scope, 'l');
    // `IN (list of bound params)` rather than `= ANY($n::text[])`: drizzle expands an
    // array placeholder into a comma-separated *parameter list*, so the `::text[]` form
    // reaches Postgres as `($6)::text[]` with a plain string bound to it and fails with
    // `malformed array literal`. Each value stays a bound parameter here, so a branch or
    // e-mail containing a quote or a comma is still handled safely.
    const branchFilter =
      opts.branches.length > 0
        ? sql`AND COALESCE(l.git_branch, 'no branch') IN (${textList(opts.branches)})`
        : sql``;
    const userFilter =
      opts.users.length > 0
        ? sql`AND u.email IN (${textList(opts.users)})`
        : sql``;
    const causeScopeFilter: SQL =
      opts.causeScope.teamId !== undefined
        ? sql`scs.team_id = ${opts.causeScope.teamId}`
        : sql`scs.user_id = ${opts.causeScope.userId}`;
    // Filtering is a `WHERE EXISTS` (never a
    // join), so it can never duplicate a Phase A row the way a naive join on a 1:1 table
    // wouldn't, but is included here for symmetry with the pattern everywhere else.
    const attrCondition = attributeFilterSql(opts.attributeFilters, sql`s.id`);
    const attrFilter = attrCondition ? sql`AND ${attrCondition}` : sql``;

    // Phase A — eligible root sessions with their own cache/TTL columns and their stored
    // cache cost terms (`session_costs`), plus (A2) the scoped cause row. The LEFT JOIN on session_cause_stats is
    // what makes a session with no row for this config scope countable as
    // `sessionsWithoutCauseData` instead of silently dropping out of the report. The LEFT
    // JOIN on `session_attribution` is separate from the `attrFilter` predicate
    // above — it exists only to carry each row's `values` through for `groupBy=attr:<key>`;
    // a session with no attribution row still gets its own Phase A row,
    // just with `attribution_values: null`.
    const result = await this.db.execute(sql`
      SELECT
        s.id                                    AS session_row_id,
        l.start_time                            AS start_time,
        u.email                                 AS user_email,
        l.git_branch                            AS branch,
        COALESCE(ss.cache_read_tokens, 0)       AS cache_read_tokens,
        COALESCE(ss.cache_write_tokens, 0)      AS cache_write_tokens,
        COALESCE(ss.cache_write_5m_tokens, 0)   AS cache_write_5m_tokens,
        COALESCE(ss.cache_write_1h_tokens, 0)   AS cache_write_1h_tokens,
        sc.cost_cache_read                      AS cache_read_cost,
        sc.cost_cache_write_5m + sc.cost_cache_write_1h AS cache_write_cost,
        scs.threshold                           AS cause_threshold,
        scs.compaction_tokens                   AS compaction_tokens,
        scs.file_reread_tokens                  AS file_reread_tokens,
        scs.unattributed_tokens                 AS unattributed_tokens,
        scs.compaction_turns                    AS compaction_turns,
        scs.file_reread_turns                   AS file_reread_turns,
        scs.unattributed_turns                  AS unattributed_turns,
        attr_sa.values                          AS attribution_values
      FROM sessions s
      INNER JOIN logs l ON l.session_id = s.id
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      INNER JOIN users u ON u.id = l.user_id
      LEFT JOIN session_stats ss ON ss.session_id = s.id
      LEFT JOIN session_cause_stats scs
        ON scs.session_id = s.id AND ${causeScopeFilter}
      LEFT JOIN session_attribution attr_sa ON attr_sa.session_id = s.id
      -- Stored per-session cost terms (NULL when unpriced or no row).
      LEFT JOIN session_costs sc ON sc.session_id = s.id
      WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
        AND l.log_type = 'artisyn'
        AND l.first_prompt IS NOT NULL
        AND s.deleted = false
        AND EXISTS (
          SELECT 1 FROM logs cl
          WHERE cl.session_id = l.session_id AND cl.log_type = 'claude'
        )
        AND l.start_time >= ${opts.startDate}
        AND l.start_time <= ${opts.endDate}
        ${ownerFilter}
        ${branchFilter}
        ${userFilter}
        ${attrFilter}
    `);

    const phaseARows = result.rows as unknown as PhaseARow[];
    if (phaseARows.length === 0) return [];

    // Phase B — recursive descendants (depth > 0) of Phase A's sessions: cache/TTL token
    // rollup plus their own stored cache cost terms (`session_costs`, priced per
    // descendant model at write time — a sub-agent tree routinely mixes models).
    const idsLiteral = `{${phaseARows.map((r) => Number(r.session_row_id)).join(',')}}`;
    const idsArray = sql`${idsLiteral}::bigint[]`;
    const rollupResult = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)},
      descendant_cache AS (
        SELECT
          ds.root_id AS session_row_id,
          COUNT(*) AS descendant_session_count,
          COALESCE(SUM(ss.cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(ss.cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(ss.cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
          COALESCE(SUM(ss.cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
          COALESCE(SUM(sub_sc.cost_cache_read), 0.0) AS cache_read_cost,
          COALESCE(SUM(sub_sc.cost_cache_write_5m + sub_sc.cost_cache_write_1h), 0.0)
            AS cache_write_cost,
          COALESCE(BOOL_OR(sub_sc.cost IS NOT NULL), false) AS any_priced
        FROM descendant_sessions ds
        JOIN session_stats ss ON ss.session_id = ds.id
          -- Excludes an OTEL-only session_stats row (no transcript ever
          -- uploaded for it) from the descendant cache/cost rollup.
          AND EXISTS (
            SELECT 1 FROM logs tl
            WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
          )
        -- Stored sub-agent cost terms (priced at the ROOT's price date at write time).
        LEFT JOIN session_costs sub_sc ON sub_sc.session_id = ds.id
        WHERE ds.depth > 0
        GROUP BY ds.root_id
      )
      SELECT * FROM descendant_cache
    `);

    const rollupByRowId = new Map<number, PhaseBRow>();
    for (const row of rollupResult.rows as unknown as PhaseBRow[]) {
      rollupByRowId.set(Number(row.session_row_id), row);
    }

    return phaseARows.map((r) => {
      const rollup = rollupByRowId.get(Number(r.session_row_id));
      const descendantsPriced = rollup?.any_priced === true;
      const startTime =
        r.start_time instanceof Date
          ? r.start_time.toISOString()
          : new Date(r.start_time).toISOString();

      return {
        startTime,
        branch: r.branch,
        userEmail: r.user_email,
        cacheReadTokens: num(r.cache_read_tokens),
        cacheWriteTokens: num(r.cache_write_tokens),
        cacheWrite5mTokens: num(r.cache_write_5m_tokens),
        cacheWrite1hTokens: num(r.cache_write_1h_tokens),
        cacheReadCost: numOrNull(r.cache_read_cost),
        cacheWriteCost: numOrNull(r.cache_write_cost),
        descendantSessionCount: num(rollup?.descendant_session_count),
        descendantCacheReadTokens: num(rollup?.cache_read_tokens),
        descendantCacheWriteTokens: num(rollup?.cache_write_tokens),
        descendantCacheWrite5mTokens: num(rollup?.cache_write_5m_tokens),
        descendantCacheWrite1hTokens: num(rollup?.cache_write_1h_tokens),
        descendantCacheReadCost: descendantsPriced
          ? num(rollup?.cache_read_cost)
          : null,
        descendantCacheWriteCost: descendantsPriced
          ? num(rollup?.cache_write_cost)
          : null,
        cause:
          r.cause_threshold !== null && r.cause_threshold !== undefined
            ? {
                threshold: num(r.cause_threshold),
                compactionTokens: num(r.compaction_tokens),
                fileRereadTokens: num(r.file_reread_tokens),
                unattributedTokens: num(r.unattributed_tokens),
                compactionTurns: num(r.compaction_turns),
                fileRereadTurns: num(r.file_reread_turns),
                unattributedTurns: num(r.unattributed_turns),
              }
            : null,
        attributionValues: r.attribution_values ?? null,
      };
    });
  }
}
