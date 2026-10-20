import { CHART_TABS, type ChartTab } from '../../../../tab-ids';

// Charts sub-tab ids, in tab-bar order, live in the pure `tab-ids.ts` module;
// re-exported for existing importers.
export { CHART_TABS, type ChartTab };

export const CHART_TAB_STORAGE_KEY = 'charts-sub-tab';

/**
 * Reads the persisted Charts sub-tab id. An unknown or stale id (for example
 * one of a sub-tab that no longer exists) falls back to `'dashboard'`, so a
 * viewer never lands on a tab that renders nothing.
 */
export function readChartTab(): ChartTab {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CHART_TAB_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked site data) — use the default.
  }
  if (stored && (CHART_TABS as readonly string[]).includes(stored)) {
    return stored as ChartTab;
  }
  return 'dashboard';
}
