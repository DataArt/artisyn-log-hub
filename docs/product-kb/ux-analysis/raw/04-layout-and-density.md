# Raw report 4 — Layout, density and personalisation

Read-only study, 2026-11-01.

## 1. Densest pages

**Session detail pane** (`SessionDetailPane.tsx`, `SessionTabBar.tsx`, `tab-ids.ts`) — by far the densest:

- Up to 15 flat tabs in one row; Charts has 7 sub-tabs; Info has 9+ sections.
- Shares the screen with the left nav and a resizable session list.
- Cost content is spread over Charts, Statistics, System context anatomy, OTEL and Info → Tokens & Cost.

**Repository view** — 7 tabs; Analytics ~12 views in one select with group-by, date range, layout
and sub-metric controls; Reports ~20 report types in a tree; Settings 7 tabs. **Admin** — 9 tabs.

**How layout state is kept today**

- URL: `tab`, `mtab`, `stab`, `al`, `bashCall`.
- localStorage (scattered keys): left nav width and collapsed state, session-list width, `sessionViewMode`, per-repo `hideHookSessions`, Charts sub-tab, Tools tree collapsed state, Reports tree expanded state.
- Not saved: Info's `CollapsibleSection` always opens expanded.
- No server-side UI preferences, no density setting, no focus mode.

## 2. Ideas

1. **Grouped session tab bar with overflow** — Overview (Summary, Info, Advisor) / Conversation (Logs, Bash, Raw Logs) / Cost & Context (Charts, Statistics, System context anatomy, OTEL) / Footprint (Change surface, Harness usage, OKF, Tools/MCP); "More" when narrow. Ids unchanged. S–M / high. Risk: 14 scenario files click `tab-session-*`.
2. **Session lenses** — Overview, Cost/Tokens, Debug a failure, Context and Harness, Change review; reorder, default tab, promote 3–4 tabs; `lens` URL param, remembered per user. Fixed list. M / high.
3. **Summary as a hub** — mini-card per tab below `SummaryExecutiveBand` with one figure and "Open →" via `onSessionTabChange`; optional inline expand. Use data already loaded; do not load lazy tab chunks. M / high.
4. **Focus mode** — button and `f` key collapse left nav, session list and repo header; `focus=1`; Esc restores. S / medium.
5. **Remembered collapsible sections** — `storageKey` and `defaultOpen` on `CollapsibleSection`; rarely used Info sections and `SummaryExtendedDetails` collapsed by default. S / medium.
6. **Density modes** — Comfortable / Compact via `data-density` on `<html>` and CSS tokens. M / medium. Light-only rule applies.
7. **Analytics views grouped by question, plus favourites** — sections Time, Cost & Tokens, Code & Files, Tools & MCP, Sessions; starred views as chips. S / medium.
8. **Saved workspaces** — "Save view" stores name + query string; localStorage first, server-side later. M (local) / L (server); high over time. Saved URLs must ignore unknown params.
9. **Role-based default landing** — default lens and repo tab by team role, user can override. S after idea 2 / medium.

**Cross-cutting:** a single `useUiPref(key, default)` hook with versioned keys and try/catch would
back ideas 2, 5, 6, 7 and 8 and allow server sync later.

## 3. Top-3

1. **Grouped tab bar + lenses (1+2).**
2. **Summary as a hub (3).**
3. **Saved workspaces, localStorage first (8).**

Key files: `tab-ids.ts`, `SessionTabBar.tsx`, `SessionDetailPane.tsx`, `RepositoryView.tsx`,
`useRepositoryViewState.ts`, `session-log/summary/SessionSummaryTab.tsx`,
`session-log/session-info-primitives.tsx`, `analytics/analytics-state.ts`.
