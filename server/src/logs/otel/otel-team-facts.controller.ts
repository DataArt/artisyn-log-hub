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
import {
  enumParam,
  parseRepoOtelFactsQuery,
  repeatable,
  type RawQuery,
} from './otel-facts.controller';
import { OtelFactsReader } from './otel-facts.reader';
import type {
  TeamOtelFactsQuery,
  TeamOtelFactsResponse,
  TeamOtelStackBy,
} from './otel-facts.types';

const TEAM_STACK_BY: readonly TeamOtelStackBy[] = [
  'person',
  'repository',
  'structure',
  'model',
  'querySource',
];

/** A repeatable positive-integer filter (`repoId`, `userId`); anything else is a 400. */
function idList(raw: RawQuery, name: string): number[] {
  return repeatable(raw, name).map((value) => {
    const id = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id <= 0) {
      throw new BadRequestException(`${name} values must be positive integers`);
    }
    return id;
  });
}

/**
 * The team facts query (API changes, DD-29): the repository facts' parameters plus `repoId[]`,
 * `userId[]` and the team `stackBy` (default `person`). The repository route's own `stackBy`
 * and `teamId` are not part of it (the team is in the path).
 */
export function parseTeamOtelFactsQuery(raw: RawQuery): TeamOtelFactsQuery {
  const stackBy = enumParam(raw, 'stackBy', TEAM_STACK_BY, 'person');
  const repoQuery = parseRepoOtelFactsQuery({
    ...raw,
    stackBy: undefined,
    teamId: undefined,
  });
  return {
    from: repoQuery.from,
    to: repoQuery.to,
    models: repoQuery.models,
    ccVersions: repoQuery.ccVersions,
    calls: repoQuery.calls,
    interval: repoQuery.interval,
    tz: repoQuery.tz,
    repoIds: idList(raw, 'repoId'),
    userIds: idList(raw, 'userId'),
    stackBy,
  };
}

/**
 * The team OTEL tab route (2026-10-30 otel-tabs-traces, DD-29). Cookie-session auth; no GET
 * mutates anything.
 *
 * `GET :teamId/otel/facts` — every team repository's OTEL facts over the DISTINCT scoped roots.
 * 403 for a non-member and when the caller's team scope does not allow analytics (FR-34, the
 * gate of `usage-analytics.controller.ts`): in a `restricted` team only the owner and managers
 * pass, in a `transparent` team every member does.
 */
@Controller('api/v1/teams')
@UseGuards(SessionAuthGuard)
export class OtelTeamFactsController {
  constructor(
    private readonly repositoriesService: RepositoriesService,
    private readonly reader: OtelFactsReader,
  ) {}

  @Get(':teamId/otel/facts')
  async getTeamOtelFacts(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Query() raw: RawQuery,
  ): Promise<TeamOtelFactsResponse> {
    const query = parseTeamOtelFactsQuery(raw);
    const user = req.user as AuthUser;
    if (!(await this.reader.isTeamMember(teamId, user.id))) {
      throw new ForbiddenException();
    }
    const teamScope = await this.repositoriesService.resolveTeamScope(
      user,
      teamId,
    );
    if (!teamScope.analyticsAllowed) {
      throw new ForbiddenException();
    }
    return this.reader.getTeamOtelFacts({ teamId, teamScope, query });
  }
}
