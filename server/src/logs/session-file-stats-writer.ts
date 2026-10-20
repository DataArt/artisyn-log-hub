/**
 * The `session_file_stats` writer — the ONLY code that writes that table. Ingest
 * (`LogsService.upsert()` Step 3b), import (`LogsService.importSession()`), the
 * claude-before-artisyn heal ({@link rewriteSessionTreeFileStats}) and the settings-save
 * recompute (`RepositoriesService.recomputeForRepo()`) all go through
 * {@link writeSessionFileStats}, so the four paths cannot drift apart.
 *
 * Rules shared by every caller:
 *
 * - **One root rule.** A node's repo roots are those of its own
 *   `artisyn` log, otherwise its nearest ancestor's — exactly what
 *   `resolveSessionRepoRoots()` returns. Only a tree's root session ever carries an `artisyn`
 *   log, so resolving once on the tree root is equivalent for every node of the tree. Read
 *   paths are made repo-relative with `normaliseReadPath()` (inside `extractFileStatsByCategory`);
 *   no known root falls back to the `KNOWN_TOP_LEVEL_DIRS` heuristic.
 * - **Scope resolution.** {@link resolveFileStatsScopes} returns one row
 *   set per team linking the session tree's repo URLs (`team_repositories`) — each by its
 *   own `team_repo_config`, else `DEFAULT_FILE_CATEGORIES` — plus one per user with a
 *   personal `repo_config` row on those URLs (first by `repo_config.repo_id` wins per user),
 *   not just the uploader's. The uploader always gets a personal scope: their own config if
 *   they have one, else `DEFAULT_FILE_CATEGORIES`.
 * - **Writer contract.** Per scope: `DELETE` that scope's rows for the
 *   node, then a multi-row `INSERT` of the non-empty categories. The insert keeps
 *   `ON CONFLICT … DO UPDATE` on the partial unique indexes, because the heal touches
 *   descendant nodes it never locks and recompute runs outside a transaction — a concurrent
 *   writer for the same node must not hit a unique violation. Scopes that are not passed are
 *   never touched, so another user's default rows survive a re-ingest.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import {
  type FileCategory,
  logs,
  repoConfig,
  repositories,
} from '../database/schema/index';
import { resolveSessionRepoRoots } from './change-surface/changed-paths.sql';
import {
  DEFAULT_FILE_CATEGORIES,
  extractFileStatsByCategory,
} from './claude-extractor';
import type { CauseStatsScope } from './session-cause-stats-writer';
import { getDescendantSessionIds } from './session-tree.sql';
import { listTeamScopesForUrls } from './team-repo-config';

/** One config scope to write, with the categories that scope classifies by. */
export interface FileStatsScopeEntry {
  scope: CauseStatsScope;
  categories: FileCategory[];
}

/**
 * Rewrites the `session_file_stats` rows of one node for each given scope: delete the
 * scope's rows, then insert the categories that matched at least one read.
 */
export async function writeSessionFileStats(
  db: DrizzleDb,
  sessionRowId: number,
  lines: object[],
  repoRoots: readonly string[],
  scopes: readonly FileStatsScopeEntry[],
): Promise<void> {
  for (const { scope, categories } of scopes) {
    const isTeamScope = scope.teamId !== undefined;
    const scopeId = isTeamScope ? scope.teamId : scope.userId;

    await db.execute(
      isTeamScope
        ? sql`DELETE FROM session_file_stats WHERE session_id = ${sessionRowId} AND team_id = ${scopeId}`
        : sql`DELETE FROM session_file_stats WHERE session_id = ${sessionRowId} AND user_id = ${scopeId}`,
    );

    const statsByCategory = extractFileStatsByCategory(
      lines,
      repoRoots,
      categories,
    );
    const rows = Object.entries(statsByCategory).filter(
      ([, v]) => v.fileCount > 0 || v.byteCount > 0,
    );
    if (rows.length === 0) continue;

    const values = sql.join(
      rows.map(
        ([cat, v]) =>
          sql`(${sessionRowId}, ${cat}, ${v.fileCount}, ${v.byteCount}, ${scopeId})`,
      ),
      sql`, `,
    );

    await db.execute(
      isTeamScope
        ? sql`INSERT INTO session_file_stats (session_id, category_name, file_count, byte_count, team_id)
              VALUES ${values}
              ON CONFLICT (session_id, category_name, team_id) WHERE team_id IS NOT NULL
              DO UPDATE SET file_count = excluded.file_count, byte_count = excluded.byte_count`
        : sql`INSERT INTO session_file_stats (session_id, category_name, file_count, byte_count, user_id)
              VALUES ${values}
              ON CONFLICT (session_id, category_name, user_id) WHERE user_id IS NOT NULL
              DO UPDATE SET file_count = excluded.file_count, byte_count = excluded.byte_count`,
    );
  }
}

/**
 * The repo URLs of a session's tree: walks up
 * `sessions.parent_session_id` (same `depth < 50` guard as `resolveSessionRepoRoots()`) and
 * returns the distinct `repositories.repo_url` linked through `log_repositories` to the
 * **nearest** ancestor (the node itself included) that has any link. A sub-agent has no
 * linked logs of its own, so `getSessionRepoUrls()` would always give it `[]`.
 */
