/**
 * The lazily loaded session detail tabs rendered by `SessionDetailPane`. Each one pulls its own
 * queries or heavy renderers and is opened deliberately, not on every session view, so it stays
 * out of the session pane's chunk until first opened. They all load through one barrel
 * (`session-tabs-lazy-group.ts`) so they share one chunk: opening any of them loads them all,
 * which keeps the client inside its lazy-chunk budget.
 */
import { lazy } from 'react';

const loadTabs = () => import('./session-tabs-lazy-group');

export const SessionChartsTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionChartsTab })),
);

// The tab pulls its own two queries and a whole tree renderer.
export const SessionChangeSurfaceTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionChangeSurfaceTab })),
);

// The tab pulls its own transcript walker and tree renderer.
export const SessionHarnessUsageTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionHarnessUsageTab })),
);

// The tab pulls its own OKF usage query and tree.
export const SessionOkfTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionOkfTab })),
);

// The repo Tools/MCP tab narrowed to this session; pulls its own queries and three panes. It is a
// repository tab, so it comes from the repository barrel (one chunk, shared with RepositoryView).
export const SessionToolsTab = lazy(() =>
  import('./repository-tabs-lazy-group').then((m) => ({
    default: m.RepoToolsTab,
  })),
);

// The startup system-context anatomy, computed client-side from the loaded transcript.
export const SessionSysctxAnatomyTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionSysctxAnatomyTab })),
);

// The OTEL chart and trace waterfall poll their own route.
export const SessionOtelTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionOtelTab })),
);

// The tab pulls the Bash view (and, through it, the tree-sitter parser on first use — that stays
// its own chunk). Its row count for the tab bar comes from the WASM-free collector in the pane.
export const SessionBashTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionBashTab })),
);

// The Session Map polls its own `/logs/delta` route and builds its own model.
export const SessionMapTab = lazy(() =>
  loadTabs().then((m) => ({ default: m.SessionMapTab })),
);
