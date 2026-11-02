---
type: "Architecture Guide"
title: "Client Component Hierarchy"
description: "React SPA routing, layout, provider hierarchy, major page components, the All views map route and Ctrl+K door, per-user browser storage keys, cross-component window events, location.state tab seeding and data-fetching patterns."
tags:
  - client
  - routing
timestamp: "2026-11-02T00:00:00+04:00"
---

# Client Component Hierarchy

React/Vite SPA at `client/src/`. Entry point: `client/src/main.tsx`.

---

## Top-level bootstrap (`main.tsx`)

```
QueryClientProvider (react-query)
  AuthProvider          — provides UserProfile via useAuth()
    RouterProvider      — react-router-dom createHashRouter
      Bootstrap         — calls fetchMe(), prefetches the consent queries, shows spinner
        AuthGuard       — redirects unauthenticated users to /login
          AppLayout     — consent gate: notice screen OR AuthedApp
            AuthedApp   — wraps AppShell around route pages; runs the new-user nudge
              AdminGuard — wraps admin-only routes; redirects non-admins to /main
```

`Bootstrap` resolves auth state before rendering routes. `AuthGuard` redirects to `/login` (with saved `from` location). `AdminGuard` redirects non-admins to `/main`.

### The data-collection consent gate

`AppLayout` calls `useDataCollectionConsent()` and, while it returns `'required'`, renders `<DataCollectionConsentScreen />` **instead of** `<AppShell><Outlet /></AppShell>` — it replaces the app rather than overlaying it. Consequences worth knowing:

- No top nav, no left nav and no page content exist behind the notice, and none of the shell's data queries fire. "Not bypassable by navigating directly to another route" is therefore structural, not behavioural — a deep link to `/#/api-keys` renders the same screen.
- The gate sits inside `AuthGuard`, so it never appears on `/login` or `/signup`.
- `Bootstrap` prefetches `['user-settings']`, `['consent-notice']` and `['retention-days']` (all defined once in `viewer/lib/consent-queries.ts`, all `staleTime: Infinity`) before flipping its status to `ok`. The gate therefore decides from cache at first paint: no second spinner, and no flash of the app for a user who has not accepted — nor of the notice for one who has.
- The accepted branch renders `AuthedApp`, a separate component purely so `useNewUserNudge()` is never called conditionally. That hook sends a user with zero repos and zero teams to `/#/api-keys` once per browser session.
- Acceptance is stored as one `user_settings` row (`dataCollectionNotice`) holding the hash of the notice text accepted; editing `user-docs/data-collection-notice.md` (copied byte-for-byte to the generated `client/public/help/data-collection-notice.md`) re-asks every user exactly once. `tests/e2e/global.setup.ts` writes that row for all five storageState roles — without it every existing spec would sit behind the notice.

---

## Hash-based routing (react-router-dom `createHashRouter`)

Routing uses `react-router-dom`'s `createHashRouter`. Path helpers are in `viewer/hooks/useHashRoute.ts` (`routes` object). Navigation uses `useNavigate()` from react-router-dom; in-page URL state uses `useSearchParams()`. No custom `parseHash()` exists.

| Hash pattern | Page component |
|---|---|
| `#/login` | `LoginPage` |
| `#/signup` | `SignupPage` |
| `#/forgot-password` | `ForgotPasswordPage` (public) |
| `#/reset-password` | `ResetPasswordPage` (public) |
| `#/confirm-email` | `ConfirmEmailPage` (public) |
| `#/main` | `MainPage` (Home) |
| `#/map` | `MapPage` (All views map; `teamId`, `repoId`, `session` prefill the context rail, `q` is the filter) |
| `#/teams` | `TeamsPage` |
| `#/teams/:teamId` | `TeamDetailPage` |
| `#/repos/:repoId` | `RepositoryView` |
| `#/teams/:teamId/repos/:repoId` | `RepositoryView` |
| `#/repos/:repoId/hook-state` | `HookStatePage` |
| `#/api-keys` | `ApiKeysPage` |
| `#/admin` | `AdminPage` (admin only — `AdminGuard` redirects non-admins to `/main`) |

> Any unmatched route redirects to `/main`. `RepositoryView` reads `repoId` and optional `teamId` via `useParams()`, not props.

