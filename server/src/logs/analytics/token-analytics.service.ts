import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
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
  TokenAnalyticsResponse,
  TokenTotals,
} from './usage-analytics.types';

/** Per-root-session token rollup over that session's whole tree (depth >= 0). */
interface TreeTokenSqlRow {
  root_id: string | number;
  input: string | number | null;
  output: string | number | null;
  cache_read: string | number | null;
  cache_creation: string | number | null;
  cache_write_5m: string | number | null;
  cache_write_1h: string | number | null;
}

interface TierTokenSqlRow {
  tier: string;
  input: string | number | null;
  output: string | number | null;
  cache_read: string | number | null;
  cache_creation: string | number | null;
  cache_write_5m: string | number | null;
  cache_write_1h: string | number | null;
}

@Injectable()
export class TokenAnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    scope: AnalyticsScope,
  ): Promise<TokenAnalyticsResponse> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    if (roots.length === 0) {
      return { totals: emptyTotals(), byServiceTier: [], buckets: [] };
    }

    const rootIds = roots.map((r) => r.sessionRowId);
    const [treeRows, tierRows] = await Promise.all([
      this.loadTreeTokens(rootIds),
      this.loadServiceTierTokens(rootIds),
    ]);

    const perRoot = new Map<number, TokenTotals>();
    for (const row of treeRows) {
      perRoot.set(Number(row.root_id), {
        input: num(row.input),
        output: num(row.output),
        cacheRead: num(row.cache_read),
        cacheCreation: num(row.cache_creation),
        cacheWrite5m: num(row.cache_write_5m),
        cacheWrite1h: num(row.cache_write_1h),
      });
    }

    return {
      totals: sumTotals([...perRoot.values()]),
      byServiceTier: tierRows
        .map((row) => ({
          tier: row.tier,
          input: num(row.input),
          output: num(row.output),
          cacheRead: num(row.cache_read),
          cacheCreation: num(row.cache_creation),
          cacheWrite5m: num(row.cache_write_5m),
          cacheWrite1h: num(row.cache_write_1h),
        }))
        .sort((a, b) => b.input + b.output - (a.input + a.output)),
      buckets: bucketByDay(roots, perRoot),
    };
  }

  /**
   * Per-root token rollup over the whole tree. `depth >= 0` deliberately includes the root
   * itself, so one query covers both the session's own usage and its sub-agents'.
   *
   * Reads only `session_stats` columns — the totals stay pinned to what
   * `extractClaudeStats()` derived from top-level `message.usage`, per
   * `docs/knowledgebase/llm-call-math.md`. The `iterations[]` decomposition is session-scope
   * only and never contributes here.
   */
  private async loadTreeTokens(rootIds: number[]): Promise<TreeTokenSqlRow[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))}
      SELECT
        ds.root_id                                AS root_id,
        COALESCE(SUM(ss.input_tokens), 0)         AS input,
        COALESCE(SUM(ss.output_tokens), 0)        AS output,
        COALESCE(SUM(ss.cache_read_tokens), 0)    AS cache_read,
        COALESCE(SUM(ss.cache_write_tokens), 0)   AS cache_creation,
        COALESCE(SUM(ss.cache_write_5m_tokens), 0) AS cache_write_5m,
        COALESCE(SUM(ss.cache_write_1h_tokens), 0) AS cache_write_1h
      FROM descendant_sessions ds
      JOIN session_stats ss ON ss.session_id = ds.id
        -- Excludes an OTEL-only session_stats row (no transcript ever uploaded
        -- for it) from the tree token rollup.
        AND EXISTS (
          SELECT 1 FROM logs tl
          WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
        )
      GROUP BY ds.root_id
    `);
    return result.rows as unknown as TreeTokenSqlRow[];
  }

  /**
   * Token totals per `service_tier`, unrolled from the `token_by_service_tier` jsonb column.
   * Messages that carried no `service_tier` were stored under the `'unknown'` key at ingest,
   * so that bucket appears here like any other rather than silently vanishing.
   */
  private async loadServiceTierTokens(
    rootIds: number[],
  ): Promise<TierTokenSqlRow[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))}
      SELECT
        t.key                                                   AS tier,
        COALESCE(SUM((t.value->>'input')::bigint), 0)           AS input,
        COALESCE(SUM((t.value->>'output')::bigint), 0)          AS output,
        COALESCE(SUM((t.value->>'cacheRead')::bigint), 0)       AS cache_read,
        COALESCE(SUM((t.value->>'cacheCreation')::bigint), 0)   AS cache_creation,
        COALESCE(SUM((t.value->>'cacheWrite5m')::bigint), 0)    AS cache_write_5m,
        COALESCE(SUM((t.value->>'cacheWrite1h')::bigint), 0)    AS cache_write_1h
      FROM descendant_sessions ds
      JOIN session_stats ss ON ss.session_id = ds.id
        -- Excludes an OTEL-only session_stats row (no transcript ever uploaded
        -- for it) from the per-service-tier token rollup.
        AND EXISTS (
          SELECT 1 FROM logs tl
          WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
        )
      CROSS JOIN LATERAL jsonb_each(ss.token_by_service_tier) AS t(key, value)
      GROUP BY t.key
    `);
    return result.rows as unknown as TierTokenSqlRow[];
  }
}

// --- Pure helpers (exported for unit tests) ----------------------------------------------

export function emptyTotals(): TokenTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
}

export function sumTotals(totals: TokenTotals[]): TokenTotals {
  return totals.reduce<TokenTotals>(
    (acc, t) => ({
      input: acc.input + t.input,
      output: acc.output + t.output,
      cacheRead: acc.cacheRead + t.cacheRead,
      cacheCreation: acc.cacheCreation + t.cacheCreation,
      cacheWrite5m: acc.cacheWrite5m + t.cacheWrite5m,
      cacheWrite1h: acc.cacheWrite1h + t.cacheWrite1h,
    }),
    emptyTotals(),
  );
}

/**
 * Buckets each tree's tokens into the UTC day of its *root* session's start time, matching the
 * existing reports' day-key convention. A sub-agent that ran past midnight is attributed to its
 * root's day rather than splitting one logical session across two buckets.
 */
export function bucketByDay(
  roots: ScopedRootSession[],
  perRoot: Map<number, TokenTotals>,
): ({ bucket: string } & TokenTotals)[] {
  const byDay = new Map<string, TokenTotals[]>();

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
    .map(([bucket, list]) => ({ bucket, ...sumTotals(list) }));
}
