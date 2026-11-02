import { CHART_TABS, isChartTab, type ChartTab } from '../../../../tab-ids';

// The chart tab ids, in tab-bar order, live in the pure `tab-ids.ts` module; re-exported for
// existing importers.
export { CHART_TABS, type ChartTab };

/** Browser key of the chart last opened (it predates per-user storage; the value is not personal). */
export const CHART_TAB_STORAGE_KEY = 'charts-sub-tab';

/**
 * The chart last opened, for the legacy `tab=charts` deep link (the charts used to be sub-tabs
 * of one Charts tab). An unknown or stale id falls back to `'dashboard'`, so a viewer never
 * lands on a tab that renders nothing.
 */
export function readChartTab(): ChartTab {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CHART_TAB_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked site data) — use the default.
  }
  return stored !== null && isChartTab(stored) ? stored : 'dashboard';
}

/** Remembers `tab` as the chart last opened. */
export function rememberChartTab(tab: ChartTab): void {
  try {
    localStorage.setItem(CHART_TAB_STORAGE_KEY, tab);
  } catch {
    // Storage unavailable — `tab=charts` then opens the Dashboard.
  }
}
