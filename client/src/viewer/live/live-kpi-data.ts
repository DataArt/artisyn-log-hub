/**
 * Live KPI helpers (2026-11-21 cloudwatch-cai-parity, FR-2): Active users, Active hours and the
 * Total tokens sparkline of the Live view KPI row. Computed on the client from data the live
 * response already carries: the DISTINCT session roots under the selected node (first placement,
 * the same `rootsUnder` mapping as the Share page) and the node's 5-minute `view.buckets`.
 */
import type { OtelLiveNode, OtelLiveView } from '../../models/otel-live';
import { rootsUnder } from './live-share-data';

/** Width of one live chart bucket; mirror of the server `OTEL_BUCKET_MS`. */
const LIVE_BUCKET_MS = 300_000;

/** Points of the Total tokens sparkline: the 2 h window in 5-minute buckets. */
export const LIVE_TOKEN_SPARK_POINTS = 24;

/** Distinct owners (user emails) of the session roots under the node; null when there are none. */
export function liveActiveUsers(
  nodes: readonly OtelLiveNode[],
  selectedKey: string,
): number | null {
  const roots = rootsUnder(nodes, selectedKey);
  if (roots.length === 0) return null;
  return new Set(roots.map((r) => r.session.userEmail ?? '')).size;
}

/**
 * Sum of `runningMs` (first to latest call, lifetime) over the DISTINCT session roots under the
 * node; null when there are none.
 */
export function liveActiveHoursMs(
  nodes: readonly OtelLiveNode[],
  selectedKey: string,
): number | null {
  const roots = rootsUnder(nodes, selectedKey);
  if (roots.length === 0) return null;
  return roots.reduce((s, r) => s + (r.session.totals.runningMs || 0), 0);
}

/**
 * Tokens (all four kinds) per 5-minute bucket of the 2 h window, oldest first, zero-filled to
 * `LIVE_TOKEN_SPARK_POINTS` points. Rows outside the window are ignored.
 */
export function liveTokenSpark(
  view: OtelLiveView,
  windowFrom: string,
  windowTo: string,
): number[] {
  const out = new Array<number>(LIVE_TOKEN_SPARK_POINTS).fill(0);
  const to = Date.parse(windowTo);
  if (!Number.isFinite(to)) return out;
  const parsedFrom = Date.parse(windowFrom);
  const from = Number.isFinite(parsedFrom)
    ? parsedFrom
    : to - LIVE_TOKEN_SPARK_POINTS * LIVE_BUCKET_MS;
  const n = (v: string) => Number(v) || 0;
  for (const b of view.buckets) {
    const t = Date.parse(b.start);
    if (!Number.isFinite(t) || t < from || t >= to) continue;
    // Index from the window end, so the last point is always the current bucket.
    const i =
      LIVE_TOKEN_SPARK_POINTS - 1 - Math.floor((to - 1 - t) / LIVE_BUCKET_MS);
    if (i < 0 || i >= LIVE_TOKEN_SPARK_POINTS) continue;
    out[i] +=
      n(b.inputTokens) +
      n(b.outputTokens) +
      n(b.cacheReadTokens) +
      n(b.cacheWriteTokens);
  }
  return out;
}
