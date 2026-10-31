import { sql, type SQL } from 'drizzle-orm';
import {
  callTierRatesSql,
  pricingAsOfSql,
  sessionPriceDateSql,
  tieredCallCostSql,
} from './cost.sql';

/**
 * OTEL-reported cost, used only as a cross-check.
 *
 * Two cost figures exist per session: the computed cost (token counts × Log Hub's
 * `model_pricing`) and the OTEL cost — `session_stats.telemetry_cost`, denormalized at OTEL
 * ingest time from `SUM(logs_otel.cost_usd_micros)` in the same transaction as the chunk
 * write. The shown cost is always the computed one ({@link resolveSessionTotalCost}); the OTEL
 * total only feeds the discrepancy warning and the mismatch flag.
 *
 * OTEL cost is only ever recorded under the ROOT session's own `session_stats` row —
 * in-process sub-agents (`Agent`/`Workflow`-launched agents) share the root process's
 * OTEL exporter and are never tagged with their own `session_id` there. So this CTE must
 * be joined on the ROOT session id, never a descendant's, and its value covers the whole
 * descendant tree — compare it with the whole computed tree cost, never with one part.
 *
 * Excludes `telemetry_cost IS NULL`: the column is written `NULL` whenever the recomputed
 * `SUM(logs_otel.cost_usd_micros)` is exactly 0 — a `claude-otel` chunk exists for every
 * upload the receiver ever gets, including ones that carry no `claude_code.api_request`
 * record at all (plain telemetry with nothing billable), which sum to `0n` by design
 * ("cost-free, not broken"). An exact-zero total is therefore treated as "no OTEL signal".
 */
export function otelCostsCte(rootIdsArray: SQL): SQL {
  return sql`otel_costs AS (
    SELECT
      ss.session_id AS session_row_id,
      ss.telemetry_cost::float / 1000000.0 AS otel_cost
    FROM session_stats ss
    WHERE ss.session_id = ANY(${rootIdsArray})
      AND ss.telemetry_cost IS NOT NULL
  )`;
}

/**
 * The parts a session's computed cost is made of: the root's own stored cost
 * (`session_costs.cost`, `null` when the root is unpriced or has no row), the sum of its
 * sub-agents' stored costs, and its utility calls (`utilityCostsCte`). The two flags say
 * whether some sub-agent with a transcript, or some utility call, has a model with no price
 * in Log Hub — its share is then missing from the sum.
 */
export interface SessionCostParts {
  mainCost: number | null;
  subagentCost: number;
  subagentPricingMissing: boolean;
  utilityCost: number;
  utilityPricingMissing: boolean;
}

/**
 * The single definition of a session's headline cost: what Log Hub computes from its own
 * price table, complete or not at all.
 *
 * `mainCost + subagentCost + utilityCost`, or `null` as soon as any part of the tree is
 * unpriced (the root, a sub-agent or a utility call) — a partial sum would silently
 * under-report the session. Nothing is substituted: the OTEL total is never used as the
 * shown cost (Claude Code prices a model it does not know at another model's rates and
 * reports that number with no marker), and no other model's price stands in for an unknown
 * one. OTEL stays a cross-check: {@link otelComputedDiscrepancy} and {@link costMismatch}.
 *
 * Every surface that shows a session cost goes through this (via `readTreeCost` in
 * `session-tree-cost.sql.ts`), so the session list, the analytics timeline, the reports,
 * the turn-end advisor and the delete-time audit row can never disagree.
 */
export function resolveSessionTotalCost(
  parts: SessionCostParts,
): number | null {
  if (
    parts.mainCost == null ||
    parts.subagentPricingMissing ||
    parts.utilityPricingMissing
  ) {
    return null;
  }
  return parts.mainCost + parts.subagentCost + parts.utilityCost;
}

/**
 * The model ids named in a "no price" hint: the distinct non-empty ids of every given list
 * (root, sub-agents, utility calls), sorted by code unit so the text is stable.
 */
export function unpricedModelList(
  ...lists: ReadonlyArray<ReadonlyArray<string | null>>
): string[] {
  const ids = new Set<string>();
  for (const list of lists) {
    for (const id of list) {
      if (id != null && id !== '') ids.add(id);
    }
  }
  return [...ids].sort();
}

/** Relative-delta threshold above which the session header shows a discrepancy warning. */
export const OTEL_DISCREPANCY_THRESHOLD = 0.33;

/**
 * Whether an OTEL cost and a computed cost disagree enough to warrant the session-header
 * warning icon: `abs(otel - computed) / computed >= 0.33`, guarding the computed-zero case
 * (no computed baseline to take a relative delta against, so no signal either way).
 */
