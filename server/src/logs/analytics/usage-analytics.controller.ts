import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../../auth/guards/session-auth.guard';
import {
  buildAttributeTypeLookup,
  normalizeRepeatableParam,
  parseAttributeFilters,
  type ParsedAttributeFilter,
  validateAttributeFilterTypes,
} from '../attribute-filter.sql';
import { RepositoriesService } from '../repositories.service';
import type { AuthUser } from '../repositories.service';
import { SessionAttributionService } from '../session-attribution/session-attribution.service';
import { ActiveSessionsService } from './active-sessions.service';
import { ClaudeVersionUsageService } from './claude-version-usage.service';
import {
  parseActiveSessionsLimit,
  parseAnalyticsQuery,
} from './analytics-query';
import { ProductivityAnalyticsService } from './productivity-analytics.service';
import type { AnalyticsScope } from './scoped-sessions.sql';
import { TokenAnalyticsService } from './token-analytics.service';
import { ToolAnalyticsService } from './tool-analytics.service';
import type {
  ActiveSessionsResponse,
  ClaudeVersionUsageResponse,
  ProductivityAnalyticsResponse,
  TokenAnalyticsResponse,
  ToolAnalyticsResponse,
} from './usage-analytics.types';

/**
 * The four repository-scope usage-analytics endpoints.
 *
 * A separate controller because `repositories.controller.ts` is already ~2,050 lines. Guard,
 * ownership assertion and team-visibility resolution are identical to
 * `reports.controller.ts` — the four `reports/*` counterparts delegate to these same services
 * and return these same DTOs, so a report can never disagree with its analytics view.
 */
@Controller('api/v1/repositories')
@UseGuards(SessionAuthGuard)
export class UsageAnalyticsController {
  constructor(
    private readonly repositoriesService: RepositoriesService,
    private readonly sessionAttributionService: SessionAttributionService,
    private readonly toolAnalyticsService: ToolAnalyticsService,
    private readonly tokenAnalyticsService: TokenAnalyticsService,
    private readonly productivityAnalyticsService: ProductivityAnalyticsService,
    private readonly activeSessionsService: ActiveSessionsService,
    private readonly claudeVersionUsageService: ClaudeVersionUsageService,
  ) {}

  @Get(':repoId/analytics/tools')
  async getToolAnalytics(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<ToolAnalyticsResponse> {
    const { repoIds, scope } = await this.resolveScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.toolAnalyticsService.build(repoIds, scope);
  }

  @Get(':repoId/analytics/tokens')
  async getTokenAnalytics(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<TokenAnalyticsResponse> {
    const { repoIds, scope } = await this.resolveScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.tokenAnalyticsService.build(repoIds, scope);
  }

  @Get(':repoId/analytics/productivity')
  async getProductivityAnalytics(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<ProductivityAnalyticsResponse> {
    const { repoIds, scope } = await this.resolveScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.productivityAnalyticsService.build(repoIds, scope);
  }

  @Get(':repoId/analytics/active-sessions')
  async getActiveSessions(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<ActiveSessionsResponse> {
    const { repoIds, scope } = await this.resolveScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.activeSessionsService.build(
      repoIds,
      scope,
      parseActiveSessionsLimit(limit),
    );
  }

  @Get(':repoId/analytics/claude-versions')
  async getClaudeVersionUsage(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<ClaudeVersionUsageResponse> {
    const { repoIds, scope } = await this.resolveScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.claudeVersionUsageService.build(repoIds, scope);
  }

  /**
   * Validates the shared query params and resolves the repositories and visibility scope the
   * caller is entitled to — `assertRepoAccess` throws 403 for a repo the user cannot reach, and
   * `resolveTeamScope` decides which members' sessions a team query may see.
   *
   * Analytics is gated once, here, for all four routes — in a
   * `restricted` team only the team owner and a `manager` may read it, so a plain member and
   * an `adlc trainer` without `manager` get a 403 rather than a silently self-scoped chart.
   * The gate is deliberately keyed on `teamId !== undefined`: the personal view is always the
   * caller's own data and is never gated.
   *
   * Also parses+validates the repeatable `attr=<key>:<op>:<value>`
   * filter against this repo's resolved attribute definitions and splices
   * it into the returned `AnalyticsScope`, which `loadScopedRootSessions()` applies for all
   * four of these routes.
   */
  private async resolveScope(
    req: Request,
    repoId: number,
    raw: {
      teamId?: number;
      startDate?: string;
      endDate?: string;
      branches?: string;
      users?: string;
      attr?: string | string[];
    },
  ): Promise<{ repoIds: number[]; scope: AnalyticsScope }> {
    const query = parseAnalyticsQuery(raw);
    const user = req.user as AuthUser;

    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      query.teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      query.teamId,
    );
    const teamScope = await this.repositoriesService.resolveTeamScope(
      user,
      query.teamId,
    );
    if (query.teamId !== undefined && !teamScope.analyticsAllowed) {
      throw new ForbiddenException();
    }

    const attributeFilters = await this.resolveAttributeFilters(
      user.id,
      repo.repoUrl,
      raw.attr,
      query.teamId,
    );

    return {
      repoIds,
      scope: {
        teamId: query.teamId,
        requesterUserId: user.id,
        scope: teamScope,
        startDate: query.startDate,
        endDate: query.endDate,
        branches: query.branches,
        users: query.users,
        attributeFilters,
      },
    };
  }

  /**
   * Shared by both this controller and `ReportsController`'s identical `resolveUsageScope()` —
   * parses the repeatable `attr=` param and 400s an operator/type mismatch against the repo's
   * resolved attribute definitions. Resolving definitions unconditionally
   * (not only when `attr=` is present) mirrors `getRepositorySessions()`'s own choice in
   * `repositories.controller.ts`, for the same reason: cheap, and keeps this one call site the
   * only place that decides "unknown key" for this route family.
   */
  private async resolveAttributeFilters(
    userId: number,
    repoUrl: string,
    attrParam: string | string[] | undefined,
    teamId?: number,
  ): Promise<ParsedAttributeFilter[]> {
    const filters = parseAttributeFilters(normalizeRepeatableParam(attrParam));
    if (filters.length === 0) return filters;

    const { attributes } =
      await this.sessionAttributionService.resolveDefinitions(
        userId,
        repoUrl,
        teamId,
      );
    validateAttributeFilterTypes(filters, buildAttributeTypeLookup(attributes));
    return filters;
  }
}
