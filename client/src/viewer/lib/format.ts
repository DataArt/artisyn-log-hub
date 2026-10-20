import { trunc } from './tools/strings';
import type { ModelPricingEntry } from '../../models/pricing';
import type { TokenBreakdown } from '../pages/repository/session-log/types';

export { trunc as truncate };

export function formatDuration(ms: number | undefined | null): string {
  if (ms == null) return '\u2013';
  // Round before the threshold check so e.g. an SQL AVG of 697.9047\u2026 renders as
  // "698ms" (not raw decimals), and 999.6 goes to the seconds branch, not "1000ms".
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Multiplier applied to the standard per-token rate for tokens billed in fast mode
 * (`usage.speed === 'fast'`).
 *
 * Client-side twin of `FAST_MODE_MULTIPLIER` in `server/src/logs/cost.sql.ts` — the two
 * must always carry the same value, or the same tokens price differently depending on
 * whether the figure came from the transcript (client) or from `session_stats` (server).
 * Fast rates are derived, never stored: `model_pricing` holds only the standard
 * `priceIn` / `priceOut`. Cache reads/writes and web-search requests have no fast-mode
 * surcharge.
 */
export const FAST_MODE_MULTIPLIER = 2;

/**
 * The single client-side definition of a token breakdown's cost.
 *
 * ```
 * F = FAST_MODE_MULTIPLIER - 1                      // 1 today
 *
 * cost = (input  + inputFast  * F) / 1e6 * priceIn
 *      + (output + outputFast * F) / 1e6 * priceOut
 *      +  cacheRead               / 1e6 * priceCacheR
 *      +  cacheWrite5m            / 1e6 * priceCacheW5m
 *      +  cacheWrite1h            / 1e6 * priceCacheW1h
 *      +  webSearchRequests             * priceWebSearch   // per REQUEST, not per 1e6
 * ```
 *
 * Two invariants make the shape of this expression load-bearing:
 * - `cacheWrite5m + cacheWrite1h === cacheWrite`, so the two TTL terms replace the old
 *   flat `cacheWrite * priceCacheW` term — never add both.
 * - `inputFast` / `outputFast` are **subsets** of `input` / `output`, so fast mode is a
 *   *surcharge* on the grand total (`(total - fast)*r + fast*M*r = (total + fast*(M-1))*r`),
 *   not a separate priced term. Adding `fast * M * r` on top of a full-total term would
 *   double-bill every fast token.
 *
 * Server-side twin: `computeSessionCost` / `sessionCostSql` in `server/src/logs/cost.sql.ts`.
 * The client prices individual turns from the transcript and the server prices whole
 * sessions from `session_stats`, but both must land on the same number for the same tokens.
 */
export function computeCost(
  breakdown: TokenBreakdown,
  pricing: ModelPricingEntry,
): number {
  const fastSurcharge = FAST_MODE_MULTIPLIER - 1;
  const input = breakdown.input + breakdown.inputFast * fastSurcharge;
  const output = breakdown.output + breakdown.outputFast * fastSurcharge;
  return (
    (input / 1_000_000) * pricing.priceIn +
    (output / 1_000_000) * pricing.priceOut +
    (breakdown.cacheRead / 1_000_000) * pricing.priceCacheR +
    (breakdown.cacheWrite5m / 1_000_000) * pricing.priceCacheW5m +
    (breakdown.cacheWrite1h / 1_000_000) * pricing.priceCacheW1h +
    breakdown.webSearchRequests * pricing.priceWebSearch
  );
}

/**
 * Single source of truth for the **cache read ratio** on the client side.
 *
 *   cacheRead / (cacheRead + cacheWrite)
 *
 * Two rules every call site must respect:
 * - A zero denominator is **not** `0` — it is *undefined* (`null`) and renders as `n/a`.
 *   A turn/session that produced no cache traffic at all has no ratio; folding it in as
 *   `0` drags every aggregate down.
 * - Aggregates are **ratio-of-sums**, never a mean of per-session ratios: sum the reads
 *   and the writes over the scope first, then call this once — do not average its outputs.
 *
 * Server-side twin: `server/src/logs/cache-ratio.sql.ts` (`cacheReadRatioSql` /
 * `cacheReadRatio`). The pre-existing `cacheHitRate` in `session-info-derive.ts` is a
 * *different* metric and is unrelated to this one.
 */
export function cacheReadRatio(
  cacheRead: number,
  cacheWrite: number,
): number | null {
  const total = cacheRead + cacheWrite;
  if (total <= 0) return null;
  return cacheRead / total;
}

/** Renders a {@link cacheReadRatio} result: `'n/a'` for undefined, else `'93.0%'`. */
export function formatCacheReadRatio(r: number | null): string {
  if (r === null || !Number.isFinite(r)) return 'n/a';
  return `${(r * 100).toFixed(1)}%`;
}

export function formatCost(v: number | undefined | null): string {
  if (typeof v !== 'number') return '\u2013';
  return `$${v.toFixed(4)}`;
}

export function formatTokens(n: number | undefined | null): string {
  if (typeof n !== 'number') return '\u2013';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function summarizeTurnStats(
  turnCount: number,
  toolCount: number,
  label: 'turn' | 'more turn' = 'turn',
): string {
  const parts: string[] = [
    `${turnCount} ${label}${turnCount !== 1 ? 's' : ''}`,
  ];
  if (toolCount > 0) {
    parts.push(`${toolCount} tool call${toolCount !== 1 ? 's' : ''}`);
  }
  return parts.join(' \u00b7 ');
}

export function shortModelName(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return model;
}

export function dominantModel(
  turns: { type: string; model?: string }[],
): string {
  const counts = new Map<string, number>();
  for (const t of turns) {
    if (t.type === 'assistant' && t.model) {
      counts.set(t.model, (counts.get(t.model) ?? 0) + 1);
    }
  }
  let best = '';
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

export function formatToolBadgeLabel(name: string, count: number): string {
  return `${count}\u00d7 ${name}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

const localTimestampFormatter = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const localDayFormatter = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function parseTimestamp(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The single client-side timestamp formatter (D3): the viewer's **local** time as
 * `YYYY-MM-DD HH:mm:ss` (with `.SSS` when `ms` is set), no zone suffix. An empty or
 * unparseable input renders as `—`. Reports and admin pages that print an explicit
 * "UTC" keep their own formatting.
 */
export function formatLocalTimestamp(
  iso: string | undefined | null,
  opts: { ms?: boolean } = {},
): string {
  const d = parseTimestamp(iso);
  if (!d) return '—';
  // sv-SE renders `YYYY-MM-DD HH:mm:ss` natively.
  const base = localTimestampFormatter.format(d);
  if (!opts.ms) return base;
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** Local calendar day of a timestamp as `YYYY-MM-DD`; `''` for an empty/invalid input. */
export function localDayKey(iso: string | undefined | null): string {
  const d = parseTimestamp(iso);
  return d ? localDayFormatter.format(d) : '';
}

export function formatTime(ts: string | undefined | null): string {
  if (!ts) return '\u2013';
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}
