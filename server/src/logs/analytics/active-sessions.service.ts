import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { maskFirstPrompt } from '../team-scope';
import { descendantSessionsCte } from '../session-tree.sql';
import { loadTreeCostRows, readTreeCost } from '../session-tree-cost.sql';
import {
  loadScopedRootSessions,
  num,
  sessionIdsArray,
  type AnalyticsScope,
  type ScopedRootSession,
} from './scoped-sessions.sql';
import type {
  ActiveSessionRow,
  ActiveSessionsResponse,
} from './usage-analytics.types';

/**
 * Active-session overview.
 *
 * "Active" means *recency inside the selected date range*, not a live-session concept:
 * transcripts are uploaded after the fact and the data carries no active/isActive notion. Rows
 * are ordered by last activity descending and every figure covers the session's whole tree, so
 * a session whose work was done by sub-agents does not report zeros.
 */

interface TreeRollupSqlRow {
  root_id: string | number;
  total_tokens: string | number | null;
  lines_added: string | number | null;
  lines_removed: string | number | null;
}

interface ToolRollupSqlRow {
  root_id: string | number;
  tool_calls: string | number | null;
  top_tool: string | null;
}

@Injectable()
export class ActiveSessionsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async build(
    repoIds: number[],
    scope: AnalyticsScope,
    limit: number,
  ): Promise<ActiveSessionsResponse> {
    const roots = await loadScopedRootSessions(this.db, repoIds, scope);
    if (roots.length === 0) {
      return { sessions: [], limit, truncated: false };
    }

    // Order and truncate before the rollups, so a 5,000-session range still only rolls up the
    // rows that will actually be returned.
    const ordered = [...roots].sort(
      (a, b) => lastActivityMs(b) - lastActivityMs(a),
    );
    const truncated = ordered.length > limit;
    const page = ordered.slice(0, limit);
    const rootIds = page.map((r) => r.sessionRowId);

    const [treeRows, toolRows, costRows] = await Promise.all([
      this.loadTreeRollup(rootIds),
      this.loadToolRollup(rootIds),
      loadTreeCostRows(this.db, rootIds),
    ]);

    const treeByRoot = new Map(
      treeRows.map((r) => [Number(r.root_id), r] as const),
    );
    const toolByRoot = new Map(
      toolRows.map((r) => [Number(r.root_id), r] as const),
    );

    const sessions: ActiveSessionRow[] = page.map((root) => {
      const tree = treeByRoot.get(root.sessionRowId);
      const tools = toolByRoot.get(root.sessionRowId);
      // The same complete tree cost every other surface shows (session-tree-cost.sql.ts).
      const cost = readTreeCost(costRows.get(root.sessionRowId));
      return {
        sessionId: root.sessionId,
        // A `manager` (`team-no-prompts`) sees every visible
        // member's row and its statistics, but never another member's prompt text.
        // Masked here in the projection, never in the `WHERE` — `first_prompt IS NOT
        // NULL` is the root-session discriminator and filtering on it would drop the row.
        firstPrompt: maskFirstPrompt(
          scope.scope,
          scope.requesterUserId,
          root.userId,
          root.firstPrompt,
        ),
        userEmail: root.userEmail,
        gitBranch: root.branch,
        lastActivity: new Date(lastActivityMs(root)).toISOString(),
        workTimeMs: root.workTimeMs,
        turns: root.turnCount,
        totalTokens: num(tree?.total_tokens),
        totalCost: cost.total,
        unpricedModels: cost.unpricedModels,
        costUnavailableReason: cost.costUnavailableReason,
        toolCalls: num(tools?.tool_calls),
        linesAdded: num(tree?.lines_added),
        linesRemoved: num(tree?.lines_removed),
        topTool: tools?.top_tool ?? null,
      };
    });

    return { sessions, limit, truncated };
  }

  /**
   * Tokens and diff-based line counts over the whole tree (`depth >= 0`). The cost comes from
   * `loadTreeCostRows` instead, so this panel shows the sessions list's figure.
   */
  private async loadTreeRollup(rootIds: number[]): Promise<TreeRollupSqlRow[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))}
      SELECT
        ds.root_id AS root_id,
        COALESCE(SUM(
          ss.input_tokens + ss.output_tokens
          + ss.cache_read_tokens + ss.cache_write_tokens
        ), 0) AS total_tokens,
        COALESCE(SUM(ss.lines_added), 0)   AS lines_added,
        COALESCE(SUM(ss.lines_removed), 0) AS lines_removed
      FROM descendant_sessions ds
      JOIN session_stats ss ON ss.session_id = ds.id
        -- Excludes an OTEL-only session_stats row (no transcript ever uploaded
        -- for it) from the tree token/lines rollup.
        AND EXISTS (
          SELECT 1 FROM logs tl
          WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
        )
      GROUP BY ds.root_id
    `);
    return result.rows as unknown as TreeRollupSqlRow[];
  }

  /** Tool-call count and the single most-used tool per tree, from `session_tool_stats`. */
  private async loadToolRollup(rootIds: number[]): Promise<ToolRollupSqlRow[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))},
      per_tool AS (
        SELECT ds.root_id AS root_id, sts.tool_name AS tool_name, SUM(sts.calls) AS calls
        FROM descendant_sessions ds
        JOIN session_tool_stats sts ON sts.session_id = ds.id
        GROUP BY ds.root_id, sts.tool_name
      )
      SELECT
        root_id,
        SUM(calls) AS tool_calls,
        -- Most-used tool, with the name as a deterministic tie-break.
        (ARRAY_AGG(tool_name ORDER BY calls DESC, tool_name ASC))[1] AS top_tool
      FROM per_tool
      GROUP BY root_id
    `);
    return result.rows as unknown as ToolRollupSqlRow[];
  }
}

/**
 * Last activity of a root session: its `end_time` when present, else its `start_time`.
 *
 * `artisyn` logs can carry a null `end_time` for a session that never reported completion;
 * falling back to `start_time` keeps such a session in the ordering instead of sorting it to
 * the epoch.
 */
export function lastActivityMs(root: ScopedRootSession): number {
  const end = root.endTime === null ? NaN : new Date(root.endTime).getTime();
  if (!isNaN(end) && end > 0) return end;
  const start = new Date(root.startTime).getTime();
  return isNaN(start) ? 0 : start;
}
