/**
 * Budget and Spend routes (2026-11-05 budgets-threshold-alerts). Two controllers over one set of
 * services, one per scope family (DD-2):
 *
 * - `api/v1/repositories/:repoId/...` — the personal `repo` scope, or the `team-repo` scope with
 *   `?teamId=T`;
 * - `api/v1/teams/:teamId/...` — the whole-team `team` scope.
 *
 * Access is resolved once per request by `BudgetAccessService` (`ScopeAccess`): mutating routes
 * need `canManage` (owner, or team owner / manager), the budgets list, the event log and
 * `spend/sessions` need `fullView`; `spend` answers every member, with the DD-9 restricted view
 * for a caller without `fullView`. Literal segments (`budgets/events`, `spend/sessions`) are
 * declared before `budgets/:budgetId`.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../../auth/guards/session-auth.guard';
import type { AuthUser } from '../repositories.service';
import { BudgetAccessService } from './budget-access.service';
import {
  assertPositiveTeamId,
  parseSpendPeriodQuery,
  parseSpendSessionsSlice,
} from './budget-query';
import type { ScopeAccess } from './budget-scope';
import { BudgetsService, type BudgetEventsPage } from './budgets.service';
import type {
  BudgetDto,
  SpendSessionsResult,
  SpendView,
} from './budgets.types';
import { SpendService } from './spend.service';

interface SpendRawQuery {
  period?: string;
  offset?: string;
  tz?: string;
}

interface SpendSessionsRawQuery extends SpendRawQuery {
  slice?: string;
  key?: string;
}

interface BudgetsListResponse {
  budgets: BudgetDto[];
  canManage: boolean;
}

/** The scope-independent half of every route: given a resolved `ScopeAccess`, do the work. */
class BudgetRoutes {
  constructor(
    private readonly access: BudgetAccessService,
    private readonly budgets: BudgetsService,
    private readonly spend: SpendService,
  ) {}

  async list(access: ScopeAccess): Promise<BudgetsListResponse> {
    this.access.assertFullView(access);
    return {
      budgets: await this.budgets.list(access.scope),
      canManage: access.canManage,
    };
  }

  create(
    access: ScopeAccess,
    user: AuthUser,
    body: unknown,
  ): Promise<BudgetDto> {
    this.access.assertCanManage(access);
    return this.budgets.create(access, user, body);
  }

  update(
    access: ScopeAccess,
    user: AuthUser,
    budgetId: number,
    body: unknown,
  ): Promise<BudgetDto> {
    this.access.assertCanManage(access);
    return this.budgets.update(access, user, budgetId, body);
  }

  async remove(
    access: ScopeAccess,
    user: AuthUser,
    budgetId: number,
  ): Promise<void> {
    this.access.assertCanManage(access);
    await this.budgets.delete(access, user, budgetId);
  }

  events(
    access: ScopeAccess,
    q: { budgetId?: number; event?: string; before?: number; limit?: number },
  ): Promise<BudgetEventsPage> {
    this.access.assertFullView(access);
    return this.budgets.listEvents(access.scope, {
      budgetId: q.budgetId,
      event: q.event === '' ? undefined : q.event,
      before: q.before,
      limit: q.limit,
    });
  }

  spendView(
    access: ScopeAccess,
    user: AuthUser,
    raw: SpendRawQuery,
  ): Promise<SpendView> {
    return this.spend.getSpendView(access, user.id, parseSpendPeriodQuery(raw));
  }

  spendSessions(
    access: ScopeAccess,
    user: AuthUser,
    raw: SpendSessionsRawQuery,
  ): Promise<SpendSessionsResult> {
    this.access.assertFullView(access);
    return this.spend.getSpendSessions(access, user.id, {
      ...parseSpendPeriodQuery(raw),
      slice: parseSpendSessionsSlice(raw.slice),
      key: raw.key ?? '',
    });
  }
}

@Controller('api/v1/repositories')
@UseGuards(SessionAuthGuard)
export class RepositoryBudgetsController {
  private readonly routes: BudgetRoutes;

  constructor(
    private readonly budgetAccess: BudgetAccessService,
    budgetsService: BudgetsService,
    spendService: SpendService,
  ) {
    this.routes = new BudgetRoutes(budgetAccess, budgetsService, spendService);
  }

  private resolve(
    req: Request,
    repoId: number,
    teamId: number | undefined,
  ): Promise<ScopeAccess> {
    assertPositiveTeamId(teamId);
    return this.budgetAccess.resolveRepoScope(
      req.user as AuthUser,
      repoId,
      teamId,
    );
  }

