import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import {
  mapTreeMetricsRow,
  SESSION_TREE_METRICS_CTE,
  treeMetricsCte,
  type TreeMetricsSqlRow,
} from '../session-tree-metrics.sql';
import { descendantSessionsCte } from '../session-tree.sql';
import {
  dayKey,
  loadScopedRootSessions,
  num,
  sessionIdsArray,
  type AnalyticsScope,
  type ScopedRootSession,
} from './scoped-sessions.sql';
import type {
  ProductivityAnalyticsResponse,
  ProductivityBucket,
  ProductivityTotals,
} from './usage-analytics.types';

/**
 * Productivity counters at repository scope.
 *
 * Every figure here is **diff-based** — parsed from `toolUseResult.structuredPatch` at ingest —
 * and is deliberately a different measure from `session_stats.lines_changed`, which counts
 * lines *written* by Edit/Write with no delta and no removals. `lines_changed` keeps its
 * semantics, its values and every one of its consumers (including `costPerLine`); this service
 * never reads it, and no view may show both figures at once.
 */

/**
 * The shared tree-rollup row (`session-tree-metrics.sql.ts`) plus this service's two
 * commit/PR counters, which no other surface rolls up and which therefore ride along as
 * `extraSumColumns` rather than widening `SessionTreeMetrics`.
 */
interface ProductivitySqlRow extends TreeMetricsSqlRow {
  commits: string | number | null;
  pull_requests: string | number | null;
}

@Injectable()
export class ProductivityAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    scope: AnalyticsScope,
  ): Promise<ProductivityAnalyticsResponse> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    if (roots.length === 0) {
      return { totals: emptyProductivityTotals(), buckets: [] };
    }

    const rows = await this.loadTreeCounters(roots.map((r) => r.sessionRowId));

    const perRoot = new Map<number, ProductivityTotals>();
    for (const row of rows) {
      const tree = mapTreeMetricsRow(row);
      perRoot.set(Number(row.root_id), {
        linesAdded: tree.linesAdded,
        linesRemoved: tree.linesRemoved,
        commits: num(row.commits),
        pullRequests: num(row.pull_requests),
        diffCoveredCalls: tree.diffLinesCoveredCalls,
        diffTotalCalls: tree.diffLinesTotalCalls,
      });
    }

    return {
      totals: sumProductivity([...perRoot.values()]),
      buckets: bucketProductivityByDay(roots, perRoot),
    };
  }

  /**
   * Per-root rollup over the whole tree (`depth >= 0` includes the root itself), reading only
   * pre-computed `session_stats` columns — never `logs.body`.
   *
   * The join, the OTEL-only-row guard and the `GROUP BY` now come from the shared
   * `treeMetricsCte()` — this service's hand-written twin was the second definition of the
   * same rollup, and the two were free to drift. `commit_count`/`pr_count` are the only
   * counters no other surface needs, so they ride along as extra sum columns over the same
   * join. Values and response shape are unchanged.
   */
  private async loadTreeCounters(
    rootIds: number[],
  ): Promise<ProductivitySqlRow[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))},
        ${treeMetricsCte(sql`,
        COALESCE(SUM(ss.commit_count), 0)               AS commits,
        COALESCE(SUM(ss.pr_count), 0)                   AS pull_requests`)}
      SELECT * FROM ${sql.raw(SESSION_TREE_METRICS_CTE)}
    `);
    return result.rows as unknown as ProductivitySqlRow[];
  }
}

// --- Pure helpers (exported for unit tests) ----------------------------------------------

export function emptyProductivityTotals(): ProductivityTotals {
  return {
    linesAdded: 0,
    linesRemoved: 0,
    commits: 0,
    pullRequests: 0,
    diffCoveredCalls: 0,
    diffTotalCalls: 0,
  };
}

export function sumProductivity(
  totals: ProductivityTotals[],
): ProductivityTotals {
  return totals.reduce<ProductivityTotals>(
    (acc, t) => ({
      linesAdded: acc.linesAdded + t.linesAdded,
      linesRemoved: acc.linesRemoved + t.linesRemoved,
      commits: acc.commits + t.commits,
      pullRequests: acc.pullRequests + t.pullRequests,
      diffCoveredCalls: acc.diffCoveredCalls + t.diffCoveredCalls,
      diffTotalCalls: acc.diffTotalCalls + t.diffTotalCalls,
    }),
    emptyProductivityTotals(),
  );
}

/** UTC day of the root session's start time — same convention as the token buckets. */
export function bucketProductivityByDay(
  roots: ScopedRootSession[],
  perRoot: Map<number, ProductivityTotals>,
): ProductivityBucket[] {
  const byDay = new Map<string, ProductivityTotals[]>();

  for (const root of roots) {
    const key = dayKey(root.startTime);
    if (key === null) continue;
    const totals = perRoot.get(root.sessionRowId);
    if (totals === undefined) continue;
    const existing = byDay.get(key);
    if (existing) existing.push(totals);
    else byDay.set(key, [totals]);
  }

  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, list]) => {
      const summed = sumProductivity(list);
      return {
        bucket,
        linesAdded: summed.linesAdded,
        linesRemoved: summed.linesRemoved,
        commits: summed.commits,
        pullRequests: summed.pullRequests,
      };
    });
}
