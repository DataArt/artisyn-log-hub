import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { descendantSessionsCte } from '../session-tree.sql';
import {
  computeFailureRate,
  DURATION_BUCKET_COUNT,
  emptyDurationBySource,
  interpolateHistogramPercentile,
  mcpServerOfTool,
  type DurationSource,
} from '../tool-stats';
import {
  loadScopedRootSessions,
  num,
  sessionIdsArray,
  type AnalyticsScope,
} from './scoped-sessions.sql';
import type {
  McpServerRow,
  ToolAnalyticsResponse,
  ToolAnalyticsRow,
} from './usage-analytics.types';

/**
 * One `(agent side, tool)` group as aggregated by Postgres. `is_main` is `true` for the root
 * session's own calls (descendant depth 0) and `false` for sub-agent calls (depth > 0).
 */
interface ToolGroupSqlRow {
  is_main: boolean;
  tool_name: string;
  calls: string | number | null;
  failures: string | number | null;
  unresolved: string | number | null;
  covered: string | number | null;
  total_ms: string | number | null;
  max_ms: string | number | null;
  parallel_calls: string | number | null;
  histogram: number[] | null;
  by_source: Record<string, number | string> | null;
}

/** The mutable accumulator a `ToolAnalyticsRow` is folded up in. */
interface ToolAccumulator {
  tool: string;
  calls: number;
  failures: number;
  unresolved: number;
  durationCoveredCalls: number;
  durationMsTotal: number;
  durationMaxMs: number;
  parallelBatchCalls: number;
  histogram: number[];
  bySource: Record<DurationSource, number>;
}

