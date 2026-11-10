---
type: "Architecture Guide"
title: "Client Component Hierarchy"
description: "React SPA routing, layout, provider hierarchy, major page components, the All views map route and Ctrl+K door, per-user browser storage keys, cross-component window events, location.state tab seeding and data-fetching patterns."
tags:
  - client
  - routing
timestamp: "2026-11-10T00:00:00+04:00"
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
| Repository tabs | `RepositoryAnalytics`, `RepoToolsTab`, `RepoOkfTab`, `RepoOtelTab` (`RepositoryTeamWideTabs`; `RepoToolsTab` is also the session Tools/MCP tab), `SpendTab` (repository and team Spend tab; no own chunk), and `LiveModal` (the OTEL Live view, lazy in `LiveNavItem` — it shares the OTEL chart code and Recharts, so no own chunk) | `pages/repository/repository-tabs-lazy-group.ts` |
| Reports | `ReportsPanel` — kept apart because it carries the PDF and zip export libraries (~1.4 MB), which the light tabs above must not download | own `import()` in `RepositoryTeamWideTabs` |
| Session tabs | `SessionChartsTab`, `SessionChangeSurfaceTab`, `SessionHarnessUsageTab`, `SessionOkfTab`, `SessionSysctxAnatomyTab`, `SessionOtelTab`, `SessionBashTab` (`SessionTabContent`, through `session-lazy-tabs.ts`) | `pages/repository/session-tabs-lazy-group.ts` |

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
Top bar: app title, "Home" button on the left next to the title (`nav-home`, navigates to `routes.main`; `aria-current="page"` + `bg-accent` while on Home), then `LiveNavItem` (the OTEL "Live" button with a red dot while something is live; see § "The `live` param" below), then right-aligned `AccessModeBadge` (team routes only), "All views" button (`nav-all-views`, light tooltip "All views (Ctrl+K)"), Help button (`HelpCircle` icon — opens `HelpModal`), `NotificationBell`, then, under `AUTH_MODE=none`, user email from `useAuth()` plus an "Edit email" button (calls `logout()` API then redirects to `#/login`); in every other mode the `UserMenu` account menu (Log out, Change password, Delete account).

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

Which folder and file holds each page: [`client-component-map.md`](client-component-map.md). This
section covers only the page-level behaviour that the files do not make obvious.

### `RepositoryView` (`pages/repository/RepositoryView.tsx`)
Reads `repoId` and optional `teamId` from `useParams()`; no props. A thin shell: URL-derived state is in
`useRepositoryViewState.ts`, every query of the page in `useRepositoryData.ts` (query keys
`['repo-sessions' | 'repo-summary' | 'repo-contexts', repoId, teamId]`,
`['session-logs', repoId, sessionId, teamId]`, …). Main tabs (`mtab`, `REPO_MAIN_TABS`): Sessions,
Analytics, Spend, Reports, Tools/MCP, OKF, OTEL, Settings; all but Sessions and Spend only where
`canSeeTeamWideTabs` allows.

**Spend tab** (`mtab=spend`) — its `PageTabsContent` is rendered **outside** `RepositoryTeamWideTabs` and
its registry row has no `visible` predicate, so a plain member of a restricted team reaches it (the server
answers with an own-spend `restricted` view; see [budgets.md](budgets.md)). The tab fallback keeps
`spend` like `sessions` when `canSeeTeamWideTabs` is false. URL params (`useSpendUrlState.ts`):
`sp=day|week|month` (default `month`, dropped from the URL) and `so=<offset ≤ 0>` (default 0, clamped to
`[-400, 0]`); a period change resets `so`. Writes use `{ replace: true }`. The same params drive the
team Spend tab. Settings › Budgets is `stab=budgets`; a budget notice opens
`#/repos/:id?mtab=spend&sp=…&so=…`, its team-repo variant, or `#/teams/:id?ttab=spend&…`
(`budgetNoticePath` in `pages/budgets/budget-format.ts`).

