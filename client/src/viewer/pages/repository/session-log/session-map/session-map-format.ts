/**
 * Display formatters shared by the Session Map components (session-map DD-18, DD-22a).
 */

/** `$0.00` — the header and card cost format. */
export function formatMapUsd(v: number): string {
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

/** Elapsed time as `H h M min` (hours omitted under one hour). */
export function formatElapsed(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Local wall-clock `HH:MM`. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Local wall-clock `HH:MM:SS`. */
export function formatClockSeconds(ms: number): string {
  const d = new Date(ms);
  return `${formatClock(ms)}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Whole minutes of a span, `N min` (at least 0). */
export function formatMinutes(ms: number): string {
  return `${Math.max(0, Math.floor(ms / 60_000))} min`;
}

/** `12%` share of a total, from a 0–1 fraction. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  return `${Math.round(share * 100)}%`;
}
