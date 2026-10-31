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
import { RepositoriesService, type AuthUser } from '../repositories.service';
import type { TeamScope } from '../team-scope';
import { isValidOtelTimeZone } from './otel-classify';
import type { OtelReadScope } from './otel-facts-read.sql';
import { OTEL_MAX_PERIOD_DAYS } from './otel-facts.constants';
import { OtelFactsReader } from './otel-facts.reader';
import type {
  OtelCallsFilter,
  RepoOtelFactsQuery,
  RepoOtelFactsResponse,
  RepoOtelStackBy,
  SessionOtelQuery,
  SessionOtelResponse,
  SessionOtelStackBy,
} from './otel-facts.types';

const DAY_MS = 86_400_000;
const CALLS_FILTERS: readonly OtelCallsFilter[] = [
  'all',
  'hidden',
  'transcript',
];
const REPO_INTERVALS = ['auto', '5m', '1h', '1d'] as const;
const SESSION_INTERVALS = ['auto', '5m', '1h'] as const;
const REPO_STACK_BY: readonly RepoOtelStackBy[] = [
  'structure',
  'querySource',
  'model',
  'ccVersion',
];
const SESSION_STACK_BY: readonly SessionOtelStackBy[] = [
  'structure',
  'querySource',
  'model',
];
/** Upper bounds on free-text parameters. */
const TEXT_MAX_CHARS = 255;
const TZ_MAX_CHARS = 64;
const CURSOR_MAX_CHARS = 64;
/** Most values one repeatable filter (`model`, `ccVersion`) may carry. */
const FILTER_MAX_VALUES = 100;

export type RawQuery = Record<string, unknown>;