**Sessions tab** — session list on the left, `SessionDetailPane` on the right.

- **Session tabs** come from the tab registry (`tab-ids.ts` `TAB_REGISTRY` / `SESSION_TABS`): labels,
  groups (Overview · Transcript · Cost & context · Effects, also the "More ▾" section order) and
  visibility live there, not in the pane. The chart views are plain session tabs (`CHART_TABS`);
  `tab=charts` is a legacy alias the pane redirects to the last chart shown (`charts-sub-tab`, else
  `dashboard`). Heavy tabs load lazily (see [Code splitting](#code-splitting)).
- **Lens** (`lens=` URL param, `session-lenses.ts`, DD-7): the `SessionLensSwitcher` "View" select at the start of the tab row picks `what-happened` / `cost` / `harness` / `failed-tool` / `all`. The bar always has one row (`SessionLensRow`): the lens's promoted tabs (`all` = every visible tab), the out-of-lens active tab after a divider, and every other tab in "More ▾" under its group heading. There is no group row and no sub-tab bar. Effective lens = valid `lens=` → the per-user `session-lens` storage item → `cost`. A lens switch writes `lens` and the lens's default tab in one `replace` (`switchLens`) and stores `session-lens`; every other tab change (`setSessionTab`) leaves `lens` alone. Loading never writes a lens or a tab: no `tab=` opens Summary under every lens, an explicit `tab=` always wins. `lens` survives session switches and is dropped with `tab` when leaving the Sessions tab or closing the session.
- Tab-specific behaviour is in each tab's own article (index in [`client-component-map.md`](client-component-map.md#pagesrepositorysession-log)).

### `HookStatePage` (`pages/hook-state/HookStatePage.tsx`)
Standalone page (not a `RepositoryView` tab). Reads `repoId` via `useParams()`. `useQuery(['hook-state', repoId])` → `fetchHookState`. Renders, in order: header (repo URL) with a manual refresh button; `HookStatusCard` (orange/green status summary — installed vs. latest version, last activity, "Copy upgrade cmd" button); Recommendations card; Non-uploadable logs table; Errors & warnings list; a dark monospace hook-log-tail `<pre>` block (intentional dark-surface exception — see `ui-principles.md`). 404/403 responses render "not reported yet" / "No access" via `PageState`.

### `TeamDetailPage` and `ApiKeysPage`
`TEAM_TABS`: Members, Repositories, Invitations, Spend (every member) and, with team-wide access
(`canSeeOtel`), OTEL and Settings (the team Budgets section). The team tab is URL-backed: `ttab=<TeamTab>`
(`useTeamTabState` in `TeamDetailPage.tsx`), else the `location.state` seed, else `members`; a seed is
written into `ttab` once with `replace`, so the tab survives a refresh, and the default tab is dropped from
the URL. The team Spend tab uses the same `sp` / `so` params as the repository one.
`API_KEYS_TABS` (Install, Keys) stay local `useState`, seeded once from `location.state` (see
[location.state tab seeding](#locationstate-tab-seeding)).

### `AdminPage` (`pages/admin/AdminPage.tsx`)
Admin-only panel; tabs from `visibleTabs('admin', { isAdmin })` (`ADMIN_TABS`), URL-backed via `useAdminTabState`. The Repos / Teams / Users tabs use `AdminDataTable` (TanStack Table): client-side sort, a debounced 300 ms filter on the name / URL / email column. System Info: [`system-info-and-cluster.md`](system-info-and-cluster.md).

**Route guard** (`AdminGuard` in `main.tsx`): redirects to `/main` if `user.role !== 'admin'`; placed inside `AppLayout` before the `*` catch-all. `AppLeftNav` shows the `ShieldCheck` "Admin Panel" link only to admins.

### `MainPage`
Home: repository entries, questions, Needs attention, This week, Pinned and Recent widgets (`pages/main/home/`); Get started when the viewer has no repositories and no teams.

---

## Shared UI components

### `HelpModal` (`help/HelpModal.tsx`)
Opened from the Help button in `MainNav`, `React.lazy()`-loaded, its own chunk (see [Code splitting](#code-splitting)). The left nav is the repo-root `user-docs/nav.json` (imported through the `@loghub/user-docs` alias as `helpNav`), the shared page set of the in-app help and the site — see [user-docs-and-site.md](user-docs-and-site.md). The right pane fetches `/help/<slug>.md` at runtime — files **generated** from `user-docs/` into `client/public/help/` (gitignored, never edit them) — and renders it with `ReactMarkdown` + `remark-gfm`, `rehype-slug` giving every heading a GitHub-style id. Default article: `DEFAULT_HELP_SLUG = 'getting-started'`.

Links go through `help/HelpMarkdownLink.tsx` (parsing: the pure `parseHelpHref` in `help/help-links.ts`): `#anchor` scrolls inside the pane (missing id → no-op); `<slug>.md[#anchor]` with a known slug switches the article and then scrolls to the anchor or the top; an unknown slug only logs `console.warn('[help] unknown help page: …')`; `http(s):` / `mailto:` open in a new tab with a trailing ` ↗`.

---

## Contexts and models

`AuthContext` (`context/AuthContext.tsx`) provides `user: UserProfile | null` and `setUser` through
`useAuth()`; it is the only React context. `src/models/` holds type-only mirrors of API response
shapes, one file per area; server code never imports them.

---

## Key patterns

**API fetching** — all API calls go through `src/viewer/api.ts`. The internal `apiFetch` wrapper redirects to `#/login` on 401. All data is cached via react-query (`useQuery` / `useMutation`).

**Tab navigation** — `RepositoryView`, `AdminPage` and `TeamDetailPage` (`ttab`) use URL-backed tab state via `useSearchParams()` (see `useRepositoryViewState.ts`, `useAdminTabState.ts` and `useTeamTabState` in `TeamDetailPage.tsx`) so the active tab is bookmarkable/shareable and survives refresh. `ApiKeysPage.tsx` is the exception — it keeps local `useState` tab state, seeded once from `location.state` (below).

### `location.state` tab seeding
API-keys tabs have no URL param (team tabs have `ttab`, but a `teamTab` state seed still works and is copied into `ttab`). A link that must open a specific tab (an All views map leaf, Home's Get started "Install the hook") passes it as router state: `navigate(path, { state: { teamTab } })` / `{ state: { apiKeysTab: 'install' } }` (or `<Link state>`). `ApiKeysPage` (`initialApiKeysTab`) reads `location.state` once as the `useState` initial value and accepts it only when it is a valid `API_KEYS_TABS` id; anything else falls back to the first tab. No URL param is added, so a reload keeps the tab only while the history entry keeps its state. `TeamDetailPage` (`stateTeamTab`) accepts a valid `TEAM_TABS` id the same way, but writes it into `ttab` (see [TeamDetailPage](#teamdetailpage-and-apikeyspage)).

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

**The `live` param** (OTEL Live view, `client/src/viewer/live/useLiveUrlState.ts`, `LIVE_URL_PARAM`). `?live=<nodeKey>` works on every route that has the top bar: `LiveNavItem` (inside `MainNav`) mounts `LiveModal`, which is open iff `searchParams.has('live')`. Opening copies the current params, sets `live=home` and **pushes**; selecting a tree node **replaces** with the node's canonical key (as sent by the server; the client never builds keys); ✕ / Esc delete `live` with `{ replace: true }`; Back pops the opening push. When the server answers a different `selected` key (an unqualified key resolved to its canonical form, or the fallback to `home`), the URL is replaced with it. The details-panel key is local state, not a param. "Open session ↗" navigates to `routes.teamRepo` / `routes.repo` + `?session=`, which drops `live` and closes the modal.

**Left nav lazy loading** — team repositories are fetched only when the team node is expanded (`enabled: isExpanded`). The active item is scrolled into view after route changes.
