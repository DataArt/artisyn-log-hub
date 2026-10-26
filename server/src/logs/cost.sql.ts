import {
  type CallTokens,
  computeCostBreakdown,
  type CostTerms,
  FAST_MODE_MULTIPLIER,
  type PricingTier,
} from '@loghub/pricing';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The single server-side definition of a session's **computed** cost.
 *
 * Before the TTL pricing split the same arithmetic was hand-copied into eleven expressions across six
 * files, which is exactly how the flat cache-write rate survived the TTL token split:
 * fixing one copy left the others contradicting it on screen. Every server session-cost
 * site must now go through {@link computeSessionCostBreakdown} (or its scalar wrapper
 * {@link computeSessionCost}); its result is stored per session in `session_costs` and
 * every reader (sessions list, analytics timeline, executive summary, cache-read-ratio
 * report, active-sessions panel, delete-time audit row) reads that stored value, so they
 * can never disagree about what a session cost.
 *
 * {@link sessionCostSql} is the SQL form of the aggregate formula at base rates. The OTEL
 * utility-call rollup (`utilityCostsCte` in `otel-cost.sql.ts`) prices each
 * `otel_api_calls` row per call with prompt-length tiers instead: {@link callTierRatesSql}
 * picks the call's rates and {@link tieredCallCostSql} applies them — together the SQL form
 * of the per-call rule (`pickCallRates` in `@loghub/pricing`).
 *
 * The formula itself — the aggregate form and the per-call rule for prompt-length tiers —
 * is defined once in the shared package `@loghub/pricing` (`packages/pricing/src/cost.ts`),
 * which the client uses as well; {@link computeSessionCostBreakdown} only adapts
 * `session_stats` / `session_call_tokens` rows (Postgres numerics, columnar per-call
 * arrays) to it. {@link sessionCostSql} must stay equal to its aggregate path.
 */

/** Fast-mode multiplier of the standard rate — defined in `@loghub/pricing`. */
export { FAST_MODE_MULTIPLIER };

/**
 * The fast-mode *surcharge* factor `F = M - 1`, as a raw SQL literal.
 *
 * `sql.raw` rather than a bind parameter on purpose: an untyped `$n` inside
 * `bigint + $n` arithmetic makes Postgres guess at the parameter's type. The value is
 * derived from a numeric constant of `@loghub/pricing`, never from input.
 */
const fastSurchargeSql = sql.raw(String(FAST_MODE_MULTIPLIER - 1));

/**
 * The `SELECT` list for a `model_pricing` lookup — every rate {@link sessionCostSql}
 * needs, plus `model_id`, which call sites use for the "is this model priced at all?"
 * guard (`p.model_id IS NULL` -> `costUnavailableReason: 'unknown-model'`), plus
 * `tiers` (jsonb prompt-length tiers or NULL), `effective_from` and `source` of the
 * resolved row, which the stored session-cost writer records alongside the cost.
 *
 * Emitted in the `DISTINCT ON (model_id)` shape every existing lookup already uses, so
 * the caller supplies only the `WHERE` / `ORDER BY` around it. Both forms below are in
 * use and both are correct — the `ORDER BY model_id, effective_from DESC` is what makes
 * `DISTINCT ON` pick the newest row that has already taken effect; selecting by
 * `model_id` alone can return a future-dated row and overcharge.
 *
 * All rates are cast to `::float` here, matching the `::float` token casts in
 * {@link sessionCostSql} — `numeric` would otherwise force the whole cost expression
 * into arbitrary-precision arithmetic and come back as a string of a different shape.
 *
 * Session-cost sites should not hand-write that `WHERE` / `ORDER BY` any more: use
 * {@link pricingAsOfSql}, which prices a model at a given date — normally the session's
 * own price date from {@link sessionPriceDateSql}, so a session is priced at the
 * rates that applied when it ran rather than at today's.
 *
 * @example per-row LATERAL at the session's price date, for a joined `session_stats` alias
 *   sql`LEFT JOIN LATERAL (
 *     ${pricingAsOfSql(sql`ss.model`, sessionPriceDateSql(sql`ss.session_id`))}
 *   ) p ON true`
 *
 * @example sub-agent rows priced at their ROOT's date (`descendant_sessions` in scope)
 *   sql`LEFT JOIN LATERAL (
 *     ${pricingAsOfSql(sql`ss.model`, sessionPriceDateSql(sql`d.root_id`))}
 *   ) p ON true`
 */
