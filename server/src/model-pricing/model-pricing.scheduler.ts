import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AnthropicPricingFetchService } from './anthropic-pricing-fetch.service';
import {
  SCHEDULER_NAME,
  getFetchIntervalMs,
  isFetchEnabled,
} from './model-pricing.constants';

/**
 * Runs the Anthropic pricing fetch once at bootstrap and then on every `getFetchIntervalMs()`
 * tick. Every cluster worker runs it; the service's DB claim makes sure only one worker
 * per stale/retry window actually fetches the page.
 *
 * Mirrors `AiToolVersionsScheduler` — env is read in `onApplicationBootstrap()`, not at import
 * time, so a test's `MODEL_PRICING_FETCH_ENABLED='false'` takes effect.
 */
@Injectable()
export class ModelPricingScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ModelPricingScheduler.name);
  private isTickRunning = false;
  // The tick currently in flight (if any), awaited by `onModuleDestroy()` so shutdown does
  // not close the DB pool under a running fetch.
  private inFlightTick: Promise<void> | null = null;

  constructor(
    private readonly fetchService: AnthropicPricingFetchService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    if (!isFetchEnabled()) return;
    this.runTick();
    const interval = setInterval(() => this.runTick(), getFetchIntervalMs());
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
      await this.fetchService.runFetch();
    } catch (err) {
      this.logger.error(
        `Model pricing fetch tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }
}
