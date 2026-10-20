/**
 * Ratio-of-sums aggregation helpers for the analytics "Cache Read Ratio" view.
 *
 * Every figure this module produces follows one rule: sum the cache-read and
 * cache-write tokens over the scope first, then divide once — never average per-session
 * ratios. A scope whose denominator is 0 has `ratio === null` and renders as `n/a`,
 * it is never reported as `0 %`.
 *
 * Two scopes are always produced side by side:
 * - `root` — the timeline session's own tokens;
 * - `withDescendants` — the session plus every recursive descendant sub-agent, using the
 *   `descendant*` fields the timeline endpoint already rolls up.
 */
import type { TimelineSession } from '../../../../models/repositories';
import { cacheReadRatio } from '@/lib/format';

/** One scope's summed tokens and its ratio-of-sums. */
export interface CacheRatioScopeTotals {
  /** Summed cache-read tokens over the scope. */
  read: number;
  /** Summed cache-creation tokens over the scope. */
  write: number;
  /** `read / (read + write)`, or `null` when the denominator is 0. */
  ratio: number | null;
  /** Number of timeline sessions folded into this scope. */
  sessionCount: number;
}

/** The root-only / root+descendants pair reported for any scope. */
export interface CacheRatioScopePair {
  root: CacheRatioScopeTotals;
  withDescendants: CacheRatioScopeTotals;
}

/** A UTC day bucket of the paired totals, keyed by `YYYY-MM-DD`. */
export interface CacheRatioDayBucket extends CacheRatioScopePair {
  /** UTC day key, `YYYY-MM-DD`. */
  day: string;
  /** The sessions that fell into this bucket, for tooltips and drill-downs. */
  sessions: TimelineSession[];
}

function totals(
  read: number,
  write: number,
  sessionCount: number,
): CacheRatioScopeTotals {
  return { read, write, ratio: cacheReadRatio(read, write), sessionCount };
}

/**
 * Aggregates a session array into the root-only / root+descendants pair.
 *
 * `withDescendants.sessionCount` counts the same timeline (root) sessions — the
 * descendants are folded into the token sums by the server rollup and are not
 * individually addressable here.
 */
export function aggregateCacheRatio(
  sessions: TimelineSession[],
): CacheRatioScopePair {
  let rootRead = 0;
  let rootWrite = 0;
  let allRead = 0;
  let allWrite = 0;

  for (const s of sessions) {
    const r = s.cacheReadTokens ?? 0;
    const w = s.cacheWriteTokens ?? 0;
    rootRead += r;
    rootWrite += w;
    allRead += r + (s.descendantCacheReadTokens ?? 0);
    allWrite += w + (s.descendantCacheWriteTokens ?? 0);
  }

  return {
    root: totals(rootRead, rootWrite, sessions.length),
    withDescendants: totals(allRead, allWrite, sessions.length),
  };
}

/**
 * UTC day key (`YYYY-MM-DD`) of an ISO timestamp — matches the report's bucketing.
 * Returns `null` for an unparseable timestamp.
 */
export function utcDayKey(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Buckets sessions by the UTC day of their start time and aggregates each bucket.
 * Buckets are returned in ascending day order; days with no sessions are not emitted.
 */
export function bucketCacheRatioByDay(
  sessions: TimelineSession[],
): CacheRatioDayBucket[] {
  const byDay = new Map<string, TimelineSession[]>();
  for (const s of sessions) {
    if (!s.startTime) continue;
    const day = utcDayKey(s.startTime);
    if (day === null) continue;
    const existing = byDay.get(day);
    if (existing) existing.push(s);
    else byDay.set(day, [s]);
  }

  return Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, daySessions]) => ({
      day,
      sessions: daySessions,
      ...aggregateCacheRatio(daySessions),
    }));
}
