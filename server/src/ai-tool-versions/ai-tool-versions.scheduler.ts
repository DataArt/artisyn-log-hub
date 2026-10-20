import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  CLAUDE_CODE_TOOL,
  SCHEDULER_NAME,
  getCheckIntervalMs,
  isCheckEnabled,
} from './ai-tool-versions.constants';
import { AiToolVersionsService } from './ai-tool-versions.service';

/**
 * Runs the Claude Code release-version check once at bootstrap and then on every
 * `getCheckIntervalMs()` tick. Every cluster worker runs it; the service's DB claim makes
 * sure only one worker per stale/retry window actually calls npm.
 *
 * Mirrors `TurnEndAdvisorOrphanCleanupScheduler`'s `SchedulerRegistry` + `setInterval`
 * mechanics — env is read in `onApplicationBootstrap()`, not at import time, so a test's
 * `AI_TOOL_VERSION_CHECK_ENABLED='false'` takes effect.
 */
@Injectable()
export class AiToolVersionsScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AiToolVersionsScheduler.name);
  private isTickRunning = false;
  // The tick currently in flight (if any), awaited by `onModuleDestroy()` so shutdown does
  // not close the DB pool under a running check.
  private inFlightTick: Promise<void> | null = null;

  constructor(
    private readonly aiToolVersionsService: AiToolVersionsService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!isCheckEnabled()) return;
    this.runTick();
    const interval = setInterval(() => this.runTick(), getCheckIntervalMs());
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
      await this.aiToolVersionsService.runCheck(CLAUDE_CODE_TOOL);
    } catch (err) {
      this.logger.error(
        `AI tool version check tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }
}
