import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import {
  resolveSessionTotalCost,
  unpricedModelList,
  utilityCostsCte,
} from './otel-cost.sql';
import { descendantSessionsCte } from './session-tree.sql';

/**
 * The complete computed cost of a session tree, shared by every surface that shows a
 * session cost (sessions list and header, analytics timeline, executive summary,
 * attribution breakdown, turn-end advisor, delete-time audit row).
 *
 * The parts: the root's own stored cost (`session_costs.cost`), the stored costs of every
 * sub-agent that has a transcript, and the root's utility calls ({@link utilityCostsCte}).
 * {@link readTreeCost} turns one `tree_costs` row into those parts and the shown total
 * ({@link resolveSessionTotalCost}: complete, or `null` as soon as any part is unpriced).
 */

/**
 * Three CTEs (no `WITH RECURSIVE`, no trailing comma) over the given root ids:
 *
 * - `tree_subagent_costs(session_row_id, subagent_cost, subagent_count,
 *   subagent_pricing_missing, subagent_unpriced_models)` — the descendants (depth > 0) that
 *   have a `claude` / `claude-subagent` transcript; an OTEL-only `session_stats` row is not a
 *   sub-agent. A sub-agent is unpriced when its `session_costs` row has a NULL cost for a
 *   named model (a sub-agent without a model has no tokens to price); `subagent_count`
 *   counts those with a `session_stats` row.
 * - `utility_costs` — {@link utilityCostsCte}.
 * - `tree_costs(session_row_id, main_cost, main_model, subagent_cost, subagent_count,
 *   subagent_pricing_missing, subagent_unpriced_models, utility_cost,
 *   utility_pricing_missing, utility_unpriced_models)` — one row per root id.
 *   `main_cost` is NULL when the root is unpriced or has no `session_costs` row;
 *   `main_model` is the stored model id (snapshot suffix stripped).
 *
 * Requires `descendantSessionsCte(rootIdsArray)` earlier in the same `WITH RECURSIVE`.
 */
export function treeCostCtes(rootIdsArray: SQL): SQL {
  return sql`tree_subagent_costs AS (
    SELECT
      ds.root_id AS session_row_id,
      COALESCE(SUM(sub_sc.cost), 0.0)::float AS subagent_cost,
      COUNT(sub_ss.session_id) AS subagent_count,
      COALESCE(BOOL_OR(sub_sc.cost IS NULL AND sub_sc.model_id IS NOT NULL), false)
        AS subagent_pricing_missing,
      COALESCE(
        ARRAY_AGG(DISTINCT sub_sc.model_id::text)
          FILTER (WHERE sub_sc.cost IS NULL AND sub_sc.model_id IS NOT NULL),
        '{}'::text[]
      ) AS subagent_unpriced_models
    FROM descendant_sessions ds
    LEFT JOIN session_stats sub_ss ON sub_ss.session_id = ds.id
    LEFT JOIN session_costs sub_sc ON sub_sc.session_id = ds.id
    WHERE ds.depth > 0
      AND EXISTS (
        SELECT 1 FROM logs tl
        WHERE tl.session_id = ds.id AND tl.log_type IN ('claude', 'claude-subagent')
      )
    GROUP BY ds.root_id
  ),
  ${utilityCostsCte(rootIdsArray)},
  tree_costs AS (
    SELECT
      r.id AS session_row_id,
      sc.cost::float AS main_cost,
      sc.model_id::text AS main_model,
      COALESCE(tsc.subagent_cost, 0.0)::float AS subagent_cost,
      COALESCE(tsc.subagent_count, 0) AS subagent_count,
      COALESCE(tsc.subagent_pricing_missing, false) AS subagent_pricing_missing,
      COALESCE(tsc.subagent_unpriced_models, '{}'::text[]) AS subagent_unpriced_models,
      COALESCE(uc.utility_cost, 0.0)::float AS utility_cost,
      COALESCE(uc.utility_pricing_missing, false) AS utility_pricing_missing,
      COALESCE(uc.utility_unpriced_models, '{}'::text[]) AS utility_unpriced_models
    FROM sessions r
    LEFT JOIN session_costs sc ON sc.session_id = r.id
    LEFT JOIN tree_subagent_costs tsc ON tsc.session_row_id = r.id
    LEFT JOIN utility_costs uc ON uc.session_row_id = r.id
    WHERE r.id = ANY(${rootIdsArray})
  )`;
}

