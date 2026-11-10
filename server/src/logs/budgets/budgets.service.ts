/**
 * Budget CRUD and the budget event log (2026-11-05 budgets-threshold-alerts, DD-11 / DD-12 /
 * DD-21). Access checks (`canManage` / `fullView`) are the caller's job via
 * `BudgetAccessService`; this service only ever touches rows of the scope it is given, so an id
 * outside the scope is a 404.
 *
 * Every change writes its `created` / `edited` / `deleted` event in the same transaction as the
 * change itself, with the acting user and their email snapshot.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { budgetEvents, budgets, users } from '../../database/schema';
import type { AuthUser } from '../repositories.service';
import { BUDGET_EVENTS_PAGE } from './budget.constants';
import { insertBudgetEvent } from './budget-events.sql';
import {
  budgetRowToDto,
  budgetSnapshot,
  scopeColumns,
  validateBudgetInput,
  type BudgetScope,
  type ScopeAccess,
} from './budget-scope';
import type {
  BudgetDto,
  BudgetEventDto,
  BudgetEventType,
  BudgetInput,
  BudgetRow,
  PeriodBounds,
} from './budgets.types';
import { loadPeriodBounds, loadScopeBudgets } from './spend-read.sql';

/** Every `budget_events.event_type` (DD-11), for the `event` filter. */
export const BUDGET_EVENT_TYPES: readonly BudgetEventType[] = [
  'created',
  'edited',
  'deleted',
  'threshold_crossed',
  'threshold_superseded',
  'email_sent',
  'email_skipped',
  'email_failed',
];

function isBudgetEventType(value: string): value is BudgetEventType {
  return (BUDGET_EVENT_TYPES as readonly string[]).includes(value);
}

export interface BudgetEventsQuery {
  budgetId?: number;
  event?: string;
  /** Return events with an id below this one (the previous page's `nextBefore`). */
  before?: number;
  limit?: number;
}

export interface BudgetEventsPage {
  items: BudgetEventDto[];
  nextBefore: number | null;
}

/** True for a Postgres unique violation, also when Drizzle wraps it (`cause`). */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e['code'] === '23505') return true;
  if (e['cause'] !== undefined) return isUniqueViolation(e['cause']);
  return false;
}

function duplicatePeriod(input: BudgetInput): ConflictException {
  return new ConflictException(
    `A ${input.period} budget already exists for this scope`,
  );
}

/** The `budgets` WHERE of a scope. */
function budgetScopeWhere(scope: BudgetScope): SQL | undefined {
  const c = scopeColumns(scope);
  return and(
    eq(budgets.scopeKind, c.scopeKind),
    c.userId === null ? isNull(budgets.userId) : eq(budgets.userId, c.userId),
    c.teamId === null ? isNull(budgets.teamId) : eq(budgets.teamId, c.teamId),
    c.repoUrl === null
      ? isNull(budgets.repoUrl)
      : eq(budgets.repoUrl, c.repoUrl),
  );
}

/** The `budget_events` WHERE of a scope (its snapshot scope columns). */
function eventScopeWhere(scope: BudgetScope): SQL | undefined {
  const c = scopeColumns(scope);
  return and(
    eq(budgetEvents.scopeKind, c.scopeKind),
    c.userId === null
      ? isNull(budgetEvents.userId)
      : eq(budgetEvents.userId, c.userId),
    c.teamId === null
      ? isNull(budgetEvents.teamId)
      : eq(budgetEvents.teamId, c.teamId),
    c.repoUrl === null
      ? isNull(budgetEvents.repoUrl)
      : eq(budgetEvents.repoUrl, c.repoUrl),
  );
}

function toAmountMicros(amountUsd: number): number {
  return Math.round(amountUsd * 1e6);
}