export async function resolveSessionTreeRepoUrls(
  db: DrizzleDb,
  sessionRowId: number,
): Promise<string[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, session_id, parent_session_id, 0 AS depth
      FROM sessions
      WHERE id = ${sessionRowId}
      UNION ALL
      SELECT p.id, p.session_id, p.parent_session_id, a.depth + 1
      FROM sessions p
      JOIN ancestors a ON a.parent_session_id = p.session_id
      WHERE a.depth < 50
    ),
    linked AS (
      SELECT a.depth, r.repo_url
      FROM ancestors a
      JOIN logs l ON l.session_id = a.id
      JOIN log_repositories lr ON lr.log_id = l.id
      JOIN repositories r ON r.id = lr.repo_id
    )
    SELECT DISTINCT repo_url
    FROM linked
    WHERE depth = (SELECT MIN(depth) FROM linked)
    ORDER BY repo_url
  `);

  return (result.rows as unknown as { repo_url: string }[]).map(
    (row) => row.repo_url,
  );
}

/**
 * Every config scope that gets a `session_file_stats` row set for a session whose tree is
 * linked to `repoUrls`: every team linking a URL (its team config, else
 * `DEFAULT_FILE_CATEGORIES`), and every user with a personal config (first
 * `repo_config.repo_id` wins per user); the uploader always ends up with a personal scope,
 * falling back to `DEFAULT_FILE_CATEGORIES` when they have no personal config.
 */
export async function resolveFileStatsScopes(
  db: DrizzleDb,
  repoUrls: readonly string[],
  uploaderUserId: number,
): Promise<FileStatsScopeEntry[]> {
  if (repoUrls.length === 0) {
    return [
      {
        scope: { userId: uploaderUserId },
        categories: DEFAULT_FILE_CATEGORIES,
      },
    ];
  }

  const teamScopes: FileStatsScopeEntry[] = (
    await listTeamScopesForUrls(db, repoUrls)
  ).map(({ teamId, config }) => ({
    scope: { teamId },
    categories: config?.fileCategories ?? DEFAULT_FILE_CATEGORIES,
  }));

  const configRows = await db
    .select({
      userId: repoConfig.userId,
      config: repoConfig.config,
    })
    .from(repoConfig)
    .innerJoin(repositories, eq(repoConfig.repoId, repositories.id))
    .where(inArray(repositories.repoUrl, [...repoUrls]))
    // `repo_config` has no surrogate id; `(repo_id, user_id)` is unique, so ordering by
    // `repo_id` makes "first wins" deterministic per user.
    .orderBy(asc(repoConfig.repoId));

  const userScopes = new Map<number, FileStatsScopeEntry>();
  for (const row of configRows) {
    if (!userScopes.has(row.userId)) {
      userScopes.set(row.userId, {
        scope: { userId: row.userId },
        categories: row.config.fileCategories,
      });
    }
  }

  if (!userScopes.has(uploaderUserId)) {
    userScopes.set(uploaderUserId, {
      scope: { userId: uploaderUserId },
      categories: DEFAULT_FILE_CATEGORIES,
    });
  }

  return [...teamScopes, ...userScopes.values()];
}

/**
 * The claude-before-artisyn heal: once the tree root's `artisyn` log
 * lands (or links a repo, or learns a root), rebuild the file stats of every node of the
 * tree from its stored `claude` / `claude-subagent` body. Roots and scopes are resolved once
 * on the tree root — equivalent for every node.
 */
export async function rewriteSessionTreeFileStats(
  db: DrizzleDb,
  rootSessionRowId: number,
  uploaderUserId: number,
): Promise<void> {
  const descendantsByRoot = await getDescendantSessionIds(db, [
    rootSessionRowId,
  ]);
  const treeIds = [
    ...new Set([
      rootSessionRowId,
      ...(descendantsByRoot.get(rootSessionRowId) ?? []),
    ]),
  ];

  const bodyRows = await db
    .select({ sessionId: logs.sessionId, body: logs.body })
    .from(logs)
    .where(
      and(
        inArray(logs.sessionId, treeIds),
        inArray(logs.logType, ['claude', 'claude-subagent']),
      ),
    )
    .orderBy(asc(logs.id));
  if (bodyRows.length === 0) return;

  // A node normally has exactly one claude/claude-subagent log; group defensively so a node
  // is written once from all of its lines rather than once per log (the last write winning).
  const linesBySession = new Map<number, object[]>();
  for (const row of bodyRows) {
    const body: unknown = row.body;
    if (!Array.isArray(body)) continue;
    const lines = linesBySession.get(row.sessionId) ?? [];
    for (const line of body as unknown[]) {
      if (typeof line === 'object' && line !== null) lines.push(line);
    }
    linesBySession.set(row.sessionId, lines);
  }
  if (linesBySession.size === 0) return;

  const repoRoots = await resolveSessionRepoRoots(db, rootSessionRowId);
  const scopes = await resolveFileStatsScopes(
    db,
    await resolveSessionTreeRepoUrls(db, rootSessionRowId),
    uploaderUserId,
  );

  for (const [sessionRowId, lines] of linesBySession) {
    await writeSessionFileStats(db, sessionRowId, lines, repoRoots, scopes);
  }
}
