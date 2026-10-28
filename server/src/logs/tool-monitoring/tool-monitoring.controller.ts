import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../../auth/guards/session-auth.guard';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import type {
  ToolCallStatus,
  ToolUsageChannel,
} from '../../database/schema/index';
import { RepositoriesService, type AuthUser } from '../repositories.service';
import { maskFirstPrompt, type TeamScope } from '../team-scope';
import { ToolMonitorConfigService } from './tool-monitor-config.service';
import type {
  ToolCallDetailResponse,
  ToolCallsPageResponse,
  ToolMonitorConfigView,
  ToolUsageSummaryResponse,
} from './tool-monitoring.types';
import {
  CALLS_PAGE_SIZE_DEFAULT,
  CALLS_PAGE_SIZE_MAX,
  SEARCH_MAX_CHARS,
} from './tool-usage.constants';
import {
  assembleToolUsageSummary,
  loadCallDetail,
  loadCalls,
  loadSummary,
  toToolCallListItem,
  type ToolCallsFilters,
  type ToolUsageRange,
  type ToolUsageReadScope,
} from './tool-usage-read.sql';

/** Default range length when `from` is omitted (API changes: the last 30 days). */
const DEFAULT_RANGE_DAYS = 30;
const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const CHANNELS: readonly ToolUsageChannel[] = ['mcp', 'cli'];
const STATUSES: readonly ToolCallStatus[] = [
  'ok',
  'error',
  'killed',
  'no_result',
];
/** Upper bound on the `tool` / `operation` filters and the `callId` path segment. */
const FILTER_MAX_CHARS = 256;

function assertTeamId(teamId: number | undefined): void {
  if (teamId !== undefined && teamId <= 0) {
    throw new BadRequestException('teamId must be a positive integer');
  }
}

function parseDateParam(name: string, raw: string): Date {
  const date = new Date(raw);
  if (isNaN(date.getTime())) {
    throw new BadRequestException(`${name} must be a valid ISO 8601 date`);
  }
  return date;
}

/**
 * The tab's date range (API changes): ISO `from` / `to`, both optional. `to` defaults to now
 * and `from` to 30 days before `to`; a date-only `to` (`YYYY-MM-DD`) covers that whole UTC day.
 * Validated like `analytics/analytics-query.ts`; `from` after `to` is a 400.
 */
export function parseToolUsageRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now: Date = new Date(),
): ToolUsageRange {
  let to = now;
  if (toRaw !== undefined && toRaw !== '') {
    to = parseDateParam('to', toRaw);
    if (DATE_ONLY.test(toRaw)) to = new Date(to.getTime() + DAY_MS - 1);
  }
  const from =
    fromRaw !== undefined && fromRaw !== ''
      ? parseDateParam('from', fromRaw)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException('from must not be after to');
  }
  return { from, to };
}

/** No date bounds: the session tab shows the whole session, whenever its calls were made. */
const ALL_TIME_RANGE: ToolUsageRange = {
  from: new Date(0),
  to: new Date('9999-12-31T23:59:59.999Z'),
};

/**
 * The range for a read route: with `sessionId` and neither bound given, all time (the session
 * detail's Tools/MCP tab); otherwise {@link parseToolUsageRange}.
 */
function resolveRange(
  sessionId: string | undefined,
  fromRaw: string | undefined,
  toRaw: string | undefined,
): ToolUsageRange {
  if (sessionId !== undefined && !fromRaw && !toRaw) return ALL_TIME_RANGE;
  return parseToolUsageRange(fromRaw, toRaw);
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  max?: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (max !== undefined && value > max)
  ) {
    throw new BadRequestException(
      max === undefined
        ? `${name} must be a positive integer`
        : `${name} must be an integer between 1 and ${max}`,
    );
  }
  return value;
}

function parseOptionalText(
  name: string,
  raw: string | undefined,
  max: number,
): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw.length > max) {
    throw new BadRequestException(`${name} must be at most ${max} characters`);
  }
  return raw;
}

function parseEnumParam<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!allowed.includes(raw as T)) {
    throw new BadRequestException(
      `${name} must be one of ${allowed.join(', ')}`,
    );
  }
  return raw as T;
}

