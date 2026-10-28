/**
 * Read queries of the Tools/MCP tab (impl-plan DD-11, DD-17, DD-18): the summary tree, the
 * paged calls table and one call's detail, all over `session_tool_usage`.
 *
 * **Scope (DD-17, Sessions-tab rules).** A row is in scope when its node belongs to a session
 * tree whose root's `artisyn` log is linked through `log_repositories` to one of `repoIds`, the
 * root is not deleted, and the root's uploader passes the caller's team access-mode row filter
 * (`scopedUserFilterSql`: `[caller]` in the personal view and for a plain member, the
 * acknowledged members for an owner / manager / trainer, nothing in a `transparent` team). The
 * tree is walked downward from those roots with `descendantSessionsCte`, the same two-phase
 * shape the usage analytics use, so a sub-agent upload is reached only through its true root.
 *
 * **Range.** The date range selects rows by `session_tool_usage.last_call_at` (a residual filter on
 * the scoped tree's rows, which the UNIQUE (session_id, channel, tool) index reaches), and the
 * summary and the calls table use the very same row set, so the tree's figures always add up to
 * the table's unfiltered total. Status and search narrow the table only (DD-18).
 *
 * **Never detoast what is not shown (DD-9).** The summary names only `aggregates`; the calls
 * table reads `calls` (and `outputs` only for a `q` search); only the detail reads one call's
 * `outputs` entry.
 */
import { sql, type SQL } from 'drizzle-orm';
import { normalizeToolName } from '@loghub/tool-monitor';
import type { DrizzleDb } from '../../database/database.module';
import type {
  ToolCallOutput,
  ToolCallRecord,
  ToolCallStatus,
  ToolUsageChannel,
} from '../../database/schema/index';
import { scopedUserFilterSql } from '../analytics/scoped-sessions.sql';
import { descendantSessionsCte, topAncestorIdsSql } from '../session-tree.sql';
import type { TeamScope } from '../team-scope';
import type {
  ToolCallListItem,
  ToolUsageAgg,
  ToolUsageOperationSummary,
  ToolUsageSummaryResponse,
  ToolUsageToolSummary,
} from './tool-monitoring.types';

/** The caller's resolved scope: the repository rows and the team access-mode row filter. */
export interface ToolUsageReadScope {
  repoIds: number[];
  teamScope: TeamScope;
  /**
   * `sessions.session_id` of one tree root (the session detail's Tools/MCP tab): only that tree
   * is in scope. Absent → every in-scope tree of the repository.
   */
  rootSessionId?: string;
}

/** Inclusive bounds on `session_tool_usage.last_call_at`. */
export interface ToolUsageRange {
  from: Date;
  to: Date;
}

/** Calls-table filters (DD-18); every field is optional. */
export interface ToolCallsFilters {
  channel?: ToolUsageChannel;
  tool?: string;
  operation?: string;
  status?: ToolCallStatus;
  /** Free-text search, already length-checked by the controller. */
  q?: string;
}

