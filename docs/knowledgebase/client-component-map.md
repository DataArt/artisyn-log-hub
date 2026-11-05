---
type: "Component Map"
title: "Client Components Structure"
description: "Folder-level index of client/src: what each folder holds, its entry file and the KB article with the details, plus the cross-cutting modules whose names do not say what they own. Not a per-file list — find files with grep/glob."
tags:
  - client
  - ui
timestamp: "2026-11-05T00:00:00+04:00"
---

# Client Components Structure

A folder-level map of `client/src/`. It tells you **which folder** to look in and **which KB article**
has the details; it deliberately does not list every file. Inside a folder, find the file with
`Glob` / `Grep` — file names follow the component names (`SessionDetailPane.tsx`,
`useSessionLens.ts`, `session-lenses.ts`).

Update this file only when a folder, an entry point or a cross-cutting module (the table at the end)
is added, removed or renamed. A new component inside an existing folder needs no change here.

For routing, the provider tree, lazy chunks, URL state and browser storage see
[`client-routing-and-layout.md`](client-routing-and-layout.md). For UI rules see
[`ui-principles.md`](ui-principles.md).

---

## `client/src/`

| Path | What it holds |
|---|---|
| `main.tsx` | SPA entry: providers, `createHashRouter`, `Bootstrap` / `AuthGuard` / `AdminGuard` / consent gate (`AppLayout`). Route paths come from `ROUTE` in `app-routes.ts` |
| `app-routes.ts` | Pure route table: `ROUTE`, `APP_ROUTES`, `ROUTE_ACCESS` (public / auth / admin) |
| `models/` | Type-only mirrors of API response shapes, one file per area (`repositories.ts`, `teams.ts`, `admin.ts`, `pricing.ts`, `tool-monitoring.ts`, …) |
| `lib/` | `format.ts` (dates, durations) |
| `viewer/` | Everything else — below |

## `client/src/viewer/`

