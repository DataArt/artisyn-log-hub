import { Logger } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';

/**
 * Pricing-side half of the stored session-cost machinery (`session_costs`).
 *
 * `model-pricing/` must never import from `logs/`, yet every pricing write has to flag the
 * stored costs it invalidates and wake the recompute sweeper. So this file holds only:
 * - {@link markModelSessionsStale} — raw SQL on `session_costs`, no `logs/` helpers;
 * - a one-slot drain-handler registry, filled by `SessionCostRecomputeService` (in
 *   `logs/session-cost/`) when its module initialises;
 * - {@link notifySessionCostsStale}, which pricing writers call after their transaction
 *   commits.
 */

const logger = new Logger('SessionCostInvalidation');

/**
 * Flags as `stale` every stored session cost that a `model_pricing` row of `modelId`
 * effective from `effectiveFrom` now prices: same model, `price_date >= effectiveFrom`, and
 * no other row of the model taking effect in `(effectiveFrom, price_date]` (which would
 * still be the one in force at that date). Rows already stale are left alone.
 *
 * Runs on the caller's handle, so inside the pricing transaction it commits or rolls back
 * with the price write.
 *
 * @param effectiveFrom `YYYY-MM-DD` string, or a SQL `date` expression (e.g. `CURRENT_DATE`).
 * @returns the number of rows newly flagged.
 */
export async function markModelSessionsStale(
  db: DrizzleDb,
  modelId: string,
  effectiveFrom: string | SQL,
): Promise<number> {
  const from =
    typeof effectiveFrom === 'string'
      ? sql`${effectiveFrom}::date`
      : sql`(${effectiveFrom})::date`;
  const result = await db.execute(sql`
    UPDATE session_costs sc
       SET stale = true
     WHERE sc.model_id = ${modelId}
       AND sc.price_date >= ${from}
       AND NOT sc.stale
       AND NOT EXISTS (
         SELECT 1 FROM model_pricing mp
          WHERE mp.model_id = ${modelId}
            AND mp.effective_from > ${from}
            AND mp.effective_from <= sc.price_date
       )
  `);
  return result.rowCount ?? 0;
}

/** Drains every stale `session_costs` row; registered by `SessionCostRecomputeService`. */
export type SessionCostDrainHandler = () => Promise<unknown>;

let drainHandler: SessionCostDrainHandler | null = null;

/**
 * Installs (or, with `null`, removes) the handler {@link notifySessionCostsStale} runs.
 * One slot: the latest registration wins.
 */
export function registerSessionCostDrainHandler(
  fn: SessionCostDrainHandler | null,
): void {
  drainHandler = fn;
}

/**
 * Signals that stored session costs were flagged stale. Call it after the flagging
 * transaction has committed — the sweeper reads committed rows only.
 *
 * - `SESSION_COST_RECOMPUTE_INLINE=true` (contract stand): awaits the drain, so the costs are
 *   fresh by the time the caller responds.
 * - Otherwise: starts the drain without awaiting it; the periodic sweep is the backstop.
 * - No handler registered: does nothing.
 *
 * Never throws: the pricing write has already committed, so a drain failure is logged and the
 * rows stay stale for the next sweep.
 */
export async function notifySessionCostsStale(): Promise<void> {
  const handler = drainHandler;
  if (handler === null) return;
  const run = handler().catch((err: unknown) => {
    logger.error(
      `Session cost drain failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  });
  if (process.env.SESSION_COST_RECOMPUTE_INLINE === 'true') {
    await run;
  }
}
