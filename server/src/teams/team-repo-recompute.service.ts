import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { RepositoriesService } from '../logs/repositories.service';

/** Sweep period when `TEAM_REPO_RECOMPUTE_INTERVAL_MS` is unset or invalid. */
export const DEFAULT_TEAM_REPO_RECOMPUTE_INTERVAL_MS = 5_000;

/** Attempts before a row is left as `failed`. */
const MAX_ATTEMPTS = 3;

/** A `processing` row untouched for this long is reclaimed (its worker died or restarted). */
const STALE_PROCESSING_MINUTES = 10;

const TICK_INTERVAL_NAME = 'team-repo-recompute-tick';

function resolveIntervalMs(): number {
  const raw = Number(process.env.TEAM_REPO_RECOMPUTE_INTERVAL_MS);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : DEFAULT_TEAM_REPO_RECOMPUTE_INTERVAL_MS;
}

type ClaimedRow = {
  team_repository_id: number;
  team_id: number;
  repo_url: string;
  attempts: number;
};

/**
 * Background drain of `team_repo_recompute_queue` (migration 0082): the team-scope recompute
 * (`RepositoriesService.recomputeTeamScope`) that adding a repository to a team needs, run
 * outside the request because it reads every transcript of the URL.
 *
 * - `enqueue()` (from `TeamsService.addTeamRepository`) upserts the link's row as `pending`
 *   and kicks a drain without awaiting it — or awaits it when
 *   `TEAM_REPO_RECOMPUTE_INLINE=true` (contract stand), so the request returns with the
 *   recompute done.
 * - An interval every `TEAM_REPO_RECOMPUTE_INTERVAL_MS` drains whatever is left (rows from a
 *   restart, a kick that lost a race, a retry). A tick that fires while a drain runs is skipped.
 * - Each row is claimed with `FOR UPDATE SKIP LOCKED` (safe across a cluster) and marked
 *   `processing`; on success it is deleted unless it was re-enqueued meanwhile (back to
 *   `pending`), on failure it returns to `pending` until `MAX_ATTEMPTS`, then stays `failed`.
 */
@Injectable()
export class TeamRepoRecomputeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TeamRepoRecomputeService.name);
  private inFlight: Promise<void> | null = null;
  private rerun = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const interval = setInterval(() => {
      if (this.inFlight !== null) return;
      void this.kick();
    }, resolveIntervalMs());
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /** Queues the team-scope recompute of one team link and starts a drain. */
  async enqueue(teamRepositoryId: number): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO team_repo_recompute_queue (team_repository_id)
      VALUES (${teamRepositoryId})
      ON CONFLICT (team_repository_id) DO UPDATE
        SET status = 'pending', attempts = 0, last_error = NULL,
            enqueued_at = now(), updated_at = now()
    `);
    if (process.env.TEAM_REPO_RECOMPUTE_INLINE === 'true') {
      while (this.inFlight !== null) {
        await this.inFlight.catch(() => undefined);
      }
      await this.kick();
      return;
    }
    void this.kick();
  }

  /** Starts a drain, or asks the running one to go round once more. Never throws. */
  private kick(): Promise<void> {
    if (this.inFlight !== null) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = this.drain()
      .catch((err: unknown) => {
        this.logger.error(
          `Team repo recompute sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private async drain(): Promise<void> {
    do {
      this.rerun = false;
      for (;;) {
        const row = await this.claim();
        if (!row) break;
        await this.process(row);
      }
    } while (this.rerun);
  }

  private async claim(): Promise<ClaimedRow | null> {
    const res = await this.db.execute<ClaimedRow>(sql`
      UPDATE team_repo_recompute_queue q
         SET status = 'processing', attempts = q.attempts + 1, updated_at = now()
        FROM team_repositories tr
       WHERE tr.id = q.team_repository_id
         AND q.team_repository_id = (
           SELECT team_repository_id FROM team_repo_recompute_queue
            WHERE (status = 'pending'
                   OR (status = 'processing'
                       AND updated_at < now() - make_interval(mins => ${STALE_PROCESSING_MINUTES})))
              AND attempts < ${MAX_ATTEMPTS}
            ORDER BY enqueued_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
      RETURNING q.team_repository_id, tr.team_id, tr.repo_url, q.attempts
    `);
    return res.rows[0] ?? null;
  }

  private async process(row: ClaimedRow): Promise<void> {
    const started = Date.now();
    try {
      await this.repositoriesService.recomputeTeamScope(
        row.team_id,
        row.repo_url,
      );
      // A re-add while this ran set the row back to 'pending': keep it for another pass.
      await this.db.execute(sql`
        DELETE FROM team_repo_recompute_queue
         WHERE team_repository_id = ${row.team_repository_id} AND status = 'processing'
      `);
      this.logger.log(
        `Team ${row.team_id}: recomputed ${row.repo_url} in ${Date.now() - started}ms`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db.execute(sql`
        UPDATE team_repo_recompute_queue
           SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
               last_error = ${message.slice(0, 2000)}, updated_at = now()
         WHERE team_repository_id = ${row.team_repository_id} AND status = 'processing'
      `);
      this.logger.error(
        `Team ${row.team_id}: recompute of ${row.repo_url} failed (attempt ${row.attempts}): ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
