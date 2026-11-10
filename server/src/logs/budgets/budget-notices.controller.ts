/**
 * The caller's budget threshold notices (2026-11-05 budgets-threshold-alerts, DD-10 / DD-18):
 * the bell tray and the banner read `GET /api/v1/budget-notices`; read marking is POST only
 * (never a GET side effect) and touches only the caller's own recipient rows.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SessionAuthGuard } from '../../auth/guards/session-auth.guard';
import type { AuthUser } from '../repositories.service';
import { BUDGET_NOTICES_PAGE } from './budget.constants';
import {
  BudgetNoticesService,
  type BudgetNoticesPage,
  type MarkReadInput,
} from './budget-notices.service';

/** `{ids: number[]}` (at most 100 positive integers) or `{all: true}`; 400 otherwise. */
export function parseMarkReadBody(body: unknown): MarkReadInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException(
      'Body must be {ids: number[]} or {all: true}',
    );
  }
  const record = body as Record<string, unknown>;
  if (record['all'] === true) return { all: true };
  const ids = record['ids'];
  if (!Array.isArray(ids)) {
    throw new BadRequestException(
      'Body must be {ids: number[]} or {all: true}',
    );
  }
  if (ids.length > BUDGET_NOTICES_PAGE.max) {
    throw new BadRequestException(
      `ids may hold at most ${BUDGET_NOTICES_PAGE.max} values`,
    );
  }
  const parsed: number[] = [];
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new BadRequestException('ids must be positive integers');
    }
    parsed.push(id);
  }
  return { ids: parsed };
}

@Controller('api/v1/budget-notices')
@UseGuards(SessionAuthGuard)
export class BudgetNoticesController {
  constructor(private readonly notices: BudgetNoticesService) {}

  @Get()
  list(
    @Req() req: Request,
    @Query('before', new ParseIntPipe({ optional: true })) before?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ): Promise<BudgetNoticesPage> {
    const user = req.user as AuthUser;
    return this.notices.listForUser(user.id, { before, limit });
  }

  @Post('read')
  @HttpCode(200)
  markRead(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ unreadCount: number }> {
    const user = req.user as AuthUser;
    return this.notices.markRead(user.id, parseMarkReadBody(body));
  }
}
