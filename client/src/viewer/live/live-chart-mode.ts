/**
 * Chart mode of the Live view pane (2026-11-21 cloudwatch-cai-parity): a grid of compact tiles
 * (the default) or the one-chart carousel. Remembered per browser under `artisyn:liveChartMode`
 * (global, not per user, like the splitter widths). The enlarged tile is component state only and
 * is never stored.
 */

export type LiveChartMode = 'tiles' | 'carousel';

/** Browser key of the chart mode last chosen. */
export const LIVE_CHART_MODE_STORAGE_KEY = 'artisyn:liveChartMode';

/** The chart mode last chosen; a missing, unknown or unreadable value means tiles. */
export function readLiveChartMode(): LiveChartMode {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LIVE_CHART_MODE_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked site data) — use the default.
  }
  return stored === 'carousel' ? 'carousel' : 'tiles';
}

/** Remembers `mode` as the chart mode last chosen. */
export function rememberLiveChartMode(mode: LiveChartMode): void {
  try {
    localStorage.setItem(LIVE_CHART_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage unavailable — the next open falls back to tiles.
  }
}