| Path | What it holds |
|---|---|
| `api.ts` | Every fetch wrapper for the server API (`apiFetch` redirects to `#/login` on 401) |
| `tab-ids.ts` | **The tab registry**: tab-id arrays (`SESSION_TABS`, `REPO_MAIN_TABS`, `ADMIN_TABS`, `TEAM_TABS`, `API_KEYS_TABS`, `CHART_TABS`, …), `TAB_REGISTRY` rows (label, group, visibility) and `visibleTabs()`. Add or rename a tab here first |
| `context/` | `AuthContext` (`useAuth()`) |
| `hooks/` | App-wide hooks: `useHashRoute.ts` (the `routes` path builder), `useAllViewsShortcut.ts` (Ctrl+K and the All views doors), auth config, build version, model pricing, keep-alive, consent, debounce, drag-resize / drag-scroll, copy to clipboard |
| `help/` | In-app help: `HelpModal.tsx`, link handling (`help-links.ts`), nav from `user-docs/nav.json`. Articles are generated into `client/public/help/` — see [`user-docs-and-site.md`](user-docs-and-site.md) |
| `components/` | App shell and shared components — [below](#viewercomponents) |
| `lib/` | Shared non-page logic — [below](#viewerlib) |
| `ui/` | Shadcn/Radix primitives (`button`, `dialog`, `tabs`, `page-tabs`, `overflow-row`, `popover`, `tooltip`, `switch`, …). Prefer these over raw HTML elements |
| `pages/` | One folder per page — [below](#viewerpages) |
| `live/` | OTEL **Live view** modal (opened from the top-nav Live item, `?live=<nodeKey>`): `LiveModal` (shell, polling via `useOtelLivePoll`, banners, `LiveSplitter` pane handles) + `LiveModalHeader`, `LiveTree` (left pane), `LiveViewPane` (breadcrumb, `LiveKpiTiles`, `LiveChartCarousel` / `LiveLatencyChart` fed by `live-chart-data.ts` (last carousel page: `LiveSharePage` doughnuts fed by `live-share-data.ts`), `LiveFlowSankey` fed by `live-flow-data.ts`, `LiveBreakdownTable`), `LiveDetailsPanel` + `LiveDetailsParts` (right panel), `useLiveUrlState` (`?live=`), `live-links.ts` (Open session / OTEL tab targets), `live-format.ts` (`formatLiveDuration`, `formatLiveClock`), `live-node-key.ts`, `live.constants.ts`. Exported through `pages/repository/repository-tabs-lazy-group.ts` — [`otel-tabs.md`](otel-tabs.md) § "Live view" |

---

## `viewer/pages/`

`auth-lazy-group.ts` and `workspace-lazy-group.ts` are the barrels behind the Auth and Workspace route
chunks ([code splitting](client-routing-and-layout.md#code-splitting)): a new page joins one of them.

| Folder | Route | Entry | Details |
|---|---|---|---|
| `login/`, `signup/`, `forgot-password/`, `reset-password/`, `confirm-email/` | `#/login` … | `LoginPage.tsx` (mode-aware: identify / password / Azure) | [`user-account-flows.md`](user-account-flows.md), [`authorization-and-authentificaiton.md`](authorization-and-authentificaiton.md) |
| `main/` | `#/main` (Home) | `MainPage.tsx`; the top bar `MainNav.tsx` also lives here | — |
| `main/home/` | — | Home widgets (`HomeWidget.tsx` shell, `home-tones.ts` palette), `useHomeRepos.ts`, `home-queries.ts` | — |
| `map/` | `#/map` (All views) | `MapPage.tsx`; pure model `nav-tree.ts`, questions `nav-questions.ts` (shared with Home) | [`algorithms/nav-filter-match.md`](algorithms/nav-filter-match.md) |
| `repository/` | `#/repos/:id`, `#/teams/:tid/repos/:id` | `RepositoryView.tsx` | [below](#pagesrepository) |
| `teams/` | `#/teams`, `#/teams/:id` | `TeamsPage.tsx`, `TeamDetailPage.tsx`; `tabs/` (members, repositories, invitations), `otel/` (team OTEL tab) | [`otel-tabs.md`](otel-tabs.md) |
| `api-keys/` | `#/api-keys` | `ApiKeysPage.tsx` (Install + API Keys tabs) | [`hook-installation.md`](hook-installation.md) |
| `hook-state/` | `#/repos/:id/hook-state` | `HookStatePage.tsx` | [`hook-installation.md`](hook-installation.md) |
| `admin/` | `#/admin` | `AdminPage.tsx`, one file per tab in `tabs/`, model pricing in `tabs/model-pricing/` | [`system-info-and-cluster.md`](system-info-and-cluster.md), [`upload-queue.md`](upload-queue.md), [`data-retention.md`](data-retention.md) |

### `pages/repository/`

`RepositoryView.tsx` is a thin shell over `useRepositoryViewState.ts` (URL-backed tab / session / filter
state) and `useRepositoryData.ts` (all of the page's queries); `useRepoTeamAccess.ts` decides the
team-wide tabs and the restricted notice, `useSessionListPrefs.ts` keeps the list's `localStorage`
preferences, and `RepositoryTeamWideTabs.tsx` renders every main tab but Sessions. Its main tabs:

| Main tab | Where |
|---|---|
| Sessions | `RepositorySessionsPanel.tsx`: the list in `session-list/` (`SessionListPanel.tsx`, branch / date / user / plain views) + the detail pane `SessionDetailPane.tsx` |
| Analytics | `analytics/` (`RepositoryAnalytics.tsx`, D3 charts, URL state in `analytics-url.ts`) |
| Reports | `reports/` (`ReportsPanel.tsx`, `report-catalog.ts` = the report tree; every report has an on-page document and a react-pdf export, shared PDF primitives in `reports/pdf/`, the Executive Summary in `reports/executive-summary/`) — [`executive-summary-report.md`](executive-summary-report.md) |
| Tools/MCP | `tools/` (`RepoToolsTab.tsx`, also the session Tools/MCP tab) — [`tool-monitoring.md`](tool-monitoring.md) |
| OKF | `okf/` (`RepoOkfTab.tsx`; the tree and cards are shared from `session-log/okf/`) — [`okf-usage.md`](okf-usage.md) |
| OTEL | `otel/` (`RepoOtelTab.tsx` and the OTEL data layer shared with the session and team tabs) — [`otel-tabs.md`](otel-tabs.md) |
| Settings | `RepositorySettings.tsx` + its sub-tab bodies in the same folder; Import/Export in `export-import/` — [`session-export-import.md`](session-export-import.md) |

The **session detail pane** and its tab bar live in this folder, not in `session-log/`:

| File | Role |
|---|---|
| `SessionDetailPane.tsx` | Renders the header and the tab bar; derives the shared usage / code-impact memos; computes the effective lens; routes Refresh (Session Map) |
| `SessionTabContent.tsx` | The active tab's content (one branch per session tab); owns the Logs deep-link turn target and the Summary's change-surface aggregate query |
| `SessionTabBar.tsx`, `SessionLensRow.tsx`, `SessionTabTrigger.tsx` | The one-level tab row with the "More ▾" menu (built on `ui/overflow-row.tsx`) |
| `SessionLensSwitcher.tsx`, `session-lenses.ts`, `useSessionLens.ts` | The "View" select (lens): pure lens model and its URL / per-user storage hook — [`algorithms/session-lens-row.md`](algorithms/session-lens-row.md) |
| `session-tab-groups.ts` | Visible session registry rows with typed tab ids |
| `session-lazy-tabs.ts`, `session-tabs-lazy-group.ts`, `repository-tabs-lazy-group.ts` | The lazy tab chunks — a new heavy tab joins a barrel |
| `SessionDetailHeader.tsx`, `AdvisorTab.tsx`, `SessionNotFoundState.tsx` | Header with attributes, the Advisor tab, the not-found pane |

#### `pages/repository/session-log/`

One folder per session tab; flat files are the Logs tab and the shared parsing. Overview article:
[`session-log-view.md`](session-log-view.md).

| Path | Session tab / role | Details |
|---|---|---|
| `log-parser.ts`, `types.ts`, `tool-calls.ts`, `tool-outcome.ts` | Transcript → turns; the only place that decides a tool call's section and outcome | [`algorithms/tool-call-sections.md`](algorithms/tool-call-sections.md), [`algorithms/tool-call-outcome.md`](algorithms/tool-call-outcome.md) |
| `SessionLogView.tsx`, `PromptTurn*.tsx`, `SubAgent*.tsx`, `Workflow*.tsx`, `workflow-agent-rows.ts` | Logs tab | [`algorithms/workflow-agent-rows.md`](algorithms/workflow-agent-rows.md) |
| `tool-call-view/` | The shared tool-call view (modal, sub-agent detail, step modal, Bash tab) | [`algorithms/bash-command-view.md`](algorithms/bash-command-view.md) |
| `SessionInfoTab.tsx`, `SessionInfo*Section.tsx`, `session-info-derive.ts` | Info tab | — |
| `summary/` | Summary tab (default landing tab): executive band, "Where to look next" cards, detected issues (`summary/detectors/`, thresholds in `detectors/thresholds.ts`) | — |
| `usage/` | Statistics tab (session-scope usage, computed client-side) | [`session-metrics-scope.md`](session-metrics-scope.md) |
| `charts/` | Chart tabs (Dashboard, Context Growth, Context Usage, Agent Tree, Timeline, Tool Heatmap); `chart-tab.ts` = `CHART_TABS` and the last-chart storage | [`llm-call-math.md`](llm-call-math.md) |
| `call-tree/`, `CallTreeView.tsx` | Call Tree tab | — |
| `session-map/` | Session Map tab (realtime / replay, `smSel` URL param, own `logs/delta` poll) | [`session-map.md`](session-map.md) |
| `bash-tab/` | Bash tab (`bashCall` URL param) | [`algorithms/bash-command-view.md`](algorithms/bash-command-view.md) |
| `RawLogsTab.tsx`, `raw-logs/` | Raw Logs tab | [`raw-logs-renderers.md`](raw-logs-renderers.md) |
| `change-surface/` | Change surface tab | [`change-surface.md`](change-surface.md) |
| `harness-usage/` | Harness usage tab | [`harness-usage-tab.md`](harness-usage-tab.md) |
| `sysctx-anatomy/` | System context anatomy tab (`sysctx`) | [`sysctx-anatomy-tab.md`](sysctx-anatomy-tab.md) |
| `okf/` | Session OKF tab; verdict card, bundle cards and tree shared with the repo tab | [`okf-usage.md`](okf-usage.md) |
| `otel/` | Session OTEL tab (traces, waterfall) | [`otel-tabs.md`](otel-tabs.md) |

---

## `viewer/components/`

### Shell & Navigation

| File | Role |
|---|---|
| `AppShell.tsx` | Authenticated shell: `MainNav` + `AppLeftNav` + page area; mounts the Ctrl+K shortcut |
| `AppLeftNav.tsx`, `TeamAccordion.tsx` | Left sidebar: teams tree, My Repos, API Keys, Installed Hooks, Admin link |
| `top-nav/` | `NotificationBell`, `UserMenu`, `ChangePasswordModal`, `AppLogo`, `LiveNavItem` (the OTEL Live entry: glowing activity icon + token sparkline + tooltip from `GET /api/v1/otel/live/status`, lazily mounts `viewer/live/LiveModal`) (the bar itself is `pages/main/MainNav.tsx`) |
| `teams/` | Team access mode: `AccessModeBadge`, `TeamDisclosureModal`, `PendingDisclosureGate` |

### Shared components

`ViewportPopover.tsx` is **the** floating layer — every popup and tooltip positions through it
(`DetailTooltip`, `DefinitionTooltip`, `CostBreakdownTooltip` build on it). Also here: cost markers
(`NoPricingBadge`, `UtilityCallsMarker`, `CostReconciliation`), `PinToggle`, `DateTime`, `PageState`,
`LazyFallback`, `ChartResponsiveContainer`, `DataCollectionConsentScreen`.

---

## `viewer/lib/`

Shared non-React logic and the "single home" modules. Pure helpers here are imported by several
pages; a page-only helper stays next to its page.

| File | Owns |
|---|---|
| `format.ts` | Duration, cost and token formatting, and the client cost math (`computeCost`, via `@loghub/pricing`) — [`repo-local-packages.md`](repo-local-packages.md) |
| `user-storage.ts` | Per-user `localStorage` (`artisyn:<userId>:<name>`) — key list in [`client-routing-and-layout.md`](client-routing-and-layout.md#per-user-browser-storage-keys) |
| `recent-visits.ts`, `useRecentVisits.ts` | Recent repos / sessions (Home, map rail) |
| `home-pins.ts`, `useHomePins.ts` | Home pins (the `home.pins` user setting) |
| `access-mode-copy.ts` | Every user-facing team access-mode string and badge class |
| `cost-hints.ts` | Texts for untrusted / uncomputable costs |
| `feature-flags.ts` | The only reader of `VITE_*` feature flags — [`client-feature-flags.md`](client-feature-flags.md) |
| `settings.ts` | Other `VITE_*` settings (poll interval) |
| `chart-colors.ts`, `cache-ratio-ui.ts`, `change-surface-ui.ts` | Shared chart colours and band legends |
| `semver.ts`, `release-versions.ts` | Version comparison for the Claude Code version checks — [`claude-version-check.md`](claude-version-check.md) |
| `bash-view/` | Loader of the tree-sitter Bash parser (logic is `packages/bash-view`) |
| `okf/`, `tools/` | Strings shared by the OKF tabs; string truncation |

---

## Where things are not where the name suggests

| You want to change… | Look in… |
|---|---|
| A tab's label, order, group or visibility (any page) | `viewer/tab-ids.ts` |
| The top bar | `pages/main/MainNav.tsx` (not `components/`) |
| The session tab bar, lens / "View" select | `pages/repository/` (`SessionTabBar.tsx`, `session-lenses.ts`), not `session-log/` |
| Which section a tool call shows in, or its ok / error status | `session-log/tool-calls.ts`, `session-log/tool-outcome.ts` |
| A popup or tooltip position | `components/ViewportPopover.tsx` |
| A route path or route access | `app-routes.ts`, then `main.tsx` |
| A link to a route | `hooks/useHashRoute.ts` (`routes.*`) |
| An API call | `viewer/api.ts`, types in `models/` |
| Cost math | `viewer/lib/format.ts` → `packages/pricing` (never a second rate table) |
| A Bash command's analysis or layout | `packages/bash-view/src/` (shared with the server) |
| Help article text | `user-docs/` (`client/public/help/` is generated) |
