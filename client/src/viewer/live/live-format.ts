/**
 * Time formatting of the Live view (2026-11-04 otel-live-view, DD-23). Sessions may run for
 * several days, so durations go up to days and clock times carry a date when not today. The
 * shared `formatDuration` (`lib/format.ts`) stops at minutes and is not reused.
 */

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `45s`, `12m`, `3h 12m`, `2d 4h` (floored; negative or invalid input → `0s`). */
export function formatLiveDuration(ms: number): string {
  const totalS = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : 0;
  if (totalS < 60) return `${totalS}s`;
  const totalM = Math.floor(totalS / 60);
  if (totalM < 60) return `${totalM}m`;
  const totalH = Math.floor(totalM / 60);
  if (totalH < 24) return `${totalH}h ${totalM % 60}m`;
  return `${Math.floor(totalH / 24)}d ${totalH % 24}h`;
}

/** A short span duration: `120 ms`, `2.4 s`; `—` when absent. */
export function formatLiveSpanMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return formatLiveDuration(ms);
}

/**
 * A local clock time: `hh:mm:ss` when `at` falls on the same local day as `now`, otherwise
 * `MMM d, hh:mm`. `at` is an ISO string or epoch ms; `—` when absent or invalid.
 */
export function formatLiveClock(
  at: string | number | null | undefined,
  now: number,
): string {
  if (at === null || at === undefined || at === '') return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) return `${hm}:${pad2(d.getSeconds())}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hm}`;
}