type NumericLike = number | string | null;

/** One `tree_costs` row as `db.execute` returns it. */
export interface TreeCostSqlRow {
  session_row_id: number | string;
  main_cost: NumericLike;
  main_model: string | null;
  subagent_cost: NumericLike;
  subagent_count: NumericLike;
  subagent_pricing_missing: boolean | null;
  subagent_unpriced_models: string[] | null;
  utility_cost: NumericLike;
  utility_pricing_missing: boolean | null;
  utility_unpriced_models: string[] | null;
}

/** The SELECT list that carries every `tree_costs` column out under its own name. */
export const TREE_COST_COLUMNS_SQL = sql`tc.main_cost, tc.main_model, tc.subagent_cost,
  tc.subagent_count, tc.subagent_pricing_missing, tc.subagent_unpriced_models,
  tc.utility_cost, tc.utility_pricing_missing, tc.utility_unpriced_models`;

/** A session tree's cost, as every surface reports it. */
export interface SessionTreeCost {
  mainCost: number | null;
  subagentCost: number;
  subagentCount: number;
  subagentPricingMissing: boolean;
  utilityCost: number;
  utilityPricingMissing: boolean;
  /** {@link resolveSessionTotalCost} — complete, or null. */
  total: number | null;
  /** Model ids with no price in Log Hub, root / sub-agents / utility calls, sorted. */
  unpricedModels: string[];
  /**
   * `'unknown-model'` when `total` is null because some model of the tree has no price;
   * null otherwise — including a root with no model and no stats, which has nothing to price.
   */
  costUnavailableReason: 'unknown-model' | null;
}

function toNum(v: NumericLike | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolves one `tree_costs` row (or its absence) into a {@link SessionTreeCost}.
 *
 * @param rootModel the root's model as the surface knows it, used when the root has no
 *   `session_costs` row yet (no stored model id) — so an unpriced root is still named.
 */
export function readTreeCost(
  row: TreeCostSqlRow | undefined,
  rootModel: string | null = null,
): SessionTreeCost {
  const mainCost = toNum(row?.main_cost);
  const subagentCost = toNum(row?.subagent_cost) ?? 0;
  const utilityCost = toNum(row?.utility_cost) ?? 0;
  const subagentPricingMissing = row?.subagent_pricing_missing === true;
  const utilityPricingMissing = row?.utility_pricing_missing === true;
  const total = resolveSessionTotalCost({
    mainCost,
    subagentCost,
    subagentPricingMissing,
    utilityCost,
    utilityPricingMissing,
  });
  const rootName =
    row?.main_model ?? rootModel?.replace(/-[0-9]{8}$/, '') ?? null;
  const rootUnpriced = mainCost == null && rootName != null;
  const unpricedModels = unpricedModelList(
    rootUnpriced ? [rootName] : [],
    row?.subagent_unpriced_models ?? [],
    row?.utility_unpriced_models ?? [],
  );
  return {
    mainCost,
    subagentCost,
    subagentCount: toNum(row?.subagent_count) ?? 0,
    subagentPricingMissing,
    utilityCost,
    utilityPricingMissing,
    total,
    unpricedModels,
    costUnavailableReason:
      total == null &&
      (rootUnpriced || subagentPricingMissing || utilityPricingMissing)
        ? 'unknown-model'
        : null,
  };
}

/**
 * Loads the tree cost of each given root `sessions.id` in one query, keyed by that id.
 * For surfaces whose own query has no `descendant_sessions` CTE to embed
 * {@link treeCostCtes} into.
 */
export async function loadTreeCostRows(
  db: DrizzleDb,
  rootIds: readonly number[],
): Promise<Map<number, TreeCostSqlRow>> {
  const out = new Map<number, TreeCostSqlRow>();
  if (rootIds.length === 0) return out;
  const idsArray = sql`${`{${rootIds.join(',')}}`}::bigint[]`;
  const result = await db.execute(sql`
    WITH RECURSIVE ${descendantSessionsCte(idsArray)},
    ${treeCostCtes(idsArray)}
    SELECT tc.session_row_id, ${TREE_COST_COLUMNS_SQL}
    FROM tree_costs tc
  `);
  for (const row of result.rows as unknown as TreeCostSqlRow[]) {
    out.set(Number(row.session_row_id), row);
  }
  return out;
}