export function pricingColumnsSql(): SQL {
  return sql`DISTINCT ON (model_id) model_id,
         price_in::float         AS price_in,
         price_out::float        AS price_out,
         price_cache_r::float    AS price_cache_r,
         price_cache_w_5m::float AS price_cache_w_5m,
         price_cache_w_1h::float AS price_cache_w_1h,
         price_web_search::float AS price_web_search,
         tiers,
         effective_from,
         source`;
}

/**
 * A session's **price date**: the UTC calendar date of its earliest
 * `logs.start_time`, falling back to `CURRENT_DATE` when the session has no timed log yet.
 *
 * Pricing a session at the rates in force when it ran — not at today's — keeps its cost
 * stable when `model_pricing` gains a newer row. Sub-agents and utility calls are priced at
 * their ROOT's date, so pass the root's `sessions.id` for them.
 *
 * The UTC conversion is explicit so the date matches the client, which derives its
 * `asOf` from the first 10 characters of the session's ISO-UTC `startTime`.
 *
 * @param sessionRowIdExpr SQL expression yielding a `sessions.id` (integer row id).
 */
export function sessionPriceDateSql(sessionRowIdExpr: SQL): SQL {
  return sql`COALESCE(
    ((SELECT MIN(pl.start_time) FROM logs pl WHERE pl.session_id = ${sessionRowIdExpr}) AT TIME ZONE 'UTC')::date,
    CURRENT_DATE
  )`;
}

/**
 * The body of a `LEFT JOIN LATERAL` that looks up the `model_pricing` row for a model as of
 * a date: the newest row with `effective_from <= dateExpr`, matched on the model id with any
 * `-YYYYMMDD` snapshot suffix stripped. Selects {@link pricingColumnsSql}, so the result
 * feeds {@link sessionCostSql}'s `pricing` alias directly and exposes `model_id` for the
 * unpriced-model guard (`p.model_id IS NULL`).
 *
 * Returns the bare `SELECT` — the caller supplies the parentheses, the alias and `ON true`.
 *
 * @example
 *   sql`LEFT JOIN LATERAL (
 *     ${pricingAsOfSql(sql`ss.model`, sessionPriceDateSql(sql`ss.session_id`))}
 *   ) p ON true`
 *
 * @param modelExpr SQL expression yielding the (possibly date-suffixed, possibly NULL) model id.
 * @param dateExpr SQL expression yielding a `date` — normally {@link sessionPriceDateSql}.
 */
export function pricingAsOfSql(modelExpr: SQL, dateExpr: SQL): SQL {
  return sql`SELECT ${pricingColumnsSql()}
    FROM model_pricing
    WHERE effective_from <= ${dateExpr}
      AND model_id = REGEXP_REPLACE(COALESCE(${modelExpr}, ''), '-[0-9]{8}$', '')
    ORDER BY model_id, effective_from DESC`;
}

interface SessionCostSqlAliases {
  /**
   * SQL alias of the token source: a `session_stats` row, or a CTE that reproduces its
   * column names. Must expose `input_tokens`, `output_tokens`, `cache_read_tokens`,
   * `cache_write_5m_tokens`, `cache_write_1h_tokens`, `web_search_requests`,
   * `input_tokens_fast` and `output_tokens_fast`. A raw-JSONB CTE therefore has to
   * alias its aggregates to those exact names (see the sessions-list and timeline
   * `session_events` CTEs in `repositories.controller.ts`).
   */
  stats: SQL;
  /**
   * SQL alias of a pricing source built with {@link pricingColumnsSql} — a CTE joined
   * on the normalised model id, or a `LEFT JOIN LATERAL`.
   */
  pricing: SQL;
}

