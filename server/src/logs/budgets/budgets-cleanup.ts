/**
 * Budget scope cleanup (2026-11-05 budgets-threshold-alerts, DD-13 / FR-14). Plain functions —
 * no Nest provider, no DI — so every repository / team-repository delete and URL-rewrite path
 * can call them inside its own transaction (or raw-SQL executor).
 *
 * Budgets carry no FK to `repositories` / `team_repositories` (they are stored by URL), so
 * removing a repository or rewriting its URL has to touch `budgets`, `budget_notices` and
 * `budget_events` here. Team and user deletion are handled by the FK cascades instead.
 *
 * Merge-conflict rule of a rewrite: when the target URL already has a budget of the same
 * period, the source budget is deleted and the target wins. The source's notices and events
 * get the new `repo_url` and keep `budget_id` NULL (the FK is ON DELETE SET NULL).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';

/** Anything that can run a raw SQL statement — the pool-backed db or a transaction. */
export type BudgetsCleanupExecutor = Pick<DrizzleDb, 'execute'>;

const SCOPE_TABLES = ['budget_notices', 'budget_events', 'budgets'] as const;

/**
 * Removes the personal (`repo` scope) budgets, notices and events of `repoUrl` — of one owner
 * when `userId` is given, otherwise of every user (a repository removed by URL).
 */
export async function deletePersonalRepo(
  tx: BudgetsCleanupExecutor,
  repoUrl: string,
  userId?: number,
): Promise<void> {
  const userFilter =
    userId === undefined ? sql`` : sql` AND user_id = ${userId}`;
  for (const table of SCOPE_TABLES) {
    await tx.execute(sql`
      DELETE FROM ${sql.identifier(table)}
      WHERE scope_kind = 'repo' AND repo_url = ${repoUrl}${userFilter}
    `);
  }
}

/** Removes the `team-repo` budgets, notices and events of one team's repository link. */
export async function deleteTeamRepo(
  tx: BudgetsCleanupExecutor,
  teamId: number,
  repoUrl: string,
): Promise<void> {
  for (const table of SCOPE_TABLES) {
    await tx.execute(sql`
      DELETE FROM ${sql.identifier(table)}
      WHERE scope_kind = 'team-repo' AND team_id = ${teamId} AND repo_url = ${repoUrl}
    `);
  }
}

/** Moves one owner's personal budgets (and their notices / events) from `oldUrl` to `newUrl`. */
export async function rewritePersonalRepoUrl(
  tx: BudgetsCleanupExecutor,
  userId: number,
  oldUrl: string,
  newUrl: string,
): Promise<void> {
  if (oldUrl === newUrl) return;
  await rewriteScopeUrl(
    tx,
    sql`scope_kind = 'repo' AND user_id = ${userId}`,
    oldUrl,
    newUrl,
  );
}

/** Moves one team's `team-repo` budgets (and their notices / events) from `oldUrl` to `newUrl`. */
export async function rewriteTeamRepoUrl(
  tx: BudgetsCleanupExecutor,
  teamId: number,
  oldUrl: string,
  newUrl: string,
): Promise<void> {
  if (oldUrl === newUrl) return;
  await rewriteScopeUrl(
    tx,
    sql`scope_kind = 'team-repo' AND team_id = ${teamId}`,
    oldUrl,
    newUrl,
  );
}

async function rewriteScopeUrl(
  tx: BudgetsCleanupExecutor,
  owner: SQL,
  oldUrl: string,
  newUrl: string,
): Promise<void> {
  // 1. Merge conflict: the target already has a budget of this period → the source goes.
  await tx.execute(sql`
    DELETE FROM budgets src
    WHERE ${owner} AND src.repo_url = ${oldUrl}
      AND EXISTS (
        SELECT 1 FROM budgets dst
        WHERE dst.scope_kind = src.scope_kind
          AND dst.user_id IS NOT DISTINCT FROM src.user_id
          AND dst.team_id IS NOT DISTINCT FROM src.team_id
          AND dst.repo_url = ${newUrl}
          AND dst.period = src.period
      )
  `);
  // 2. The remaining source budgets, then the notices and events, follow the new URL.
  for (const table of SCOPE_TABLES) {
    await tx.execute(sql`
      UPDATE ${sql.identifier(table)} SET repo_url = ${newUrl}
      WHERE ${owner} AND repo_url = ${oldUrl}
    `);
  }
}