export interface ToolCallsPaging {
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** One `(channel, tool, operation)` line of the summary, summed over the rows in scope. */
export interface ToolUsageOperationTotals {
  channel: ToolUsageChannel;
  tool: string;
  operation: string;
  calls: number;
  errors: number;
  killed: number;
  noResult: number;
  empty: number;
  retried: number;
  fellBack: number;
  openedFile: number;
  durationMsSum: number;
  durationCount: number;
  inBytesSum: number;
  outBytesSum: number;
  lastTs: string | null;
}

export interface ToolUsageSummaryRows {
  operations: ToolUsageOperationTotals[];
  pendingSessions: number;
}

/** A calls-table row before the owner e-mail is masked by the controller. */
export interface ToolCallListRow {
  usageId: number;
  sessionId: string;
  ownerId: number | null;
  ownerEmail: string | null;
  call: Omit<ToolCallRecord, 'args' | 'cwd'>;
}

export interface ToolCallListRows {
  total: number;
  rows: ToolCallListRow[];
}

/** One call's detail before the visibility check and masking done by the controller. */
export interface ToolCallDetailRow {
  usageId: number;
  /** `sessions.id` of the node holding the call. */
  nodeRowId: number;
  /** `sessions.session_id` of that node. */
  sessionId: string;
  /** `sessions.session_id` of the tree's root. */
  rootSessionId: string;
  ownerId: number | null;
  ownerEmail: string | null;
  call: ToolCallRecord;
  output: ToolCallOutput;
}

// ── Shared scope SQL ─────────────────────────────────────────────────────────────────────────

/** `{…}::int[]` literal of integer ids that come from the DB, as scoped-sessions.sql.ts does. */
function intArray(ids: number[]): SQL {
  return sql`${`{${ids.join(',')}}`}::int[]`;
}

/** `AND s.session_id = …` when the scope is narrowed to one session tree, else nothing. */
function rootSessionSql(scope: ToolUsageReadScope): SQL {
  return scope.rootSessionId !== undefined
    ? sql`AND s.session_id = ${scope.rootSessionId}`
    : sql``;
}

/**
 * The `scoped_roots` and `descendant_sessions` CTE bodies (callers prefix `WITH RECURSIVE`).
 * `scoped_roots(id, user_id)` are the in-scope tree roots started no later than `to`; a row
 * whose last call is in range cannot belong to a tree that started after the range ends.
 */
function scopedTreeCtes(scope: ToolUsageReadScope, range: ToolUsageRange): SQL {
  return sql`scoped_roots AS (
    SELECT DISTINCT s.id, l.user_id
    FROM sessions s
    INNER JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
    INNER JOIN log_repositories lr ON lr.log_id = l.id
    WHERE lr.repo_id = ANY(${intArray(scope.repoIds)})
      AND s.deleted = false
      AND l.start_time <= ${range.to}
      ${rootSessionSql(scope)}
      ${scopedUserFilterSql(scope.teamScope, 'l')}
  ),
  ${descendantSessionsCte(sql`ARRAY(SELECT id FROM scoped_roots)`)}`;
}

/** The range predicate on a `session_tool_usage` alias `u`. */
function rowRangeSql(range: ToolUsageRange): SQL {
  return sql`u.last_call_at >= ${range.from} AND u.last_call_at <= ${range.to}`;
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escapes `\`, `%` and `_` so `q` matches literally inside `ILIKE '%…%'`. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────────────────────

interface OperationSqlRow {
  channel: string;
  tool: string;
  operation: string;
  calls: unknown;
  errors: unknown;
  killed: unknown;
  no_result: unknown;
  empty: unknown;
  retried: unknown;
  fell_back: unknown;
  opened_file: unknown;
  duration_ms_sum: unknown;
  duration_count: unknown;
  in_bytes_sum: unknown;
  out_bytes_sum: unknown;
  last_ts: string | null;
}

/** Sum of one numeric field of the DD-11 per-operation aggregate. */
function opSum(field: string): SQL {
  return sql`SUM(CASE WHEN jsonb_typeof(op.value -> ${field}::text) = 'number'
    THEN (op.value ->> ${field}::text)::numeric ELSE 0 END)`;
}

/**
 * The summary inputs (DD-11): the per-operation aggregates summed over the rows in scope and
 * range, plus `pendingSessions` — in-scope, non-deleted roots overlapping the range whose tree
 * still waits for a rebuild (`tool_usage_version IS NULL`; ingest NULLs the root together with
 * the uploaded node, DD-7). Never selects `calls` or `outputs`.
 */
export async function loadSummary(
  db: DrizzleDb,
  scope: ToolUsageReadScope,
  range: ToolUsageRange,
): Promise<ToolUsageSummaryRows> {
  if (scope.repoIds.length === 0) return { operations: [], pendingSessions: 0 };

  const opsResult = await db.execute(sql`
    WITH RECURSIVE ${scopedTreeCtes(scope, range)}
    SELECT
      u.channel,
      u.tool,
      op.key AS operation,
      ${opSum('calls')} AS calls,
      ${opSum('errors')} AS errors,
      ${opSum('killed')} AS killed,
      ${opSum('noResult')} AS no_result,
      ${opSum('empty')} AS empty,
      ${opSum('retried')} AS retried,
      ${opSum('fellBack')} AS fell_back,
      ${opSum('openedFile')} AS opened_file,
      ${opSum('durationMsSum')} AS duration_ms_sum,
      ${opSum('durationCount')} AS duration_count,
      ${opSum('inBytesSum')} AS in_bytes_sum,
      ${opSum('outBytesSum')} AS out_bytes_sum,
      MAX(op.value ->> 'lastTs') AS last_ts
    FROM (SELECT DISTINCT id FROM descendant_sessions) d
    INNER JOIN session_tool_usage u ON u.session_id = d.id
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(u.aggregates -> 'operations') = 'object'
        THEN u.aggregates -> 'operations' ELSE '{}'::jsonb END
    ) AS op
    WHERE ${rowRangeSql(range)}
    GROUP BY u.channel, u.tool, op.key
  `);

  const pendingResult = await db.execute(sql`
    SELECT COUNT(DISTINCT s.id) AS pending
    FROM sessions s
    INNER JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
    INNER JOIN log_repositories lr ON lr.log_id = l.id
    WHERE lr.repo_id = ANY(${intArray(scope.repoIds)})
      AND s.deleted = false
      AND s.tool_usage_version IS NULL
      AND l.start_time <= ${range.to}
      AND COALESCE(l.end_time, l.start_time) >= ${range.from}
      ${rootSessionSql(scope)}
      ${scopedUserFilterSql(scope.teamScope, 'l')}
  `);

  const operations = (opsResult.rows as unknown as OperationSqlRow[]).map(
    (r): ToolUsageOperationTotals => ({
      channel: r.channel === 'cli' ? 'cli' : 'mcp',
      tool: r.tool,
      operation: r.operation,
      calls: num(r.calls),
      errors: num(r.errors),
      killed: num(r.killed),
      noResult: num(r.no_result),
      empty: num(r.empty),
      retried: num(r.retried),
      fellBack: num(r.fell_back),
      openedFile: num(r.opened_file),
      durationMsSum: num(r.duration_ms_sum),
      durationCount: num(r.duration_count),
      inBytesSum: num(r.in_bytes_sum),
      outBytesSum: num(r.out_bytes_sum),
      lastTs: r.last_ts ?? null,
    }),
  );
  const pendingRow = pendingResult.rows[0] as { pending?: unknown } | undefined;
  return { operations, pendingSessions: num(pendingRow?.pending) };
}

// ── Summary tree assembly (pure) ─────────────────────────────────────────────────────────────

/** Running sums an `Agg` is folded from. */
interface AggSums {
  calls: number;
  errors: number;
  killed: number;
  noResult: number;
  empty: number;
  retried: number;
  fellBack: number;
  openedFile: number;
  durationMsSum: number;
  durationCount: number;
  inBytes: number;
  outBytes: number;
  lastTs: string | null;
}

function emptySums(): AggSums {
  return {
    calls: 0,
    errors: 0,
    killed: 0,
    noResult: 0,
    empty: 0,
    retried: 0,
    fellBack: 0,
    openedFile: 0,
    durationMsSum: 0,
    durationCount: 0,
    inBytes: 0,
    outBytes: 0,
    lastTs: null,
  };
}

function addOperation(sums: AggSums, op: ToolUsageOperationTotals): void {
  sums.calls += op.calls;
  sums.errors += op.errors;
  sums.killed += op.killed;
  sums.noResult += op.noResult;
  sums.empty += op.empty;
  sums.retried += op.retried;
  sums.fellBack += op.fellBack;
  sums.openedFile += op.openedFile;
  sums.durationMsSum += op.durationMsSum;
  sums.durationCount += op.durationCount;
  sums.inBytes += op.inBytesSum;
  sums.outBytes += op.outBytesSum;
  if (op.lastTs !== null && (sums.lastTs === null || op.lastTs > sums.lastTs)) {
    sums.lastTs = op.lastTs;
  }
}

function addSums(target: AggSums, source: AggSums): void {
  target.calls += source.calls;
  target.errors += source.errors;
  target.killed += source.killed;
  target.noResult += source.noResult;
  target.empty += source.empty;
  target.retried += source.retried;
  target.fellBack += source.fellBack;
  target.openedFile += source.openedFile;
  target.durationMsSum += source.durationMsSum;
  target.durationCount += source.durationCount;
  target.inBytes += source.inBytes;
  target.outBytes += source.outBytes;
  if (
    source.lastTs !== null &&
    (target.lastTs === null || source.lastTs > target.lastTs)
  ) {
    target.lastTs = source.lastTs;
  }
}

function toAgg(sums: AggSums): ToolUsageAgg {
  return {
    calls: sums.calls,
    errors: sums.errors,
    killed: sums.killed,
    noResult: sums.noResult,
    empty: sums.empty,
    retried: sums.retried,
    fellBack: sums.fellBack,
    openedFile: sums.openedFile,
    avgDurationMs:
      sums.durationCount > 0
        ? Math.round(sums.durationMsSum / sums.durationCount)
        : null,
    inBytes: sums.inBytes,
    outBytes: sums.outBytes,
  };
}

/** Descending by calls, then ascending by name — a stable default the client may re-sort. */
function byCallsThenName<T extends { calls: number }>(
  name: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) => b.calls - a.calls || name(a).localeCompare(name(b));
}

/**
 * Assembles the summary response (API changes) from the per-operation totals: each tool's
 * figures are the sum of its operations, each group's (`mcp`, `cli`) the sum of its tools, and
 * `totals` the sum of both groups. `neverCalled` lists the `monitoredCliTools` (enabled
 * configured CLI tools, in config order) with no CLI call in range and scope, matched
 * case-insensitively and ignoring a trailing `.exe` etc. (`normalizeToolName`).
 */
export function assembleToolUsageSummary(input: {
  range: ToolUsageRange;
  pendingSessions: number;
  operations: ToolUsageOperationTotals[];
  monitoredCliTools: string[];
}): ToolUsageSummaryResponse {
  const toolMap = new Map<
    string,
    {
      channel: ToolUsageChannel;
      tool: string;
      sums: AggSums;
      operations: ToolUsageOperationSummary[];
    }
  >();

  for (const op of input.operations) {
    const key = `${op.channel}\u0000${op.tool}`;
    let entry = toolMap.get(key);
    if (entry === undefined) {
      entry = {
        channel: op.channel,
        tool: op.tool,
        sums: emptySums(),
        operations: [],
      };
      toolMap.set(key, entry);
    }
    addOperation(entry.sums, op);
    const opSums = emptySums();
    addOperation(opSums, op);
    entry.operations.push({
      operation: op.operation,
      lastUsedAt: opSums.lastTs,
      ...toAgg(opSums),
    });
  }

  const groupSums: Record<ToolUsageChannel, AggSums> = {
    mcp: emptySums(),
    cli: emptySums(),
  };
  const groupTools: Record<ToolUsageChannel, number> = { mcp: 0, cli: 0 };
  const tools: ToolUsageToolSummary[] = [];
  for (const entry of toolMap.values()) {
    addSums(groupSums[entry.channel], entry.sums);
    groupTools[entry.channel] += 1;
    entry.operations.sort(byCallsThenName((o) => o.operation));
    tools.push({
      channel: entry.channel,
      tool: entry.tool,
      lastUsedAt: entry.sums.lastTs,
      ...toAgg(entry.sums),
      operations: entry.operations,
    });
  }
  tools.sort(byCallsThenName((t) => `${t.channel}:${t.tool}`));

  const totalSums = emptySums();
  addSums(totalSums, groupSums.mcp);
  addSums(totalSums, groupSums.cli);

  const calledCli = new Set(
    tools
      .filter((t) => t.channel === 'cli' && t.calls > 0)
      .map((t) => normalizeToolName(t.tool)),
  );
  const neverCalled: string[] = [];
  const listed = new Set<string>();
  for (const name of input.monitoredCliTools) {
    const key = normalizeToolName(name);
    if (calledCli.has(key) || listed.has(key)) continue;
    listed.add(key);
    neverCalled.push(name);
  }

  return {
    range: {
      from: input.range.from.toISOString(),
      to: input.range.to.toISOString(),
    },
    pendingSessions: input.pendingSessions,
    totals: toAgg(totalSums),
    groups: {
      mcp: { tools: groupTools.mcp, ...toAgg(groupSums.mcp) },
      cli: { tools: groupTools.cli, ...toAgg(groupSums.cli) },
    },
    tools,
    neverCalled,
  };
}

// ── Calls table ──────────────────────────────────────────────────────────────────────────────

interface CallSqlRow {
  usage_id: unknown;
  session_id: string;
  owner_id: unknown;
  owner_email: string | null;
  call: unknown;
  total: unknown;
}

/** The DD-18 filter predicates on `u` (row) and `c.value` (call element). */
function callFiltersSql(filters: ToolCallsFilters): SQL {
  const parts: SQL[] = [];
  if (filters.channel !== undefined) {
    parts.push(sql`AND u.channel = ${filters.channel}`);
  }
  if (filters.tool !== undefined) {
    parts.push(sql`AND u.tool = ${filters.tool}`);
  }
  if (filters.operation !== undefined) {
    parts.push(sql`AND c.value ->> 'operation' = ${filters.operation}`);
  }
  if (filters.status !== undefined) {
    parts.push(sql`AND c.value ->> 'status' = ${filters.status}`);
  }
  if (filters.q !== undefined && filters.q !== '') {
    const pattern = `%${escapeLikePattern(filters.q)}%`;
    parts.push(sql`AND (
      COALESCE(c.value ->> 'inputPreview', '') ILIKE ${pattern}
      OR COALESCE((c.value -> 'args')::text, '') ILIKE ${pattern}
      OR COALESCE((u.outputs -> (c.value ->> 'callId'))::text, '') ILIKE ${pattern}
    )`);
  }
  return sql.join(parts, sql` `);
}

/** `FROM … WHERE …` of the calls table: one row per call element of an in-scope usage row. */
function callsFromSql(
  scope: ToolUsageReadScope,
  range: ToolUsageRange,
  filters: ToolCallsFilters,
): SQL {
  return sql`
    FROM (SELECT DISTINCT id, session_id, root_id FROM descendant_sessions) d
    INNER JOIN scoped_roots r ON r.id = d.root_id
    INNER JOIN session_tool_usage u ON u.session_id = d.id
    LEFT JOIN users us ON us.id = r.user_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(u.calls) = 'array' THEN u.calls ELSE '[]'::jsonb END
    ) AS c(value)
    WHERE ${rowRangeSql(range)}
      ${callFiltersSql(filters)}`;
}

/**
 * One page of the calls table (DD-18): `jsonb_array_elements(calls)` of the rows in scope and
 * range, narrowed by channel / tool / operation / status and the `q` search (`ILIKE` over the
 * call's `inputPreview`, its `args` and its own `outputs` entry), sorted `ts DESC, callId DESC`.
 * Each call comes without `args` / `cwd`; `total` counts every matching call.
 */
export async function loadCalls(
  db: DrizzleDb,
  scope: ToolUsageReadScope,
  range: ToolUsageRange,
  filters: ToolCallsFilters,
  paging: ToolCallsPaging,
): Promise<ToolCallListRows> {
  if (scope.repoIds.length === 0) return { total: 0, rows: [] };
  const offset = (paging.page - 1) * paging.pageSize;

  const result = await db.execute(sql`
    WITH RECURSIVE ${scopedTreeCtes(scope, range)}
    SELECT
      u.id AS usage_id,
      d.session_id AS session_id,
      r.user_id AS owner_id,
      us.email AS owner_email,
      (c.value - 'args' - 'cwd') AS call,
      COUNT(*) OVER () AS total
    ${callsFromSql(scope, range, filters)}
    ORDER BY c.value ->> 'ts' DESC, c.value ->> 'callId' DESC, u.id DESC
    LIMIT ${paging.pageSize} OFFSET ${offset}
  `);

  const rows = result.rows as unknown as CallSqlRow[];
  let total = rows.length > 0 ? num(rows[0].total) : 0;
  if (rows.length === 0 && paging.page > 1) {
    const countResult = await db.execute(sql`
      WITH RECURSIVE ${scopedTreeCtes(scope, range)}
      SELECT COUNT(*) AS total
      ${callsFromSql(scope, range, filters)}
    `);
    total = num(
      (countResult.rows[0] as { total?: unknown } | undefined)?.total,
    );
  }

  return {
    total,
    rows: rows.flatMap((r): ToolCallListRow[] =>
      isRecord(r.call)
        ? [
            {
              usageId: num(r.usage_id),
              sessionId: r.session_id,
              ownerId: numOrNull(r.owner_id),
              ownerEmail: r.owner_email ?? null,
              call: r.call as unknown as Omit<ToolCallRecord, 'args' | 'cwd'>,
            },
          ]
        : [],
    ),
  };
}

/** Builds a calls-table item from a row and the (already masked) owner e-mail. */
export function toToolCallListItem(
  row: ToolCallListRow,
  email: string | null,
): ToolCallListItem {
  return {
    ...row.call,
    usageId: row.usageId,
    sessionId: row.sessionId,
    sessionOwner: { id: row.ownerId ?? 0, email },
  };
}

// ── Call detail ──────────────────────────────────────────────────────────────────────────────

interface DetailSqlRow {
  usage_id: unknown;
  node_row_id: unknown;
  node_session_id: string;
  root_session_id: string;
  owner_id: unknown;
  owner_email: string | null;
  call: unknown;
  output: unknown;
}

/**
 * One call of usage row `usageId` (DD-9, DD-10) with its `outputs` entry, the node and root
 * session ids and the root's uploader. Returns null when the row or call is missing, or the
 * tree's root is deleted or not linked to any of `repoIds` — the controller answers 404 and
 * then runs the visibility check (`assertSessionVisible`) on `nodeRowId`.
 */
export async function loadCallDetail(
  db: DrizzleDb,
  usageId: number,
  callId: string,
  repoIds: number[],
): Promise<ToolCallDetailRow | null> {
  if (repoIds.length === 0) return null;

  const result = await db.execute(sql`
    WITH RECURSIVE target AS (
      SELECT u.id, u.session_id, c.value AS call, u.outputs -> ${callId}::text AS output
      FROM session_tool_usage u
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(u.calls) = 'array' THEN u.calls ELSE '[]'::jsonb END
      ) AS c(value)
      WHERE u.id = ${usageId} AND c.value ->> 'callId' = ${callId}
      LIMIT 1
    ),
    ${topAncestorIdsSql(sql`ARRAY(SELECT session_id FROM target)::bigint[]`)}
    SELECT
      t.id AS usage_id,
      n.id AS node_row_id,
      n.session_id AS node_session_id,
      root.session_id AS root_session_id,
      owner.user_id AS owner_id,
      us.email AS owner_email,
      t.call,
      t.output
    FROM target t
    INNER JOIN sessions n ON n.id = t.session_id
    INNER JOIN top_ancestors ta ON ta.id = t.session_id
    INNER JOIN sessions root ON root.id = ta.top_id
    INNER JOIN LATERAL (
      SELECT l.user_id
      FROM logs l
      INNER JOIN log_repositories lr ON lr.log_id = l.id
      WHERE l.session_id = root.id
        AND l.log_type = 'artisyn'
        AND lr.repo_id = ANY(${intArray(repoIds)})
      LIMIT 1
    ) owner ON true
    LEFT JOIN users us ON us.id = owner.user_id
    WHERE root.deleted = false
  `);

  const row = result.rows[0] as unknown as DetailSqlRow | undefined;
  if (row === undefined || !isRecord(row.call)) return null;
  const output: ToolCallOutput = isRecord(row.output)
    ? (row.output as unknown as ToolCallOutput)
    : { encoding: 'utf8' };
  return {
    usageId: num(row.usage_id),
    nodeRowId: num(row.node_row_id),
    sessionId: row.node_session_id,
    rootSessionId: row.root_session_id,
    ownerId: numOrNull(row.owner_id),
    ownerEmail: row.owner_email ?? null,
    call: row.call as unknown as ToolCallRecord,
    output,
  };
}
