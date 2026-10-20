import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  ParseIntPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../../api-keys/api-key-auth.guard';
import { normalizeRepoUrl } from '../repo-url-normalizer';
import { SessionAttributionService } from '../session-attribution/session-attribution.service';
import {
  DEFAULT_TURN_END_COST_ADVISOR_MIN_SESSION_COST_USD,
  TurnEndCostAdvisorService,
} from '../turn-end-cost-advisor/turn-end-cost-advisor.service';
import type {
  PostTurnAnalysisConfigResponse,
  SessionAttributionGate,
  TurnEndAdvisorGate,
} from './post-turn-analysis-response.types';

/**
 * The one combined gate-info `GET` both hook branches read before
 * deciding whether to evaluate at all. This controller performs no
 * resolution logic of its own: it normalizes `repoUrl` first (the same convention every
 * other `repoUrl`-taking endpoint in this codebase follows), then fans out to each
 * feature's own already-independently-testable `resolveGate()` and merges the two results.
 * This endpoint replaces the two feature-specific `GET` routes from the pre-unification
 * design — each feature's own `POST` result-submission endpoint is untouched and still
 * separate.
 */

/** A service's own `resolveGate()`
 * never throws under normal operation (both are total functions over their inputs), but
 * if one ever does (e.g. a transient DB error), that must not swallow the sibling
 * branch's already-computed result. This is the "feature unavailable" shape returned in
 * that branch's place — the same shape each service already answers for a switched-off
 * repo, so a caller cannot tell "genuinely off" apart from "failed to resolve" from the
 * response shape alone; the server log is where that distinction lives. */
const ADVISOR_GATE_FALLBACK: TurnEndAdvisorGate = {
  enabled: false,
  thresholdMet: false,
  minSessionCostUsd: DEFAULT_TURN_END_COST_ADVISOR_MIN_SESSION_COST_USD,
  aggregate: null,
  fileCategories: [],
};
const ATTRIBUTION_GATE_FALLBACK: SessionAttributionGate = {
  enabled: false,
  attributes: [],
  evaluatedWatermark: null,
  evaluationRequired: false,
};

@Controller('api/v2/post-turn-analysis')
@UseGuards(ApiKeyAuthGuard)
export class PostTurnAnalysisController {
  private readonly logger = new Logger(PostTurnAnalysisController.name);

  constructor(
    private readonly turnEndCostAdvisorService: TurnEndCostAdvisorService,
    private readonly sessionAttributionService: SessionAttributionService,
  ) {}

  @Get('config')
  async getConfig(
    @Query('repoUrl') repoUrl: string | undefined,
    @Query('sessionId') sessionId: string | undefined,
    @Query('promptWatermark', new ParseIntPipe({ optional: true }))
    promptWatermark: number | undefined,
    @Req() req: Request & { userId: number },
  ): Promise<PostTurnAnalysisConfigResponse> {
    if (!repoUrl) {
      throw new BadRequestException('Missing repoUrl query parameter');
    }
    if (!sessionId) {
      throw new BadRequestException('Missing sessionId query parameter');
    }

    const normalizedRepoUrl = normalizeRepoUrl(repoUrl);

    // A thin composition layer only: neither service's own
    // resolution logic changes here, this just packages both results into one response.
    // `Promise.allSettled` (not `Promise.all`) so a throw in one branch's `resolveGate()`
    // never discards the other branch's already-computed result: a throw in one service's resolveGate() does not
    // prevent the other's result from being returned — each is awaited independently,
    // not short-circuited.
    const [advisorResult, attributionResult] = await Promise.allSettled([
      this.turnEndCostAdvisorService.resolveGate(
        req.userId,
        normalizedRepoUrl,
        sessionId,
      ),
      this.sessionAttributionService.resolveGate(
        req.userId,
        normalizedRepoUrl,
        sessionId,
        // promptWatermark is used by the attribution branch only (API changes); an
        // absent/non-integer value defaults to 0 rather than 400ing the whole combined
        // response over a query param the advisor half doesn't even need.
        promptWatermark ?? 0,
      ),
    ]);

    const advisor = this.settle(
      advisorResult,
      ADVISOR_GATE_FALLBACK,
      'advisor',
    );
    const attribution = this.settle(
      attributionResult,
      ATTRIBUTION_GATE_FALLBACK,
      'attribution',
    );

    return { advisor, attribution };
  }

  private settle<T>(
    result: PromiseSettledResult<T>,
    fallback: T,
    branch: 'advisor' | 'attribution',
  ): T {
    if (result.status === 'fulfilled') return result.value;
    this.logger.error(
      `${branch} resolveGate() failed — answering the feature-unavailable shape for this branch only: ${String(result.reason)}`,
    );
    return fallback;
  }
}
