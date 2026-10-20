import { sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import { sessionCauseStats } from '../database/schema/index';
import type { TurnCauseTotals } from './turn-walk';

/**
 * Which config scope a `session_cause_stats` row belongs to.
 *
 * The cause decomposition depends on the high-cache-creation threshold, which is a scoped
 * config field — a team-wide value (`team_repo_config`) and a personal override
 * (`repo_config`) can be in force for the same session at the same time. Exactly one of the two ids is set per row, mirroring
 * `session_file_stats`.
 */
export type CauseStatsScope =
  | { teamId: number; userId?: never }
  | { userId: number; teamId?: never };

/**
 * Upserts one scoped `session_cause_stats` row, mirroring `session-stats-writer.ts` so the
 * upload path and the recompute path share a single column list.
 *
 * The conflict target is a *partial* unique index — `UNIQUE (session_id, team_id) WHERE
 * team_id IS NOT NULL` or `UNIQUE (session_id, user_id) WHERE user_id IS NOT NULL` — so the
 * matching `targetWhere` predicate must be passed along with the target columns, otherwise
 * Postgres cannot pick the index and the statement fails with "no unique or exclusion
 * constraint matching the ON CONFLICT specification".
 */
export async function upsertSessionCauseStatsRow(
  db: DrizzleDb,
  sessionRowId: number,
  scope: CauseStatsScope,
  threshold: number,
  totals: TurnCauseTotals,
): Promise<void> {
  const isTeamScope = scope.teamId !== undefined;

  await db
    .insert(sessionCauseStats)
    .values({
      sessionId: sessionRowId,
      teamId: scope.teamId ?? null,
      userId: scope.userId ?? null,
      threshold,
      compactionTokens: totals.compactionTokens,
      fileRereadTokens: totals.fileRereadTokens,
      unattributedTokens: totals.unattributedTokens,
      compactionTurns: totals.compactionTurns,
      fileRereadTurns: totals.fileRereadTurns,
      unattributedTurns: totals.unattributedTurns,
    })
    .onConflictDoUpdate({
      target: isTeamScope
        ? [sessionCauseStats.sessionId, sessionCauseStats.teamId]
        : [sessionCauseStats.sessionId, sessionCauseStats.userId],
      targetWhere: isTeamScope
        ? sql`${sessionCauseStats.teamId} IS NOT NULL`
        : sql`${sessionCauseStats.userId} IS NOT NULL`,
      set: {
        threshold,
        compactionTokens: totals.compactionTokens,
        fileRereadTokens: totals.fileRereadTokens,
        unattributedTokens: totals.unattributedTokens,
        compactionTurns: totals.compactionTurns,
        fileRereadTurns: totals.fileRereadTurns,
        unattributedTurns: totals.unattributedTurns,
      },
    });
}