@Injectable()
export class ToolAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    scope: AnalyticsScope,
  ): Promise<ToolAnalyticsResponse> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    if (roots.length === 0) return emptyResponse();

    const groups = await this.loadToolGroups(roots.map((r) => r.sessionRowId));
    return buildToolAnalytics(groups);
  }

  /**
   * Phase B — per-tool aggregation over the whole session tree, split by agent side.
   *
   * Everything is summed inside Postgres rather than shipping one row per
   * `(session, tool)`: a busy repository holds tens of thousands of those, and the response
   * only ever needs ~50 groups. `session_tool_stats` is read directly — no `logs.body` is
   * touched, which is the performance requirement for this route.
   *
   * The histogram and `duration_by_source` jsonb columns are summed elementwise via
   * `WITH ORDINALITY` / `jsonb_each_text` and re-aggregated into one array/object per group.
   */
  private async loadToolGroups(rootIds: number[]): Promise<ToolGroupSqlRow[]> {
    const idsArray = sessionIdsArray(rootIds);

    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArray)},
      scoped AS (
        SELECT ds.id AS session_id, (ds.depth = 0) AS is_main
        FROM descendant_sessions ds
      ),
      base AS (
        SELECT
          sc.is_main                            AS is_main,
          sts.tool_name                         AS tool_name,
          SUM(sts.calls)                        AS calls,
          SUM(sts.failures)                     AS failures,
          SUM(sts.unresolved)                   AS unresolved,
          SUM(sts.duration_covered_calls)       AS covered,
          SUM(sts.duration_ms_total)            AS total_ms,
          MAX(sts.duration_ms_max)              AS max_ms,
          SUM(sts.parallel_batch_calls)         AS parallel_calls
        FROM scoped sc
        JOIN session_tool_stats sts ON sts.session_id = sc.session_id
        GROUP BY sc.is_main, sts.tool_name
      ),
      hist AS (
        SELECT
          sc.is_main            AS is_main,
          sts.tool_name         AS tool_name,
          h.idx                 AS idx,
          SUM(h.value::bigint)  AS n
        FROM scoped sc
        JOIN session_tool_stats sts ON sts.session_id = sc.session_id
        CROSS JOIN LATERAL jsonb_array_elements_text(sts.duration_ms_histogram)
          WITH ORDINALITY AS h(value, idx)
        GROUP BY sc.is_main, sts.tool_name, h.idx
      ),
      hist_agg AS (
        SELECT is_main, tool_name, jsonb_agg(n ORDER BY idx) AS histogram
        FROM hist GROUP BY is_main, tool_name
      ),
      src AS (
        SELECT
          sc.is_main            AS is_main,
          sts.tool_name         AS tool_name,
          k.key                 AS key,
          SUM(k.value::bigint)  AS n
        FROM scoped sc
        JOIN session_tool_stats sts ON sts.session_id = sc.session_id
        CROSS JOIN LATERAL jsonb_each_text(sts.duration_by_source) AS k(key, value)
        GROUP BY sc.is_main, sts.tool_name, k.key
      ),
      src_agg AS (
        SELECT is_main, tool_name, jsonb_object_agg(key, n) AS by_source
        FROM src GROUP BY is_main, tool_name
      )
      SELECT
        b.is_main, b.tool_name, b.calls, b.failures, b.unresolved,
        b.covered, b.total_ms, b.max_ms, b.parallel_calls,
        ha.histogram AS histogram,
        sa.by_source AS by_source
      FROM base b
      LEFT JOIN hist_agg ha
        ON ha.is_main = b.is_main AND ha.tool_name = b.tool_name
      LEFT JOIN src_agg sa
        ON sa.is_main = b.is_main AND sa.tool_name = b.tool_name
    `);

    return result.rows as unknown as ToolGroupSqlRow[];
  }
}

// --- Pure assembly (exported for unit tests) ---------------------------------------------

function emptyResponse(): ToolAnalyticsResponse {
  return {
    tools: [],
    mainAgent: [],
    subAgent: [],
    mcpServers: [],
    totalCalls: 0,
    parallelBatchCalls: 0,
  };
}

/**
 * Folds the SQL groups into the three ranked tables plus the MCP-per-server rollup.
 *
 * `tools` is the combined ranking, `mainAgent`/`subAgent` the same rows split by agent side.
 * Every median here is interpolated from a bucket histogram, so all three tables are flagged
 * `durationApproximate: true` — per-session medians cannot be averaged, and session scope
 * computes its exact median client-side instead.
 */
export function buildToolAnalytics(
  groups: ToolGroupSqlRow[],
): ToolAnalyticsResponse {
  const combined = new Map<string, ToolAccumulator>();
  const main = new Map<string, ToolAccumulator>();
  const sub = new Map<string, ToolAccumulator>();

  for (const group of groups) {
    const side = group.is_main ? main : sub;
    accumulate(combined, group);
    accumulate(side, group);
  }

  const tools = rank(combined);
  const totalCalls = tools.reduce((sum, row) => sum + row.calls, 0);
  const parallelBatchCalls = tools.reduce(
    (sum, row) => sum + row.parallelBatchCalls,
    0,
  );

  return {
    tools,
    mainAgent: rank(main),
    subAgent: rank(sub),
    mcpServers: rollupMcpServers(tools),
    totalCalls,
    parallelBatchCalls,
  };
}

function accumulate(
  target: Map<string, ToolAccumulator>,
  group: ToolGroupSqlRow,
): void {
  let acc = target.get(group.tool_name);
  if (acc === undefined) {
    acc = {
      tool: group.tool_name,
      calls: 0,
      failures: 0,
      unresolved: 0,
      durationCoveredCalls: 0,
      durationMsTotal: 0,
      durationMaxMs: 0,
      parallelBatchCalls: 0,
      histogram: new Array<number>(DURATION_BUCKET_COUNT).fill(0),
      bySource: emptyDurationBySource(),
    };
    target.set(group.tool_name, acc);
  }

  acc.calls += num(group.calls);
  acc.failures += num(group.failures);
  acc.unresolved += num(group.unresolved);
  acc.durationCoveredCalls += num(group.covered);
  acc.durationMsTotal += num(group.total_ms);
  acc.durationMaxMs = Math.max(acc.durationMaxMs, num(group.max_ms));
  acc.parallelBatchCalls += num(group.parallel_calls);

  if (group.histogram !== null) {
    for (let i = 0; i < DURATION_BUCKET_COUNT; i++) {
      acc.histogram[i] += num(group.histogram[i]);
    }
  }
  if (group.by_source !== null) {
    for (const [key, value] of Object.entries(group.by_source)) {
      if (key in acc.bySource) {
        acc.bySource[key as DurationSource] += num(value);
      }
    }
  }
}

/** Ranked by call count descending, with the tool name as a stable tie-break. */
function rank(accumulators: Map<string, ToolAccumulator>): ToolAnalyticsRow[] {
  return [...accumulators.values()]
    .map(toRow)
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

function toRow(acc: ToolAccumulator): ToolAnalyticsRow {
  const successes = acc.calls - acc.failures - acc.unresolved;
  return {
    tool: acc.tool,
    mcpServer: mcpServerOfTool(acc.tool),
    calls: acc.calls,
    successes,
    failures: acc.failures,
    unresolved: acc.unresolved,
    failureRate: computeFailureRate(successes, acc.failures),
    durationCoveredCalls: acc.durationCoveredCalls,
    durationP50Ms:
      acc.durationCoveredCalls > 0
        ? interpolateHistogramPercentile(acc.histogram, 0.5)
        : null,
    durationMaxMs: acc.durationCoveredCalls > 0 ? acc.durationMaxMs : null,
    durationMeanMs:
      acc.durationCoveredCalls > 0
        ? acc.durationMsTotal / acc.durationCoveredCalls
        : null,
    durationApproximate: true,
    durationBySource: acc.bySource,
    parallelBatchCalls: acc.parallelBatchCalls,
  };
}

/** MCP tools additionally rolled up per server, derived from the `mcp__<server>__` prefix. */
function rollupMcpServers(rows: ToolAnalyticsRow[]): McpServerRow[] {
  const byServer = new Map<string, McpServerRow>();

  for (const row of rows) {
    if (row.mcpServer === null) continue;
    const entry = byServer.get(row.mcpServer) ?? {
      server: row.mcpServer,
      calls: 0,
      failures: 0,
      unresolved: 0,
    };
    entry.calls += row.calls;
    entry.failures += row.failures;
    entry.unresolved += row.unresolved;
    byServer.set(row.mcpServer, entry);
  }

  return [...byServer.values()].sort(
    (a, b) => b.calls - a.calls || a.server.localeCompare(b.server),
  );
}