@Injectable()
export class BudgetsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** A budget row as the API returns it (DD-21); `bounds` = its current period, if known. */
  toDto(row: BudgetRow, bounds?: PeriodBounds): BudgetDto {
    return budgetRowToDto(row, bounds);
  }

  /** The scope's budgets, each with its current period in its own time zone. */
  async list(scope: BudgetScope): Promise<BudgetDto[]> {
    const rows = await loadScopeBudgets(this.db, scope);
    return Promise.all(rows.map((row) => this.withCurrentPeriod(row)));
  }

  /** Creates a budget (DD-12): 400 on invalid input, 409 when the period already has one. */
  async create(
    access: ScopeAccess,
    user: AuthUser,
    body: unknown,
  ): Promise<BudgetDto> {
    const input = validateBudgetInput(body);
    const actor = await this.actorOf(user);
    let created: BudgetRow;
    try {
      created = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(budgets)
          .values({
            ...scopeColumns(access.scope),
            period: input.period,
            amountMicros: toAmountMicros(input.amountUsd),
            thresholds: input.thresholds,
            timeZone: input.timeZone,
            createdBy: user.id,
          })
          .returning();
        await insertBudgetEvent(tx, {
          budget: row,
          eventType: 'created',
          details: { after: budgetSnapshot(row) },
          actor,
        });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicatePeriod(input);
      throw err;
    }
    return this.withCurrentPeriod(created);
  }

  /** Replaces a budget's settings: 404 outside the scope, 409 on a duplicate period. */
  async update(
    access: ScopeAccess,
    user: AuthUser,
    id: number,
    body: unknown,
  ): Promise<BudgetDto> {
    const input = validateBudgetInput(body);
    const actor = await this.actorOf(user);
    let updated: BudgetRow;
    try {
      updated = await this.db.transaction(async (tx) => {
        const before = await this.loadInScope(tx, access.scope, id);
        const [row] = await tx
          .update(budgets)
          .set({
            period: input.period,
            amountMicros: toAmountMicros(input.amountUsd),
            thresholds: input.thresholds,
            timeZone: input.timeZone,
            updatedAt: new Date(),
          })
          .where(eq(budgets.id, before.id))
          .returning();
        await insertBudgetEvent(tx, {
          budget: row,
          eventType: 'edited',
          details: {
            before: budgetSnapshot(before),
            after: budgetSnapshot(row),
          },
          actor,
        });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicatePeriod(input);
      throw err;
    }
    return this.withCurrentPeriod(updated);
  }

  /** Deletes a budget (404 outside the scope). Its notices and events keep their snapshots. */
  async delete(access: ScopeAccess, user: AuthUser, id: number): Promise<void> {
    const actor = await this.actorOf(user);
    await this.db.transaction(async (tx) => {
      const row = await this.loadInScope(tx, access.scope, id);
      // Written before the row goes, so it carries the budget id until SET NULL clears it.
      await insertBudgetEvent(tx, {
        budget: row,
        eventType: 'deleted',
        details: { before: budgetSnapshot(row) },
        actor,
      });
      await tx.delete(budgets).where(eq(budgets.id, row.id));
    });
  }

  /** The scope's event log, newest first, paged by id (`before`). */
  async listEvents(
    scope: BudgetScope,
    q: BudgetEventsQuery,
  ): Promise<BudgetEventsPage> {
    const limit = Math.min(
      BUDGET_EVENTS_PAGE.max,
      Math.max(1, Math.trunc(q.limit ?? BUDGET_EVENTS_PAGE.default)),
    );
    if (q.event !== undefined && !isBudgetEventType(q.event)) {
      throw new BadRequestException(
        `event must be one of ${BUDGET_EVENT_TYPES.join(', ')}`,
      );
    }
    const conditions: (SQL | undefined)[] = [eventScopeWhere(scope)];
    if (q.budgetId !== undefined) {
      conditions.push(eq(budgetEvents.budgetId, q.budgetId));
    }
    if (q.event !== undefined && isBudgetEventType(q.event)) {
      conditions.push(eq(budgetEvents.eventType, q.event));
    }
    if (q.before !== undefined) {
      conditions.push(lt(budgetEvents.id, q.before));
    }

    const rows = await this.db
      .select()
      .from(budgetEvents)
      .where(and(...conditions))
      .orderBy(desc(budgetEvents.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actorEmail: r.actorEmail,
        budgetId: r.budgetId,
        budgetLabel: r.budgetLabel,
        budgetDeleted: r.budgetId === null,
        eventType: r.eventType,
        details: r.details,
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────

  private async withCurrentPeriod(row: BudgetRow): Promise<BudgetDto> {
    const bounds = await loadPeriodBounds(this.db, {
      period: row.period,
      tz: row.timeZone,
      offset: 0,
    });
    return this.toDto(row, bounds);
  }

  /** The budget `id` when it belongs to `scope`, locked for the change; 404 otherwise. */
  private async loadInScope(
    tx: DrizzleDb,
    scope: BudgetScope,
    id: number,
  ): Promise<BudgetRow> {
    const [row] = await tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.id, id), budgetScopeWhere(scope)))
      .for('update');
    if (!row) throw new NotFoundException('Budget not found');
    return row;
  }

  /** The acting user and their email snapshot (DD-11). */
  private async actorOf(
    user: AuthUser,
  ): Promise<{ userId: number; email: string }> {
    const [row] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, user.id));
    return { userId: user.id, email: row?.email ?? '' };
  }
}
