/**
 * The team repo config store — the single read/write point for `team_repo_config`.
 *
 * A team config belongs to one `team_repositories` link, i.e. one (team, repoUrl) pair, and is
 * removed with it by the FK cascade. Personal configs stay in `repo_config` (one row per
 * repository row and user). Helpers here take the db handle explicitly so services and plain
 * writer modules can share them.
 */
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import {
  repoConfig,
  repositories,
  teamMembers,
  teamRepoConfig,
  teamRepositories,
  teams,
  type RepoConfigJson,
} from '../database/schema/index';
import { DEFAULT_FILE_CATEGORIES } from './claude-extractor';

/**
 * The one default config: what a team view shows when its team has no config, and what a
 * personal view falls back to when neither a personal nor a team config exists.
 */
export const DEFAULT_TEAM_VIEW_CONFIG: RepoConfigJson = {
  fileCategories: DEFAULT_FILE_CATEGORIES,
};

/**
 * Reads `highCacheCreationThreshold` out of a stored config blob, tolerating garbage.
 *
 * The config is jsonb with no DB-level shape check, so a row written before this field
 * existed — or by a client that sent nonsense — must not break a read path. Anything that is
 * not a finite integer is treated as absent, i.e. "fall back to the next scope".
 * `validateConfig` is what stops bad values from getting written in the first place.
 */
export function readConfigThreshold(
  config: RepoConfigJson | null | undefined,
): number | null {
  const raw = config?.highCacheCreationThreshold;
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

/**
 * The team a request without `teamId` resolves to: the lowest id among teams that link
 * `repoUrl` and that `userId` belongs to (member or owner). With `ownerOnly`, only teams the
 * user owns count. `null` when there is no such team.
 */
export async function resolveUserTeamForUrl(
  db: DrizzleDb,
  userId: number,
  repoUrl: string,
  options: { ownerOnly?: boolean } = {},
): Promise<number | null> {
  const [row] = await db
    .select({ teamId: teams.id })
    .from(teams)
    .innerJoin(teamRepositories, eq(teamRepositories.teamId, teams.id))
    .leftJoin(
      teamMembers,
      and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)),
    )
    .where(
      and(
        eq(teamRepositories.repoUrl, repoUrl),
        options.ownerOnly
          ? eq(teams.ownerId, userId)
          : or(eq(teams.ownerId, userId), isNotNull(teamMembers.userId)),
      ),
    )
    .orderBy(asc(teams.id))
    .limit(1);
  return row?.teamId ?? null;
}

/** The config of team `teamId` for `repoUrl`, or `null` when the link has none (or no link). */
export async function findTeamRepoConfig(
  db: DrizzleDb,
  teamId: number,
  repoUrl: string,
): Promise<{
  teamRepositoryId: number;
  config: RepoConfigJson;
  updatedAt: Date;
} | null> {
  const [row] = await db
    .select({
      teamRepositoryId: teamRepoConfig.teamRepositoryId,
      config: teamRepoConfig.config,
      updatedAt: teamRepoConfig.updatedAt,
    })
    .from(teamRepoConfig)
    .innerJoin(
      teamRepositories,
      eq(teamRepositories.id, teamRepoConfig.teamRepositoryId),
    )
    .where(
      and(
        eq(teamRepositories.teamId, teamId),
        eq(teamRepositories.repoUrl, repoUrl),
      ),
    );
  return row ?? null;
}

/**
 * Writes the config of team `teamId` for `repoUrl`. Returns `false` (and writes nothing)
 * when the team does not link `repoUrl`.
 */
export async function upsertTeamRepoConfig(
  db: DrizzleDb,
  teamId: number,
  repoUrl: string,
  config: RepoConfigJson,
): Promise<boolean> {
  const result = await db.execute(
    sql`INSERT INTO team_repo_config (team_repository_id, config, updated_at)
        SELECT tr.id, ${JSON.stringify(config)}::jsonb, now()
        FROM team_repositories tr
        WHERE tr.team_id = ${teamId} AND tr.repo_url = ${repoUrl}
        ON CONFLICT (team_repository_id)
        DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at`,
  );
  return (result.rowCount ?? 0) > 0;
}

/** Deletes the config of team `teamId` for `repoUrl`, if any. */
export async function deleteTeamRepoConfig(
  db: DrizzleDb,
  teamId: number,
  repoUrl: string,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM team_repo_config
        WHERE team_repository_id IN (
          SELECT id FROM team_repositories
          WHERE team_id = ${teamId} AND repo_url = ${repoUrl}
        )`,
  );
}

/** Seeds a link's config; an existing config is never overwritten. */
export async function seedTeamRepoConfig(
  db: DrizzleDb,
  teamRepositoryId: number,
  config: RepoConfigJson,
): Promise<void> {
  await db
    .insert(teamRepoConfig)
    .values({ teamRepositoryId, config })
    .onConflictDoNothing({ target: teamRepoConfig.teamRepositoryId });
}

/**
 * The personal config of `userId` for `repoUrl`, looked up by URL rather than by one
 * repository row; the lowest `repo_id` wins so the result is deterministic.
 */
export async function findPersonalRepoConfig(
  db: DrizzleDb,
  userId: number,
  repoUrl: string,
): Promise<RepoConfigJson | null> {
  const [row] = await db
    .select({ config: repoConfig.config })
    .from(repoConfig)
    .innerJoin(repositories, eq(repositories.id, repoConfig.repoId))
    .where(
      and(eq(repositories.repoUrl, repoUrl), eq(repoConfig.userId, userId)),
    )
    .orderBy(asc(repoConfig.repoId))
    .limit(1);
  return row?.config ?? null;
}

/**
 * Every team that links any of `repoUrls`, with its config (`null` = no config, the caller
 * applies the defaults). One entry per team: the lowest link id wins.
 */
export async function listTeamScopesForUrls(
  db: DrizzleDb,
  repoUrls: readonly string[],
): Promise<{ teamId: number; config: RepoConfigJson | null }[]> {
  if (repoUrls.length === 0) return [];
  const rows = await db
    .select({
      teamId: teamRepositories.teamId,
      config: teamRepoConfig.config,
    })
    .from(teamRepositories)
    .leftJoin(
      teamRepoConfig,
      eq(teamRepoConfig.teamRepositoryId, teamRepositories.id),
    )
    .where(inArray(teamRepositories.repoUrl, [...repoUrls]))
    .orderBy(asc(teamRepositories.id));

  const byTeam = new Map<number, RepoConfigJson | null>();
  for (const row of rows) {
    if (!byTeam.has(row.teamId)) byTeam.set(row.teamId, row.config);
  }
  return [...byTeam].map(([teamId, config]) => ({ teamId, config }));
}
