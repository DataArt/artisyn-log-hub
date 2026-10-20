/**
 * Shared UI constants for the cache-read-ratio metric.
 *
 * The colours are **fixed per scope**, not zone-coloured: the ratio is bounded 0–100 %,
 * a low value is simply bad, and the `zoneColor()` / `ZoneLegend` pattern from
 * `ui-principles.md` would imply thresholds that do not exist here. Every view that
 * renders the metric (chart, scope strip, horizontal layout, session info, report,
 * PDF export) imports these instead of inlining hexes.
 */
export const CACHE_RATIO_SCOPE_COLORS = {
  /** Root session only. */
  root: '#3b82f6',
  /** Root session + all recursive descendants. */
  withDescendants: '#14b8a6',
  /** Undefined ratio (zero denominator) — rendered as `n/a`. */
  undefinedRatio: '#94a3b8',
} as const;

/**
 * Bounds for `RepoConfigJson.highCacheCreationThreshold`, the per-turn cache-creation
 * token count at or above which a turn is attributed to a cause. Mirrored server-side in
 * `server/src/logs/cache-ratio.sql.ts` — keep both in sync.
 */
export const CACHE_CREATION_THRESHOLD_MIN = 1_000;

/**
 * Fallback shown in the settings UI when neither the user- nor the team-scoped
 * `repo_config` carries a `highCacheCreationThreshold`. Mirrors
 * `DEFAULT_HIGH_CACHE_CREATION_THRESHOLD` in `server/src/logs/cache-ratio.sql.ts` —
 * keep both in sync.
 */
export const DEFAULT_HIGH_CACHE_CREATION_THRESHOLD = 25_000;

/** Upper bound for `RepoConfigJson.highCacheCreationThreshold`. */
export const CACHE_CREATION_THRESHOLD_MAX = 10_000_000;
