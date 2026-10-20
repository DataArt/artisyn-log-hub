import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';

const TICK_INTERVAL_NAME = 'turn-end-advisor-orphan-cleanup-tick';

/**
 * Sweeps `turn_end_advisor_runs` rows recorded for a session the server never
 * (or no longer) has a `sessions` row for. `submitRun()` may write a row for a
 * not-yet-ingested session so the run isn't lost while the hook's upload
 * races the log-ingest pipeline (usually resolved within seconds-to-minutes, per requirements);
 * this job bounds storage for the cases that never resolve (session deleted, upload permanently
 * failed) by deleting rows both older than `TURN_END_ADVISOR_ORPHAN_RETENTION_MS` AND still
 * unmatched by any `sessions.session_id` at sweep time.
 *
 * Mirrors `ExportImportJobCleanupScheduler`'s `SchedulerRegistry` + `setInterval` mechanics
 * (env vars read at `onApplicationBootstrap()` time so an e2e test's bootstrap override still
 * takes effect) and its no-claim/no-lease shape — this sweep is safe to run independently and
 * concurrently in every cluster worker, since it is idempotent cleanup, not exclusive "claim a row to
 * *process*" work.
 */
@Injectable()
export class TurnEndAdvisorOrphanCleanupScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    TurnEndAdvisorOrphanCleanupScheduler.name,
  );
  private isTickRunning = false;
  // Tracks whichever `tick()` call is currently in flight (if any), so
  // `onModuleDestroy()` can await it before shutdown proceeds to
  // `DatabaseModule.onApplicationShutdown()`'s `pool.end()` — otherwise a tick
  // already started by the interval just before teardown could still be
  // mid-await when the pool closes. `deleteInterval()` alone only stops
  // *future* firings.
  private inFlightTick: Promise<void> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Runs in `onApplicationBootstrap` rather than `onModuleInit` so the first
   * sweep cannot fire before the whole context is up.
   */
  onApplicationBootstrap(): void {
    const intervalMs =
      Number(process.env.TURN_END_ADVISOR_ORPHAN_CLEANUP_INTERVAL_MS) ||
      1800000;
    const interval = setInterval(() => {
      this.inFlightTick = this.tick().finally(() => {
        this.inFlightTick = null;
      });
    }, intervalMs);
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
  }

  /** Read fresh per tick (not cached at bootstrap) so a config change takes effect on the
   * next tick without a restart. */
  private getRetentionMs(): number {
    return Number(process.env.TURN_END_ADVISOR_ORPHAN_RETENTION_MS) || 86400000;
  }

  async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(
        `Turn-end advisor orphan cleanup sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  /**
   * Deletes `turn_end_advisor_runs` rows older than the retention window relative to `now`
   * (injectable for tests, rather than relying on `jest.useFakeTimers()`) that still have no
   * matching `sessions.session_id` — an anti-join, since `turn_end_advisor_runs.session_id`
   * carries no FK as of migration 0058.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - this.getRetentionMs());

    await this.db.execute(sql`
      DELETE FROM turn_end_advisor_runs
      WHERE created_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM sessions s WHERE s.session_id = turn_end_advisor_runs.session_id
        )
    `);
  }
}
