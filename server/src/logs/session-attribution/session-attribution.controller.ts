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
import { SubmitSessionAttributionDto } from './dto/submit-session-attribution.dto';
import {
  SessionAttributionRunOutcome,
  SessionAttributionService,
} from './session-attribution.service';

/**
 * `POST /api/v2/session-attribution` (API changes), the hook's
 * attribution-branch result submission endpoint. The combined gate-info `GET` the hook
 * reads before deciding whether to evaluate at all lives on the separate
 * `post-turn-analysis` module — this controller only ever
 * writes a run (and, on a winning `submitted` outcome, the current attribution values).
 */
@Controller('api/v2/session-attribution')
@UseGuards(ApiKeyAuthGuard)
export class SessionAttributionController {
  constructor(
    private readonly sessionAttributionService: SessionAttributionService,
  ) {}

  @Post()
  @HttpCode(200)
  async submitRun(
    @Body() body: SubmitSessionAttributionDto,
    @Req() req: Request & { userId: number },
  ): Promise<{ applied: boolean }> {
    const lookup =
      await this.sessionAttributionService.resolveOwnedSessionRowId(
        body.sessionId,
        req.userId,
      );

    if (lookup.status === 'owner-mismatch') {
      // One API key must never be able to write a run against another user's
      // session — same 404 (not 403) the advisor endpoint uses to avoid confirming
      // the session's existence to a caller who doesn't own it.
      throw new NotFoundException('Session not found');
    }

    if (lookup.status === 'not-ingested' || lookup.sessionRowId === null) {
      // API changes — not-yet-ingested: mirrors the advisor endpoint's rule. Answer
      // success-shaped `{applied:false}`, never 5xx/404, no row written — the next
      // upload's turn re-triggers evaluation.
      return { applied: false };
    }

    const sessionRowId = lookup.sessionRowId;
    const startedAt = new Date(body.startedAt);
    const finishedAt = new Date(body.finishedAt);

    // `submitted` is server-derived into `applied`/`ignored_stale`
    // depending on whether the conditional upsert actually won; `failed` passes straight
    // through and never touches `session_attribution` at all.
    let runOutcome: SessionAttributionRunOutcome;
    if (body.outcome === 'failed') {
      runOutcome = 'failed';
    } else {
      const applied = await this.sessionAttributionService.upsertValues(
        sessionRowId,
        body.promptWatermark,
        body.values ?? {},
      );
      runOutcome = applied ? 'applied' : 'ignored_stale';
    }

    await this.sessionAttributionService.recordRun({
      sessionRowId,
      promptWatermark: body.promptWatermark,
      evalSessionId: body.evalSessionId ?? null,
      invokingSessionId: body.invokingSessionId ?? null,
      startedAt,
      finishedAt,
      outcome: runOutcome,
      failureReason:
        body.outcome === 'failed' ? (body.failureReason ?? null) : null,
      model: body.cost?.model ?? null,
      costUsd: body.cost?.costUsd ?? null,
      inputTokens: body.cost?.inputTokens ?? 0,
      outputTokens: body.cost?.outputTokens ?? 0,
      cacheReadTokens: body.cost?.cacheReadTokens ?? 0,
      cacheWriteTokens: body.cost?.cacheWriteTokens ?? 0,
    });

    return { applied: runOutcome === 'applied' };
  }
}
