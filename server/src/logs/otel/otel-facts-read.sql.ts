/**
 * Read SQL of the OTEL tabs (2026-10-30 otel-tabs-traces): the repository facts route, the
 * session OTEL route and — through the same building blocks — the team facts route.
 *
 * **Scope (DD-6).** The repository and session reads take their roots from `scoped_roots`, the
 * CTE `scopedTreeCtes` (`tool-monitoring/tool-usage-read.sql.ts`) builds for the Tools/MCP tab:
 * roots whose `artisyn` log is linked to one of `repoIds`, not deleted (`sessions.deleted =
 * false`), filtered by the caller's team access-mode row filter. Every OTEL row belongs to the
 * root (DD-1), so the sub-agent walk that CTE also defines is never read here.
 *
 * **Bucket source.** Most repository aggregates read one filtered CTE `fb` over
 * `otel_cost_buckets` ({@link repoBucketSource}): the scoped roots' rows in `[from, to)`, through
 * the primary key's leading `(session_id, bucket_start)`, narrowed by the `calls` / model /
 * ccVersion filters, zero rows dropped (DD-7: a rebuilt key is zeroed, never deleted). Its
 * `uid` is the bucket's user, falling back to the root's uploader.
 *
 * **Rolling (DD-18, DD-19).** 5-minute UTC buckets roll up with `date_trunc(unit, bucket_start,
 * tz)`; every current UTC offset is a multiple of 15 min, so the roll is exact.
 *
 * Every amount is summed in SQL and returned as a decimal string (`bigint` / `numeric` from
 * node-postgres), never as a float.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  scopedUserFilterSql,
  textList,
} from '../analytics/scoped-sessions.sql';
import { topAncestorIdsSql } from '../session-tree.sql';
import type { TeamScope } from '../team-scope';
import {
  scopedTreeCtes,
  type ToolUsageReadScope,
} from '../tool-monitoring/tool-usage-read.sql';
import {
  OTEL_CHUNK_DELAY_MS,
  OTEL_COVERED_STATES,
  OTEL_NO_STATUS_REASON,
  OTEL_SESSION_ENDED_MS,
} from './otel-facts.constants';
import type {
  OtelCallsFilter,
  OtelChangeKind,
  OtelInterval,
  OtelStructure,
} from './otel-facts.types';
import { OTEL_SOURCE_CHUNK_BIT } from './otel-facts-writer';

/** The caller's resolved scope — the Tools/MCP tab's (`repoIds`, team scope, optional root). */
export type OtelReadScope = ToolUsageReadScope;

/** A half-open time window `[from, to)` over `otel_cost_buckets.bucket_start`. */
export interface OtelWindow {
  from: Date;
  to: Date;
}

/** The chart filters (API changes): `calls`, `model[]`, `ccVersion[]`. */
export interface OtelBucketFilters {
  calls: OtelCallsFilter;
  models: string[];
  ccVersions: string[];
}

/** No filter at all (filter options, presence, the session route). */
export const OTEL_NO_FILTERS: OtelBucketFilters = {
  calls: 'all',
  models: [],
  ccVersions: [],
};

/** The open-ended upper bound the session route scopes with (a session has no period). */
const ALL_TIME_TO = new Date('9999-12-31T23:59:59.999Z');

type DbValue = string | number | null | undefined;
type DbDate = Date | string | null | undefined;

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

/** A node-postgres numeric / bigint value as an integer decimal string ("0" when missing). */
export function microsText(value: DbValue): string {
  if (value === null || value === undefined || value === '') return '0';
  const text = String(value);
  // SUM over bigint is numeric; it never carries a fraction, but be safe with a stray ".0".
  const dot = text.indexOf('.');
  return dot === -1 ? text : text.slice(0, dot) || '0';
}

export function microsTextOrNull(value: DbValue): string | null {
  return value === null || value === undefined ? null : microsText(value);
}

export function toNum(value: DbValue): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function toDate(value: DbDate): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

