/**
 * Formatting helpers of the OTEL tabs (2026-10-30 otel-tabs-traces). Micro-USD amounts travel
 * as decimal strings (`otel-facts.types.ts`), so every amount goes through `microsToUsd` first.
 */
import { compareVersions } from '../../../lib/semver';
import { OTEL_LIVE_HOOK_MIN_VERSION } from './otel.constants';

/** Micro-USD (decimal string, number or null) → USD; null / unparseable → null. */
export function microsToUsd(
  micros: string | number | null | undefined,
): number | null {
  if (micros === null || micros === undefined || micros === '') return null;
  const n = typeof micros === 'number' ? micros : Number(micros);
  return Number.isFinite(n) ? n / 1_000_000 : null;
}

/** USD with two decimals (four below one cent, so small calls do not read as `$0.00`). */
export function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatMicrosUsd(
  micros: string | number | null | undefined,
): string {
  return formatUsd(microsToUsd(micros));
}

/** A 0..1 fraction as `46.6 %`; null → `—`. */
export function formatShare(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction))
    return '—';
  return `${(fraction * 100).toFixed(1)} %`;
}

/** `part / total` as a 0..1 fraction; 0 when the total is not positive. */
export function shareOf(part: number, total: number): number {
  return total > 0 ? part / total : 0;
}

/** Context : output token ratio as `286 : 1`; null → `—`. */
export function formatContextToOutput(
  ratio: number | null | undefined,
): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio))
    return '—';
  const rounded = ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10;
  return `${rounded.toLocaleString('en-US')} : 1`;
}

/** A count with thousands separators (`12,840`). */
export function formatCount(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
}

/** A token count in the units the tiles use: `0.6 M`, `28.1 K`, `512`. */
export function formatTokenCount(
  n: number | string | null | undefined,
): string {
  if (n === null || n === undefined) return '—';
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)} M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)} K`;
  return String(v);
}

/**
 * Cache read ratio (FR-25): cache read / (input + cache read + cache write), 0..1; null when the
 * denominator is zero (rendered `n/a`, never 0 %).
 */
export function otelCacheReadRatio(
  input: number,
  cacheRead: number,
  cacheWrite: number,
): number | null {
  const denom = input + cacheRead + cacheWrite;
  return denom > 0 ? cacheRead / denom : null;
}

/** The change of a KPI against the previous period (DD-28). */
export interface OtelKpiChange {
  /** Relative change (0.18 = +18 %) or percentage points for a share. */
  value: number;
  unit: 'relative' | 'pp';
}

/**
 * Relative change for amounts and counts; percentage points for shares (`unit: 'pp'`, both
 * values 0..1). None when there is no previous value, or a relative change against 0.
 */
export function otelKpiChange(
  current: number | null,
  previous: number | null | undefined,
  unit: 'relative' | 'pp' = 'relative',
): OtelKpiChange | null {
  if (current === null || previous === null || previous === undefined)
    return null;
  if (unit === 'pp') return { value: (current - previous) * 100, unit };
  if (previous === 0) return null;
  return { value: (current - previous) / previous, unit };
}

/** `▲ 18 %`, `▼ 6 %`, `▲ 0.4 pp`. */
export function formatOtelKpiChange(change: OtelKpiChange): string {
  const arrow = change.value >= 0 ? '▲' : '▼';
  const abs = Math.abs(change.value);
  if (change.unit === 'pp') return `${arrow} ${abs.toFixed(1)} pp`;
  const pct = abs * 100;
  return `${arrow} ${pct >= 10 ? Math.round(pct) : pct.toFixed(1)} %`;
}

/** Whether a hook version sends realtime batches (≥ `OTEL_LIVE_HOOK_MIN_VERSION`, DD-15). */
export function otelHookIsLive(version: string | null | undefined): boolean {
  if (!version) return false;
  return compareVersions(version, OTEL_LIVE_HOOK_MIN_VERSION) >= 0;
}

/** `HH:MM` local time of an ISO timestamp; `—` when absent. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Chart axis label of a bucket start for an interval. */
export function formatBucketStart(
  iso: string,
  interval: '5m' | '1h' | '1d',
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  if (interval === '1d') return md;
  const hm = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${md} ${hm}`;
}