  @Get(':repoId/budgets')
  async listBudgets(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<BudgetsListResponse> {
    return this.routes.list(await this.resolve(req, repoId, teamId));
  }

  @Get(':repoId/budgets/events')
  async listBudgetEvents(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('budgetId', new ParseIntPipe({ optional: true })) budgetId?: number,
    @Query('event') event?: string,
    @Query('before', new ParseIntPipe({ optional: true })) before?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<BudgetEventsPage> {
    return this.routes.events(await this.resolve(req, repoId, teamId), {
      budgetId,
      event,
      before,
      limit,
    });
  }

  @Post(':repoId/budgets')
  async createBudget(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Body() body: unknown,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<BudgetDto> {
    const access = await this.resolve(req, repoId, teamId);
    return this.routes.create(access, req.user as AuthUser, body);
  }

  @Put(':repoId/budgets/:budgetId')
  async updateBudget(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('budgetId', ParseIntPipe) budgetId: number,
    @Body() body: unknown,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<BudgetDto> {
    const access = await this.resolve(req, repoId, teamId);
    return this.routes.update(access, req.user as AuthUser, budgetId, body);
  }

  @Delete(':repoId/budgets/:budgetId')
  @HttpCode(204)
  async deleteBudget(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('budgetId', ParseIntPipe) budgetId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<void> {
    const access = await this.resolve(req, repoId, teamId);
    await this.routes.remove(access, req.user as AuthUser, budgetId);
  }

  @Get(':repoId/spend/sessions')
  async getSpendSessions(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query() raw: SpendSessionsRawQuery,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<SpendSessionsResult> {
    const access = await this.resolve(req, repoId, teamId);
    return this.routes.spendSessions(access, req.user as AuthUser, raw);
  }

  @Get(':repoId/spend')
  async getSpend(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query() raw: SpendRawQuery,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<SpendView> {
    const access = await this.resolve(req, repoId, teamId);
    return this.routes.spendView(access, req.user as AuthUser, raw);
  }
}

@Controller('api/v1/teams')
@UseGuards(SessionAuthGuard)
export class TeamBudgetsController {
  private readonly routes: BudgetRoutes;

  constructor(
    private readonly budgetAccess: BudgetAccessService,
    budgetsService: BudgetsService,
    spendService: SpendService,
  ) {
    this.routes = new BudgetRoutes(budgetAccess, budgetsService, spendService);
  }

  private resolve(req: Request, teamId: number): Promise<ScopeAccess> {
    return this.budgetAccess.resolveTeamScope(req.user as AuthUser, teamId);
  }

  @Get(':teamId/budgets')
  async listBudgets(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
  ): Promise<BudgetsListResponse> {
    return this.routes.list(await this.resolve(req, teamId));
  }

  @Get(':teamId/budgets/events')
  async listBudgetEvents(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Query('budgetId', new ParseIntPipe({ optional: true })) budgetId?: number,
    @Query('event') event?: string,
    @Query('before', new ParseIntPipe({ optional: true })) before?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<BudgetEventsPage> {
    return this.routes.events(await this.resolve(req, teamId), {
      budgetId,
      event,
      before,
      limit,
    });
  }

  @Post(':teamId/budgets')
  async createBudget(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() body: unknown,
  ): Promise<BudgetDto> {
    const access = await this.resolve(req, teamId);
    return this.routes.create(access, req.user as AuthUser, body);
  }

  @Put(':teamId/budgets/:budgetId')
  async updateBudget(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('budgetId', ParseIntPipe) budgetId: number,
    @Body() body: unknown,
  ): Promise<BudgetDto> {
    const access = await this.resolve(req, teamId);
    return this.routes.update(access, req.user as AuthUser, budgetId, body);
  }

  @Delete(':teamId/budgets/:budgetId')
  @HttpCode(204)
  async deleteBudget(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Param('budgetId', ParseIntPipe) budgetId: number,
  ): Promise<void> {
    const access = await this.resolve(req, teamId);
    await this.routes.remove(access, req.user as AuthUser, budgetId);
  }

  @Get(':teamId/spend/sessions')
  async getSpendSessions(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Query() raw: SpendSessionsRawQuery,
  ): Promise<SpendSessionsResult> {
    const access = await this.resolve(req, teamId);
    return this.routes.spendSessions(access, req.user as AuthUser, raw);
  }

  @Get(':teamId/spend')
  async getSpend(
    @Req() req: Request,
    @Param('teamId', ParseIntPipe) teamId: number,
    @Query() raw: SpendRawQuery,
  ): Promise<SpendView> {
    const access = await this.resolve(req, teamId);
    return this.routes.spendView(access, req.user as AuthUser, raw);
  }
}