Every route except `RepositoryView` loads lazily; see [Code splitting](#code-splitting).

---

## Code splitting

The client bundle is split into a small, fixed set of lazily loaded chunks, each one a `React.lazy()` boundary
placed where its code is first needed. The budget is about 8 dynamically loaded chunks and never more than 10:
related small pages are grouped into one chunk instead of lazy-loading each file.

There are 9 distinct `import()` targets: 3 route chunks (Auth, Workspace, Admin), the Help chunk, the
repository-tabs chunk, the Reports chunk, the session-tabs chunk, and the two Bash parser chunks
(`browser-parser` and the `web-tree-sitter` runtime it loads). A new page or tab joins an existing barrel instead of adding an
`import()`.

**Route chunks** (`client/src/main.tsx`). Every route in the table above except `RepositoryView` is
`React.lazy()`-loaded and wrapped in `<Suspense fallback={<LazyFallback fullScreen />}>` by a local
`withSuspense()` helper:

| Chunk | Contents | How it is grouped |
|---|---|---|
| Auth | `LoginPage`, `SignupPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `ConfirmEmailPage` | barrel `viewer/pages/auth-lazy-group.ts` |
| Workspace | `MainPage`, `TeamsPage`, `TeamDetailPage`, `ApiKeysPage`, `MapPage`, `HookStatePage` | barrel `viewer/pages/workspace-lazy-group.ts` |
| Admin | `AdminPage` and its tabs | own `import()` |

Grouping uses barrel files because Rollup merges dynamic-import targets only when they share the same
`import()` specifier. One `import()` per page file would produce one tiny chunk per page.

**In-page chunks.** The heavy tabs are boundaries inside their host page, each `lazy()` in its own
`<Suspense fallback={<LazyFallback />}>` (not full-screen, so it fills the tab content area), and grouped
into two barrels:

| Chunk | Contents | Barrel |
|---|---|---|
| Repository tabs | `RepositoryAnalytics`, `RepoToolsTab`, `RepoOkfTab`, `RepoOtelTab` (`RepositoryView`; `RepoToolsTab` is also the session Tools/MCP tab) | `pages/repository/repository-tabs-lazy-group.ts` |
| Reports | `ReportsPanel` — kept apart because it carries the PDF and zip export libraries (~1.4 MB), which the light tabs above must not download | own `import()` in `RepositoryView` |
| Session tabs | `SessionChartsTab`, `SessionChangeSurfaceTab`, `SessionHarnessUsageTab`, `SessionOkfTab`, `SessionSysctxAnatomyTab`, `SessionOtelTab`, `SessionBashTab` (`SessionDetailPane`, through `session-lazy-tabs.ts`) | `pages/repository/session-tabs-lazy-group.ts` |

The code is fetched when the first tab of a group opens; the other tabs of that group then open with no
further request. Shared heavy dependencies (recharts and the like) are split out by Rollup on its own.

**Bash parser chunk.** The Bash command view's tree-sitter parser (`web-tree-sitter` runtime ~210 KB WASM and
the `tree-sitter-bash` grammar ~1.36 MB WASM, `client/src/viewer/lib/bash-view/browser-parser.ts`) is reached
only through `import()` from `useBashView`, so it loads the first time a Bash call is shown (Logs modal,
Context Growth step modal or Bash tab), never with the main bundle. The `.wasm` files are Vite `?url` assets;
`vite.config.ts` excludes `web-tree-sitter` from `optimizeDeps`. The Bash tab's count in the tab bar needs no
WASM (`collectBashCalls` is pure).

**Help chunk.** `HelpModal` (with `react-markdown` and `remark-gfm`) is lazy in `MainNav.tsx`, but it is
mounted only after `helpLoaded` flips true on the first click. `helpOpen` and `helpLoaded` are separate flags so
that closing the modal does not unmount it and cut off the exit animation, and re-opening does not refetch. Its
`Suspense fallback` is `null`, because there is no visible chrome yet to show a spinner in.

### Rejected alternatives

- A hand-rolled `manualChunks` vendor split is not used, because Rollup already splits out and dedupes shared
  dependencies across `import()` boundaries once those boundaries exist. The heavy code (recharts, the PDF and
  zip export libraries, the session charts) sits behind the route and tab boundaries above, so a user who only
  opens `/main` or the Admin panel does not download it.
- One lazy chunk per page file is not used, because it multiplies small requests without deferring more code.

---

## AppShell layout (authenticated app shell)

Used by all authenticated routes.

```
AppShell
  MainNav                     — top bar: logo, title, Home, All views, Help, NotificationBell, user email / account menu
  AppLeftNav                  — collapsible, resizable left sidebar (default 320px)
    TeamNavItem[]             — collapsible team rows; fetches team repos on expand
    [My Repos section]        — flat list of user's own repos
    [API Keys link]
  <page content>              — flex-1 area, route-dependent
```

### `MainNav`
Top bar: app title, "Home" button on the left next to the title (`nav-home`, navigates to `routes.main`; `aria-current="page"` + `bg-accent` while on Home), then right-aligned `AccessModeBadge` (team routes only), "All views" button (`nav-all-views`, light tooltip "All views (Ctrl+K)"), Help button (`HelpCircle` icon — opens `HelpModal`), `NotificationBell`, then, under `AUTH_MODE=none`, user email from `useAuth()` plus an "Edit email" button (calls `logout()` API then redirects to `#/login`); in every other mode the `UserMenu` account menu (Log out, Change password, Delete account).

### The All views map and its doors (`/map`, Ctrl+K)
`MapPage` (`pages/map/`, in the Workspace chunk) is the tree of every view; its model is the pure `nav-tree.ts` (`buildNavTree`, `matchNavFilter`) plus `nav-questions.ts` (`NAV_QUESTIONS`, shared with Home). Two doors open it, both through `useOpenAllViews()` in `hooks/useAllViewsShortcut.ts`:

- the `MainNav` "All views" button, and
- **Ctrl/Cmd+K**: `useAllViewsShortcut()`, mounted once in `AppShell`, adds a capture-phase `window` keydown listener for `(ctrlKey||metaKey) && !altKey && !shiftKey && key 'k'`. It calls `preventDefault()` (suppressing the browser's own Ctrl+K) and works inside text inputs too. No other key is handled.

A door calls `navigate(routes.map(mapParamsFromLocation(pathname, search)), { state: { from: pathname + search } })`, so the rail is prefilled with the current route's team / repository / session. On `/map` it does not navigate; it dispatches `MAP_FOCUS_FILTER_EVENT` (`'loghub:map-focus-filter'`) and the map focuses its filter. Esc on an empty filter or "Back" calls `navigate(-1)` when `state.from` is set (`isMapOpenState`), else goes to `routes.main`. The `q` param is synced with `setSearchParams(…, { replace: true })`.

### `AppLeftNav`
Left sidebar, collapsible and resizable; `AppShell` owns its width. A toggle button above the nav collapses
it to a 48px icon rail and expands it again. While expanded, the drag handle on its right border resizes it between
150px and 80% of the viewport (default 320px, `useDraggableWidth`). Both states persist in `localStorage`
(`artisyn:leftNavCollapsed`, `artisyn:leftNavWidth`), and the stored width is clamped to 80% of the current
viewport on render. Sections:
- **Teams** — lists teams from `GET /api/v1/teams`. Each team is a `TeamNavItem` that expands to show repos (fetched lazily from `GET /api/v1/teams/:id/repositories`). Navigates to `#/teams/:id/repos/:rid`.
- **My Repos** — repos from `GET /api/v1/repositories`. Navigates to `#/repos/:id`.
- **API Keys** link.
- **Installed Hooks** — collapsible section below the API Keys link, gated by `useQuery(['api-keys'])` (hidden until the user has >=1 API key). Rows from `useQuery(['hook-repos'])` → `GET /api/v1/repositories/hooks`; orange row/dot + "N issue(s)" when `issueCount > 0`, green dot + "OK" otherwise. Navigates to `#/repos/:id/hook-state` (`HookStatePage`).

Active item is highlighted. Scrolls active item into view on route change.

---

## Page components

### `RepositoryView` (`pages/repository/RepositoryView.tsx`)
Main content for a repository. Reads `repoId` and optional `teamId` from react-router-dom `useParams()`; no props.

**Header bar** — shows `repoUrl` (read from react-query cache), session count, user count (from `/summary`), then all context key:value pairs (from `/contexts`).

**Data fetching:**
- `useQuery(['repo-sessions', repoId, teamId])` → `GET /api/v1/repositories/:id/sessions`
- `useQuery(['repo-summary', repoId, teamId])` → `GET /api/v1/repositories/:id/summary`
- `useQuery(['repo-contexts', repoId, teamId])` → `GET /api/v1/repositories/:id/contexts`
- `useQuery(['session-contexts', repoId, sessionId, teamId])` → `GET /api/v1/repositories/:id/sessions/:sid/contexts` (enabled when session selected)
- `useQuery(['session-logs', repoId, sessionId, teamId])` → `GET /api/v1/repositories/:id/sessions/:sid/logs` (enabled when Logs tab active)

**Tab layout** via `PageTabs`:
- **Sessions tab** — left column: scrollable session list (date, first prompt, branch); right panel:
  - **Top summary strip** (always visible when session selected): start time, end time, user email, session context key:value pairs.
  - **Inner tab bar** (`SessionTabBar.tsx`, rows in `tab-ids.ts` `TAB_REGISTRY` / `SESSION_TABS`, group order): one level of tabs. Registry order (also the "More ▾" section order): Overview (Summary, Info, Statistics, [Advisor]) · Transcript (Logs, Bash, [Raw Logs]) · Cost & context (Charts dashboard, Context Growth, Context Usage, Agent Tree, Timeline, Tool Heatmap, Call Tree, System context anatomy, Harness usage, OTEL) · Effects (Change surface, Tools/MCP, OKF); the row shows the lens's tabs (below). The seven charts are plain session tabs (`CHART_TABS`); `tab=charts` is a legacy alias the pane redirects to the last chart shown (`charts-sub-tab`, else `dashboard`).
    - **Logs tab** (`SessionLogView`): structured prompt-turn list, headed by the one-line `StartupContextLine` (startup token total + "View anatomy →" link to the `sysctx` tab).
    - **Bash tab** (`SessionBashTab`, tab id `bash`): every Bash command of the session tree (main + sub-agents) in a keyboard-navigable list, with the readable command view of the selected one. The selected call lives in the `bashCall` search param (`useBashCallParam`, `setSearchParams(next, { replace: true })`); a missing or unknown id selects the first row without rewriting the URL.
    - **Call Tree tab** (`CallTreeView`): hierarchical token-cost breakdown tree (System Context → Prompt turns → per-turn children). Token counts and cost-share percentages with progress bars. Expandable rows for prompt turns, groups (Skills, Rules, Code, Docs), and sub-agent rows.
    - **Chart tabs** (`SessionChartsTab chart={id}`): Dashboard, Context Growth, Context Usage, Agent Tree, Timeline, Tool Heatmap and Call Tree, each its own `tab=` value.
    - **Info tab** (`SessionInfoTab`): session metadata panel with sections — Identity, Timeline, Activity, Tokens & Cost, Files & Tools, MCP Usage, Vision, Productivity, CLAUDE.md Context.
    - **Usage tab** (`SessionUsageTab`): transcript-derived analytics for this session only — productivity counters, per-tool table, cache-TTL/service-tier breakdown, iterations drill-down. Computed client-side from the already-fetched `/logs` payload; carries only figures not already shown by the Tool Heatmap chart tab or Info → Tokens & Cost.
    - **Raw Logs tab** (`RawLogsTab`): Kibana-style table of all raw log entries.
    - **System context anatomy tab** (`SessionSysctxAnatomyTab`, tab id `sysctx`, in the Cost & context group): the first request's startup context split into estimated partitions with drill-downs, git status and Harness internals; lazy, computed client-side from the `/logs` `main` + `harnessSnapshot` — see `sysctx-anatomy-tab.md`.
  - Tab value is persisted in URL search params so it is bookmarkable.
  - **Lens** (`lens=` URL param, `session-lenses.ts`, DD-7): the `SessionLensSwitcher` "View" select at the start of the tab row picks `what-happened` / `cost` / `harness` / `failed-tool` / `all`. The bar always has one row (`SessionLensRow`): the lens's promoted tabs (`all` = every visible tab), the out-of-lens active tab after a divider, and every other tab in "More ▾" under its group heading. There is no group row and no sub-tab bar. Effective lens = valid `lens=` → the per-user `session-lens` storage item → `cost`. A lens switch writes `lens` and the lens's default tab in one `replace` (`switchLens`) and stores `session-lens`; every other tab change (`setSessionTab`) leaves `lens` alone. Loading never writes a lens or a tab: no `tab=` opens Summary under every lens, an explicit `tab=` always wins. `lens` survives session switches and is dropped with `tab` when leaving the Sessions tab or closing the session.
  - **Per-user storage** (`lib/user-storage.ts`, key `artisyn:<userId>:<name>`): `session-lens` (last picked lens id).
- **Analytics tab** — `RepositoryAnalytics` component with date range picker, group-by, bar/horizontal chart layouts, and view selector (work-time/cost/files/vision/mcp/productivity/log-lines/cache-read-ratio/tools/tokens/productivity-counters/active-sessions — the last four are usage-analytics table views, not charts).
- **Settings tab** — `RepositorySettings` modal for team/user file-category config.

### `HookStatePage` (`pages/hook-state/HookStatePage.tsx`)
Standalone page (not a `RepositoryView` tab). Reads `repoId` via `useParams()`. `useQuery(['hook-state', repoId])` → `fetchHookState`. Renders, in order: header (repo URL) with a manual refresh button; `HookStatusCard` (orange/green status summary — installed vs. latest version, last activity, "Copy upgrade cmd" button); Recommendations card; Non-uploadable logs table; Errors & warnings list; a dark monospace hook-log-tail `<pre>` block (intentional dark-surface exception — see `ui-principles.md`). 404/403 responses render "not reported yet" / "No access" via `PageState`.

### `TeamDetailPage` (`pages/teams/TeamDetailPage.tsx`)
Detail view for a team. Uses `PageTabs` with the `TEAM_TABS` rows of the registry: **Members**, **Repositories**, **Invitations** and, with team-wide access, **OTEL**. The initial tab is seeded from `location.state.teamTab` (see [location.state tab seeding](#locationstate-tab-seeding)).
- Members tab: list with inline role/invite controls, transfer ownership.
- Repositories tab: list team repos, add from URL or from "My Repos", remove.
- Invitations tab: `TeamInvitationsTab` sub-component — send/cancel invitations.

### `TeamsPage` (`pages/teams/TeamsPage.tsx`)
List of all teams; click navigates to `TeamDetailPage`. Owner can delete.

### `ApiKeysPage` (`pages/api-keys/ApiKeysPage.tsx`)
Manage personal API keys (create, list, delete) and the hook install guide (`API_KEYS_TABS`: Install, Keys). The initial tab is seeded from `location.state.apiKeysTab`.

### `AdminPage` (`pages/admin/AdminPage.tsx`)
Admin-only panel. Wraps content in `<TooltipProvider>`. Uses `PageTabs` with the `ADMIN_TABS` rows of the tab registry (`visibleTabs('admin', { isAdmin })`), in this order: System Info, Repos, Teams, Users, Error Logs, Upload Queue (`AdminUploadQueueTab`), Data Retention (`AdminDataRetentionTab`), Auth (`AdminAuthTab`), Model Pricing (`AdminModelPricingTab`). The first five:
- **All Repos** (`AdminReposTab`) — all repositories with owner, session count, last session, first seen. Filter by URL substring.
- **All Teams** (`AdminTeamsTab`) — all teams with owner, member count, repo count. Filter by name.
- **All Users** (`AdminUsersTab`) — all users with role, team count, last activity. Filter by email. Each row has a role-toggle button (Make Admin / Revoke Admin). Self-row button is disabled with a tooltip.
- **System Info** (`AdminSystemTab`) — live server/cluster-worker metrics (10 s auto-refresh via `GET /api/v1/admin/system`); see `system-info-and-cluster.md` for the full subsystem.
- **Error Logs** (`AdminErrorLogsTab`) — server app-log `ERROR` entries fetched once per tab open (no auto-refresh) via `GET /api/v1/admin/error-logs`; columns: Timestamp, Source, Message (with details line).

The Repos/Teams/Users tabs use `AdminDataTable` (TanStack Table + Shadcn `viewer/ui/table.tsx` primitives). Sorting is client-side; filtering is debounced 300 ms global filter restricted to the name/URL/email column. The System Info tab is not a filterable data table — it renders live metric cards plus a per-instance breakdown table.

**Route guard** (`AdminGuard` in `main.tsx`): reads `user` from `useAuth()`; redirects to `/main` if `user.role !== 'admin'`. Placed as a wrapper route inside `AppLayout` children before the `*` catch-all.

**Left nav**: `AppLeftNav` renders a `ShieldCheck` icon link to `#/admin` only when `user.role === 'admin'` — in both expanded (labeled "Admin Panel") and collapsed (icon-only) variants.

### `LoginPage` / `SignupPage`
Auth forms. On success set user via `useAuth()` and redirect.

### `MainPage`
Home: repository entries, questions, Needs attention, This week, Pinned and Recent widgets (`pages/main/home/`, see `client-component-map.md`); Get started when the viewer has no repositories and no teams.

---

## Shared UI components

### `PageTabs` / `PageTabsContent` (`ui/page-tabs.tsx`)
Thin wrapper over Radix UI Tabs with `variant="line"` style.

```tsx
<PageTabs
  tabs={[{ value: 'foo', label: 'Foo' }, ...]}
  value={activeTab}
  onValueChange={setActiveTab}
>
  <PageTabsContent value="foo">...</PageTabsContent>
</PageTabs>
```

`PageTabsContent` is re-exported directly as `TabsContent`. Used in `RepositoryView` and `TeamDetailPage`.

### `NotificationBell` (`components/top-nav/NotificationBell.tsx`)
Bell icon with pending invitation count badge. Fetches `GET /api/v1/invitations` and shows accept/decline actions in a popover.

### `HelpModal` (`help/HelpModal.tsx`)
Full-screen dialog opened from the Help button in `MainNav`. Left sidebar lists help articles grouped by section. The navigation comes from the repo-root `user-docs/nav.json` (the shared page set of the in-app help and the site, see [user-docs-and-site.md](user-docs-and-site.md)), imported by `help/articles/index.ts` through the `@loghub/user-docs` alias and exported as `helpNav`. Right pane renders the selected Markdown article via `ReactMarkdown` + `remark-gfm`, with `rehype-slug` giving every heading a GitHub-style id. Articles are static files served from `public/help/<slug>.md`, which is **generated** from `user-docs/` by `scripts/user-docs/generate-help.js` (gitignored — never edit it); `HelpModal` fetches the active article at runtime via `fetch('/help/<slug>.md')`. Default article is `DEFAULT_HELP_SLUG = 'getting-started'` ("Your first session"). Links in an article go through `help/HelpMarkdownLink.tsx` (parsing in the pure `parseHelpHref` of `help/help-links.ts`): `#anchor` scrolls to that heading in the content pane (missing id → no-op); `<slug>.md[#anchor]` with a known slug switches the article (and the menu highlight) and, after it renders, scrolls to the anchor or to the top (`pendingAnchor` state); an unknown slug only logs `console.warn('[help] unknown help page: …')`; `http(s):`/`mailto:` links open in a new tab (`target="_blank" rel="noopener noreferrer"`) with a trailing ` ↗`. `React.lazy()`-loaded from `MainNav.tsx`, its own chunk — see [Code splitting](#code-splitting).

---

## Contexts

| Context | File | Provides |
|---|---|---|
| `AuthContext` | `context/AuthContext.tsx` | `user: UserProfile \| null`, `setUser` |

---

## Models (`src/models/`)

Type-only files mirroring API response shapes. Not imported by server code.

| File | Types |
|---|---|
| `auth.ts` | `UserProfile` |
| `teams.ts` | `Team`, `TeamMember`, `TeamRepository`, `Invitation` |
| `repositories.ts` | `RepositoryContext`, `RepositorySession`, `RepositorySummary`, `BranchSummary`, `TimelineSession`, `WorkTimeBucket`, `RepoConfig`, `FileCategory` |
| `admin.ts` | `AdminRepo`, `AdminTeam`, `AdminUser` |
| `pricing.ts` | `ModelPricingEntry`, `ModelPricingMap` |

---

## Key patterns

**API fetching** — all API calls go through `src/viewer/api.ts`. The internal `apiFetch` wrapper redirects to `#/login` on 401. All data is cached via react-query (`useQuery` / `useMutation`).

**Tab navigation** — `RepositoryView` and `AdminPage` use URL-backed tab state via `useSearchParams()` (see `useRepositoryViewState.ts` and `useAdminTabState.ts`) so the active tab is bookmarkable/shareable and survives refresh. `TeamDetailPage.tsx` and `ApiKeysPage.tsx` are exceptions — they keep local `useState` tab state, seeded once from `location.state` (below).

### `location.state` tab seeding
Team and API-keys tabs have no URL param. A link that must open a specific tab (an All views map leaf, Home's Get started "Install the hook") passes it as router state: `navigate(path, { state: { teamTab } })` / `{ state: { apiKeysTab: 'install' } }` (or `<Link state>`). `TeamDetailPage` (`initialTeamTab`) and `ApiKeysPage` (`initialApiKeysTab`) read `location.state` once as the `useState` initial value and accept it only when it is a valid `TEAM_TABS` / `API_KEYS_TABS` id; anything else falls back to the first tab. No URL param is added, so a reload keeps the tab only while the history entry keeps its state.

### Per-user browser storage keys
`lib/user-storage.ts` (`readUserItem` / `writeUserItem` / `removeUserItem`, every access in try/catch, a parse failure reads as `undefined`) stores per-user items in `localStorage` under `artisyn:<userId>:<name>`; the user id is `useAuth().user.id`, and without a user nothing is read or written.

| Name | Value | Written by |
|---|---|---|
| `session-lens` | last picked lens id | `useSessionLens` (used by `SessionDetailPane`) on a lens switch |
| `recent-visits` | `{v:1, repos[], sessions[]}`, at most 10 + 10 (`recent-visits.ts`) | `RepositoryView` via `useRecentVisits` |
| `map-expanded` | string[] of expanded map node ids | `MapTree` |

Other browser keys: `artisyn:leftNavCollapsed` / `artisyn:leftNavWidth` (not per user, `AppLeftNav`) and `charts-sub-tab` (`CHART_TAB_STORAGE_KEY`, the last chart tab shown, read only by the legacy `tab=charts` redirect). Home pins are not in the browser: they are the `home.pins` user setting (`saveUserSetting`, `useHomePins`), so they follow the user across browsers.

### Cross-component window events
| Event | Dispatched by | Listener | `detail` |
|---|---|---|---|
| `loghub:map-focus-filter` (`MAP_FOCUS_FILTER_EVENT`) | a map door used while on `/map` | `MapPage` focuses its filter | — |

**Hash routing** — uses `react-router-dom`'s `createHashRouter`. `viewer/hooks/useHashRoute.ts` exports only the `routes` path-builder object (e.g. `routes.repo(id)`, `routes.teamRepo(tid, rid)`). Page navigation uses `useNavigate()` from react-router-dom with `routes.*` paths. In-page URL sync (tabs, filters, selected item) uses `useSearchParams()`: copy the current params, mutate the copy, then call `setSearchParams(next, ...)`. Never set `window.location.hash` directly.

- **Opening a session pushes history.** `handleSessionSelect` (`useRepositoryViewState.ts`) calls `setSearchParams(next)` **without** `replace`, so Back returns to the previously open session.
- **Every other param replaces.** The tab, top-N and users-filter setters keep `{ replace: true }`, so switching tabs or filters creates no history entry.
- **The URL `session` param is the only source of the selected session.** `useRepositoryData.ts` uses the branch-local selection only while its `sessionId` equals the URL's; otherwise the session is resolved from the sessions query, and `RepositoryView.tsx` clears a stale branch selection. Back/forward and hand-edited `?session=` therefore switch the pane without a reload.
- **The detail pane is keyed by session.** `RepositorySessionsPanel.tsx` renders `<SessionDetailPane key={selectedSession.sessionId}>`, so a session change remounts it and resets all per-tab local state — no per-tab reset code is needed.
- **Not-found state.** When `session` is set, the sessions query has settled (success, or 403/404) and no listed session (nor the matching branch query) has that id, the pane shows `SessionNotFoundState`. Its Close removes `session` and `tab` with `{ replace: true }`. With no `session` param the "Select a session…" placeholder stays.

**Left nav lazy loading** — team repositories are fetched only when the team node is expanded (`enabled: isExpanded`). The active item is scrolled into view after route changes.
