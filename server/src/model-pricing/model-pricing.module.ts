import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AnthropicPricingFetchService } from './anthropic-pricing-fetch.service';
import { ModelPricingAdminController } from './model-pricing-admin.controller';
import { ModelPricingAdminService } from './model-pricing-admin.service';
import { ModelPricingScheduler } from './model-pricing.scheduler';
import { OpenRouterImportService } from './openrouter-import.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ModelPricingAdminController],
  providers: [
    AnthropicPricingFetchService,
    OpenRouterImportService,
    ModelPricingAdminService,
    ModelPricingScheduler,
  ],
})
export class ModelPricingModule {}