export function otelComputedDiscrepancy(
  otelCost: number | null,
  computedCost: number | null,
): boolean {
  if (otelCost == null || computedCost == null || computedCost === 0) {
    return false;
  }
  return (
    Math.abs(otelCost - computedCost) / computedCost >=
    OTEL_DISCREPANCY_THRESHOLD
  );
}

/**
 * Absolute floor of the `costBreakdown.mismatch` tolerance: a delta below five
 * cents is never a mismatch.
 */
export const COST_MISMATCH_TOLERANCE_USD = 0.05;

/**
 * Relative part of the `costBreakdown.mismatch` tolerance: a delta below 1% of the telemetry
 * total is never a mismatch. It absorbs the known residual on utility calls — OTEL reports only
 * a total `cache_creation_tokens`, so they are priced at the 5m write rate even when some of
 * the write was 1h (cents per session, well under 1%).
 */
export const COST_MISMATCH_TOLERANCE_RATIO = 0.01;

/**
 * Whether the utility-inclusive calculated cost and the OTEL telemetry total disagree:
 * `true` only when both sides are present and `|calculated − telemetry|` reaches BOTH
 * {@link COST_MISMATCH_TOLERANCE_USD} and {@link COST_MISMATCH_TOLERANCE_RATIO} of the
 * telemetry total. Exposed only as `costBreakdown.mismatch` — independent of the coarse
 * relative {@link otelComputedDiscrepancy} flag.
 */
export function costMismatch(
  telemetry: number | null,
  calculated: number | null,
): boolean {
  if (telemetry == null || calculated == null) {
    return false;
  }
  const delta = Math.abs(calculated - telemetry);
  return (
    delta >= COST_MISMATCH_TOLERANCE_USD &&
    delta >= Math.abs(telemetry) * COST_MISMATCH_TOLERANCE_RATIO
  );
}

/**
 * `query_source` values whose API calls are recorded in the transcript (the main thread and
 * `claude -p`'s `sdk` thread). Used only by the {@link utilityCostsCte} fallback for trees
 * with no `session_request_ids` rows (old transcripts without `requestId`). Always
 * interpolated as SQL parameters, never as literals.
 */
export const TRANSCRIPT_QUERY_SOURCES: readonly string[] = [
  'repl_main_thread',
  'sdk',
];

/** `query_source` prefix of sub-agent threads (`agent:<name>`) — also transcript-recorded. */
export const TRANSCRIPT_QUERY_SOURCE_PREFIX = 'agent:';

/**
 * Per-session cost parts sent with every listed session (`costBreakdown`).
 *
 * `calculatedCost` is {@link resolveSessionTotalCost}: `mainCost + subagentCost + utilityCost`,
 * or `null` as soon as the root, a sub-agent or a utility call is unpriced.
 * `telemetryCost` is the root's OTEL total (`null` without telemetry), and `mismatch` is
 * {@link costMismatch} of the two. `subagentPricingMissing` / `utilityPricingMissing` say
 * which part is unpriced, and `unpricedModels` lists the model ids with no price in Log
 * Hub ({@link unpricedModelList}; empty when everything is priced). The last two fields
 * were added later, so a consumer must treat them as optional.
 * `costExcludesUtilityCalls` is {@link costExcludesUtilityCallsSql} (DD-30 of 2026-10-30
 * otel-shared-receiver; added later still, so it is optional for a consumer too).
 */
export interface CostBreakdown {
  mainCost: number | null;
  subagentCost: number;
  utilityCost: number;
  calculatedCost: number | null;
  telemetryCost: number | null;
  mismatch: boolean;
  utilityPricingMissing: boolean;
  subagentPricingMissing: boolean;
  unpricedModels: string[];
  costExcludesUtilityCalls: boolean;
}

/**
 * Whether a root's computed cost leaves out Claude Code's utility calls because Log Hub never
 * saw them (2026-10-30 otel-shared-receiver, DD-30): the root has no OTEL API-call rows — neither
 * in `otel_api_calls`, which {@link utilityCostsCte} prices, nor in the projected `otel_calls` —
 * **and** its `session_stats.otel_state` is not `ok`. Deliberately not keyed on
 * `telemetry_cost`, which is also NULL for a zero OTEL sum (FR-C7).
 *
 * A boolean SQL expression over `rootId` (a `sessions.id` of a tree root). Used by the
 * sessions list `costBreakdown` and the session OTEL route's status.
 */
