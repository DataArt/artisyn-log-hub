import { forwardRef, Module } from '@nestjs/common';
import { ApiKeysModule } from '../../api-keys/api-keys.module';
import { LogsModule } from '../logs.module';
import { SessionAttributionController } from './session-attribution.controller';
import { SessionAttributionService } from './session-attribution.service';

/**
 * Mirrors `TurnEndCostAdvisorModule`'s shape exactly: `ApiKeyAuthGuard`
 * resolves via `ApiKeysModule`'s exported `ApiKeysService`, and
 * `forwardRef(() => LogsModule)` breaks the cycle with `RepositoriesService`
 * (`SessionAttributionService`'s own dependency, exported by `LogsModule`).
 * `SessionAttributionService` is exported so the combined `post-turn-analysis` module
 * can import it.
 */
@Module({
  imports: [ApiKeysModule, forwardRef(() => LogsModule)],
  controllers: [SessionAttributionController],
  providers: [SessionAttributionService],
  exports: [SessionAttributionService],
})
export class SessionAttributionModule {}