/**
 * The Tools/MCP tab routes (impl-plan "API changes", DD-17, DD-18). Cookie-session auth;
 * `teamId` is optional (positive int, else 400) and checked by `assertRepoAccess` like the other
 * repository routes. Reads follow the **Sessions-tab** rules: without `teamId` the caller's own
 * sessions and the personal config level; with `teamId` the team access-mode row filter
 * (`resolveTeamScope`) over every member's repository row for the URL, and the team level,
 * editable by the team owner. No GET mutates anything.
 */
@Controller('api/v1/repositories')
@UseGuards(SessionAuthGuard)
export class ToolMonitoringController {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
    private readonly configService: ToolMonitorConfigService,
  ) {}

  /**
   * The repo scope every read route resolves — what `buildSessionListConditions` resolves for
   * the Sessions tab: `assertRepoAccess` 403s a repository the caller cannot reach,
   * `resolveRepoIds` widens a team view to every member's row for the URL, and
   * `resolveTeamScope` gives the owner row filter and the masking scope.
   */
  private async resolveReadScope(
    user: AuthUser,
    repoId: number,
    teamId: number | undefined,
    rootSessionId?: string,
  ): Promise<{ scope: ToolUsageReadScope; repoUrl: string }> {
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const [teamScope, repoIds] = await Promise.all([
      this.repositoriesService.resolveTeamScope(user, teamId),
      this.repositoriesService.resolveRepoIds(repoId, repo.repoUrl, teamId),
    ]);
    return {
      scope: { repoIds, teamScope, rootSessionId },
      repoUrl: repo.repoUrl,
    };
  }

  @Get(':repoId/tool-monitoring/config')
  async getConfig(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<ToolMonitorConfigView> {
    assertTeamId(teamId);
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);
    return this.configService.buildConfigView(user, repoId, teamId);
  }

  /**
   * Replaces one level's tool list: personal without `teamId` (the repository row's owner),
   * team with it (the team owner only, else 403). Newly added or enabled tools mark the level's
   * scope sessions stale (DD-7).
   */
  @Put(':repoId/tool-monitoring/config')
  async putConfig(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Body() body: unknown,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<ToolMonitorConfigView> {
    assertTeamId(teamId);
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoAccess(user, repoId, teamId);
    return this.configService.saveLevelConfig(user, repoId, teamId, body);
  }

  /**
   * The tools tree (DD-11): per-operation aggregates summed into tools, groups and totals for
   * the range and scope, the monitored CLI tools with no call, and the count of in-scope
   * sessions still waiting for a rebuild. Status and search do not apply here (DD-18).
   * `sessionId` (a root session id) narrows everything to that one session tree.
   */
  @Get(':repoId/tool-monitoring/summary')
  async getSummary(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sessionId') sessionIdRaw?: string,
  ): Promise<ToolUsageSummaryResponse> {
    assertTeamId(teamId);
    const sessionId = parseOptionalText(
      'sessionId',
      sessionIdRaw,
      FILTER_MAX_CHARS,
    );
    const range = resolveRange(sessionId, from, to);
    const user = req.user as AuthUser;
    const { scope, repoUrl } = await this.resolveReadScope(
      user,
      repoId,
      teamId,
      sessionId,
    );

    const [rows, monitoredCliTools] = await Promise.all([
      loadSummary(this.db, scope, range),
      this.loadMonitoredCliTools(user, repoId, repoUrl, teamId),
    ]);
    return assembleToolUsageSummary({
      range,
      pendingSessions: rows.pendingSessions,
      operations: rows.operations,
      monitoredCliTools,
    });
  }

  /**
   * The enabled configured CLI tools behind `neverCalled`: in the team view the team level's
   * list; in the personal view (the caller owns the repository row) the caller's effective set
   * — personal ∪ the teams' lists, DD-2 — which is what the hook wraps for them.
   */
  private async loadMonitoredCliTools(
    user: AuthUser,
    repoId: number,
    repoUrl: string,
    teamId: number | undefined,
  ): Promise<string[]> {
    if (teamId !== undefined) {
      const config = await this.configService.getLevelConfig(repoId, teamId);
      return config.tools.filter((t) => t.enabled).map((t) => t.name);
    }
    const resolved = await this.configService.resolveMonitoredTools(
      user.id,
      repoUrl,
    );
    return resolved.tools.map((t) => t.name);
  }

  /**
   * The calls table (DD-18): one page of calls in range and scope, newest first. `sessionId`
   * (a root session id) narrows it to that one session tree.
   */
  @Get(':repoId/tool-monitoring/calls')
  async getCalls(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('channel') channel?: string,
    @Query('tool') tool?: string,
    @Query('operation') operation?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('sessionId') sessionIdRaw?: string,
  ): Promise<ToolCallsPageResponse> {
    assertTeamId(teamId);
    const sessionId = parseOptionalText(
      'sessionId',
      sessionIdRaw,
      FILTER_MAX_CHARS,
    );
    const range = resolveRange(sessionId, from, to);
    const filters: ToolCallsFilters = {
      channel: parseEnumParam('channel', channel, CHANNELS),
      tool: parseOptionalText('tool', tool, FILTER_MAX_CHARS),
      operation: parseOptionalText('operation', operation, FILTER_MAX_CHARS),
      status: parseEnumParam('status', status, STATUSES),
      q: parseOptionalText('q', q, SEARCH_MAX_CHARS),
    };
    const paging = {
      page: parsePositiveInt('page', page, 1),
      pageSize: parsePositiveInt(
        'pageSize',
        pageSize,
        CALLS_PAGE_SIZE_DEFAULT,
        CALLS_PAGE_SIZE_MAX,
      ),
    };
    const user = req.user as AuthUser;
    const { scope } = await this.resolveReadScope(
      user,
      repoId,
      teamId,
      sessionId,
    );

    const result = await loadCalls(this.db, scope, range, filters, paging);
    return {
      total: result.total,
      page: paging.page,
      pageSize: paging.pageSize,
      items: result.rows.map((row) =>
        toToolCallListItem(
          row,
          maskOwnerEmail(scope.teamScope, user.id, row.ownerId, row.ownerEmail),
        ),
      ),
    };
  }

  /**
   * One call with its captured text (DD-9, DD-25) and the deep link into the session (DD-19).
   * 404 when the row or call is missing, the tree is not in this repository's scope, or the
   * session is not visible to the caller (`assertSessionVisible`, answered as 404 here).
   */
  @Get(':repoId/tool-monitoring/calls/:usageId/:callId')
  async getCallDetail(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('usageId', ParseIntPipe) usageId: number,
    @Param('callId') callId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<ToolCallDetailResponse> {
    assertTeamId(teamId);
    if (usageId <= 0) {
      throw new BadRequestException('usageId must be a positive integer');
    }
    if (callId.length === 0 || callId.length > FILTER_MAX_CHARS) {
      throw new BadRequestException('callId is invalid');
    }
    const user = req.user as AuthUser;
    const { scope } = await this.resolveReadScope(user, repoId, teamId);

    const detail = await loadCallDetail(
      this.db,
      usageId,
      callId,
      scope.repoIds,
    );
    if (detail === null) {
      throw new NotFoundException('Tool call not found');
    }
    try {
      await this.repositoriesService.assertSessionVisible(
        user,
        scope.teamScope,
        detail.nodeRowId,
      );
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw new NotFoundException('Tool call not found');
      }
      throw err;
    }
    // The row filter of the read scope also applies to the tree root's uploader.
    const visibleUserIds = scope.teamScope.visibleUserIds;
    if (
      visibleUserIds !== null &&
      (detail.ownerId === null || !visibleUserIds.includes(detail.ownerId))
    ) {
      throw new NotFoundException('Tool call not found');
    }

    return {
      call: {
        ...detail.call,
        usageId: detail.usageId,
        sessionId: detail.sessionId,
        rootSessionId: detail.rootSessionId,
        sessionOwner: {
          id: detail.ownerId ?? 0,
          email: maskOwnerEmail(
            scope.teamScope,
            user.id,
            detail.ownerId,
            detail.ownerEmail,
          ),
        },
      },
      output: detail.output,
      link: {
        sessionId: detail.rootSessionId,
        toolUseId: detail.call.toolUseId ?? null,
      },
    };
  }
}

/**
 * Masks another member's e-mail for a `team-no-prompts` caller (a `manager` in a `restricted`
 * team), with the `maskFirstPrompt` rules: the caller's own rows are never masked, a row whose
 * owner is unknown is masked rather than leaked.
 */
function maskOwnerEmail(
  scope: TeamScope,
  requesterUserId: number,
  ownerId: number | null,
  email: string | null,
): string | null {
  return maskFirstPrompt(scope, requesterUserId, ownerId, email);
}