export function costExcludesUtilityCallsSql(rootId: SQL): SQL {
  return sql`(
    NOT EXISTS (SELECT 1 FROM otel_api_calls xa WHERE xa.session_id = ${rootId})
    AND NOT EXISTS (SELECT 1 FROM otel_calls xc WHERE xc.session_id = ${rootId})
    AND (SELECT xs.otel_state FROM session_stats xs WHERE xs.session_id = ${rootId})
      IS DISTINCT FROM 'ok'
  )`;
}

/**
 * Prices the **utility calls** of each root session: API calls
 * the OTEL exporter metered but no transcript in the session tree records (title generation,
 * summarisation, haiku side calls, ...). Produces
 * `utility_costs(session_row_id, utility_cost, utility_pricing_missing,
 * utility_unpriced_models)`, one row per root
 * that has `otel_api_calls`; roots without telemetry have no row (callers `COALESCE` to 0).
 *
 * Classification — a root R's `otel_api_calls` row is utility when:
 * - the tree has `session_request_ids` rows: its `request_id` is NULL or not among the
 *   request ids of any session in R's `descendant_sessions` tree (depth 0 included);
 * - otherwise (old transcripts without `requestId`): its `query_source` is neither one of
 *   {@link TRANSCRIPT_QUERY_SOURCES} nor starts with {@link TRANSCRIPT_QUERY_SOURCE_PREFIX}.
 *
 * Pricing — per call, with the prompt-length tier rule of `pickCallRates`
 * (`@loghub/pricing`): {@link tieredCallCostSql} over the call row at the rates
 * {@link callTierRatesSql} picks, for the call's model as of the ROOT's
 * {@link sessionPriceDateSql}. An unpriced model contributes 0, sets
 * `utility_pricing_missing` and adds its id (snapshot suffix stripped) to
 * `utility_unpriced_models` (`text[]`, distinct, empty when all are priced) — the shown cost
 * is then null ({@link resolveSessionTotalCost}).
 *
 * Requires a `descendant_sessions` CTE (`descendantSessionsCte`) over the same roots to be in
 * scope earlier in the same `WITH`.
 */
export function utilityCostsCte(rootIdsArray: SQL): SQL {
  const transcriptSources = sql.join(
    TRANSCRIPT_QUERY_SOURCES.map((source) => sql`${source}`),
    sql`, `,
  );
  const transcriptPrefixLike = `${TRANSCRIPT_QUERY_SOURCE_PREFIX}%`;
  return sql`utility_costs AS (
    SELECT
      rs.id AS session_row_id,
      COALESCE(SUM(
        CASE WHEN p.model_id IS NOT NULL
          THEN ${tieredCallCostSql({ call: sql`oc`, pricing: sql`p`, tier: sql`ct` })}
          ELSE 0.0 END
      ), 0.0)::float AS utility_cost,
      COALESCE(BOOL_OR(p.model_id IS NULL), false) AS utility_pricing_missing,
      COALESCE(
        ARRAY_AGG(DISTINCT REGEXP_REPLACE(oc.model, '-[0-9]{8}$', '')::text)
          FILTER (WHERE p.model_id IS NULL AND COALESCE(oc.model, '') <> ''),
        '{}'::text[]
      ) AS utility_unpriced_models
    FROM sessions rs
    CROSS JOIN LATERAL (
      SELECT ${sessionPriceDateSql(sql`rs.id`)} AS price_date
    ) pd
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM descendant_sessions dt
        JOIN session_request_ids sri ON sri.session_id = dt.id
        WHERE dt.root_id = rs.id
      ) AS has_request_ids
    ) tr
    JOIN otel_api_calls oc ON oc.session_id = rs.id
    LEFT JOIN LATERAL (
      ${pricingAsOfSql(sql`oc.model`, sql`pd.price_date`)}
    ) p ON true
    LEFT JOIN LATERAL (
      ${callTierRatesSql(sql`oc`, sql`p`)}
    ) ct ON true
    WHERE rs.id = ANY(${rootIdsArray})
      AND CASE
        WHEN tr.has_request_ids THEN
          oc.request_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM descendant_sessions dr
            JOIN session_request_ids sr
              ON sr.session_id = dr.id AND sr.request_id = oc.request_id
            WHERE dr.root_id = rs.id
          )
        ELSE
          NOT (
            COALESCE(oc.query_source, '') IN (${transcriptSources})
            OR COALESCE(oc.query_source, '') LIKE ${transcriptPrefixLike}
          )
      END
    GROUP BY rs.id
  )`;
}
