import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import { OkfFactsService } from './okf-facts.service';
import type { OkfFactsResponse } from './okf-usage.types';

/**
 * The OKF facts route (FR-20): the plain facts of one of the caller's own session trees —
 * prompts, per-agent KB reads in first-access order, other reads, changes — for an on-demand
 * analysis skill to judge. API-key auth (the key's user is the caller); a missing session and
 * a session the caller does not own both answer 404 (DD-33, in `OkfFactsService`).
 */
@Controller('api/v2/okf-usage')
@UseGuards(ApiKeyAuthGuard)
export class OkfFactsController {
  constructor(private readonly okfFactsService: OkfFactsService) {}

  @Get('facts')
  async getFacts(
    @Query('sessionId') sessionId: string | undefined,
    @Req() req: Request & { userId: number },
  ): Promise<OkfFactsResponse> {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new BadRequestException('Missing sessionId query parameter');
    }
    return this.okfFactsService.getFacts(sessionId, req.userId);
  }
}
