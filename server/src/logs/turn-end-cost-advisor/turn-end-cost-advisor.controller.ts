import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import { SubmitTurnEndAdvisorRunDto } from './dto/submit-turn-end-advisor-run.dto';
import { TurnEndCostAdvisorService } from './turn-end-cost-advisor.service';

/**
 * `POST /api/v2/turn-end-cost-advisor` (API changes), the hook's
 * advisor-branch result submission endpoint. The combined gate-info `GET` the hook
 * reads before deciding whether to evaluate at all lives on the separate
 * `post-turn-analysis` module — this controller only
 * ever writes a run.
 */
@Controller('api/v2/turn-end-cost-advisor')
@UseGuards(ApiKeyAuthGuard)
export class TurnEndCostAdvisorController {
  constructor(
    private readonly turnEndCostAdvisorService: TurnEndCostAdvisorService,
  ) {}

  @Post()
  @HttpCode(200)
  async submitRun(
    @Body() body: SubmitTurnEndAdvisorRunDto,
    @Req() req: Request & { userId: number },
  ): Promise<{ applied: boolean }> {
    const ownership =
      await this.turnEndCostAdvisorService.checkSessionOwnership(
        body.sessionId,
        req.userId,
      );

    if (ownership === 'owner-mismatch') {
      // One API key must never be able to write a run against another user's
      // session — same 404 (not 403) `getSessionLogs()` uses to avoid confirming
      // the session's existence to a caller who doesn't own it.
      throw new NotFoundException('Session not found');
    }

    // `'unknown'` (session not yet ingested) is recorded exactly like
    // `'ok'`: the run is keyed on the raw string `sessionId`, no FK to wait on, so
    // it persists even when `sessions` has no row for it yet.
    await this.turnEndCostAdvisorService.recordRun(
      {
        sessionId: body.sessionId,
        evalSessionId: body.evalSessionId ?? null,
        startedAt: new Date(body.startedAt),
        finishedAt: new Date(body.finishedAt),
        outcome: body.outcome,
        summaryGeneral: body.summary?.general ?? null,
        costFactors: body.summary?.costFactors ?? null,
        harnessAdvice: body.summary?.harnessAdvice ?? null,
        failureReason: body.failureReason ?? null,
        model: body.cost?.model ?? null,
        costUsd: body.cost?.costUsd ?? null,
        inputTokens: body.cost?.inputTokens ?? 0,
        outputTokens: body.cost?.outputTokens ?? 0,
        cacheReadTokens: body.cost?.cacheReadTokens ?? 0,
        cacheWriteTokens: body.cost?.cacheWriteTokens ?? 0,
      },
      req.userId,
    );

    return { applied: true };
  }
}
