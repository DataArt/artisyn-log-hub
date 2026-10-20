import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { num, sessionIdsArray } from './analytics/scoped-sessions.sql';
import { descendantSessionsCte } from './session-tree.sql';

/**
 * The single server-side definition of the **tree-scoped** `session_stats` rollup.
 *
 * `session_stats` rows are strictly per-node: one for the root transcript and one for every
 * sub-agent transcript, each counting only what that transcript itself did. Any surface that
 * wants "what did this session and all its sub-agents change" must therefore sum over the
 * recursive `descendant_sessions` tree — and before the shared rollup four surfaces did not, reporting a
 * delegating session (all work done by sub-agents) as `0 lines changed`.
 *
 * Two entry points, one SQL definition:
 * - {@link treeMetricsCte} — the CTE body, for a caller that already builds
 *   `descendant_sessions` inside its own `WITH RECURSIVE` (analytics timeline, executive
 *   summary Phase B). Embed it after that CTE and join on `root_id`.
 * - {@link loadTreeMetricsByRoot} — a standalone batched query for a caller that has no such
 *   CTE (branch summary): one round trip for all roots, never per-root N+1.
 *
 * ## The double-count trap
 *
 * `descendant_sessions` emits the root itself at `depth = 0`, and this rollup applies **no
 * `depth` predicate** — so the returned totals **already include the root's own row**. Adding
 * the root's own `session_stats` value on top of a tree total is a silent double count, and it
 * is the single easiest mistake to make here: both figures are needed side by side (the
 * payloads expose `linesChanged` and `linesChangedOwn`), so the own value is always in scope
 * at the call site.
 *
 * A root-own fallback is nonetheless required for the one case where the root is *absent*
 * from the rollup: it has no `session_stats` row, or its only row is OTEL-derived and the
 * OTEL-only-row guard below excludes it. `rootCounted` distinguishes the two cases and
 * {@link withOwnFallback} is the only sanctioned way to combine them — call sites must not
 * re-derive `tree + own` by hand.
 *
 * ## What the guard excludes
 *
 * The join carries the OTEL-only-row `EXISTS` guard: a session whose `session_stats` row exists only
 * because OTEL cost telemetry arrived (no transcript was ever uploaded for it) contributes
 * nothing. Without the guard a tree total would count a node the per-node surfaces cannot
 * show. `/logs`' `subagentStats` select carries the same guard, which is what makes the
 * client-side sum and this server-side rollup unable to disagree.
 *
 * Scope note: temporal metrics — `work_time_ms` — are deliberately NOT
 * in this rollup. Sub-agents run inside the root's wall-clock span, so the root's own value is
 * already the correct tree value; summing it over the tree would over-count.
 */

/** Name of the CTE {@link treeMetricsCte} defines, for callers writing the join by hand. */
export const SESSION_TREE_METRICS_CTE = 'session_tree_metrics';

/**
 * One root's tree totals. Every counter is the sum over the root **and** all its descendants
 * at any depth — see the double-count note in the module docblock before combining any of
 * these with a root-own figure.
 */
export interface SessionTreeMetrics {
  /** Lines *written* by Edit/Write/MultiEdit calls (no delta, no removals). */
  linesChanged: number;
  /** Count of Edit/Write/MultiEdit **calls**, not of distinct files. */
  filesEditedWritten: number;
  /** Diff-based counters, parsed from `toolUseResult.structuredPatch` at ingest. */
  linesAdded: number;
  linesRemoved: number;
  /** How many Edit/Write/MultiEdit calls carried a parsable diff, out of how many total. */
  diffLinesCoveredCalls: number;
  diffLinesTotalCalls: number;
  imageCount: number;
  mcpCallsTotal: number;
  /**
   * `true` when the root's own `session_stats` row is part of the totals above. `false` means
   * the root contributed nothing (no stats row, or excluded by the OTEL-only-row guard) and a
   * root-own fallback may be added — exactly once, via {@link withOwnFallback}.
   */
  rootCounted: boolean;
  /**
   * How many **descendant** rows (`depth > 0`) contributed. Counts only descendants that
   * survived the join and the OTEL-only-row guard, i.e. the same set the totals are built from —
   * which is what a UI needs when it says "N in M sub-agent(s)".
   */
  descendantCount: number;
}

export const EMPTY_TREE_METRICS: SessionTreeMetrics = {
  linesChanged: 0,
  filesEditedWritten: 0,
  linesAdded: 0,
  linesRemoved: 0,
  diffLinesCoveredCalls: 0,
  diffLinesTotalCalls: 0,
  imageCount: 0,
  mcpCallsTotal: 0,
  rootCounted: false,
  descendantCount: 0,
};

/** Raw shape of one {@link treeMetricsCte} row (`bigint` sums arrive as strings). */
export interface TreeMetricsSqlRow {
  root_id: string | number;
  lines_changed: string | number | null;
  files_edited_written: string | number | null;
  lines_added: string | number | null;
  lines_removed: string | number | null;
  diff_lines_covered_calls: string | number | null;
  diff_lines_total_calls: string | number | null;
  image_count: string | number | null;
  mcp_calls_total: string | number | null;
  root_counted: boolean | null;
  descendant_count: string | number | null;
}

/**
 * The `COALESCE(SUM(...), 0)` column list, shared by both entry points so the set of counters
 * can never drift between them. Private on purpose: a caller needing one
 * more column adds it here, not in a copy of the query.
 */