/**
 * Builds the canonical cost expression (see the module doc comment) from two SQL
 * aliases. Returns a bare arithmetic expression — no `CASE`, no `COALESCE` around the
 * whole thing, no alias — so it drops into a `SELECT`, a `SUM(...)` or a `GROUP BY`
 * unchanged.
 *
 * **Callers keep their own missing-pricing guard.** This helper deliberately does not
 * add one, because the surrounding shapes differ (a scalar `SELECT` wants `NULL`, a
 * rollup `SUM` wants `0.0` for the unpriced member so the priced siblings still add up).
 * Wrap it exactly as the existing sites do:
 *
 * ```
 * CASE WHEN p.model_id IS NOT NULL THEN <expression> ELSE NULL END
 * ```
 *
 * An unpriced model must yield `NULL`, never `0` — a fake `$0.00` is indistinguishable
 * from a genuinely free session, which is the whole reason `costUnavailableReason`
 * exists. Derive that flag from the same `model_id IS NULL` predicate (select it as
 * `pricing_missing`) so the flag can never contradict the join that produced the cost.
 *
 * Every token column is `COALESCE(..., 0)`-guarded: the columns are `NOT NULL` in
 * `session_stats`, but a `LEFT JOIN`ed row or a CTE with no matching events yields
 * `NULL`, and one `NULL` term would otherwise null out the entire sum.
 *
 * @example
 *   sql`CASE WHEN p.model_id IS NOT NULL
 *         THEN ${sessionCostSql({ stats: sql`ss`, pricing: sql`p` })}
 *         ELSE NULL END AS computed_cost`
 */
export function sessionCostSql({ stats, pricing }: SessionCostSqlAliases): SQL {
  return sql`(
    ((COALESCE(${stats}.input_tokens, 0) + COALESCE(${stats}.input_tokens_fast, 0) * ${fastSurchargeSql})::float / 1000000.0 * ${pricing}.price_in) +
    ((COALESCE(${stats}.output_tokens, 0) + COALESCE(${stats}.output_tokens_fast, 0) * ${fastSurchargeSql})::float / 1000000.0 * ${pricing}.price_out) +
    (COALESCE(${stats}.cache_read_tokens, 0)::float / 1000000.0 * ${pricing}.price_cache_r) +
    (COALESCE(${stats}.cache_write_5m_tokens, 0)::float / 1000000.0 * ${pricing}.price_cache_w_5m) +
    (COALESCE(${stats}.cache_write_1h_tokens, 0)::float / 1000000.0 * ${pricing}.price_cache_w_1h) +
    (COALESCE(${stats}.web_search_requests, 0)::float * ${pricing}.price_web_search)
  )`;
}

/**
 * The prompt size of one call, as SQL — `input + cache read + cache write (5m + 1h)` of a
 * row whose columns are named like `session_stats` (an `otel_api_calls` row). The same sum
 * as `promptTokens` in `@loghub/pricing`.
 */
function callPromptTokensSql(call: SQL): SQL {
  return sql`(COALESCE(${call}.input_tokens, 0) + COALESCE(${call}.cache_read_tokens, 0)
    + COALESCE(${call}.cache_write_5m_tokens, 0) + COALESCE(${call}.cache_write_1h_tokens, 0))`;
}

/**
 * The body of a `LEFT JOIN LATERAL` that picks the prompt-length tier one call is priced at:
 * among the `tiers` jsonb of the pricing row (ascending by `aboveTokens`), the tier with the
 * largest `aboveTokens` strictly below the call's prompt size ({@link callPromptTokensSql}).
 * No row comes back when no tier matches (or the model has no tiers, or no pricing row), and
 * {@link tieredCallCostSql} then falls back to the base rates.
 *
 * This is the SQL form of `pickCallRates` (`@loghub/pricing`): "the last tier with
 * prompt > aboveTokens" over an ascending list is exactly the tier with the largest threshold
 * below the prompt. Selects `price_in`, `price_out`, `price_cache_r`, `price_cache_w_5m` and
 * `price_cache_w_1h` (tiers carry no web-search price).
 *
 * @param call SQL alias of the call row (`otel_api_calls`).
 * @param pricing SQL alias of a pricing row built with {@link pricingColumnsSql}.
 */
export function callTierRatesSql(call: SQL, pricing: SQL): SQL {
  return sql`SELECT (t->>'priceIn')::float       AS price_in,
           (t->>'priceOut')::float      AS price_out,
           (t->>'priceCacheR')::float   AS price_cache_r,
           (t->>'priceCacheW5m')::float AS price_cache_w_5m,
           (t->>'priceCacheW1h')::float AS price_cache_w_1h
      FROM jsonb_array_elements(COALESCE(${pricing}.tiers, '[]'::jsonb)) AS t
     WHERE (t->>'aboveTokens')::bigint < ${callPromptTokensSql(call)}
     ORDER BY (t->>'aboveTokens')::bigint DESC
     LIMIT 1`;
}

