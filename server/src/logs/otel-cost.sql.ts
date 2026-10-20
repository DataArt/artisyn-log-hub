import { sql, type SQL } from 'drizzle-orm';
import {
  pricingAsOfSql,
  sessionCostSql,
  sessionPriceDateSql,
} from './cost.sql';

/**
 * OTEL-reported cost resolution.
 *
 * Two cost sources exist per session: the computed cost (token counts × `model_pricing`)
 * and the OTEL cost — `session_stats.telemetry_cost`, denormalized at OTEL ingest
 * time from `SUM(logs_otel.cost_usd_micros)` in the same transaction as the chunk write.
 *
 * OTEL cost is only ever recorded under the ROOT session's own `session_stats` row —
 * in-process sub-agents (`Agent`/`Workflow`-launched agents) share the root process's
 * OTEL exporter and are never tagged with their own `session_id` there. So this CTE must
 * be joined on the ROOT session id, never a descendant's, and once present its value
 * already covers the whole descendant tree — callers must use it INSTEAD OF a
 * separately-computed sub-agent rollup for that root, never in addition to one (that
 * would double-count).
 *
 * Excludes `telemetry_cost IS NULL`: the column is written `NULL` whenever the recomputed
 * `SUM(logs_otel.cost_usd_micros)` is exactly 0 — a `claude-otel` chunk exists for every
 * upload the receiver ever gets, including ones that carry no `claude_code.api_request`
 * record at all (plain telemetry with nothing billable), which sum to `0n` by design
 * ("cost-free, not broken"). An exact-zero total is therefore indistinguishable from "OTEL
 * saw no billing data yet", not a genuine free session. Treating it as "no OTEL signal" and
 * falling back to the computed cost keeps a non-billing OTEL chunk invisible to `totalCost`,
 * matching the UI-invisibility guarantee for `claude-otel` rows.
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
 * Fraction of the computed cost below which an OTEL total is treated as INCOMPLETE and no
 * longer preferred.
 *
 * A complete OTEL total is never far below the computed cost for the same scope — the OTEL
 * exporter meters what the API actually billed, including the root process's in-process
 * sub-agents. Measured across every session on the live DB with an OTEL cost and a computed
 * tree cost above $0.50:
 *
 * | otel / computed-tree | sessions | verdict |
 * |---|---|---|
 * | 10.9%                | 1        | broken — exporter stopped after 41 s of a 7 h 37 m session |
 * | 84.0%                | 1        | healthy — 14 OUT-of-process sub-agents the root's exporter never saw |
 * | 104.9% – 124.3%      | 23       | healthy — the normal band (OTEL slightly above, as expected) |
 *
 * 50% sits with a wide margin on both sides of that gap. It is deliberately generous: the
 * only cost of being too lax is keeping the status quo for a session, while being too strict
 * would discard good OTEL data.
 *
 * The rule is asymmetric on purpose — OTEL *above* computed is normal and is left alone. Only
 * a materially LOWER OTEL total is suspicious, and in both of its possible causes (a truncated
 * telemetry stream, or sub-agents that ran out of process) the computed figure is the better
 * estimate of what the whole session cost.
 */
export const OTEL_INCOMPLETE_RATIO = 0.5;

/**
 * Whether an OTEL total looks truncated/partial rather than authoritative.
 *
 * `false` when either side is missing or the computed baseline is non-positive — there is then
 * nothing to compare against, so the existing preference stands.
 */
export function isOtelCostIncomplete(
  otelCost: number | null,
  computedCost: number | null,
): boolean {
  if (otelCost == null || computedCost == null || computedCost <= 0) {
    return false;
  }
  return otelCost < computedCost * OTEL_INCOMPLETE_RATIO;
}

/**
 * The single definition of a session's headline cost.
 *
 * Prefers the root's OTEL total — it meters real billing and already covers the in-process
 * sub-agent tree — EXCEPT when that total is so far below the computed cost that it cannot be
 * complete, in which case the computed cost wins. Falls back to whichever side exists.
 *
 * Every surface that shows a session cost must go through this, so the session list, the
 * analytics timeline, the executive summary and the delete-time audit row can never disagree
 * about which source won. `otelComputedDiscrepancy()` stays independent of this choice, so the
 * header keeps warning whenever the two sources disagree — including when this guard fires.
 */
export function resolveSessionTotalCost(
  otelCost: number | null,
  computedCost: number | null,
): number | null {
  if (otelCost != null && !isOtelCostIncomplete(otelCost, computedCost)) {
    return otelCost;
  }
  return computedCost ?? otelCost ?? null;
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
 * `calculatedCost = mainCost + subagentCost + utilityCost`; `null` when the main model is
 * unpriced. `telemetryCost` is the root's OTEL total (`null` without telemetry), and
 * `mismatch` is {@link costMismatch} of the two.
 */
export interface CostBreakdown {
  mainCost: number | null;
  subagentCost: number;
  utilityCost: number;
  calculatedCost: number | null;
  telemetryCost: number | null;
  mismatch: boolean;
  utilityPricingMissing: boolean;
}

/**
 * Prices the **utility calls** of each root session: API calls
 * the OTEL exporter metered but no transcript in the session tree records (title generation,
 * summarisation, haiku side calls, ...). Produces
 * `utility_costs(session_row_id, utility_cost, utility_pricing_missing)`, one row per root
 * that has `otel_api_calls`; roots without telemetry have no row (callers `COALESCE` to 0).
 *
 * Classification — a root R's `otel_api_calls` row is utility when:
 * - the tree has `session_request_ids` rows: its `request_id` is NULL or not among the
 *   request ids of any session in R's `descendant_sessions` tree (depth 0 included);
 * - otherwise (old transcripts without `requestId`): its `query_source` is neither one of
 *   {@link TRANSCRIPT_QUERY_SOURCES} nor starts with {@link TRANSCRIPT_QUERY_SOURCE_PREFIX}.
 *
 * Pricing — {@link sessionCostSql} over the call row (its columns are named like
 * `session_stats`), at the call's model as of the ROOT's {@link sessionPriceDateSql}. An
 * unpriced model contributes 0 and sets `utility_pricing_missing`.
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
          THEN ${sessionCostSql({ stats: sql`oc`, pricing: sql`p` })}
          ELSE 0.0 END
      ), 0.0)::float AS utility_cost,
      COALESCE(BOOL_OR(p.model_id IS NULL), false) AS utility_pricing_missing
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
