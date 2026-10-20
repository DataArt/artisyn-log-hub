import { sql, type SQL } from 'drizzle-orm';

/**
 * The single server-side definition of a session's **computed** cost.
 *
 * Before the TTL pricing split the same arithmetic was hand-copied into eleven expressions across six
 * files, which is exactly how the flat cache-write rate survived the TTL token split:
 * fixing one copy left the others contradicting it on screen. Every server cost site —
 * SQL or TypeScript — must now go through {@link sessionCostSql} or
 * {@link computeSessionCost}, so the sessions list, the analytics timeline, the
 * executive summary, the cache-read-ratio report, the active-sessions panel and the
 * delete-time audit row can never disagree about what a session cost.
 *
 * The canonical formula (all six rates come from `model_pricing`; none is ever a
 * literal in source — see `docs/knowledgebase/llm-call-math.md`):
 *
 * ```
 * F = FAST_MODE_MULTIPLIER - 1                       // 1 today
 *
 * cost = (input  + inputFast  * F) / 1e6 * priceIn
 *      + (output + outputFast * F) / 1e6 * priceOut
 *      +  cacheRead               / 1e6 * priceCacheR
 *      +  cacheWrite5m            / 1e6 * priceCacheW5m
 *      +  cacheWrite1h            / 1e6 * priceCacheW1h
 *      +  webSearchRequests             * priceWebSearch   // per REQUEST, not per 1e6
 * ```
 *
 * Two invariants worth restating because both are load-bearing:
 * - `cacheWrite5m + cacheWrite1h = cacheWrite`, so this formula must never also add a
 *   `cacheWrite * priceCacheW` term — the deprecated `price_cache_w` column has no
 *   readers left.
 * - `inputFast` / `outputFast` are **subsets** of `input` / `output`, not extra tokens.
 *   That is why fast mode appears as a *surcharge* on the grand total
 *   (`(total - fast)*r + fast*M*r = (total + fast*(M-1))*r`) rather than as separate
 *   standard/fast terms. Adding `fast * M * r` on top of a full-total term would
 *   double-bill every fast token.
 *
 * Client-side twin: `client/src/viewer/lib/format.ts`'s `computeCost` (plus its own
 * `FAST_MODE_MULTIPLIER`). Any change here must be mirrored there, and vice versa —
 * the client prices individual turns from the transcript, the server prices sessions
 * from `session_stats`, but both must land on the same number for the same tokens.
 */

/**
 * Multiplier applied to the standard per-token rate for tokens billed in fast mode
 * (`usage.speed = 'fast'`).
 *
 * Fast rates are **derived, not stored**: `model_pricing` holds only the standard
 * `price_in` / `price_out`, and the fast price is this multiple of them.
 * There is deliberately no `price_in_fast` column — the two rates
 * would then be able to drift apart, and no evidence exists of a fast-mode rate that is
 * anything other than 2x standard. Cache reads/writes and web-search requests have no
 * fast-mode surcharge at all.
 *
 * The code below writes the general `M`-form rather than hardcoding "double", so a
 * future multiplier change is a single edit here and in the client twin.
 */
export const FAST_MODE_MULTIPLIER = 2;

/**
 * The fast-mode *surcharge* factor `F = M - 1`, as a raw SQL literal.
 *
 * `sql.raw` rather than a bind parameter on purpose: an untyped `$n` inside
 * `bigint + $n` arithmetic makes Postgres guess at the parameter's type. The value is
 * derived from a numeric constant in this file, never from input.
 */
const fastSurchargeSql = sql.raw(String(FAST_MODE_MULTIPLIER - 1));

/**
 * The `SELECT` list for a `model_pricing` lookup — every rate {@link sessionCostSql}
 * needs, plus `model_id`, which call sites use for the "is this model priced at all?"
 * guard (`p.model_id IS NULL` -> `costUnavailableReason: 'unknown-model'`).
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
         price_web_search::float AS price_web_search`;
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
 * A numeric value as it can arrive from Postgres: `bigint` and `numeric` columns come
 * back as strings through `node-postgres`, `::float` casts as numbers, and a
 * `LEFT JOIN`ed row as `null`.
 */
type NumericLike = number | string | null | undefined;

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
}

/** Missing/unparseable -> 0, so one absent column cannot `NaN` the whole cost. */
function num(value: NumericLike): number {
  if (value == null) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * TypeScript twin of {@link sessionCostSql}, for the cost sites that roll up in TS
 * rather than in SQL (the delete-time audit row in `sessions.service.ts`, the
 * cache-read-ratio report's group rollup). Same formula, same rates, same result.
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
  if (pricing == null) {
    return null;
  }
  const fastSurcharge = FAST_MODE_MULTIPLIER - 1;
  const input =
    num(tokens.inputTokens) + num(tokens.inputTokensFast) * fastSurcharge;
  const output =
    num(tokens.outputTokens) + num(tokens.outputTokensFast) * fastSurcharge;
  return (
    (input / 1_000_000) * num(pricing.priceIn) +
    (output / 1_000_000) * num(pricing.priceOut) +
    (num(tokens.cacheReadTokens) / 1_000_000) * num(pricing.priceCacheR) +
    (num(tokens.cacheWrite5mTokens) / 1_000_000) * num(pricing.priceCacheW5m) +
    (num(tokens.cacheWrite1hTokens) / 1_000_000) * num(pricing.priceCacheW1h) +
    num(tokens.webSearchRequests) * num(pricing.priceWebSearch)
  );
}
