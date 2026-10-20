import {
  BadRequestException,
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
import { ActiveSessionsService } from '../analytics/active-sessions.service';
import { ClaudeVersionUsageService } from '../analytics/claude-version-usage.service';
import {
  parseActiveSessionsLimit,
  parseAnalyticsQuery,
} from '../analytics/analytics-query';
import { ProductivityAnalyticsService } from '../analytics/productivity-analytics.service';
import type { AnalyticsScope } from '../analytics/scoped-sessions.sql';
import { TokenAnalyticsService } from '../analytics/token-analytics.service';
import { ToolAnalyticsService } from '../analytics/tool-analytics.service';
import type {
  ActiveSessionsResponse,
  ClaudeVersionUsageResponse,
  ProductivityAnalyticsResponse,
  TokenAnalyticsResponse,
  ToolAnalyticsResponse,
} from '../analytics/usage-analytics.types';
import {
  assertKnownGroupByAttrKey,
  assertNoGroupByAttrFilterConflict,
  buildAttributeTypeLookup,
  normalizeRepeatableParam,
  parseAttributeFilters,
  parseGroupByAttrKey,
  type ParsedAttributeFilter,
  validateAttributeFilterTypes,
} from '../attribute-filter.sql';
import type { SessionAttributionAttributeDef } from '../../database/schema/index';
import { RepositoriesService } from '../repositories.service';
import type { AuthUser } from '../repositories.service';
import type { TeamScope } from '../team-scope';
import {
  SessionAttributionService,
  type SessionAttributionRunOutcome,
} from '../session-attribution/session-attribution.service';
import {
  AttributionBreakdownService,
  type AttributionBreakdownReportData,
} from './attribution-breakdown.service';
import {
  ATTRIBUTION_USAGE_OUTCOMES,
  AttributionUsageService,
  type AttributionUsageReportData,
} from './attribution-usage.service';
import {
  CacheReadRatioService,
  type CacheRatioGroupBy,
  type CacheReadRatioReportData,
} from './cache-read-ratio.service';
import type { ChangeSurfaceGroupBy } from '../change-surface/change-surface-aggregate.service';
import type { ChangeSurfaceReportData } from '../change-surface/change-surface.types';
import { ChangeSurfaceReportService } from './change-surface-report.service';
import {
  ExecutiveSummaryService,
  type ExecutiveSummaryReport,
} from './executive-summary.service';
import {
  HarnessUsageService,
  type HarnessUsageGroupBy,
  type HarnessUsageReportData,
} from './harness-usage.service';

// Whitelist for the cache-read-ratio report's fixed (non-`attr:`) `groupBy` values.
// `groupBy=attr:<key>` is validated separately,
// against the repo's resolved attribute definitions, via `assertKnownGroupByAttrKey()`.
const CACHE_RATIO_GROUP_BY_VALUES: readonly CacheRatioGroupBy[] = [
  'none',
  'branch',
  'user',
];

// Whitelist for the harness-usage report's fixed `groupBy` values —
// same three values as `cache-read-ratio`, validated the same way; `attr:<key>` likewise
// validated separately.
const HARNESS_USAGE_GROUP_BY_VALUES: readonly HarnessUsageGroupBy[] = [
  'none',
  'branch',
  'user',
];

// Whitelist for the change-surface report's fixed `groupBy` values
// — the same three values as the two reports above, validated the same way; `attr:<key>`
// likewise validated separately, against the repo's resolved attribute definitions.
const CHANGE_SURFACE_GROUP_BY_VALUES: readonly ChangeSurfaceGroupBy[] = [
  'none',
  'branch',
  'user',
];

@Controller('api/v1/repositories')
@UseGuards(SessionAuthGuard)
export class ReportsController {
  constructor(
    private readonly repositoriesService: RepositoriesService,
    private readonly sessionAttributionService: SessionAttributionService,
    private readonly executiveSummaryService: ExecutiveSummaryService,
    private readonly cacheReadRatioService: CacheReadRatioService,
    private readonly harnessUsageService: HarnessUsageService,
    private readonly changeSurfaceReportService: ChangeSurfaceReportService,
    private readonly attributionBreakdownService: AttributionBreakdownService,
    private readonly attributionUsageService: AttributionUsageService,
    private readonly toolAnalyticsService: ToolAnalyticsService,
    private readonly tokenAnalyticsService: TokenAnalyticsService,
    private readonly productivityAnalyticsService: ProductivityAnalyticsService,
    private readonly activeSessionsService: ActiveSessionsService,
    private readonly claudeVersionUsageService: ClaudeVersionUsageService,
  ) {}

  @Get(':repoId/reports/executive-summary')
  async getExecutiveSummary(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('branches') branchesParam?: string,
    @Query('users') usersParam?: string,
    @Query('attr') attrParam?: string | string[],
  ): Promise<ExecutiveSummaryReport> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    if (!startDateParam) {
      throw new BadRequestException('startDate is required');
    }
    if (!endDateParam) {
      throw new BadRequestException('endDate is required');
    }

    const startDate = new Date(startDateParam);
    const endDate = new Date(endDateParam);
    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }

    const branches =
      branchesParam !== undefined && branchesParam !== ''
        ? branchesParam.split(',').map((b) => decodeURIComponent(b))
        : [];
    const users =
      usersParam !== undefined && usersParam !== ''
        ? usersParam.split(',').map((u) => decodeURIComponent(u))
        : [];

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    const teamScope = await this.resolveReportScope(user, teamId);
    const { filters: attributeFilters } = await this.resolveAttributeFilters(
      user.id,
      repo.repoUrl,
      attrParam,
      teamId,
    );

    return this.executiveSummaryService.build(repoIds, {
      teamId,
      requesterUserId: user.id,
      scope: teamScope,
      startDate,
      endDate,
      branches,
      users,
      attributeFilters,
    });
  }

  @Get(':repoId/reports/cache-read-ratio')
  async getCacheReadRatio(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('groupBy') groupByParam?: string,
    @Query('branches') branchesParam?: string,
    @Query('users') usersParam?: string,
    @Query('attr') attrParam?: string | string[],
  ): Promise<CacheReadRatioReportData> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    if (!startDateParam) {
      throw new BadRequestException('startDate is required');
    }
    if (!endDateParam) {
      throw new BadRequestException('endDate is required');
    }

    const startDate = new Date(startDateParam);
    const endDate = new Date(endDateParam);
    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }

    // `groupBy=attr:<key>` is validated separately below, once
    // the repo's resolved attribute definitions are known — the fixed whitelist here only
    // rejects a value that is neither one of the three fixed groupings nor the `attr:` form.
    const groupByAttrKey = parseGroupByAttrKey(groupByParam);
    const groupBy = (groupByParam ?? 'none') as CacheRatioGroupBy;
    if (
      groupByAttrKey === undefined &&
      !CACHE_RATIO_GROUP_BY_VALUES.includes(groupBy)
    ) {
      throw new BadRequestException(
        `groupBy must be one of: ${CACHE_RATIO_GROUP_BY_VALUES.join(', ')}, or attr:<key>`,
      );
    }

    const branches =
      branchesParam !== undefined && branchesParam !== ''
        ? branchesParam.split(',').map((b) => decodeURIComponent(b))
        : [];
    const users =
      usersParam !== undefined && usersParam !== ''
        ? usersParam.split(',').map((u) => decodeURIComponent(u))
        : [];

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    const teamScope = await this.resolveReportScope(user, teamId);

    // The threshold in force for THIS requester and the
    // `session_cause_stats` scope holding the totals computed with it.
    const causeScope = this.repositoriesService.resolveCauseStatsScope(
      user.id,
      teamId,
    );
    const [{ threshold, source }, { filters, resolvedDefinitions }] =
      await Promise.all([
        this.repositoriesService.getEffectiveCacheThreshold(
          user.id,
          repo.repoUrl,
          teamId,
        ),
        this.resolveAttributeFilters(user.id, repo.repoUrl, attrParam, teamId),
      ]);
    assertKnownGroupByAttrKey(groupByAttrKey, resolvedDefinitions);
    assertNoGroupByAttrFilterConflict(groupByAttrKey, filters);

    return this.cacheReadRatioService.build(repoIds, {
      teamId,
      requesterUserId: user.id,
      scope: teamScope,
      startDate,
      endDate,
      branches,
      users,
      groupBy,
      thresholdTokens: threshold,
      thresholdSource: source,
      causeScope,
      attributeFilters: filters,
      resolvedAttributeDefinitions: resolvedDefinitions,
    });
  }

  @Get(':repoId/reports/harness-usage')
  async getHarnessUsageReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('groupBy') groupByParam?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<HarnessUsageReportData> {
    // Same split as `cache-read-ratio` — the fixed whitelist
    // here, `attr:<key>` validated below against the repo's resolved definitions.
    const groupByAttrKey = parseGroupByAttrKey(groupByParam);
    const groupBy = (groupByParam ?? 'none') as HarnessUsageGroupBy;
    if (
      groupByAttrKey === undefined &&
      !HARNESS_USAGE_GROUP_BY_VALUES.includes(groupBy)
    ) {
      throw new BadRequestException(
        `groupBy must be one of: ${HARNESS_USAGE_GROUP_BY_VALUES.join(', ')}, or attr:<key>`,
      );
    }

    const { repoIds, scope, resolvedDefinitions } =
      await this.resolveUsageScope(req, repoId, {
        teamId,
        startDate,
        endDate,
        branches,
        users,
        attr,
      });
    assertKnownGroupByAttrKey(groupByAttrKey, resolvedDefinitions);
    assertNoGroupByAttrFilterConflict(
      groupByAttrKey,
      scope.attributeFilters ?? [],
    );

    return this.harnessUsageService.build(repoIds, {
      ...scope,
      groupBy,
      resolvedAttributeDefinitions: resolvedDefinitions,
    });
  }

  /**
   * The Change Surface report.
   *
   * Same `groupBy` split as `harness-usage` above: the fixed values against the whitelist
   * here, `attr:<key>` validated below against this repo's resolved definitions. The report
   * itself computes nothing — it delegates to the same `ChangeSurfaceAggregateService.build()`
   * the analytics chart calls, pinned to `bucket: 'week'`, which is what makes the report and
   * the chart incapable of disagreeing.
   */
  @Get(':repoId/reports/change-surface')
  async getChangeSurfaceReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('groupBy') groupByParam?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<ChangeSurfaceReportData> {
    const groupByAttrKey = parseGroupByAttrKey(groupByParam);
    const groupBy = (groupByParam ?? 'none') as ChangeSurfaceGroupBy;
    if (
      groupByAttrKey === undefined &&
      !CHANGE_SURFACE_GROUP_BY_VALUES.includes(groupBy)
    ) {
      throw new BadRequestException(
        `groupBy must be one of: ${CHANGE_SURFACE_GROUP_BY_VALUES.join(', ')}, or attr:<key>`,
      );
    }

    const { repoIds, scope, resolvedDefinitions } =
      await this.resolveUsageScope(req, repoId, {
        teamId,
        startDate,
        endDate,
        branches,
        users,
        attr,
      });
    assertKnownGroupByAttrKey(groupByAttrKey, resolvedDefinitions);
    assertNoGroupByAttrFilterConflict(
      groupByAttrKey,
      scope.attributeFilters ?? [],
    );

    return this.changeSurfaceReportService.build(repoIds, {
      ...scope,
      groupBy,
      resolvedAttributeDefinitions: resolvedDefinitions,
    });
  }

  // Attribution Breakdown. `supportsAttributeFilter: true`
  // but not one of the 5 `supportsGroupBy: true` reports —
  // it already breaks every attribute down into its own section, so a `groupBy` would be
  // redundant.
  @Get(':repoId/reports/attribution-breakdown')
  async getAttributionBreakdownReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('branches') branchesParam?: string,
    @Query('users') usersParam?: string,
    @Query('attr') attrParam?: string | string[],
  ): Promise<AttributionBreakdownReportData> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    if (!startDateParam) {
      throw new BadRequestException('startDate is required');
    }
    if (!endDateParam) {
      throw new BadRequestException('endDate is required');
    }

    const startDate = new Date(startDateParam);
    const endDate = new Date(endDateParam);
    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }

    const branches =
      branchesParam !== undefined && branchesParam !== ''
        ? branchesParam.split(',').map((b) => decodeURIComponent(b))
        : [];
    const users =
      usersParam !== undefined && usersParam !== ''
        ? usersParam.split(',').map((u) => decodeURIComponent(u))
        : [];

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    const teamScope = await this.resolveReportScope(user, teamId);
    const { filters, resolvedDefinitions } = await this.resolveAttributeFilters(
      user.id,
      repo.repoUrl,
      attrParam,
      teamId,
    );

    return this.attributionBreakdownService.build(repoIds, {
      teamId,
      requesterUserId: user.id,
      scope: teamScope,
      startDate,
      endDate,
      branches,
      users,
      attributeFilters: filters,
      resolvedAttributeDefinitions: resolvedDefinitions,
    });
  }

  // Attribution Usage. `supportsAttributeFilter: false`:
  // its population is `session_attribution_runs` (evaluation attempts,
  // including `failed` ones with no `values`), not sessions carrying resolved attribute
  // values — an `attr=` filter has nothing to apply to. Accepts the shared date/repo scope
  // plus its own repeatable `outcome=` narrowing.
  @Get(':repoId/reports/attribution-usage')
  async getAttributionUsageReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDateParam?: string,
    @Query('endDate') endDateParam?: string,
    @Query('branches') branchesParam?: string,
    @Query('users') usersParam?: string,
    @Query('outcome') outcomeParam?: string | string[],
  ): Promise<AttributionUsageReportData> {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
    if (!startDateParam) {
      throw new BadRequestException('startDate is required');
    }
    if (!endDateParam) {
      throw new BadRequestException('endDate is required');
    }

    const startDate = new Date(startDateParam);
    const endDate = new Date(endDateParam);
    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('startDate must be a valid ISO 8601 date');
    }
    if (isNaN(endDate.getTime())) {
      throw new BadRequestException('endDate must be a valid ISO 8601 date');
    }

    const branches =
      branchesParam !== undefined && branchesParam !== ''
        ? branchesParam.split(',').map((b) => decodeURIComponent(b))
        : [];
    const users =
      usersParam !== undefined && usersParam !== ''
        ? usersParam.split(',').map((u) => decodeURIComponent(u))
        : [];
    const outcomes = normalizeRepeatableParam(outcomeParam).map((raw) => {
      if (!(ATTRIBUTION_USAGE_OUTCOMES as readonly string[]).includes(raw)) {
        throw new BadRequestException(
          `outcome must be one of: ${ATTRIBUTION_USAGE_OUTCOMES.join(', ')}`,
        );
      }
      return raw as SessionAttributionRunOutcome;
    });

    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const repoIds = await this.repositoriesService.resolveRepoIds(
      repoId,
      repo.repoUrl,
      teamId,
    );
    const teamScope = await this.resolveReportScope(user, teamId);

    return this.attributionUsageService.build(repoIds, {
      teamId,
      requesterUserId: user.id,
      scope: teamScope,
      startDate,
      endDate,
      branches,
      users,
      outcomes,
    });
  }

  // --- Usage reports --------------------------------------------------------------------
  //
  // Each of these four delegates to the same service the matching
  // `GET :repoId/analytics/*` route uses and returns the same DTO, so a report document and
  // its analytics view can never disagree. Validation, guard and ownership assertion are
  // shared through `parseAnalyticsQuery()` / `resolveUsageScope()`.

  @Get(':repoId/reports/tool-analytics')
  async getToolAnalyticsReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<ToolAnalyticsResponse> {
    const { repoIds, scope } = await this.resolveUsageScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.toolAnalyticsService.build(repoIds, scope);
  }

  @Get(':repoId/reports/token-usage')
  async getTokenUsageReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<TokenAnalyticsResponse> {
    const { repoIds, scope } = await this.resolveUsageScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.tokenAnalyticsService.build(repoIds, scope);
  }

  @Get(':repoId/reports/productivity-counters')
  async getProductivityCountersReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<ProductivityAnalyticsResponse> {
    const { repoIds, scope } = await this.resolveUsageScope(req, repoId, {
      teamId,
      startDate,
      endDate,
      branches,
      users,
      attr,
    });
    return this.productivityAnalyticsService.build(repoIds, scope);
  }

  @Get(':repoId/reports/active-sessions')
  async getActiveSessionsReport(
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
    const { repoIds, scope } = await this.resolveUsageScope(req, repoId, {
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

  @Get(':repoId/reports/claude-versions')
  async getClaudeVersionUsageReport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branches') branches?: string,
    @Query('users') users?: string,
    @Query('attr') attr?: string | string[],
  ): Promise<ClaudeVersionUsageResponse> {
    const { repoIds, scope } = await this.resolveUsageScope(req, repoId, {
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
   * The caller's team access-mode scope for a report route, plus the analytics gate.
   *
   * Every one of the eleven `reports/*` routes resolves its scope
   * through here (seven of them indirectly, via {@link resolveUsageScope}), so the 403 and
   * the row filter can never be applied to one report and forgotten on another.
   *
   * In a `restricted` team only the team owner and a `manager` may read a report; a plain
   * member and an `adlc trainer` without `manager` get 403 rather than a silently
   * self-scoped document. The personal view (`teamId === undefined`) is never gated — it
   * is always the caller's own data.
   */
  private async resolveReportScope(
    user: AuthUser,
    teamId: number | undefined,
  ): Promise<TeamScope> {
    const scope = await this.repositoriesService.resolveTeamScope(user, teamId);
    if (teamId !== undefined && !scope.analyticsAllowed) {
      throw new ForbiddenException();
    }
    return scope;
  }

  /**
   * Identical to `UsageAnalyticsController.resolveScope` — same guard, same 403 behaviour, and
   * the same `attr=` parsing/validation, additionally returning the resolved
   * attribute definitions so `groupBy=attr:<key>` callers (harness-usage) can 400 an
   * unresolved key without a second round trip.
   */
  private async resolveUsageScope(
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
  ): Promise<{
    repoIds: number[];
    scope: AnalyticsScope;
    resolvedDefinitions: SessionAttributionAttributeDef[];
  }> {
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
    const teamScope = await this.resolveReportScope(user, query.teamId);

    const { filters, resolvedDefinitions } = await this.resolveAttributeFilters(
      user.id,
      repo.repoUrl,
      raw.attr,
      query.teamId,
    );

    return {
      repoIds,
      resolvedDefinitions,
      scope: {
        teamId: query.teamId,
        requesterUserId: user.id,
        scope: teamScope,
        startDate: query.startDate,
        endDate: query.endDate,
        branches: query.branches,
        users: query.users,
        attributeFilters: filters,
      },
    };
  }

  /**
   * Shared attr= parsing/validation — always resolves this repo's
   * attribute definitions (even with no `attr=` present), because every `groupBy=attr:<key>`
   * call site needs them too and this is the one place that fetches them per request.
   */
  private async resolveAttributeFilters(
    userId: number,
    repoUrl: string,
    attrParam: string | string[] | undefined,
    teamId?: number,
  ): Promise<{
    filters: ParsedAttributeFilter[];
    resolvedDefinitions: SessionAttributionAttributeDef[];
  }> {
    const filters = parseAttributeFilters(normalizeRepeatableParam(attrParam));
    const { attributes } =
      await this.sessionAttributionService.resolveDefinitions(
        userId,
        repoUrl,
        teamId,
      );
    if (filters.length > 0) {
      validateAttributeFilterTypes(
        filters,
        buildAttributeTypeLookup(attributes),
      );
    }
    return { filters, resolvedDefinitions: attributes };
  }
}
