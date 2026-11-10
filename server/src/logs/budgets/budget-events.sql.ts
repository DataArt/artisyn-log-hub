/**
 * Budget event-log writes (2026-11-05 budgets-threshold-alerts, DD-11 / DD-21). Used by the CRUD
 * service (created / edited / deleted) and the threshold job (threshold_* / email_*).
 */
import type { DrizzleDb } from '../../database/database.module';
import { budgetEvents } from '../../database/schema';
import { budgetLabel } from './budget-scope';
import type { BudgetEventType, BudgetRow } from './budgets.types';

export interface BudgetEventInput {
  budget: BudgetRow;
  eventType: BudgetEventType;
  details: Record<string, unknown>;
  /** `null` = the system (threshold job). */
  actor: { userId: number; email: string } | null;
}

/**
 * Appends one `budget_events` row. The scope columns and `budget_label` are snapshots copied from
 * `budget`, so the row outlives the budget (`budget_id` is SET NULL on deletion). For `deleted`,
 * call this before removing the budget row, inside the same transaction.
 */
export async function insertBudgetEvent(
  tx: DrizzleDb,
  e: BudgetEventInput,
): Promise<void> {
  await tx.insert(budgetEvents).values({
    budgetId: e.budget.id,
    scopeKind: e.budget.scopeKind,
    userId: e.budget.userId,
    teamId: e.budget.teamId,
    repoUrl: e.budget.repoUrl,
    budgetLabel: budgetLabel(e.budget.period, e.budget.amountMicros),
    actorUserId: e.actor?.userId ?? null,
    actorEmail: e.actor?.email ?? null,
    eventType: e.eventType,
    details: e.details,
  });
}
