import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SessionsService } from './sessions.service';

const TICK_INTERVAL_NAME = 'session-retention-tick';

/**
 * Timer-driven scheduler that hard-purges root sessions (and their
 * descendants) whose earliest log row predates the configured retention
 * window. Mirrors `UploadQueueSchedulerService`'s `SchedulerRegistry` +
 * `isTickRunning` + `inFlightTick` mechanics exactly
 * so behavior/tests stay consistent across schedulers in
 * this codebase. No `OnApplicationBootstrap` recovery step is needed — unlike
 * the upload queue there is no "in-progress" retention state to reclaim on
 * restart.
 */
@Injectable()
export class SessionRetentionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SessionRetentionService.name);
  private isTickRunning = false;
  // Tracks whichever `tick()` call is currently in flight (if any), so
  // `onModuleDestroy()` can await it before shutdown proceeds to
  // `DatabaseModule.onApplicationShutdown()`'s `pool.end()` — otherwise a tick
  // already started by the interval just before teardown could still be
  // mid-await when the pool closes. `deleteInterval()` alone only stops
  // *future* firings.
  private inFlightTick: Promise<void> | null = null;

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * `SESSION_RETENTION_CHECK_INTERVAL_MS` is read once here to size the
   * `setInterval(...)` call — re-reading it inside `tick()` cannot change an
   * already-created interval's period.
   *
   * Runs in `onApplicationBootstrap` rather than `onModuleInit` so the first
   * tick cannot fire before the whole context is up.
   */
  onApplicationBootstrap(): void {
    const intervalMs =
      Number(process.env.SESSION_RETENTION_CHECK_INTERVAL_MS) || 1800000;
    const interval = setInterval(() => {
      this.inFlightTick = this.tick().finally(() => {
        this.inFlightTick = null;
      });
    }, intervalMs);
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  /**
   * Order matters here: stop any *future* tick from starting first
   * (`deleteInterval`), then await whichever tick is *currently* in flight,
   * so it's guaranteed to finish (or fail) before NestJS moves on to
   * `OnApplicationShutdown` hooks (`DatabaseModule`'s `pool.end()`).
   */
  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
  }

  getRetentionDays(): number {
    return Number(process.env.SESSION_RETENTION_DAYS) || 30;
  }

  private getBatchSize(): number {
    return Number(process.env.SESSION_RETENTION_PURGE_BATCH_SIZE) || 200;
  }

  /**
   * `SESSION_RETENTION_DAYS`/`SESSION_RETENTION_PURGE_BATCH_SIZE` are read
   * fresh on every firing, so test overrides of the retention
   * window take effect without a process restart.
   */
  async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;
    try {
      const retentionDays = this.getRetentionDays();
      const batchSize = this.getBatchSize();
      const purgedCount = await this.sessionsService.hardPurgeExpiredSessions(
        retentionDays,
        batchSize,
      );
      if (purgedCount > 0) {
        this.logger.log(
          `Session retention: purged ${purgedCount} root session(s) older than ${retentionDays}d`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Session retention tick failed: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }
}
