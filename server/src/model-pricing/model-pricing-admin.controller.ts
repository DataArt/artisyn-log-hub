import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { ModelIdDto } from './dto/model-id.dto';
import { ModelPriceInputDto } from './dto/model-price-input.dto';
import { AnthropicPricingFetchService } from './anthropic-pricing-fetch.service';
import { ModelPricingAdminService } from './model-pricing-admin.service';
import type {
  AdminModelPricingResponse,
  AnthropicFetchNowResult,
  AdminModelPricingRow,
  OpenRouterImportResult,
} from './model-pricing.types';
import { OpenRouterImportService } from './openrouter-import.service';

/**
 * Admin model-pricing API. Model ids travel in the request body, never the path, because ids
 * can contain `/`. The public read-only `GET /api/v1/model-pricing` lives in
 * `logs/model-pricing.controller.ts` and is unchanged.
 */
@Controller('api/v1/admin/model-pricing')
@UseGuards(SessionAuthGuard, AdminGuard)
export class ModelPricingAdminController {
  constructor(
    private readonly adminService: ModelPricingAdminService,
    private readonly openRouterImport: OpenRouterImportService,
    private readonly anthropicFetch: AnthropicPricingFetchService,
  ) {}

  @Get()
  list(): Promise<AdminModelPricingResponse> {
    return this.adminService.list();
  }

  @Put('price')
  setPrice(@Body() dto: ModelPriceInputDto): Promise<AdminModelPricingRow> {
    return this.adminService.setPrice(dto);
  }

  @Put('override')
  setOverride(@Body() dto: ModelPriceInputDto): Promise<AdminModelPricingRow> {
    return this.adminService.setOverride(dto);
  }

  @Post('override/clear')
  @HttpCode(200)
  clearOverride(@Body() dto: ModelIdDto): Promise<AdminModelPricingRow> {
    return this.adminService.clearOverride(dto.modelId);
  }

  /** Runs the Anthropic pricing fetch now, outside its daily schedule. */
  @Post('fetch-anthropic')
  @HttpCode(200)
  async fetchAnthropic(): Promise<AnthropicFetchNowResult> {
    const result = await this.anthropicFetch.runFetch(undefined, {
      force: true,
    });
    return { result };
  }

  @Post('import-openrouter')
  @HttpCode(200)
  importOpenRouter(): Promise<OpenRouterImportResult> {
    return this.openRouterImport.runImport();
  }
}
