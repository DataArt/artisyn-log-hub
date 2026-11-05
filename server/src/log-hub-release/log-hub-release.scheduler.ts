import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { readBuildOrigin } from '../common/build-info';
import {
  SCHEDULER_NAME,
  TICK_INTERVAL_MS,
  isCheckEnabled,
} from './log-hub-release.constants';
import { LogHubReleaseService } from './log-hub-release.service';

/**
 * Runs the Log Hub release check once at bootstrap and then every `TICK_INTERVAL_MS`. Every
 * cluster worker runs it; the service's DB claim makes sure only one worker per 24 h
 * actually calls GitHub.
 *
 * Starts nothing — no fetch, no DB write — when `LOG_HUB_RELEASE_CHECK_ENABLED` is `'false'`
 * or the deployment is not an eligible official release build (`build.origin.json`).
 *
 * Mirrors `AiToolVersionsScheduler`'s `SchedulerRegistry` + `setInterval` mechanics — env
 * and the origin file are read in `onApplicationBootstrap()`, not at import time, so a
 * test's `LOG_HUB_RELEASE_CHECK_ENABLED='false'` takes effect.
 */
@Injectable()
export class LogHubReleaseScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LogHubReleaseScheduler.name);
  private isTickRunning = false;
  // The tick currently in flight (if any), awaited by `onModuleDestroy()` so shutdown does
  // not close the DB pool under a running check.
  private inFlightTick: Promise<void> | null = null;

  constructor(
    private readonly logHubReleaseService: LogHubReleaseService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!isCheckEnabled()) return;
    if (!this.logHubReleaseService.isEligible(readBuildOrigin())) return;
    this.runTick();
    const interval = setInterval(() => this.runTick(), TICK_INTERVAL_MS);
    this.schedulerRegistry.addInterval(SCHEDULER_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', SCHEDULER_NAME)) {
      this.schedulerRegistry.deleteInterval(SCHEDULER_NAME);
    }
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
  }

  /** Starts a tick unawaited, tracking it for shutdown. */
  private runTick(): void {
    if (this.isTickRunning) return;
    const tick = this.tick();
    this.inFlightTick = tick;
    void tick.finally(() => {
      if (this.inFlightTick === tick) this.inFlightTick = null;
    });
  }

  async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;
    try {
      await this.logHubReleaseService.runCheck();
    } catch (err) {
      this.logger.warn(
        `Log Hub release check tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.isTickRunning = false;
    }
  }
}
