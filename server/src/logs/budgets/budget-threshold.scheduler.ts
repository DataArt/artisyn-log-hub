import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { BUDGET_CHECK_DEFAULT_INTERVAL_MS } from './budget.constants';
import { BudgetNoticesService } from './budget-notices.service';
import { loadAllBudgets } from './spend-read.sql';
import { SpendService } from './spend.service';

const TICK_INTERVAL_NAME = 'budget-threshold-tick';

/** The job is on unless env `BUDGET_CHECK_ENABLED` is exactly `'false'`. */
export function isBudgetCheckEnabled(): boolean {
  return process.env.BUDGET_CHECK_ENABLED !== 'false';
}

/**
 * The budget threshold job (2026-11-05 budgets-threshold-alerts, DD-14). Every
 * `BUDGET_CHECK_INTERVAL_MS` (default 5 minutes) it computes each budget's current-period spend
 * (`SpendService.computeBudgetSpend`, caller-independent) and records newly crossed thresholds
 * (`BudgetNoticesService.recordCrossings`). An error on one budget is logged and never aborts the
 * tick. It is never called from ingest.
 *
 * Mechanics follow `ExportImportJobCleanupScheduler`: env read at `onApplicationBootstrap()`,
 * a `SchedulerRegistry` interval, an `isTickRunning` guard and the in-flight tick awaited on
 * shutdown. It runs in every cluster worker; the notices' unique key dedups the writes and only
 * the inserting worker sends email.
 */
@Injectable()
export class BudgetThresholdScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BudgetThresholdScheduler.name);
  private isTickRunning = false;
  private inFlightTick: Promise<void> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly spendService: SpendService,
    private readonly budgetNotices: BudgetNoticesService,
  ) {}

  onApplicationBootstrap(): void {
    if (!isBudgetCheckEnabled()) {
      this.logger.log('Budget threshold job disabled (BUDGET_CHECK_ENABLED)');
      return;
    }
    const intervalMs =
      Number(process.env.BUDGET_CHECK_INTERVAL_MS) ||
      BUDGET_CHECK_DEFAULT_INTERVAL_MS;
    const interval = setInterval(() => {
      if (this.isTickRunning) return;
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

  async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;
    try {
      const all = await loadAllBudgets(this.db);
      for (const budget of all) {
        try {
          const { spendMicros, bounds } =
            await this.spendService.computeBudgetSpend(budget);
          await this.budgetNotices.recordCrossings(budget, spendMicros, bounds);
        } catch (err) {
          this.logger.error(
            `Budget ${budget.id} threshold check failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            err instanceof Error ? err.stack : undefined,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `Budget threshold tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }
}
