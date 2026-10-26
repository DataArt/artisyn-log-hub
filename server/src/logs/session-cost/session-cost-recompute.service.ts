import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { registerSessionCostDrainHandler } from '../../model-pricing/session-cost-invalidation';
import { drainStaleSessionCosts } from './session-cost-writer';

/** Sweep period when `SESSION_COST_RECOMPUTE_INTERVAL_MS` is unset or invalid. */
export const DEFAULT_SESSION_COST_RECOMPUTE_INTERVAL_MS = 10_000;

const TICK_INTERVAL_NAME = 'session-cost-recompute-tick';

/** `SESSION_COST_RECOMPUTE_INTERVAL_MS` when it is a positive integer, else the default. */
function resolveIntervalMs(): number {
  const raw = Number(process.env.SESSION_COST_RECOMPUTE_INTERVAL_MS);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : DEFAULT_SESSION_COST_RECOMPUTE_INTERVAL_MS;
}

/**
 * Background sweeper for stale `session_costs` rows (flagged by pricing writes or by a
 * moved top-ancestor price date). Two triggers, one drain:
 *
 * - a `SchedulerRegistry` interval every `SESSION_COST_RECOMPUTE_INTERVAL_MS`; a tick that
 *   fires while a drain is running is skipped;
 * - `notifySessionCostsStale()` from the pricing writers, via the drain handler registered
 *   in `model-pricing/session-cost-invalidation.ts` (which may not import `logs/`). The
 *   handler waits for a running drain and then drains again, so an inline notify
 *   (`SESSION_COST_RECOMPUTE_INLINE=true`) always sees the rows its own write flagged.
 *
 * Safe across a cluster: each drain batch claims rows with `FOR UPDATE SKIP LOCKED`.
 */
@Injectable()
export class SessionCostRecomputeService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SessionCostRecomputeService.name);
  private inFlight: Promise<void> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    registerSessionCostDrainHandler(() => this.drainAfterCurrent());
    const interval = setInterval(() => {
      if (this.inFlight !== null) return;
      void this.startDrain().catch((err: unknown) => this.logFailure(err));
    }, resolveIntervalMs());
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    registerSessionCostDrainHandler(null);
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /** Waits out any running drain, then drains once more. Errors propagate to the caller. */
  private async drainAfterCurrent(): Promise<void> {
    while (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
    await this.startDrain();
  }

  private startDrain(): Promise<void> {
    const run = drainStaleSessionCosts(this.db)
      .then((count) => {
        if (count > 0) {
          this.logger.log(`Recomputed ${count} stale session cost(s)`);
        }
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  private logFailure(err: unknown): void {
    this.logger.error(
      `Session cost sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}