/** A single-valued query parameter (a repeated one is a 400). */
function single(raw: RawQuery, name: string): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${name} must be given once`);
  }
  return value;
}

/**
 * A repeatable filter: `name=a&name=b` (Express 5's simple parser gives a string or an array)
 * and the bracket form `name[]=a` are both accepted; empty values are ignored.
 */
export function repeatable(raw: RawQuery, name: string): string[] {
  const values: string[] = [];
  for (const key of [name, `${name}[]`]) {
    const value = raw[key];
    if (value === undefined) continue;
    const list = Array.isArray(value) ? (value as unknown[]) : [value];
    for (const item of list) {
      if (typeof item !== 'string') {
        throw new BadRequestException(`${name} must be a list of strings`);
      }
      if (item.length > TEXT_MAX_CHARS) {
        throw new BadRequestException(
          `${name} values must be at most ${TEXT_MAX_CHARS} characters`,
        );
      }
      if (item !== '') values.push(item);
    }
  }
  if (values.length > FILTER_MAX_VALUES) {
    throw new BadRequestException(
      `${name} takes at most ${FILTER_MAX_VALUES} values`,
    );
  }
  return [...new Set(values)];
}

export function enumParam<T extends string>(
  raw: RawQuery,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = single(raw, name);
  if (value === undefined || value === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(
      `${name} must be one of ${allowed.join(', ')}`,
    );
  }
  return value as T;
}

function requiredDate(raw: RawQuery, name: string): Date {
  const value = single(raw, name);
  if (value === undefined || value === '') {
    throw new BadRequestException(`${name} is required`);
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new BadRequestException(`${name} must be a valid ISO 8601 date`);
  }
  return date;
}

/** IANA time zone (DD-18): default `UTC`, an unknown name is a 400. */
function tzParam(raw: RawQuery): string {
  const value = single(raw, 'tz');
  if (value === undefined || value === '') return 'UTC';
  if (value.length > TZ_MAX_CHARS || !isValidOtelTimeZone(value)) {
    throw new BadRequestException('tz must be a valid IANA time zone name');
  }
  return value;
}

/** Optional positive `teamId` (as on the Tools/MCP routes). */
function teamIdParam(raw: RawQuery): number | undefined {
  const value = single(raw, 'teamId');
  if (value === undefined || value === '') return undefined;
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) {
    throw new BadRequestException('teamId must be a positive integer');
  }
  return id;
}

/** The repository facts query (API changes): validated before any access check. */
export function parseRepoOtelFactsQuery(raw: RawQuery): RepoOtelFactsQuery {
  const from = requiredDate(raw, 'from');
  const to = requiredDate(raw, 'to');
  if (to.getTime() <= from.getTime()) {
    throw new BadRequestException('to must be after from');
  }
  if (to.getTime() - from.getTime() > OTEL_MAX_PERIOD_DAYS * DAY_MS) {
    throw new BadRequestException(
      `the period must be at most ${OTEL_MAX_PERIOD_DAYS} days`,
    );
  }
  return {
    from,
    to,
    models: repeatable(raw, 'model'),
    ccVersions: repeatable(raw, 'ccVersion'),
    calls: enumParam(raw, 'calls', CALLS_FILTERS, 'all'),
    interval: enumParam(raw, 'interval', REPO_INTERVALS, 'auto'),
    stackBy: enumParam(raw, 'stackBy', REPO_STACK_BY, 'structure'),
    tz: tzParam(raw),
    teamId: teamIdParam(raw) ?? null,
  };
}

/** The session OTEL query (API changes). */
export function parseSessionOtelQuery(raw: RawQuery): SessionOtelQuery {
  const since = single(raw, 'since');
  if (since !== undefined && since.length > CURSOR_MAX_CHARS) {
    throw new BadRequestException(
      `since must be at most ${CURSOR_MAX_CHARS} characters`,
    );
  }
  return {
    interval: enumParam(raw, 'interval', SESSION_INTERVALS, 'auto'),
    stackBy: enumParam(raw, 'stackBy', SESSION_STACK_BY, 'structure'),
    tz: tzParam(raw),
    since: since === undefined || since === '' ? null : since,
    teamId: teamIdParam(raw) ?? null,
  };
}

/**
 * The OTEL tab routes of the repository and session views (2026-10-30 otel-tabs-traces, DD-6,
 * DD-19). Cookie-session auth; no GET mutates anything.
 *
 * - `GET :repoId/otel/facts` — the repository tab. With `teamId` (team context) it is refused
 *   with 403 when the caller's team scope does not allow analytics, the gate of
 *   `usage-analytics.controller.ts` (FR-34); without `teamId` (the personal view) there is no
 *   gate.
 * - `GET :repoId/sessions/:sessionId/otel` — the session tab, snapshot or `since=` delta. It
 *   follows the session's usual visibility (no analytics gate); a session outside the scope
 *   answers with an empty response, never 404.
 */
@Controller('api/v1/repositories')
@UseGuards(SessionAuthGuard)
export class OtelFactsController {
  constructor(
    private readonly repositoriesService: RepositoriesService,
    private readonly reader: OtelFactsReader,
  ) {}

  /**
   * The repo scope both routes resolve — a private copy of `ToolMonitoringController`'s
   * `resolveReadScope` (DD-6), calling the same three `RepositoriesService` methods:
   * `assertRepoAccess` 403s a repository the caller cannot reach, `resolveRepoIds` widens a team
   * view to every member's row for the URL, and `resolveTeamScope` gives the owner row filter
   * and the masking scope.
   */
  private async resolveReadScope(
    user: AuthUser,
    repoId: number,
    teamId: number | undefined,
  ): Promise<{ scope: OtelReadScope; teamScope: TeamScope }> {
    const repo = await this.repositoriesService.assertRepoAccess(
      user,
      repoId,
      teamId,
    );
    const [teamScope, repoIds] = await Promise.all([
      this.repositoriesService.resolveTeamScope(user, teamId),
      this.repositoriesService.resolveRepoIds(repoId, repo.repoUrl, teamId),
    ]);
    return { scope: { repoIds, teamScope }, teamScope };
  }

  @Get(':repoId/otel/facts')
  async getRepoOtelFacts(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query() raw: RawQuery,
  ): Promise<RepoOtelFactsResponse> {
    const query = parseRepoOtelFactsQuery(raw);
    const user = req.user as AuthUser;
    const teamId = query.teamId ?? undefined;
    const { scope, teamScope } = await this.resolveReadScope(
      user,
      repoId,
      teamId,
    );
    if (teamId !== undefined && !teamScope.analyticsAllowed) {
      throw new ForbiddenException();
    }
    return this.reader.getRepoOtelFacts({
      scope,
      query,
      requesterUserId: user.id,
    });
  }

  @Get(':repoId/sessions/:sessionId/otel')
  async getSessionOtel(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('sessionId') sessionId: string,
    @Query() raw: RawQuery,
  ): Promise<SessionOtelResponse> {
    if (sessionId.length === 0 || sessionId.length > TEXT_MAX_CHARS) {
      throw new BadRequestException('sessionId is invalid');
    }
    const query = parseSessionOtelQuery(raw);
    const user = req.user as AuthUser;
    const { scope } = await this.resolveReadScope(
      user,
      repoId,
      query.teamId ?? undefined,
    );
    return this.reader.getSessionOtel({
      scope,
      sessionId,
      query,
      requesterUserId: user.id,
    });
  }
}