/**
 * The cost of ONE call at its chosen rates — {@link sessionCostSql}'s arithmetic with each
 * token rate taken from the picked tier (`tier`, a {@link callTierRatesSql} lateral) when one
 * matched, else from the base row. Fast-mode surcharge as in {@link sessionCostSql}; web
 * search always at the base rate. Like {@link sessionCostSql} it carries no missing-pricing
 * guard: wrap it in `CASE WHEN p.model_id IS NOT NULL …`.
 */
export function tieredCallCostSql({
  call,
  pricing,
  tier,
}: {
  call: SQL;
  pricing: SQL;
  tier: SQL;
}): SQL {
  return sql`(
    ((COALESCE(${call}.input_tokens, 0) + COALESCE(${call}.input_tokens_fast, 0) * ${fastSurchargeSql})::float / 1000000.0 * COALESCE(${tier}.price_in, ${pricing}.price_in)) +
    ((COALESCE(${call}.output_tokens, 0) + COALESCE(${call}.output_tokens_fast, 0) * ${fastSurchargeSql})::float / 1000000.0 * COALESCE(${tier}.price_out, ${pricing}.price_out)) +
    (COALESCE(${call}.cache_read_tokens, 0)::float / 1000000.0 * COALESCE(${tier}.price_cache_r, ${pricing}.price_cache_r)) +
    (COALESCE(${call}.cache_write_5m_tokens, 0)::float / 1000000.0 * COALESCE(${tier}.price_cache_w_5m, ${pricing}.price_cache_w_5m)) +
    (COALESCE(${call}.cache_write_1h_tokens, 0)::float / 1000000.0 * COALESCE(${tier}.price_cache_w_1h, ${pricing}.price_cache_w_1h)) +
    (COALESCE(${call}.web_search_requests, 0)::float * ${pricing}.price_web_search)
  )`;
}

/**
 * A numeric value as it can arrive from Postgres: `bigint` and `numeric` columns come
 * back as strings through `node-postgres`, `::float` casts as numbers, and a
 * `LEFT JOIN`ed row as `null`.
 */
type NumericLike = number | string | null | undefined;

/**
 * Per-call token counts of one session (`session_call_tokens.calls`), columnar: index `i`
 * of every array is call `i`. A missing key reads as all zeros; the call count is the
 * longest present array. `inputTokensFast` / `outputTokensFast` are subsets of
 * `inputTokens` / `outputTokens`, as in the aggregates.
 */
export interface SessionCallTokens {
  inputTokens?: number[];
  outputTokens?: number[];
  cacheReadTokens?: number[];
  cacheWrite5mTokens?: number[];
  cacheWrite1hTokens?: number[];
  inputTokensFast?: number[];
  outputTokensFast?: number[];
}

/** Token counts for {@link computeSessionCost} — a `session_stats` row's shape. */
export interface SessionCostTokens {
  inputTokens: NumericLike;
  outputTokens: NumericLike;
  cacheReadTokens: NumericLike;
  cacheWrite5mTokens: NumericLike;
  cacheWrite1hTokens: NumericLike;
  webSearchRequests: NumericLike;
  /** Subset of `inputTokens` billed in fast mode — not additional tokens. */
  inputTokensFast: NumericLike;
  /** Subset of `outputTokens` billed in fast mode — not additional tokens. */
  outputTokensFast: NumericLike;
  /**
   * Per-call tokens; used (instead of the aggregates above) only when the pricing has a
   * non-empty `tiers` list. Their sums equal the aggregates.
   */
  calls?: SessionCallTokens | null;
}

/** Rates for {@link computeSessionCost} — a `model_pricing` row's shape. */
export interface SessionCostPricing {
  priceIn: NumericLike;
  priceOut: NumericLike;
  priceCacheR: NumericLike;
  priceCacheW5m: NumericLike;
  priceCacheW1h: NumericLike;
  /** USD per web-search request — a per-request price, NOT per million tokens. */
  priceWebSearch: NumericLike;
  /** Prompt-length tiers, ascending by `aboveTokens`; null/absent/empty means none. */
  tiers?: readonly PricingTier[] | null;
}

/** Cost terms of one session, in USD; they sum to the total cost. */
export type SessionCostTerms = CostTerms;

