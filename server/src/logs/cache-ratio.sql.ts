import { sql, type SQL } from 'drizzle-orm';

/**
 * Single source of truth for the **cache read ratio** on the server side.
 *
 * The ratio answers "of all the cache traffic this scope produced, how much of it was
 * a cheap read rather than an expensive write?":
 *
 *   cacheRead / (cacheRead + cacheWrite)
 *
 * Two rules that every call site must respect:
 * - A zero denominator is **not** `0` — it is *undefined* (`NULL` in SQL, `null` in TS)
 *   and must render as `n/a`. A session that produced no cache traffic at all has no
 *   ratio; folding it in as `0` drags every aggregate down.
 * - Aggregates are **ratio-of-sums**, never a mean of per-session ratios:
 *   `SUM(read) / (SUM(read) + SUM(write))`. Feed the summed expressions into
 *   {@link cacheReadRatioSql} / {@link cacheReadRatio} — do not average their outputs.
 *
 * Keep this in sync with the client-side twin in `client/src/viewer/lib/format.ts`
 * (`cacheReadRatio` / `formatCacheReadRatio`). The pre-existing `cacheHitRate` in
 * `session-info-derive.ts` is a *different* metric and is unrelated to this one.
 */

/**
 * Builds the SQL expression for the cache read ratio from two numeric expressions.
 *
 * Both `readExpr` and `writeExpr` are embedded twice, so they must be side-effect-free
 * (plain columns or `SUM(...)`/`COALESCE(...)` over them — never a volatile function).
 *
 * Returns `NULL` when `read + write = 0`, so `AVG()`/`SUM()` over the result skip
 * undefined sessions for free.
 *
 * @example
 *   cacheReadRatioSql(sql`SUM(ss.cache_read_tokens)`, sql`SUM(ss.cache_write_tokens)`)
 */
export function cacheReadRatioSql(readExpr: SQL, writeExpr: SQL): SQL {
  return sql`CASE WHEN (COALESCE(${readExpr}, 0) + COALESCE(${writeExpr}, 0)) > 0
    THEN COALESCE(${readExpr}, 0)::float / (COALESCE(${readExpr}, 0) + COALESCE(${writeExpr}, 0))::float
    ELSE NULL END`;
}

/**
 * TypeScript twin of {@link cacheReadRatioSql}, for aggregates computed in TS rather
 * than in SQL. Returns `null` when the denominator is zero (never `0`).
 */
export function cacheReadRatio(
  cacheRead: number,
  cacheWrite: number,
): number | null {
  const total = cacheRead + cacheWrite;
  if (total <= 0) {
    return null;
  }
  return cacheRead / total;
}

/**
 * Fallback for `RepoConfigJson.highCacheCreationThreshold` — the per-turn
 * cache-creation token count at or above which a turn is large enough to be worth
 * attributing to a cause (compaction / file re-read). Resolution order is
 * personal repo_config -> team_repo_config -> this constant in personal view, and
 * team_repo_config -> this constant in team view.
 *
 * There is deliberately **no DB default**: the number is a product decision that can
 * change without a migration.
 *
 * Calibrated (2026-08-08), not invented: `walkTurns` over the last 7 days of real `claude`
 * logs (2 897 logs, 1 845 turns) gave a p50 of 33 273 cache-creation tokens across the 157
 * turns that created any cache at all — the p50 over *all* turns is 0, because ~91 % of
 * turns write no cache, so it carries no signal. 0.8 x 33 273 = 26 618, rounded to a round
 * 25 000. Full distribution recorded in the task's `notes.md`.
 */
export const DEFAULT_HIGH_CACHE_CREATION_THRESHOLD = 25_000;

/** Lowest threshold the settings UI and the server-side config validation accept. */
export const CACHE_CREATION_THRESHOLD_MIN = 1_000;

/** Highest threshold the settings UI and the server-side config validation accept. */
export const CACHE_CREATION_THRESHOLD_MAX = 10_000_000;
