import { inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { sessionCosts } from '../../database/schema/index';
import type { PricingTier } from '../../model-pricing/model-pricing.types';
import {
  computeSessionCostBreakdown,
  pricingAsOfSql,
  sessionPriceDateSql,
  type SessionCallTokens,
} from '../cost.sql';
import { descendantSessionsCte, topAncestorIdsSql } from '../session-tree.sql';

/**
 * The sole writer of `session_costs` outside migration 0074's backfill: each session's
 * cost, stored once so every reader shows the same number (see `cost.sql.ts`).
 *
 * - Ingest (upload, import merge, recompute-all) calls {@link recomputeSessionCosts} for the
 *   session right after its `session_stats` / `session_call_tokens` writes, in the same
 *   transaction.
 * - Pricing writes flag rows `stale` (`model-pricing/session-cost-invalidation.ts`) and the
 *   sweeper (`SessionCostRecomputeService`) runs {@link drainStaleSessionCosts}.
 */

/** Rows claimed per sweeper transaction. */
export const SESSION_COST_RECOMPUTE_BATCH = 500;

/** Rows per `session_costs` upsert — 18 columns each, well under the bind-parameter cap. */
const UPSERT_BATCH = 1000;

type NumericLike = number | string | null;

interface RecomputeRow {
  session_id: number | string;
  model: string | null;
  input_tokens: NumericLike;
  output_tokens: NumericLike;
  cache_read_tokens: NumericLike;
  cache_write_5m_tokens: NumericLike;
  cache_write_1h_tokens: NumericLike;
  web_search_requests: NumericLike;
  input_tokens_fast: NumericLike;
  output_tokens_fast: NumericLike;
  calls: SessionCallTokens | null;
  price_date: string;
  old_price_date: string | null;
  had_row: boolean;
  p_model_id: string | null;
  price_in: NumericLike;
  price_out: NumericLike;
  price_cache_r: NumericLike;
  price_cache_w_5m: NumericLike;
  price_cache_w_1h: NumericLike;
  price_web_search: NumericLike;
  tiers: PricingTier[] | null;
  effective_from: string | null;
  source: string | null;
}

function idsArraySql(ids: number[]) {
  return sql`${`{${ids.join(',')}}`}::bigint[]`;
}

/**
 * Recomputes and upserts the `session_costs` rows of the given `sessions.id`s
 * (`stale = false`). Bulk-loads `session_stats`, `session_call_tokens`, each session's top
 * ancestor price date (DD6) and the `model_pricing` row in force at that date, prices
 * every session with {@link computeSessionCostBreakdown}, and writes the result.
 *
 * - A session without a `session_stats` row has nothing to price: any row it has is
 *   deleted (a missing row reads as unpriced), which also keeps a stale orphan from being
 *   claimed by the sweeper forever.
 * - When a row is new or its `price_date` changed, every descendant session's row is
 *   flagged `stale` so the sweeper re-prices it at the new top date.
 *
 * Runs on the caller's handle; pass a transaction to keep it atomic with the ingest write.
 */
export async function recomputeSessionCosts(
  db: DrizzleDb,
  ids: number[],
): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const idsArray = idsArraySql(unique);

  const result = await db.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(idsArray)},
    top_dates AS (
      SELECT t.top_id, ${sessionPriceDateSql(sql`t.top_id`)} AS price_date
      FROM (SELECT DISTINCT top_id FROM top_ancestors) t
    )
    SELECT ss.session_id,
           ss.model,
           ss.input_tokens, ss.output_tokens, ss.cache_read_tokens,
           ss.cache_write_5m_tokens, ss.cache_write_1h_tokens, ss.web_search_requests,
           ss.input_tokens_fast, ss.output_tokens_fast,
           sct.calls,
           td.price_date::text      AS price_date,
           old.price_date::text     AS old_price_date,
           (old.session_id IS NOT NULL) AS had_row,
           p.model_id               AS p_model_id,
           p.price_in, p.price_out, p.price_cache_r,
           p.price_cache_w_5m, p.price_cache_w_1h, p.price_web_search,
           p.tiers,
           p.effective_from::text   AS effective_from,
           p.source
      FROM session_stats ss
      JOIN top_ancestors ta ON ta.id = ss.session_id
      JOIN top_dates td ON td.top_id = ta.top_id
      LEFT JOIN session_call_tokens sct ON sct.session_id = ss.session_id
      LEFT JOIN session_costs old ON old.session_id = ss.session_id
      LEFT JOIN LATERAL (
        ${pricingAsOfSql(sql`ss.model`, sql`td.price_date`)}
      ) p ON true
     WHERE ss.session_id = ANY(${idsArray})
  `);
  const rows = result.rows as unknown as RecomputeRow[];

  const priced = new Set(rows.map((r) => Number(r.session_id)));
  const orphans = unique.filter((id) => !priced.has(id));
  if (orphans.length > 0) {
    await db
      .delete(sessionCosts)
      .where(inArray(sessionCosts.sessionId, orphans));
  }
  if (rows.length === 0) return;

  const now = new Date();
  const values = rows.map((r) => {
    const breakdown =
      r.p_model_id === null
        ? null
        : computeSessionCostBreakdown(
            {
              inputTokens: r.input_tokens,
              outputTokens: r.output_tokens,
              cacheReadTokens: r.cache_read_tokens,
              cacheWrite5mTokens: r.cache_write_5m_tokens,
              cacheWrite1hTokens: r.cache_write_1h_tokens,
              webSearchRequests: r.web_search_requests,
              inputTokensFast: r.input_tokens_fast,
              outputTokensFast: r.output_tokens_fast,
              calls: r.calls,
            },
            {
              priceIn: r.price_in,
              priceOut: r.price_out,
              priceCacheR: r.price_cache_r,
              priceCacheW5m: r.price_cache_w_5m,
              priceCacheW1h: r.price_cache_w_1h,
              priceWebSearch: r.price_web_search,
              tiers: r.tiers,
            },
          );
    // Same normalisation as pricingAsOfSql: strip a -YYYYMMDD snapshot suffix.
    const modelId = (r.model ?? '').replace(/-[0-9]{8}$/, '') || null;
    return {
      sessionId: Number(r.session_id),
      modelId,
      priceDate: r.price_date,
      pricingEffectiveFrom: breakdown ? r.effective_from : null,
      pricingSource: breakdown ? r.source : null,
      cost: breakdown?.cost ?? null,
      costInput: breakdown?.terms.input ?? null,
      costOutput: breakdown?.terms.output ?? null,
      costCacheRead: breakdown?.terms.cacheRead ?? null,
      costCacheWrite5m: breakdown?.terms.cacheWrite5m ?? null,
      costCacheWrite1h: breakdown?.terms.cacheWrite1h ?? null,
      costWebSearch: breakdown?.terms.webSearch ?? null,
      costFastSurcharge: breakdown?.terms.fastSurcharge ?? null,
      costTierDelta: breakdown?.tierDelta ?? null,
      unavailableReason: breakdown ? null : 'unknown-model',
      stale: false,
      computedAt: now,
    };
  });

  for (let i = 0; i < values.length; i += UPSERT_BATCH) {
    await db
      .insert(sessionCosts)
      .values(values.slice(i, i + UPSERT_BATCH))
      .onConflictDoUpdate({
        target: sessionCosts.sessionId,
        set: {
          modelId: sql`excluded.model_id`,
          priceDate: sql`excluded.price_date`,
          pricingEffectiveFrom: sql`excluded.pricing_effective_from`,
          pricingSource: sql`excluded.pricing_source`,
          cost: sql`excluded.cost`,
          costInput: sql`excluded.cost_input`,
          costOutput: sql`excluded.cost_output`,
          costCacheRead: sql`excluded.cost_cache_read`,
          costCacheWrite5m: sql`excluded.cost_cache_write_5m`,
          costCacheWrite1h: sql`excluded.cost_cache_write_1h`,
          costWebSearch: sql`excluded.cost_web_search`,
          costFastSurcharge: sql`excluded.cost_fast_surcharge`,
          costTierDelta: sql`excluded.cost_tier_delta`,
          unavailableReason: sql`excluded.unavailable_reason`,
          stale: false,
          computedAt: sql`excluded.computed_at`,
        },
      });
  }

  // DD7 tree trigger: a new row or a moved price date re-prices the whole subtree.
  const moved = rows
    .filter((r) => !r.had_row || r.old_price_date !== r.price_date)
    .map((r) => Number(r.session_id));
  if (moved.length > 0) {
    await db.execute(sql`
      WITH RECURSIVE ${descendantSessionsCte(idsArraySql(moved))}
      UPDATE session_costs
         SET stale = true
       WHERE NOT stale
         AND session_id IN (SELECT id FROM descendant_sessions WHERE depth > 0)
         AND session_id <> ALL(${idsArray})
    `);
  }
}

/**
 * Recomputes every `stale` `session_costs` row, {@link SESSION_COST_RECOMPUTE_BATCH} at a
 * time. Each batch claims its rows with `FOR UPDATE SKIP LOCKED` in its own transaction,
 * so concurrent drains (other cluster workers, an inline notify) never block on or
 * double-process each other. Loops until a batch finds nothing to claim — which also picks up
 * descendants that the batch itself flagged.
 *
 * @returns the number of rows recomputed.
 */
export async function drainStaleSessionCosts(db: DrizzleDb): Promise<number> {
  let total = 0;
  for (;;) {
    const claimed = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT session_id FROM session_costs
         WHERE stale
         ORDER BY session_id
         LIMIT ${SESSION_COST_RECOMPUTE_BATCH}
         FOR UPDATE SKIP LOCKED
      `);
      const ids = (result.rows as { session_id: number | string }[]).map((r) =>
        Number(r.session_id),
      );
      if (ids.length > 0) {
        await recomputeSessionCosts(tx, ids);
      }
      return ids.length;
    });
    if (claimed === 0) return total;
    total += claimed;
  }
}