export function toIso(value: DbDate): string | null {
  const d = toDate(value);
  return d === null ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

/**
 * The `scoped_roots` CTE list (plus the unused `descendant_sessions`) for the repository and
 * session routes (DD-6), without the `WITH RECURSIVE` keyword. Roots started after `to` are left
 * out — they cannot hold a bucket before `to`.
 */
export function otelScopedRootsCtes(scope: OtelReadScope, to: Date): SQL {
  return scopedTreeCtes(scope, { from: new Date(0), to });
}

/** The stack-by column of a bucket row in alias `fb` (`''` already stands for NULL). */
export type OtelStackColumn =
  | 'structure'
  | 'querySource'
  | 'model'
  | 'ccVersion';

export function stackKeySql(stackBy: OtelStackColumn): SQL {
  switch (stackBy) {
    case 'structure':
      return sql`fb.structure`;
    case 'querySource':
      return sql`fb.query_source`;
    case 'model':
      return sql`fb.model`;
    case 'ccVersion':
      return sql`fb.cc_version`;
  }
}

/** The rolled bucket start of alias `fb` for an interval and IANA time zone (DD-18). */
export function rolledStartSql(interval: OtelInterval, tz: string): SQL {
  switch (interval) {
    case '5m':
      return sql`fb.bucket_start`;
    case '1h':
      return sql`date_trunc('hour', fb.bucket_start, ${tz}::text)`;
    case '1d':
      return sql`date_trunc('day', fb.bucket_start, ${tz}::text)`;
  }
}

/** The `calls` / model / ccVersion predicates on a bucket alias `b` (DD-19). */
function bucketFilterSql(filters: OtelBucketFilters): SQL {
  const parts: SQL[] = [];
  if (filters.calls === 'hidden') {
    parts.push(sql`AND b.structure = 'hidden'`);
  } else if (filters.calls === 'transcript') {
    parts.push(sql`AND b.structure IN ('main', 'subagent')`);
  }
  if (filters.models.length > 0) {
    parts.push(sql`AND b.model IN (${textList(filters.models)})`);
  }
  if (filters.ccVersions.length > 0) {
    parts.push(sql`AND b.cc_version IN (${textList(filters.ccVersions)})`);
  }
  return parts.length === 0 ? sql`` : sql.join(parts, sql` `);
}

/**
 * Extra `fb` columns and joins (alias `r` = the scoped root): the team route adds the root's
 * primary team repository (`repo_key`, `repo_url`, DD-29).
 */
export interface OtelBucketSourceExtra {
  columns: SQL;
  joins: SQL;
}

/**
 * `WITH RECURSIVE <roots>, fb AS (…)`: the scoped roots' non-zero bucket rows in `window`,
 * narrowed by `filters`. `roots` is a CTE list that defines `scoped_roots(id, user_id)` —
 * {@link otelScopedRootsCtes} for the repository route; the team route passes its own.
 */
export function repoBucketSource(
  roots: SQL,
  window: OtelWindow,
  filters: OtelBucketFilters,
  extra?: OtelBucketSourceExtra,
): SQL {
  return sql`WITH RECURSIVE ${roots},
  fb AS (
    SELECT b.session_id, COALESCE(b.user_id, r.user_id) AS uid, b.bucket_start, b.structure,
           b.query_source, b.model, b.cc_version, b.calls, b.cost_usd_micros, b.input_tokens,
           b.output_tokens, b.cache_read_tokens, b.cache_write_tokens, b.seq, b.change_kind
           ${extra ? sql`, ${extra.columns}` : sql``}
      FROM scoped_roots r
      JOIN otel_cost_buckets b ON b.session_id = r.id
      ${extra ? extra.joins : sql``}
     WHERE b.bucket_start >= ${window.from}
       AND b.bucket_start < ${window.to}
       AND b.calls <> 0
       ${bucketFilterSql(filters)}
  )`;
}

/**
 * `WITH fb AS (…)`: one root's bucket rows. `includeZero` keeps zeroed keys, which a delta
 * needs so the client can clear a bucket that emptied after a reclassification.
 */
export function sessionBucketSource(rootId: number, includeZero = false): SQL {
  return sql`WITH fb AS (
    SELECT b.session_id, b.user_id AS uid, b.bucket_start, b.structure, b.query_source,
           b.model, b.cc_version, b.calls, b.cost_usd_micros, b.input_tokens, b.output_tokens,
           b.cache_read_tokens, b.cache_write_tokens, b.seq, b.change_kind
      FROM otel_cost_buckets b
     WHERE b.session_id = ${rootId}
       ${includeZero ? sql`` : sql`AND b.calls <> 0`}
  )`;
}

// ---------------------------------------------------------------------------
// Rolled buckets (DD-19)
// ---------------------------------------------------------------------------

export interface OtelBucketSqlRow {
  start: Date;
  key: string;
  calls: number;
  costUsdMicros: string;
  tokens: string;
  changeKind: OtelChangeKind;
}

interface BucketDbRow {
  start: DbDate;
  key: string | null;
  calls: DbValue;
  cost: DbValue;
  tokens: DbValue;
  change_kind: string | null;
}

function toBucketRow(r: BucketDbRow): OtelBucketSqlRow {
  return {
    start: toDate(r.start) ?? new Date(0),
    key: r.key ?? '',
    calls: toNum(r.calls),
    costUsdMicros: microsText(r.cost),
    tokens: microsText(r.tokens),
    changeKind: (r.change_kind ?? 'new') as OtelChangeKind,
  };
}

/** The value columns of a rolled bucket, over alias `fb`. */
const BUCKET_VALUES = sql`
  COALESCE(SUM(fb.calls), 0) AS calls,
  COALESCE(SUM(fb.cost_usd_micros), 0) AS cost,
  COALESCE(SUM(fb.input_tokens + fb.output_tokens + fb.cache_read_tokens
               + fb.cache_write_tokens), 0) AS tokens,
  (array_agg(fb.change_kind ORDER BY fb.seq DESC))[1] AS change_kind`;

/**
 * Snapshot: every rolled bucket of `source` (a {@link repoBucketSource} or
 * {@link sessionBucketSource}), per stack key. `changeKind` is the kind of the newest (max-seq)
 * underlying row (DD-20).
 */
export async function loadRolledBuckets(
  db: DrizzleDb,
  source: SQL,
  interval: OtelInterval,
  tz: string,
  keySql: SQL,
): Promise<OtelBucketSqlRow[]> {
  const roll = rolledStartSql(interval, tz);
  const result = await db.execute(sql`
    ${source}
    SELECT ${roll} AS start, ${keySql} AS key, ${BUCKET_VALUES}
      FROM fb
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  return (result.rows as unknown as BucketDbRow[]).map(toBucketRow);
}

/**
 * Delta (DD-19): the rolled buckets touched by a row with `since < seq` — their FULL values over
 * every row of the root (zero rows included, so an emptied bucket comes back with zeros).
 */
export async function loadSessionDeltaBuckets(
  db: DrizzleDb,
  rootId: number,
  since: number,
  interval: OtelInterval,
  tz: string,
  keySql: SQL,
): Promise<OtelBucketSqlRow[]> {
  const roll = rolledStartSql(interval, tz);
  const result = await db.execute(sql`
    ${sessionBucketSource(rootId, true)},
    changed AS (
      SELECT DISTINCT ${roll} AS start, ${keySql} AS key FROM fb WHERE fb.seq > ${since}
    )
    SELECT ${roll} AS start, ${keySql} AS key, ${BUCKET_VALUES}
      FROM fb
     WHERE (${roll}, ${keySql}) IN (SELECT start, key FROM changed)
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);
  return (result.rows as unknown as BucketDbRow[]).map(toBucketRow);
}

// ---------------------------------------------------------------------------
// KPIs (API changes, DD-28)
// ---------------------------------------------------------------------------

/** The raw KPI sums of one window; the reader derives the ratios. */
export interface OtelKpiSums {
  /** Bucket rows in the window — 0 means "no data" (`kpisPrev` = null). */
  rowCount: number;
  totalCostUsdMicros: string;
  activeDays: number;
  apiCalls: number;
  modelCount: number;
  hiddenCostUsdMicros: string;
  hiddenCalls: number;
  subagentCostUsdMicros: string;
  sessions: number;
  users: number;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  /** Median of the per-session cost, rounded; null without sessions. */
  medianSessionCostUsdMicros: string | null;
}

interface KpiDbRow {
  row_count: DbValue;
  total_cost: DbValue;
  active_days: DbValue;
  api_calls: DbValue;
  model_count: DbValue;
  hidden_cost: DbValue;
  hidden_calls: DbValue;
  subagent_cost: DbValue;
  sessions: DbValue;
  users: DbValue;
  input_tokens: DbValue;
  output_tokens: DbValue;
  cache_read_tokens: DbValue;
  cache_write_tokens: DbValue;
  median_session_cost: DbValue;
}

/**
 * The KPI sums of `source` (DD-28: token sums included). `activeDays` counts distinct days in
 * the caller's time zone. The same query over the previous window gives `kpisPrev`.
 */
export async function loadKpiSums(
  db: DrizzleDb,
  source: SQL,
  tz: string,
): Promise<OtelKpiSums> {
  const result = await db.execute(sql`
    ${source},
    per_session AS (
      SELECT fb.session_id, SUM(fb.cost_usd_micros) AS cost FROM fb GROUP BY fb.session_id
    )
    SELECT
      COUNT(*) AS row_count,
      COALESCE(SUM(fb.cost_usd_micros), 0) AS total_cost,
      COUNT(DISTINCT date_trunc('day', fb.bucket_start, ${tz}::text)) AS active_days,
      COALESCE(SUM(fb.calls), 0) AS api_calls,
      COUNT(DISTINCT NULLIF(fb.model, '')) AS model_count,
      COALESCE(SUM(fb.cost_usd_micros) FILTER (WHERE fb.structure = 'hidden'), 0) AS hidden_cost,
      COALESCE(SUM(fb.calls) FILTER (WHERE fb.structure = 'hidden'), 0) AS hidden_calls,
      COALESCE(SUM(fb.cost_usd_micros) FILTER (WHERE fb.structure = 'subagent'), 0)
        AS subagent_cost,
      COUNT(DISTINCT fb.session_id) AS sessions,
      COUNT(DISTINCT fb.uid) AS users,
      COALESCE(SUM(fb.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(fb.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(fb.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(fb.cache_write_tokens), 0) AS cache_write_tokens,
      (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.cost))::bigint
         FROM per_session ps) AS median_session_cost
    FROM fb
  `);
  const r = (result.rows as unknown as KpiDbRow[])[0];
  return {
    rowCount: toNum(r?.row_count),
    totalCostUsdMicros: microsText(r?.total_cost),
    activeDays: toNum(r?.active_days),
    apiCalls: toNum(r?.api_calls),
    modelCount: toNum(r?.model_count),
    hiddenCostUsdMicros: microsText(r?.hidden_cost),
    hiddenCalls: toNum(r?.hidden_calls),
    subagentCostUsdMicros: microsText(r?.subagent_cost),
    sessions: toNum(r?.sessions),
    users: toNum(r?.users),
    inputTokens: microsText(r?.input_tokens),
    outputTokens: microsText(r?.output_tokens),
    cacheReadTokens: microsText(r?.cache_read_tokens),
    cacheWriteTokens: microsText(r?.cache_write_tokens),
    medianSessionCostUsdMicros: microsTextOrNull(r?.median_session_cost),
  };
}

// ---------------------------------------------------------------------------
// query_source table
// ---------------------------------------------------------------------------

export interface OtelQuerySourceSqlRow {
  querySource: string;
  calls: number;
  sessions: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  /** input + cache read + cache write tokens. */
  contextTokens: number;
  outputTokens: number;
  models: string[];
}

interface QuerySourceDbRow {
  query_source: string | null;
  calls: DbValue;
  sessions: DbValue;
  cost: DbValue;
  hidden_cost: DbValue;
  context_tokens: DbValue;
  output_tokens: DbValue;
  models: string[] | null;
}

/** Per-`query_source` sums of `source`, most expensive first. */
export async function loadQuerySourceRows(
  db: DrizzleDb,
  source: SQL,
): Promise<OtelQuerySourceSqlRow[]> {
  const result = await db.execute(sql`
    ${source}
    SELECT
      fb.query_source,
      COALESCE(SUM(fb.calls), 0) AS calls,
      COUNT(DISTINCT fb.session_id) AS sessions,
      COALESCE(SUM(fb.cost_usd_micros), 0) AS cost,
      COALESCE(SUM(fb.cost_usd_micros) FILTER (WHERE fb.structure = 'hidden'), 0) AS hidden_cost,
      COALESCE(SUM(fb.input_tokens + fb.cache_read_tokens + fb.cache_write_tokens), 0)
        AS context_tokens,
      COALESCE(SUM(fb.output_tokens), 0) AS output_tokens,
      array_agg(DISTINCT fb.model ORDER BY fb.model) FILTER (WHERE fb.model <> '') AS models
    FROM fb
    GROUP BY fb.query_source
    ORDER BY SUM(fb.cost_usd_micros) DESC, fb.query_source
  `);
  return (result.rows as unknown as QuerySourceDbRow[]).map((r) => ({
    querySource: r.query_source ?? '',
    calls: toNum(r.calls),
    sessions: toNum(r.sessions),
    costUsdMicros: microsText(r.cost),
    hiddenCostUsdMicros: microsText(r.hidden_cost),
    contextTokens: toNum(r.context_tokens),
    outputTokens: toNum(r.output_tokens),
    models: r.models ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Cost flow (DD-28)
// ---------------------------------------------------------------------------

export interface OtelFlowSqlRow {
  model: string | null;
  userEmail: string | null;
  branch: string | null;
  /** The team repository URL (team route only, DD-29); null on the repository route. */
  repository: string | null;
  other: boolean;
  costUsdMicros: string;
  calls: number;
  sessions: number;
}

interface FlowDbRow {
  model: string | null;
  user_email: string | null;
  repository: string | null;
  branch: string | null;
  other: boolean;
  cost: DbValue;
  calls: DbValue;
  sessions: DbValue;
}

/**
 * The cost flow rows of `source` (DD-28): one row per `(model, user e-mail, repository, branch)`
 * — `repositorySql` (an expression over `fb`) is the team repository URL on the team route
 * (DD-29) and NULL on the repository route — where
 * `branch` is the root session's `artisyn` `logs.git_branch` (per session, not per call). The
 * `limit` most expensive rows come back as they are; the rest is folded into one `other` row
 * whose model / user / branch are NULL (absent when nothing is left over).
 */
export async function loadFlowRows(
  db: DrizzleDb,
  source: SQL,
  limit: number,
  repositorySql: SQL = sql`NULL::text`,
): Promise<OtelFlowSqlRow[]> {
  const result = await db.execute(sql`
    ${source},
    fl AS (
      SELECT NULLIF(fb.model, '') AS model, u.email AS user_email,
             ${repositorySql} AS repository, rl.git_branch AS branch,
             fb.session_id, fb.cost_usd_micros, fb.calls
        FROM fb
        LEFT JOIN users u ON u.id = fb.uid
        LEFT JOIN logs rl ON rl.session_id = fb.session_id AND rl.log_type = 'artisyn'
    ),
    g AS (
      SELECT model, user_email, repository, branch,
             SUM(cost_usd_micros) AS cost, SUM(calls) AS calls,
             COUNT(DISTINCT session_id) AS sessions,
             ROW_NUMBER() OVER (
               ORDER BY SUM(cost_usd_micros) DESC, model, user_email, repository, branch
             ) AS rn
        FROM fl
       GROUP BY model, user_email, repository, branch
    ),
    rest AS (
      SELECT fl.* FROM fl
        JOIN g ON g.rn > ${limit}
             AND g.model IS NOT DISTINCT FROM fl.model
             AND g.user_email IS NOT DISTINCT FROM fl.user_email
             AND g.repository IS NOT DISTINCT FROM fl.repository
             AND g.branch IS NOT DISTINCT FROM fl.branch
    )
    SELECT model, user_email, repository, branch, false AS other, cost, calls, sessions
      FROM g WHERE rn <= ${limit}
    UNION ALL
    SELECT NULL, NULL, NULL, NULL, true, SUM(cost_usd_micros), SUM(calls),
           COUNT(DISTINCT session_id)
      FROM rest
    HAVING COUNT(*) > 0
    ORDER BY 5, 6 DESC
  `);
  return (result.rows as unknown as FlowDbRow[]).map((r) => ({
    model: r.model,
    userEmail: r.user_email,
    branch: r.branch,
    repository: r.repository,
    other: r.other === true,
    costUsdMicros: microsText(r.cost),
    calls: toNum(r.calls),
    sessions: toNum(r.sessions),
  }));
}

// ---------------------------------------------------------------------------
// Sessions table
// ---------------------------------------------------------------------------

export interface OtelSessionSqlRow {
  sessionId: string;
  startedAt: Date | null;
  firstPrompt: string | null;
  ownerId: number | null;
  userEmail: string | null;
  ccVersions: string[];
  calls: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  hasTraces: boolean;
  lastAt: Date | null;
  unconfirmedCalls: number;
}

interface SessionDbRow {
  session_id: string;
  started_at: DbDate;
  first_prompt: string | null;
  owner_id: DbValue;
  user_email: string | null;
  cc_versions: string[] | null;
  calls: DbValue;
  cost: DbValue;
  hidden_cost: DbValue;
  has_spans: boolean | null;
  last_at: DbDate;
  unconfirmed: DbValue;
}

/**
 * The sessions table (API changes): the roots of `source` (a {@link repoBucketSource}), newest
 * first, at most `limit`. `firstPrompt` is the root `artisyn` log's (where ingest stores it) — unmasked; the reader masks
 * it (DD-22). The unconfirmed-call count runs only for the rows kept and only for a root that
 * ever received realtime data.
 */
export async function loadSessionRows(
  db: DrizzleDb,
  source: SQL,
  limit: number,
): Promise<OtelSessionSqlRow[]> {
  const result = await db.execute(sql`
    ${source},
    ps AS (
      SELECT fb.session_id,
             SUM(fb.calls) AS calls,
             SUM(fb.cost_usd_micros) AS cost,
             COALESCE(SUM(fb.cost_usd_micros) FILTER (WHERE fb.structure = 'hidden'), 0)
               AS hidden_cost,
             array_agg(DISTINCT fb.cc_version) FILTER (WHERE fb.cc_version <> '') AS cc_versions,
             MIN(fb.bucket_start) AS first_bucket
        FROM fb
       GROUP BY fb.session_id
    ),
    top AS (
      SELECT ps.*, s.session_id AS session_uuid, r.user_id AS owner_id,
             COALESCE(al.start_time, ps.first_bucket) AS started_at,
             al.first_prompt, u.email AS user_email, st.has_spans,
             st.rt_last_at, GREATEST(st.rt_last_at, st.chunk_last_at) AS last_at
        FROM ps
        JOIN sessions s ON s.id = ps.session_id
        JOIN scoped_roots r ON r.id = ps.session_id
        LEFT JOIN logs al ON al.session_id = ps.session_id AND al.log_type = 'artisyn'
        LEFT JOIN users u ON u.id = r.user_id
        LEFT JOIN otel_session_state st ON st.session_id = ps.session_id
       ORDER BY COALESCE(al.start_time, ps.first_bucket) DESC, ps.session_id DESC
       LIMIT ${limit}
    )
    SELECT top.session_uuid AS session_id, top.started_at, top.first_prompt, top.owner_id,
           top.user_email, top.cc_versions, top.calls, top.cost, top.hidden_cost,
           top.has_spans, top.last_at, COALESCE(uc.n, 0) AS unconfirmed
      FROM top
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS n FROM otel_calls c
         WHERE top.rt_last_at IS NOT NULL
           AND c.session_id = top.session_id
           AND (c.source_mask & ${OTEL_SOURCE_CHUNK_BIT}) = 0
      ) uc ON true
     ORDER BY top.started_at DESC, top.session_id DESC
  `);
  return (result.rows as unknown as SessionDbRow[]).map((r) => ({
    sessionId: r.session_id,
    startedAt: toDate(r.started_at),
    firstPrompt: r.first_prompt,
    ownerId:
      r.owner_id === null || r.owner_id === undefined
        ? null
        : toNum(r.owner_id),
    userEmail: r.user_email,
    ccVersions: r.cc_versions ?? [],
    calls: toNum(r.calls),
    costUsdMicros: microsText(r.cost),
    hiddenCostUsdMicros: microsText(r.hidden_cost),
    hasTraces: r.has_spans === true,
    lastAt: toDate(r.last_at),
    unconfirmedCalls: toNum(r.unconfirmed),
  }));
}

// ---------------------------------------------------------------------------
// Presence, filter options, realtime counts, hook versions
// ---------------------------------------------------------------------------

export interface OtelPresence {
  /** Any scoped root has an `otel_session_state` row (else empty state A). */
  hasOtel: boolean;
  /** Any non-zero bucket of a scoped root in the window, unfiltered (else empty state C). */
  hasOtelInPeriod: boolean;
}

export async function loadPresence(
  db: DrizzleDb,
  roots: SQL,
  window: OtelWindow,
): Promise<OtelPresence> {
  const result = await db.execute(sql`
    WITH RECURSIVE ${roots}
    SELECT
      EXISTS (
        SELECT 1 FROM scoped_roots r JOIN otel_session_state st ON st.session_id = r.id
      ) AS has_otel,
      EXISTS (
        SELECT 1 FROM scoped_roots r
          JOIN otel_cost_buckets b ON b.session_id = r.id
         WHERE b.bucket_start >= ${window.from}
           AND b.bucket_start < ${window.to}
           AND b.calls <> 0
      ) AS has_in_period
  `);
  const r = (
    result.rows as unknown as { has_otel: boolean; has_in_period: boolean }[]
  )[0];
  return {
    hasOtel: r?.has_otel === true,
    hasOtelInPeriod: r?.has_in_period === true,
  };
}

export interface OtelFilterOptionsRows {
  models: string[];
  ccVersions: string[];
}

/**
 * Every model and Claude Code version of the scoped roots' buckets in the window, without the
 * chart filters, so a picker keeps every choice after one is selected.
 */
export async function loadFilterOptions(
  db: DrizzleDb,
  roots: SQL,
  window: OtelWindow,
): Promise<OtelFilterOptionsRows> {
  const result = await db.execute(sql`
    ${repoBucketSource(roots, window, OTEL_NO_FILTERS)}
    SELECT
      array_agg(DISTINCT fb.model ORDER BY fb.model) FILTER (WHERE fb.model <> '') AS models,
      array_agg(DISTINCT fb.cc_version) FILTER (WHERE fb.cc_version <> '') AS cc_versions
    FROM fb
  `);
  const r = (
    result.rows as unknown as {
      models: string[] | null;
      cc_versions: string[] | null;
    }[]
  )[0];
  return { models: r?.models ?? [], ccVersions: r?.cc_versions ?? [] };
}

export interface OtelRealtimeCountRows {
  unconfirmedCalls: number;
  realtimeSessions: number;
  chunkDelayedSessions: number;
  gapSessions: number;
}

/**
 * The realtime counts of the repository / team facts (DD-14) over the scoped roots whose last
 * OTEL data (realtime or chunk) is not older than `activeSince` (the period start), so an old
 * period does not carry a notice forever. The per-root rules are the session status's:
 * realtime = `rt_last_at` within `OTEL_SESSION_ENDED_MS`; chunk delayed = realtime ahead of the
 * newest chunk by more than `OTEL_CHUNK_DELAY_MS`, or no chunk yet and realtime older than that;
 * gap = `rt_gap_at` set.
 */
export async function loadRealtimeCounts(
  db: DrizzleDb,
  roots: SQL,
  activeSince: Date,
  now: Date,
): Promise<OtelRealtimeCountRows> {
  const endedCutoff = new Date(now.getTime() - OTEL_SESSION_ENDED_MS);
  const delayCutoff = new Date(now.getTime() - OTEL_CHUNK_DELAY_MS);
  const result = await db.execute(sql`
    WITH RECURSIVE ${roots}
    SELECT
      COALESCE(SUM(uc.n), 0) AS unconfirmed,
      COUNT(*) FILTER (WHERE st.rt_last_at >= ${endedCutoff}) AS realtime_sessions,
      COUNT(*) FILTER (
        WHERE st.rt_last_at IS NOT NULL AND (
          (st.chunk_last_at IS NOT NULL
             AND st.rt_last_at - st.chunk_last_at > ${OTEL_CHUNK_DELAY_MS}::int * interval '1 millisecond')
          OR (st.chunk_last_at IS NULL AND st.rt_last_at < ${delayCutoff})
        )
      ) AS chunk_delayed_sessions,
      COUNT(*) FILTER (WHERE st.rt_gap_at IS NOT NULL) AS gap_sessions
    FROM scoped_roots r
    JOIN otel_session_state st ON st.session_id = r.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n FROM otel_calls c
       WHERE st.rt_last_at IS NOT NULL
         AND c.session_id = st.session_id
         AND (c.source_mask & ${OTEL_SOURCE_CHUNK_BIT}) = 0
    ) uc ON true
    WHERE GREATEST(st.rt_last_at, st.chunk_last_at) >= ${activeSince}
  `);
  const r = (
    result.rows as unknown as {
      unconfirmed: DbValue;
      realtime_sessions: DbValue;
      chunk_delayed_sessions: DbValue;
      gap_sessions: DbValue;
    }[]
  )[0];
  return {
    unconfirmedCalls: toNum(r?.unconfirmed),
    realtimeSessions: toNum(r?.realtime_sessions),
    chunkDelayedSessions: toNum(r?.chunk_delayed_sessions),
    gapSessions: toNum(r?.gap_sessions),
  };
}

/** `repositories.hook_version` of every row in `repoIds` (the reader takes the highest, DD-15). */
export async function loadRepoHookVersions(
  db: DrizzleDb,
  repoIds: number[],
): Promise<string[]> {
  if (repoIds.length === 0) return [];
  const result = await db.execute(sql`
    SELECT hook_version FROM repositories
     WHERE id = ANY(${`{${repoIds.join(',')}}`}::int[])
       AND hook_version IS NOT NULL
  `);
  return (result.rows as unknown as { hook_version: string }[]).map(
    (r) => r.hook_version,
  );
}

// ---------------------------------------------------------------------------
// OTEL coverage and status (2026-10-30 otel-shared-receiver, DD-28, DD-29)
// ---------------------------------------------------------------------------

/**
 * True when the root `rootId` (a `sessions.id`) counts as covered by OTEL (DD-29): it has an
 * `otel_session_state` row (the `hasOtel` predicate of {@link loadPresence}), or its hook
 * reported `otel_state` `ok` / `partial`.
 */
export function otelRootCoveredSql(rootId: SQL): SQL {
  const covered = sql.join(
    OTEL_COVERED_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  return sql`(
    EXISTS (SELECT 1 FROM otel_session_state cst WHERE cst.session_id = ${rootId})
    OR EXISTS (
      SELECT 1 FROM session_stats css
       WHERE css.session_id = ${rootId} AND css.otel_state IN (${covered})
    )
  )`;
}

/** The root's reported reason, or `no-status` when its hook never sent one (DD-29). */
export function otelRootReasonSql(rootId: SQL): SQL {
  return sql`COALESCE(
    (SELECT rss.otel_reason FROM session_stats rss WHERE rss.session_id = ${rootId}),
    ${OTEL_NO_STATUS_REASON}
  )`;
}

export interface OtelCoverageSqlRow {
  otelSessions: number;
  totalSessions: number;
  otelUsers: number;
  /** Raw stored reasons (normalised by the reader), most frequent first. */
  reasons: { reason: string; count: number }[];
}

/**
 * The OTEL coverage of `roots` (DD-29) — a CTE list ending in `scoped_roots(id, user_id)`, the
 * repository's ({@link otelScopedRootsCtes}) or the team's ({@link otelTeamRootsCtes}) with the
 * same filters as the facts. Only roots active in the window count: an `artisyn` log that
 * started before `to` and ended (or, still open, started) at or after `from`. Covered roots
 * ({@link otelRootCoveredSql}) give `otelSessions` and `otelUsers`; the rest are grouped by
 * {@link otelRootReasonSql}, most frequent first (ties by reason). A root linked to several team
 * repositories counts once.
 */
export async function loadOtelCoverage(
  db: DrizzleDb,
  roots: SQL,
  window: OtelWindow,
): Promise<OtelCoverageSqlRow> {
  const result = await db.execute(sql`
    WITH RECURSIVE ${roots},
    period_roots AS (
      SELECT r.id, MIN(r.user_id) AS user_id
        FROM scoped_roots r
       WHERE EXISTS (
         SELECT 1 FROM logs pl
          WHERE pl.session_id = r.id
            AND pl.log_type = 'artisyn'
            AND pl.start_time < ${window.to}
            AND COALESCE(pl.end_time, pl.start_time) >= ${window.from}
       )
       GROUP BY r.id
    ),
    classified AS (
      SELECT pr.id, pr.user_id,
             ${otelRootCoveredSql(sql`pr.id`)} AS covered,
             ${otelRootReasonSql(sql`pr.id`)} AS reason
        FROM period_roots pr
    ),
    reason_counts AS (
      SELECT reason, COUNT(*) AS n FROM classified WHERE NOT covered GROUP BY reason
    )
    SELECT
      (SELECT COUNT(*) FROM classified WHERE covered) AS otel_sessions,
      (SELECT COUNT(*) FROM classified) AS total_sessions,
      (SELECT COUNT(DISTINCT user_id) FROM classified WHERE covered) AS otel_users,
      (SELECT COALESCE(
         json_agg(json_build_object('reason', reason, 'count', n) ORDER BY n DESC, reason),
         '[]'::json
       ) FROM reason_counts) AS reasons
  `);
  const r = (
    result.rows as unknown as {
      otel_sessions: DbValue;
      total_sessions: DbValue;
      otel_users: DbValue;
      reasons: { reason: string; count: DbValue }[] | null;
    }[]
  )[0];
  return {
    otelSessions: toNum(r?.otel_sessions),
    totalSessions: toNum(r?.total_sessions),
    otelUsers: toNum(r?.otel_users),
    reasons: (r?.reasons ?? []).map((x) => ({
      reason: x.reason,
      count: toNum(x.count),
    })),
  };
}

/** The OTEL status columns of one root's `session_stats` row (DD-28). */
export interface OtelStatusSqlRow {
  state: string | null;
  reason: string | null;
  status: Record<string, unknown> | null;
  costExcludesUtilityCalls: boolean;
}

/**
 * One root's stored OTEL status (DD-28) and its DD-30 cost marker
 * (`costExcludesUtilityCalls`, an SQL expression passed in by the caller so it has one home in
 * `otel-cost.sql.ts`).
 */
export async function loadOtelStatusRow(
  db: DrizzleDb,
  rootId: number,
  costExcludesUtilityCalls: SQL,
): Promise<OtelStatusSqlRow> {
  const result = await db.execute(sql`
    SELECT ss.otel_state, ss.otel_reason, ss.otel_status,
           ${costExcludesUtilityCalls} AS cost_excludes_utility_calls
      FROM (SELECT ${rootId}::int AS id) root
      LEFT JOIN session_stats ss ON ss.session_id = root.id
  `);
  const r = (
    result.rows as unknown as {
      otel_state: string | null;
      otel_reason: string | null;
      otel_status: Record<string, unknown> | null;
      cost_excludes_utility_calls: boolean | null;
    }[]
  )[0];
  return {
    state: r?.otel_state ?? null,
    reason: r?.otel_reason ?? null,
    status: r?.otel_status ?? null,
    costExcludesUtilityCalls: r?.cost_excludes_utility_calls === true,
  };
}

// ---------------------------------------------------------------------------
// Session route
// ---------------------------------------------------------------------------

export interface OtelRootRef {
  /** `sessions.id` of the tree root. */
  rootId: number;
  /** `sessions.session_id` of the tree root. */
  rootSessionId: string;
}

/** The root of the session `sessionId` (any node of its tree), or null when unknown (DD-1). */
export async function resolveOtelRoot(
  db: DrizzleDb,
  sessionId: string,
): Promise<OtelRootRef | null> {
  const result = await db.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(
      sql`ARRAY(SELECT id FROM sessions WHERE session_id = ${sessionId})`,
    )}
    SELECT t.top_id, s.session_id
      FROM top_ancestors t
      JOIN sessions s ON s.id = t.top_id
     LIMIT 1
  `);
  const r = (
    result.rows as unknown as { top_id: DbValue; session_id: string }[]
  )[0];
  return r ? { rootId: toNum(r.top_id), rootSessionId: r.session_id } : null;
}

/**
 * The root's uploader when the root is in the caller's scope (DD-6: linked to the repository,
 * not deleted, passing the team row filter), else null — the session route then answers with an
 * empty response.
 */
export async function loadScopedRootOwner(
  db: DrizzleDb,
  scope: OtelReadScope,
  rootSessionId: string,
): Promise<{ inScope: boolean; ownerId: number | null }> {
  const result = await db.execute(sql`
    WITH RECURSIVE ${otelScopedRootsCtes({ ...scope, rootSessionId }, ALL_TIME_TO)}
    SELECT id, user_id FROM scoped_roots LIMIT 1
  `);
  const r = (result.rows as unknown as { id: DbValue; user_id: DbValue }[])[0];
  if (!r) return { inScope: false, ownerId: null };
  return {
    inScope: true,
    ownerId:
      r.user_id === null || r.user_id === undefined ? null : toNum(r.user_id),
  };
}

/** The `otel_session_state` columns the session route reads. */
export interface OtelStateRow {
  seq: number;
  userId: number | null;
  otelHookVersion: string | null;
  hasSpans: boolean;
  rtLastAt: Date | null;
  chunkLastAt: Date | null;
  rtGapAt: Date | null;
}

/** One primary-key read of the root's state (DD-2: the reader reads S first). */
export async function readOtelStateRow(
  db: DrizzleDb,
  rootId: number,
): Promise<OtelStateRow | null> {
  const result = await db.execute(sql`
    SELECT seq, user_id, otel_hook_version, has_spans, rt_last_at, chunk_last_at, rt_gap_at
      FROM otel_session_state
     WHERE session_id = ${rootId}
  `);
  const r = (
    result.rows as unknown as {
      seq: DbValue;
      user_id: DbValue;
      otel_hook_version: string | null;
      has_spans: boolean;
      rt_last_at: DbDate;
      chunk_last_at: DbDate;
      rt_gap_at: DbDate;
    }[]
  )[0];
  if (!r) return null;
  return {
    seq: toNum(r.seq),
    userId:
      r.user_id === null || r.user_id === undefined ? null : toNum(r.user_id),
    otelHookVersion: r.otel_hook_version,
    hasSpans: r.has_spans === true,
    rtLastAt: toDate(r.rt_last_at),
    chunkLastAt: toDate(r.chunk_last_at),
    rtGapAt: toDate(r.rt_gap_at),
  };
}

/** Unconfirmed (realtime-only, no chunk bit) calls and spans of one root (DD-14). */
export async function countUnconfirmed(
  db: DrizzleDb,
  rootId: number,
): Promise<{ calls: number; spans: number }> {
  const result = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM otel_calls
        WHERE session_id = ${rootId} AND (source_mask & ${OTEL_SOURCE_CHUNK_BIT}) = 0) AS calls,
      (SELECT COUNT(*) FROM otel_spans
        WHERE session_id = ${rootId} AND (source_mask & ${OTEL_SOURCE_CHUNK_BIT}) = 0) AS spans
  `);
  const r = (result.rows as unknown as { calls: DbValue; spans: DbValue }[])[0];
  return { calls: toNum(r?.calls), spans: toNum(r?.spans) };
}

/** First and last non-zero 5-minute bucket of one root — the session's span for `auto`. */
export async function loadSessionBucketSpan(
  db: DrizzleDb,
  rootId: number,
): Promise<{ first: Date | null; last: Date | null }> {
  const result = await db.execute(sql`
    SELECT MIN(bucket_start) AS first, MAX(bucket_start) AS last
      FROM otel_cost_buckets
     WHERE session_id = ${rootId} AND calls <> 0
  `);
  const r = (result.rows as unknown as { first: DbDate; last: DbDate }[])[0];
  return { first: toDate(r?.first), last: toDate(r?.last) };
}

export interface OtelCallSqlRow {
  callKey: string;
  requestId: string | null;
  querySource: string | null;
  model: string | null;
  eventTime: Date;
  structure: OtelStructure;
  provisional: boolean;
  sourceMask: number;
  costUsdMicros: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  agentId: string | null;
  promptId: string | null;
  changeKind: OtelChangeKind;
}

interface CallDbRow {
  call_key: string;
  request_id: string | null;
  query_source: string | null;
  model: string | null;
  event_time: DbDate;
  structure: string;
  provisional: boolean;
  source_mask: DbValue;
  cost_usd_micros: DbValue;
  input_tokens: DbValue;
  output_tokens: DbValue;
  cache_read_tokens: DbValue;
  cache_write_tokens: DbValue;
  agent_id: string | null;
  prompt_id: string | null;
  change_kind: string;
}

/** The root's calls — all of them, or only those with `since < seq` (a delta). */
export async function loadSessionCalls(
  db: DrizzleDb,
  rootId: number,
  since: number | null,
): Promise<OtelCallSqlRow[]> {
  const result = await db.execute(sql`
    SELECT call_key, request_id, query_source, model, event_time, structure, provisional,
           source_mask, cost_usd_micros, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, agent_id, prompt_id, change_kind
      FROM otel_calls
     WHERE session_id = ${rootId}
       ${since === null ? sql`` : sql`AND seq > ${since}`}
     ORDER BY event_time, call_key
  `);
  return (result.rows as unknown as CallDbRow[]).map((r) => ({
    callKey: r.call_key,
    requestId: r.request_id,
    querySource: r.query_source,
    model: r.model,
    eventTime: toDate(r.event_time) ?? new Date(0),
    structure: r.structure as OtelStructure,
    provisional: r.provisional === true,
    sourceMask: toNum(r.source_mask),
    costUsdMicros: microsTextOrNull(r.cost_usd_micros),
    inputTokens: toNum(r.input_tokens),
    outputTokens: toNum(r.output_tokens),
    cacheReadTokens: toNum(r.cache_read_tokens),
    cacheWriteTokens: toNum(r.cache_write_tokens),
    agentId: r.agent_id,
    promptId: r.prompt_id,
    changeKind: r.change_kind as OtelChangeKind,
  }));
}

export interface OtelSpanSqlRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: Date;
  endTime: Date | null;
  requestId: string | null;
  agentId: string | null;
  querySource: string | null;
  context: string | null;
  costUsdMicros: string | null;
  rollupCostUsdMicros: string | null;
  sourceMask: number;
  /** Structure of the span's call (by `request_id`), or null when the span has none. */
  callStructure: OtelStructure | null;
  /** Null when not selected (masked, DD-22). */
  attributes: Record<string, unknown> | null;
  changeKind: OtelChangeKind;
}

interface SpanDbRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time: DbDate;
  end_time: DbDate;
  request_id: string | null;
  agent_id: string | null;
  query_source: string | null;
  context: string | null;
  cost_usd_micros: DbValue;
  rollup_cost_usd_micros: DbValue;
  source_mask: DbValue;
  call_structure: string | null;
  attributes: Record<string, unknown> | null;
  change_kind: string;
}

/**
 * The root's spans with their call's structure (the span's `hidden` flag). A delta returns the
 * spans with `since < seq` plus those whose call changed since (a reclassification flips
 * `hidden` without touching the span row); a span included only for its call reports
 * `reclass`, so the client updates it silently (DD-3). `withAttributes` false leaves the raw
 * attributes out of the query (DD-22 masking).
 */
export async function loadSessionSpans(
  db: DrizzleDb,
  rootId: number,
  since: number | null,
  withAttributes: boolean,
): Promise<OtelSpanSqlRow[]> {
  const changeKind =
    since === null
      ? sql`s.change_kind`
      : sql`CASE WHEN s.seq > ${since} THEN s.change_kind ELSE 'reclass' END`;
  const result = await db.execute(sql`
    SELECT s.trace_id, s.span_id, s.parent_span_id, s.name, s.start_time, s.end_time,
           s.request_id, s.agent_id, s.query_source, s.context, s.cost_usd_micros,
           s.rollup_cost_usd_micros, s.source_mask, c.structure AS call_structure,
           ${withAttributes ? sql`s.attributes` : sql`NULL::jsonb`} AS attributes,
           ${changeKind} AS change_kind
      FROM otel_spans s
      LEFT JOIN otel_calls c ON c.session_id = s.session_id AND c.call_key = s.request_id
     WHERE s.session_id = ${rootId}
       ${since === null ? sql`` : sql`AND (s.seq > ${since} OR c.seq > ${since})`}
     ORDER BY s.start_time, s.trace_id, s.span_id
  `);
  return (result.rows as unknown as SpanDbRow[]).map((r) => ({
    traceId: r.trace_id,
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    name: r.name,
    startTime: toDate(r.start_time) ?? new Date(0),
    endTime: toDate(r.end_time),
    requestId: r.request_id,
    agentId: r.agent_id,
    querySource: r.query_source,
    context: r.context,
    costUsdMicros: microsTextOrNull(r.cost_usd_micros),
    rollupCostUsdMicros: microsTextOrNull(r.rollup_cost_usd_micros),
    sourceMask: toNum(r.source_mask),
    callStructure: (r.call_structure as OtelStructure | null) ?? null,
    attributes: r.attributes,
    changeKind: r.change_kind as OtelChangeKind,
  }));
}

// ---------------------------------------------------------------------------
// Team route (DD-29)
// ---------------------------------------------------------------------------

/** The team route's scope: the team, the caller's team scope and the person / repo filters. */
export interface OtelTeamScope {
  teamId: number;
  teamScope: TeamScope;
  /** Team repository ids (`MIN(repositories.id)` per team repository URL); empty = all. */
  repoIds: number[];
  /** Root uploaders; empty = all. */
  userIds: number[];
}

/** `{…}::int[]` literal of integer ids (validated integers, never free text). */
function otelIntArray(ids: number[]): SQL {
  return sql`${`{${ids.join(',')}}`}::int[]`;
}

/**
 * The team repositories of `teamId` as `team_repo_ids(repo_id, team_repo_id, repo_url)`: every
 * member's `repositories` row whose URL is linked to the team, keyed by the team repository id
 * the team page uses (`MIN(repositories.id)` per URL, as `TeamsService.getTeamRepositories`).
 */
function teamRepoIdsCte(teamId: number): SQL {
  return sql`team_repo_ids AS (
    SELECT r.id AS repo_id,
           MIN(r.id) OVER (PARTITION BY tr.repo_url) AS team_repo_id,
           tr.repo_url
      FROM team_repositories tr
      JOIN team_members tm ON tm.team_id = tr.team_id
      JOIN repositories r ON r.repo_url = tr.repo_url AND r.user_id = tm.user_id
     WHERE tr.team_id = ${teamId}
  )`;
}

/**
 * The team route's CTE list (without `WITH RECURSIVE`): `team_repo_ids`, `root_repos(id,
 * user_id, team_repo_id, repo_url)` (one row per scoped root and team repository it is linked
 * to), `root_primary_repo(id, team_repo_id, repo_url)` (the root's lowest team repository, the
 * one key a root stacks and flows under so it counts once) and `scoped_roots(id, user_id)`, the
 * DISTINCT roots every total aggregates (DD-29). The scope rules are DD-6's (`scopedTreeCtes`):
 * the root's `artisyn` log linked to a repository, not deleted, started before `to`, the
 * caller's team row filter. `withFilters` false drops the person / repository filters (the
 * pickers' options and the presence check).
 */
export function otelTeamRootsCtes(
  scope: OtelTeamScope,
  to: Date,
  withFilters = true,
): SQL {
  const repoFilter =
    withFilters && scope.repoIds.length > 0
      ? sql`AND tri.team_repo_id = ANY(${otelIntArray(scope.repoIds)})`
      : sql``;
  const userFilter =
    withFilters && scope.userIds.length > 0
      ? sql`AND l.user_id = ANY(${otelIntArray(scope.userIds)})`
      : sql``;
  return sql`${teamRepoIdsCte(scope.teamId)},
  root_repos AS (
    SELECT DISTINCT s.id, l.user_id, tri.team_repo_id, tri.repo_url
      FROM sessions s
      JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
      JOIN log_repositories lr ON lr.log_id = l.id
      JOIN team_repo_ids tri ON tri.repo_id = lr.repo_id
     WHERE s.deleted = false
       AND l.start_time <= ${to}
       ${scopedUserFilterSql(scope.teamScope, 'l')}
       ${repoFilter}
       ${userFilter}
  ),
  root_primary_repo AS (
    SELECT DISTINCT ON (id) id, team_repo_id, repo_url
      FROM root_repos
     ORDER BY id, team_repo_id
  ),
  scoped_roots AS (
    SELECT DISTINCT id, user_id FROM root_repos
  )`;
}

/** The team bucket source's extra `fb` columns: the root's primary team repository. */
export const OTEL_TEAM_BUCKET_EXTRA: OtelBucketSourceExtra = {
  columns: sql`rp.team_repo_id AS repo_key, rp.repo_url`,
  joins: sql`LEFT JOIN root_primary_repo rp ON rp.id = r.id`,
};

/** The stack-by column of a team bucket row (DD-29: person = user id, repository = repo id). */
export type OtelTeamStackColumn = OtelStackColumn | 'person' | 'repository';

export function teamStackKeySql(stackBy: OtelTeamStackColumn): SQL {
  switch (stackBy) {
    case 'person':
      return sql`COALESCE(fb.uid::text, '')`;
    case 'repository':
      return sql`COALESCE(fb.repo_key::text, '')`;
    default:
      return stackKeySql(stackBy);
  }
}

/** Is `userId` a member of `teamId`? (the team route's 403, as `TeamAccessGuard`). */
export async function isOtelTeamMember(
  db: DrizzleDb,
  teamId: number,
  userId: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM team_members WHERE team_id = ${teamId} AND user_id = ${userId} LIMIT 1
  `);
  return result.rows.length > 0;
}

export interface OtelTeamRepoRef {
  /** Every member `repositories.id` of the team (hook versions, DD-15). */
  memberRepoIds: number[];
  /** One entry per team repository (the repository picker). */
  repositories: { repoId: number; repoUrl: string }[];
}

/** The team's repositories (DD-29 filter options, DD-15 hook version). */
export async function loadOtelTeamRepos(
  db: DrizzleDb,
  teamId: number,
): Promise<OtelTeamRepoRef> {
  const result = await db.execute(sql`
    WITH ${teamRepoIdsCte(teamId)}
    SELECT repo_id, team_repo_id, repo_url FROM team_repo_ids ORDER BY repo_url, repo_id
  `);
  const rows = result.rows as unknown as {
    repo_id: DbValue;
    team_repo_id: DbValue;
    repo_url: string;
  }[];
  const repositories = new Map<number, string>();
  for (const r of rows) repositories.set(toNum(r.team_repo_id), r.repo_url);
  return {
    memberRepoIds: rows.map((r) => toNum(r.repo_id)),
    repositories: [...repositories].map(([repoId, repoUrl]) => ({
      repoId,
      repoUrl,
    })),
  };
}

/** Every person of the team bucket source (the people picker), by e-mail. */
export async function loadOtelTeamPeopleOptions(
  db: DrizzleDb,
  source: SQL,
): Promise<{ userId: number; email: string }[]> {
  const result = await db.execute(sql`
    ${source}
    SELECT DISTINCT fb.uid AS user_id, u.email
      FROM fb
      JOIN users u ON u.id = fb.uid
     ORDER BY u.email
  `);
  return (result.rows as unknown as { user_id: DbValue; email: string }[]).map(
    (r) => ({ userId: toNum(r.user_id), email: r.email }),
  );
}

export interface OtelTeamPersonSqlRow {
  userId: number;
  email: string;
  sessions: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  inputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  models: string[];
  repositories: number;
  live: boolean;
}

/**
 * The People table (DD-29): one row per person of `source` (a team bucket source), most
 * expensive first. `repositories` counts the team repositories the person has sessions in;
 * `live` = any of the person's roots had OTEL data within `OTEL_SESSION_ENDED_MS`.
 */
export async function loadOtelTeamPeople(
  db: DrizzleDb,
  source: SQL,
  now: Date,
): Promise<OtelTeamPersonSqlRow[]> {
  const endedCutoff = new Date(now.getTime() - OTEL_SESSION_ENDED_MS);
  const result = await db.execute(sql`
    ${source},
    pp AS (
      SELECT fb.uid,
             COUNT(DISTINCT fb.session_id) AS sessions,
             COALESCE(SUM(fb.cost_usd_micros), 0) AS cost,
             COALESCE(SUM(fb.cost_usd_micros) FILTER (WHERE fb.structure = 'hidden'), 0)
               AS hidden_cost,
             COALESCE(SUM(fb.input_tokens), 0) AS input_tokens,
             COALESCE(SUM(fb.cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(fb.cache_write_tokens), 0) AS cache_write_tokens,
             array_agg(DISTINCT fb.model ORDER BY fb.model) FILTER (WHERE fb.model <> '')
               AS models,
             array_agg(DISTINCT fb.session_id) AS roots
        FROM fb
       WHERE fb.uid IS NOT NULL
       GROUP BY fb.uid
    )
    SELECT pp.uid AS user_id, u.email, pp.sessions, pp.cost, pp.hidden_cost, pp.input_tokens,
           pp.cache_read_tokens, pp.cache_write_tokens, pp.models,
           (SELECT COUNT(DISTINCT rr.team_repo_id) FROM root_repos rr
             WHERE rr.id = ANY(pp.roots)) AS repositories,
           EXISTS (
             SELECT 1 FROM otel_session_state st
              WHERE st.session_id = ANY(pp.roots)
                AND GREATEST(st.rt_last_at, st.chunk_last_at) >= ${endedCutoff}
           ) AS live
      FROM pp
      JOIN users u ON u.id = pp.uid
     ORDER BY pp.cost DESC, u.email
  `);
  return (
    result.rows as unknown as {
      user_id: DbValue;
      email: string;
      sessions: DbValue;
      cost: DbValue;
      hidden_cost: DbValue;
      input_tokens: DbValue;
      cache_read_tokens: DbValue;
      cache_write_tokens: DbValue;
      models: string[] | null;
      repositories: DbValue;
      live: boolean;
    }[]
  ).map((r) => ({
    userId: toNum(r.user_id),
    email: r.email,
    sessions: toNum(r.sessions),
    costUsdMicros: microsText(r.cost),
    hiddenCostUsdMicros: microsText(r.hidden_cost),
    inputTokens: microsText(r.input_tokens),
    cacheReadTokens: microsText(r.cache_read_tokens),
    cacheWriteTokens: microsText(r.cache_write_tokens),
    models: r.models ?? [],
    repositories: toNum(r.repositories),
    live: r.live === true,
  }));
}

export interface OtelTeamRepositorySqlRow {
  repoId: number;
  repoUrl: string;
  people: number;
  sessions: number;
  costUsdMicros: string;
  hiddenCostUsdMicros: string;
  liveSessions: number;
}

/**
 * The Repositories table (DD-29): one row per team repository of `source`, most expensive
 * first. Unlike every other aggregate, a session linked to two team repositories counts in
 * each of them (the table footer says so).
 */
export async function loadOtelTeamRepositories(
  db: DrizzleDb,
  source: SQL,
  now: Date,
): Promise<OtelTeamRepositorySqlRow[]> {
  const endedCutoff = new Date(now.getTime() - OTEL_SESSION_ENDED_MS);
  const result = await db.execute(sql`
    ${source},
    ps AS (
      SELECT fb.session_id,
             SUM(fb.cost_usd_micros) AS cost,
             COALESCE(SUM(fb.cost_usd_micros) FILTER (WHERE fb.structure = 'hidden'), 0)
               AS hidden_cost
        FROM fb
       GROUP BY fb.session_id
    ),
    rr AS (
      SELECT DISTINCT id, user_id, team_repo_id, repo_url FROM root_repos
    )
    SELECT rr.team_repo_id AS repo_id, MIN(rr.repo_url) AS repo_url,
           COUNT(DISTINCT rr.user_id) AS people,
           COUNT(DISTINCT ps.session_id) AS sessions,
           COALESCE(SUM(ps.cost), 0) AS cost,
           COALESCE(SUM(ps.hidden_cost), 0) AS hidden_cost,
           COUNT(DISTINCT ps.session_id) FILTER (
             WHERE GREATEST(st.rt_last_at, st.chunk_last_at) >= ${endedCutoff}
           ) AS live_sessions
      FROM ps
      JOIN rr ON rr.id = ps.session_id
      LEFT JOIN otel_session_state st ON st.session_id = ps.session_id
     GROUP BY rr.team_repo_id
     ORDER BY SUM(ps.cost) DESC, MIN(rr.repo_url)
  `);
  return (
    result.rows as unknown as {
      repo_id: DbValue;
      repo_url: string;
      people: DbValue;
      sessions: DbValue;
      cost: DbValue;
      hidden_cost: DbValue;
      live_sessions: DbValue;
    }[]
  ).map((r) => ({
    repoId: toNum(r.repo_id),
    repoUrl: r.repo_url,
    people: toNum(r.people),
    sessions: toNum(r.sessions),
    costUsdMicros: microsText(r.cost),
    hiddenCostUsdMicros: microsText(r.hidden_cost),
    liveSessions: toNum(r.live_sessions),
  }));
}

/**
 * The team KPI repository counts (DD-29) of `source`: team repositories with at least one
 * bucket, and those with a live root (OTEL data within `OTEL_SESSION_ENDED_MS`).
 */
export async function loadOtelTeamRepoCounts(
  db: DrizzleDb,
  source: SQL,
  now: Date,
): Promise<{ repositories: number; repositoriesLive: number }> {
  const endedCutoff = new Date(now.getTime() - OTEL_SESSION_ENDED_MS);
  const result = await db.execute(sql`
    ${source},
    fb_roots AS (SELECT DISTINCT fb.session_id FROM fb)
    SELECT COUNT(DISTINCT rr.team_repo_id) AS repositories,
           COUNT(DISTINCT rr.team_repo_id) FILTER (
             WHERE GREATEST(st.rt_last_at, st.chunk_last_at) >= ${endedCutoff}
           ) AS repositories_live
      FROM fb_roots
      JOIN root_repos rr ON rr.id = fb_roots.session_id
      LEFT JOIN otel_session_state st ON st.session_id = fb_roots.session_id
  `);
  const r = (
    result.rows as unknown as {
      repositories: DbValue;
      repositories_live: DbValue;
    }[]
  )[0];
  return {
    repositories: toNum(r?.repositories),
    repositoriesLive: toNum(r?.repositories_live),
  };
}