function treeMetricsSumColumns(): SQL {
  return sql`
        COALESCE(SUM(ss.lines_changed), 0)              AS lines_changed,
        COALESCE(SUM(ss.files_edited_written), 0)       AS files_edited_written,
        COALESCE(SUM(ss.lines_added), 0)                AS lines_added,
        COALESCE(SUM(ss.lines_removed), 0)              AS lines_removed,
        COALESCE(SUM(ss.diff_lines_covered_calls), 0)   AS diff_lines_covered_calls,
        COALESCE(SUM(ss.diff_lines_total_calls), 0)     AS diff_lines_total_calls,
        COALESCE(SUM(ss.image_count), 0)                AS image_count,
        COALESCE(SUM(ss.mcp_calls_total), 0)            AS mcp_calls_total`;
}

/**
 * The `session_tree_metrics` CTE body (no `WITH` keyword, no trailing comma), for embedding
 * after an existing `descendant_sessions` CTE in the same `WITH RECURSIVE` clause:
 *
 * ```ts
 * sql`WITH RECURSIVE ${descendantSessionsCte(ids)}, ${treeMetricsCte()} SELECT ...`
 * ```
 *
 * One row per root that has at least one counted node, keyed `root_id` — a root whose whole
 * tree is uncounted has **no** row at all, so callers must `LEFT JOIN` and treat a missing row
 * as {@link EMPTY_TREE_METRICS}.
 *
 * `extraSumColumns` appends caller-specific aggregates over the same `descendant_sessions` x
 * `session_stats` join (leading comma required). It exists so a caller needing a counter that
 * is not part of {@link SessionTreeMetrics} — the productivity service's `commit_count` /
 * `pr_count` — still shares this one join, guard and `GROUP BY` instead of hand-writing a
 * second rollup.
 */
export function treeMetricsCte(extraSumColumns?: SQL): SQL {
  const extras = extraSumColumns ?? sql``;
  return sql`${sql.raw(SESSION_TREE_METRICS_CTE)} AS (
      SELECT
        ds.root_id                                     AS root_id,
        ${treeMetricsSumColumns()}${extras},
        BOOL_OR(ds.depth = 0)                          AS root_counted,
        COUNT(*) FILTER (WHERE ds.depth > 0)           AS descendant_count
      FROM descendant_sessions ds
      JOIN session_stats ss ON ss.session_id = ds.id
        -- An OTEL-only session_stats row (no transcript ever uploaded for it)
        -- contributes nothing to a tree total, exactly as it contributes nothing to the
        -- per-node surfaces.
        AND EXISTS (
          SELECT 1 FROM logs tl
          WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
        )
      GROUP BY ds.root_id
    )`;
}

/**
 * Standalone batched rollup for callers with no `descendant_sessions` CTE of their own.
 *
 * Keyed by `sessions.id`. Roots with nothing counted are simply absent from the map — see
 * {@link withOwnFallback} for the correct way to resolve a miss.
 */
export async function loadTreeMetricsByRoot(
  db: DrizzleDb,
  rootIds: number[],
): Promise<Map<number, SessionTreeMetrics>> {
  const byRoot = new Map<number, SessionTreeMetrics>();
  if (rootIds.length === 0) return byRoot;

  const result = await db.execute(sql`
    WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))},
      ${treeMetricsCte()}
    SELECT * FROM ${sql.raw(SESSION_TREE_METRICS_CTE)}
  `);

  for (const row of result.rows as unknown as TreeMetricsSqlRow[]) {
    byRoot.set(Number(row.root_id), mapTreeMetricsRow(row));
  }
  return byRoot;
}

/** Normalises one raw CTE row; `bigint` sums arrive as strings from node-postgres. */
export function mapTreeMetricsRow(row: TreeMetricsSqlRow): SessionTreeMetrics {
  return {
    linesChanged: num(row.lines_changed),
    filesEditedWritten: num(row.files_edited_written),
    linesAdded: num(row.lines_added),
    linesRemoved: num(row.lines_removed),
    diffLinesCoveredCalls: num(row.diff_lines_covered_calls),
    diffLinesTotalCalls: num(row.diff_lines_total_calls),
    imageCount: num(row.image_count),
    mcpCallsTotal: num(row.mcp_calls_total),
    rootCounted: row.root_counted === true,
    descendantCount: num(row.descendant_count),
  };
}

/** The root's own (per-node) figures, for the fallback path of {@link withOwnFallback}. */
export interface TreeMetricsOwnFallback {
  linesChanged: number;
  filesEditedWritten: number;
}

/**
 * The one sanctioned way to turn a tree rollup plus the root's own figures into the values a
 * surface displays.
 *
 * The rollup already contains the root whenever `rootCounted` is `true`, so the own figures
 * are added **only** when it is `false` — a root with no `session_stats` row, or one the OTEL-only-row
 * guard excluded, whose value would otherwise vanish. Passing `undefined` for `tree` (the root
 * is absent from the rollup entirely) starts from {@link EMPTY_TREE_METRICS} and therefore
 * yields the own figures unchanged.
 *
 * Consequence worth internalising: for a session with no sub-agents the result equals the own
 * figures exactly, whichever branch ran — that identity is what the e2e double-count guard
 * asserts.
 */
export function withOwnFallback(
  tree: SessionTreeMetrics | undefined,
  own: TreeMetricsOwnFallback,
): TreeMetricsOwnFallback {
  const t = tree ?? EMPTY_TREE_METRICS;
  if (t.rootCounted) {
    return {
      linesChanged: t.linesChanged,
      filesEditedWritten: t.filesEditedWritten,
    };
  }
  return {
    linesChanged: t.linesChanged + own.linesChanged,
    filesEditedWritten: t.filesEditedWritten + own.filesEditedWritten,
  };
}