/** Result of {@link computeSessionCostBreakdown}. */
export interface SessionCostBreakdown {
  cost: number;
  terms: SessionCostTerms;
  /**
   * Total minus the same tokens priced at base rates. Informational only — `terms`
   * already sum to `cost`, so it is never added as a summand. 0 on the aggregate path.
   */
  tierDelta: number;
}

/** Missing/unparseable -> 0, so one absent column cannot `NaN` the whole cost. */
function num(value: NumericLike): number {
  if (value == null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Columnar per-call record -> one row per call; the call count is the longest array. */
function callRows(calls: SessionCallTokens): CallTokens[] {
  const n = Math.max(
    0,
    calls.inputTokens?.length ?? 0,
    calls.outputTokens?.length ?? 0,
    calls.cacheReadTokens?.length ?? 0,
    calls.cacheWrite5mTokens?.length ?? 0,
    calls.cacheWrite1hTokens?.length ?? 0,
    calls.inputTokensFast?.length ?? 0,
    calls.outputTokensFast?.length ?? 0,
  );
  const at = (arr: number[] | undefined, i: number): number => num(arr?.[i]);
  const rows: CallTokens[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      input: at(calls.inputTokens, i),
      output: at(calls.outputTokens, i),
      cacheRead: at(calls.cacheReadTokens, i),
      cacheWrite5m: at(calls.cacheWrite5mTokens, i),
      cacheWrite1h: at(calls.cacheWrite1hTokens, i),
      inputFast: at(calls.inputTokensFast, i),
      outputFast: at(calls.outputTokensFast, i),
    });
  }
  return rows;
}

/**
 * The session's cost with its per-term breakdown, by the shared formula of
 * `@loghub/pricing` (`computeCostBreakdown`): per call when `tokens.calls` is present
 * and the pricing has a non-empty `tiers` list, otherwise over the aggregates at base rates.
 * Returns `null` — never a zero cost — when there is no pricing row.
 */
export function computeSessionCostBreakdown(
  tokens: SessionCostTokens,
  pricing: SessionCostPricing | null | undefined,
): SessionCostBreakdown | null {
  if (pricing == null) {
    return null;
  }
  const { total, terms, tierDelta } = computeCostBreakdown(
    {
      input: num(tokens.inputTokens),
      output: num(tokens.outputTokens),
      cacheRead: num(tokens.cacheReadTokens),
      cacheWrite5m: num(tokens.cacheWrite5mTokens),
      cacheWrite1h: num(tokens.cacheWrite1hTokens),
      inputFast: num(tokens.inputTokensFast),
      outputFast: num(tokens.outputTokensFast),
      webSearchRequests: num(tokens.webSearchRequests),
      calls: tokens.calls == null ? null : callRows(tokens.calls),
    },
    {
      priceIn: num(pricing.priceIn),
      priceOut: num(pricing.priceOut),
      priceCacheR: num(pricing.priceCacheR),
      priceCacheW5m: num(pricing.priceCacheW5m),
      priceCacheW1h: num(pricing.priceCacheW1h),
      priceWebSearch: num(pricing.priceWebSearch),
      tiers: pricing.tiers,
    },
  );
  return { cost: total, terms, tierDelta };
}

/**
 * Scalar form of {@link computeSessionCostBreakdown}: the session's cost, or `null`
 * without a pricing row. On the aggregate path it is the TypeScript twin of
 * {@link sessionCostSql}.
 *
 * Accepts the raw shapes both sources produce — Drizzle rows (`bigint` as `number`,
 * `numeric` as `string`) and raw `db.execute` rows (everything a string) — so call
 * sites need no `parseFloat` scaffolding around it.
 *
 * Mirrors the SQL guard: with no pricing row (`null` / `undefined`) the result is
 * `null`, never `0`, because "we cannot price this model" and "this session was free"
 * must stay distinguishable all the way to the UI.
 */
export function computeSessionCost(
  tokens: SessionCostTokens,
  pricing: SessionCostPricing,
): number;
export function computeSessionCost(
  tokens: SessionCostTokens,
  pricing: SessionCostPricing | null | undefined,
): number | null;
export function computeSessionCost(
  tokens: SessionCostTokens,
  pricing: SessionCostPricing | null | undefined,
): number | null {
  return computeSessionCostBreakdown(tokens, pricing)?.cost ?? null;
}
