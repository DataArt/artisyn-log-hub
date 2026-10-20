import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../../api-keys/api-keys.module';
import { SessionAttributionModule } from '../session-attribution/session-attribution.module';
import { TurnEndCostAdvisorModule } from '../turn-end-cost-advisor/turn-end-cost-advisor.module';
import { PostTurnAnalysisController } from './post-turn-analysis.controller';

/**
 * The combined `post-turn-analysis` module. `ApiKeyAuthGuard` (used by
 * `PostTurnAnalysisController`) resolves via `ApiKeysModule`'s exported `ApiKeysService`,
 * same as every other `ApiKeyAuthGuard`-using module in this codebase. Importing
 * `TurnEndCostAdvisorModule` and `SessionAttributionModule` here — rather than importing
 * their services directly — is what registers both feature modules (and therefore both
 * feature-specific `POST` controllers) in the app for the first time; see this module's
 * own registration in `app.module.ts`.
 */
@Module({
  imports: [ApiKeysModule, TurnEndCostAdvisorModule, SessionAttributionModule],
  controllers: [PostTurnAnalysisController],
})
export class PostTurnAnalysisModule {}
