import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { isRawLocalPath, toLocalRepoIdentity } from './local-repo-identity';
import { normalizeRepoUrl } from './repo-url-normalizer';

type RepoRow = Record<string, unknown> & {
  id: number;
  userId: number;
  repoUrl: string;
};

interface BackfillCounts {
  urlsNormalised: number;
  duplicatesDeleted: number;
  linksRePointed: number;
}

/** Anything that can run a raw SQL statement — the pool-backed db or a transaction. */
type SqlExecutor = Pick<DrizzleDb, 'execute'>;

/** A repository that used to store the normalised form of a raw local path. */
interface FormerLocalRepo {
  id: number;
  userId: number;
  repoUrl: string;
  identity: string;
}

@Injectable()
export class RepoBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RepoBackfillService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.migrateLocalRepoIdentities();
    await this.backfillRepoUrls();
    await this.backfillTeamRepoUrls();
  }

  /**
   * Moves every merge-able `log_repositories` link of `nonSurvivorId` onto `survivorId`, drops
   * the links the survivor already covers, then deletes the non-survivor row (its child rows
   * cascade). Returns the number of links re-pointed.
   */
  private async mergeRepoInto(
    survivorId: number,
    nonSurvivorId: number,
    executor: SqlExecutor = this.db,
  ): Promise<number> {
    // Delete log_repositories links that would conflict with survivor
    const conflictResult = await executor.execute<{
      logId: number;
      [key: string]: unknown;
    }>(
      sql`DELETE FROM log_repositories lr
          WHERE lr.repo_id = ${nonSurvivorId}
          AND EXISTS (
            SELECT 1 FROM log_repositories lr2
            WHERE lr2.log_id = lr.log_id AND lr2.repo_id = ${survivorId}
          )
          RETURNING lr.log_id AS "logId"`,
    );
    for (const deleted of conflictResult.rows) {
      this.logger.log(
        `repo #${nonSurvivorId} log_repositories link to log #${deleted.logId} dropped (already covered by survivor #${survivorId})`,
      );
    }

    // Re-point remaining log_repositories links to survivor
    const rePointResult = await executor.execute<{
      logId: number;
      [key: string]: unknown;
    }>(
      sql`UPDATE log_repositories
          SET repo_id = ${survivorId}
          WHERE repo_id = ${nonSurvivorId}
          RETURNING log_id AS "logId"`,
    );
    for (const rePointed of rePointResult.rows) {
      this.logger.log(
        `repo #${nonSurvivorId} log_repositories link #${rePointed.logId} re-pointed to survivor #${survivorId}`,
      );
    }

    // Delete the non-survivor repository row
    await executor.execute(
      sql`DELETE FROM repositories WHERE id = ${nonSurvivorId}`,
    );
    this.logger.log(
      `repo #${nonSurvivorId} deleted (duplicate of survivor #${survivorId})`,
    );

    return rePointResult.rows.length;
  }

  /**
   * Rewrites repositories created from a raw local path (a project without a git remote) to the
   * `<owner email>/<path>` identity that ingest now stores (`local-repo-identity.ts`).
   *
   * A repository is "former-local" when one of its linked artisyn logs reports a raw local path
   * (`git.repo`, or `cwd` when `git` is null) whose `normalizeRepoUrl` form equals the stored
   * `repo_url`. Rows are grouped by `(userId, identity)` together with any identity row that
   * already exists; the lowest id survives and gets the identity URL, the rest are merged into it.
   * Matching `team_repositories` rows in the owner's teams are rewritten too.
   *
   * Idempotent: identity rows are excluded from detection, so a second run finds nothing.
   */
  async migrateLocalRepoIdentities(): Promise<void> {
    // Distinct raw repo values per repository, only for repos not already holding an identity.
    // Every artisyn log linked to a repo carries the raw value that produced its URL, so only
    // the oldest and newest linked log per repo are scanned — scanning every log body on each
    // start took seconds on the dev DB, this takes tens of milliseconds.
    const rawResult = await this.db.execute<{
      repoId: number;
      userId: number;
      repoUrl: string;
      email: string;
      raw: string;
      [key: string]: unknown;
    }>(
      sql`WITH bounds AS (
            SELECT lr.repo_id, MIN(lr.log_id) AS min_id, MAX(lr.log_id) AS max_id
            FROM log_repositories lr
            JOIN logs la ON la.id = lr.log_id AND la.log_type = 'artisyn'
            GROUP BY lr.repo_id
          ),
          sample AS (
            SELECT repo_id, min_id AS log_id FROM bounds
            UNION
            SELECT repo_id, max_id AS log_id FROM bounds
          )
          SELECT DISTINCT r.id AS "repoId", r.user_id AS "userId", r.repo_url AS "repoUrl",
                 u.email AS "email", src.raw AS "raw"
          FROM repositories r
          JOIN users u ON u.id = r.user_id
          JOIN sample s ON s.repo_id = r.id
          JOIN logs l ON l.id = s.log_id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(l.body) = 'array' THEN l.body ELSE '[]'::jsonb END
          ) AS evt
          CROSS JOIN LATERAL (
            SELECT CASE
              WHEN jsonb_typeof(evt->'git') = 'object'
                AND jsonb_typeof(evt->'git'->'repo') = 'string'
                THEN evt->'git'->>'repo'
              WHEN jsonb_typeof(evt->'git') = 'null'
                AND jsonb_typeof(evt->'cwd') = 'string'
                THEN evt->>'cwd'
            END AS raw
          ) AS src
          WHERE r.repo_url !~ '^[^[:space:]/:@]+@[^[:space:]/:]+/'
            AND src.raw IS NOT NULL
          ORDER BY r.id ASC, src.raw ASC`,
    );

    const formerLocal = new Map<number, FormerLocalRepo>();
    for (const row of rawResult.rows) {
      if (!isRawLocalPath(row.raw)) continue;
      if (normalizeRepoUrl(row.raw) !== row.repoUrl) continue;
      const identity = toLocalRepoIdentity(row.email, row.raw);
      const existing = formerLocal.get(row.repoId);
      if (existing) {
        if (existing.identity !== identity) {
          this.logger.warn(
            `repo #${row.repoId} has several local paths ("${existing.identity}" kept, "${identity}" ignored)`,
          );
        }
        continue;
      }
      formerLocal.set(row.repoId, {
        id: row.repoId,
        userId: row.userId,
        repoUrl: row.repoUrl,
        identity,
      });
    }

    if (formerLocal.size === 0) {
      this.logger.log('Local repo identity migration: nothing to do');
      return;
    }

    // Group by (userId, identity).
    const groups = new Map<string, FormerLocalRepo[]>();
    for (const repo of formerLocal.values()) {
      const key = `${repo.userId}:${repo.identity}`;
      const group = groups.get(key);
      if (group) group.push(repo);
      else groups.set(key, [repo]);
    }

    let reposRewritten = 0;
    let reposMerged = 0;
    let teamRowsRewritten = 0;

    for (const group of groups.values()) {
      const { userId, identity } = group[0];

      await this.db.transaction(async (tx) => {
        // Include an identity row that ingest may already have created for this user.
        const identityRows = await tx.execute<{ id: number }>(
          sql`SELECT id FROM repositories
              WHERE user_id = ${userId} AND repo_url = ${identity}`,
        );
        const memberIds = [
          ...group.map((r) => r.id),
          ...identityRows.rows.map((r) => r.id),
        ].sort((a, b) => a - b);
        const survivorId = memberIds[0];

        for (const nonSurvivorId of memberIds.slice(1)) {
          await this.mergeRepoInto(survivorId, nonSurvivorId, tx);
          reposMerged++;
        }

        const survivorOld = group.find((r) => r.id === survivorId);
        if (survivorOld) {
          await tx.execute(
            sql`UPDATE repositories SET repo_url = ${identity} WHERE id = ${survivorId}`,
          );
          this.logger.log(
            `repo #${survivorId} local identity: "${survivorOld.repoUrl}" → "${identity}"`,
          );
          reposRewritten++;
        }

        // Rewrite team_repositories in the owner's teams from each old URL to the identity,
        // skipping rows whose team already lists the identity.
        const oldUrls = [...new Set(group.map((r) => r.repoUrl))];
        for (const oldUrl of oldUrls) {
          const updated = await tx.execute<{
            id: number;
            teamId: number;
            [key: string]: unknown;
          }>(
            sql`UPDATE team_repositories tr
                SET repo_url = ${identity}
                WHERE tr.repo_url = ${oldUrl}
                  AND tr.team_id IN (
                    SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${userId}
                    UNION
                    SELECT t.id FROM teams t WHERE t.owner_id = ${userId}
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM team_repositories t2
                    WHERE t2.team_id = tr.team_id AND t2.repo_url = ${identity}
                  )
                RETURNING tr.id AS "id", tr.team_id AS "teamId"`,
          );
          for (const row of updated.rows) {
            this.logger.log(
              `team_repositories #${row.id} (team #${row.teamId}) local identity: "${oldUrl}" → "${identity}"`,
            );
            teamRowsRewritten++;
          }
        }
      });
    }

    this.logger.log(
      `Local repo identity migration done — ${reposRewritten} repo(s) rewritten, ${reposMerged} merged, ${teamRowsRewritten} team repo row(s) rewritten`,
    );
  }

  async backfillRepoUrls(): Promise<void> {
    // Step 1: Fetch all repository rows
    const result = await this.db.execute<RepoRow>(
      sql`SELECT id, user_id AS "userId", repo_url AS "repoUrl" FROM repositories ORDER BY id ASC`,
    );
    const rows = result.rows;
    const totalCount = rows.length;

    this.logger.log(
      `Repo URL backfill started — ${totalCount} rows to inspect`,
    );

    if (totalCount === 0) {
      this.logger.log(
        'Repo URL backfill: all 0 rows already canonical, nothing to do',
      );
      return;
    }

    // Step 2: Build in-memory map: "userId:canonicalUrl" → Array<{id, repoUrl}>
    // sorted by id ascending (already sorted due to ORDER BY id ASC above)
    const groups = new Map<string, RepoRow[]>();
    for (const row of rows) {
      const canonical = normalizeRepoUrl(row.repoUrl);
      const key = `${row.userId}:${canonical}`;
      const group = groups.get(key);
      if (group) {
        group.push(row);
      } else {
        groups.set(key, [row]);
      }
    }

    const counts: BackfillCounts = {
      urlsNormalised: 0,
      duplicatesDeleted: 0,
      linksRePointed: 0,
    };

    // Step 3: For each group with duplicates, merge non-survivors into survivor
    for (const groupRows of groups.values()) {
      if (groupRows.length <= 1) continue;

      const survivor = groupRows[0];
      for (const nonSurvivor of groupRows.slice(1)) {
        counts.linksRePointed += await this.mergeRepoInto(
          survivor.id,
          nonSurvivor.id,
        );
        counts.duplicatesDeleted++;
      }
    }

    // Step 4: Update URLs that differ from canonical (survivors and ungrouped rows)
    for (const [key, groupRows] of groups) {
      const survivor = groupRows[0]; // after dedup, only survivors remain
      const canonicalUrl = key.slice(key.indexOf(':') + 1);

      if (survivor.repoUrl !== canonicalUrl) {
        await this.db.execute(
          sql`UPDATE repositories SET repo_url = ${canonicalUrl} WHERE id = ${survivor.id}`,
        );
        this.logger.log(
          `repo #${survivor.id} url normalised: "${survivor.repoUrl}" → "${canonicalUrl}"`,
        );
        counts.urlsNormalised++;
      }
    }

    // Step 5: Log summary
    if (
      counts.urlsNormalised === 0 &&
      counts.duplicatesDeleted === 0 &&
      counts.linksRePointed === 0
    ) {
      this.logger.log(
        `Repo URL backfill: all ${totalCount} rows already canonical, nothing to do`,
      );
    } else {
      this.logger.log(
        `Repo URL backfill done — ${counts.urlsNormalised} url(s) normalised, ${counts.duplicatesDeleted} duplicate(s) deleted, ${counts.linksRePointed} link(s) re-pointed`,
      );
    }
  }

  async backfillTeamRepoUrls(): Promise<void> {
    const result = await this.db.execute<{ id: number; repoUrl: string }>(
      sql`SELECT id, repo_url AS "repoUrl" FROM team_repositories ORDER BY id ASC`,
    );
    const rows = result.rows;

    let normalised = 0;
    for (const row of rows) {
      const canonical = normalizeRepoUrl(row.repoUrl);
      if (row.repoUrl !== canonical) {
        // Update in place; on conflict (canonical already exists for same team) delete this duplicate
        const updated = await this.db.execute<{ id: number }>(
          sql`UPDATE team_repositories SET repo_url = ${canonical}
              WHERE id = ${row.id}
              AND NOT EXISTS (
                SELECT 1 FROM team_repositories t2
                WHERE t2.team_id = (SELECT team_id FROM team_repositories WHERE id = ${row.id})
                  AND t2.repo_url = ${canonical}
                  AND t2.id <> ${row.id}
              )
              RETURNING id`,
        );
        if (updated.rows.length === 0) {
          // Duplicate after normalisation — delete this row
          await this.db.execute(
            sql`DELETE FROM team_repositories WHERE id = ${row.id}`,
          );
          this.logger.log(
            `team_repositories #${row.id} deleted (duplicate after normalise: "${row.repoUrl}" → "${canonical}")`,
          );
        } else {
          this.logger.log(
            `team_repositories #${row.id} url normalised: "${row.repoUrl}" → "${canonical}"`,
          );
        }
        normalised++;
      }
    }

    if (normalised === 0) {
      this.logger.log(
        `Team repo URL backfill: all ${rows.length} rows already canonical, nothing to do`,
      );
    } else {
      this.logger.log(
        `Team repo URL backfill done — ${normalised} url(s) normalised/deduped`,
      );
    }
  }
}
