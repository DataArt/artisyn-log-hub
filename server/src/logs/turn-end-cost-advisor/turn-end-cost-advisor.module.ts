import { forwardRef, Module } from '@nestjs/common';
import { ApiKeysModule } from '../../api-keys/api-keys.module';
import { LogsModule } from '../logs.module';
import { TurnEndAdvisorOrphanCleanupScheduler } from './turn-end-advisor-orphan-cleanup.scheduler';
import { TurnEndCostAdvisorController } from './turn-end-cost-advisor.controller';
import { TurnEndCostAdvisorService } from './turn-end-cost-advisor.service';

/**
 * `ApiKeyAuthGuard` resolves via `ApiKeysModule`'s exported
 * `ApiKeysService` (same pattern `LogsModule` itself uses for `LogsV2Controller`).
 * `forwardRef(() => LogsModule)` breaks the cycle with `RepositoriesService`
 * (`TurnEndCostAdvisorService`'s own dependency, exported by `LogsModule`) — the same
 * shape `LogsModule` already uses for `TeamsModule`. `TurnEndCostAdvisorService` is
 * exported so the combined `post-turn-analysis` module can import it.
 */
@Module({
  imports: [ApiKeysModule, forwardRef(() => LogsModule)],
  controllers: [TurnEndCostAdvisorController],
  providers: [TurnEndCostAdvisorService, TurnEndAdvisorOrphanCleanupScheduler],
  exports: [TurnEndCostAdvisorService],
})
export class TurnEndCostAdvisorModule {}
