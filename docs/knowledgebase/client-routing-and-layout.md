---
type: "Architecture Guide"
title: "Client Component Hierarchy"
description: "React SPA routing, layout, provider hierarchy, major page components, and data-fetching patterns."
tags:
  - client
  - routing
timestamp: "2026-10-22T00:00:00+04:00"
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
- Acceptance is stored as one `user_settings` row (`dataCollectionNotice`) holding the hash of the notice text accepted; editing `client/public/help/data-collection-notice.md` re-asks every user exactly once. `tests/e2e/global.setup.ts` writes that row for all five storageState roles — without it every existing spec would sit behind the notice.

---

## Hash-based routing (react-router-dom `createHashRouter`)

Routing uses `react-router-dom`'s `createHashRouter`. Path helpers are in `viewer/hooks/useHashRoute.ts` (`routes` object). Navigation uses `useNavigate()` from react-router-dom; in-page URL state uses `useSearchParams()`. No custom `parseHash()` exists.

| Hash pattern | Page component |
|---|---|
| `#/login` | `LoginPage` |
| `#/signup` | `SignupPage` |
| `#/main` | `MainPage` (placeholder) |
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

**Route chunks** (`client/src/main.tsx`). Every route in the table above except `RepositoryView` is
`React.lazy()`-loaded and wrapped in `<Suspense fallback={<LazyFallback fullScreen />}>` by a local
`withSuspense()` helper:

| Chunk | Contents | How it is grouped |
|---|---|---|
| Auth | `LoginPage`, `SignupPage`, `ForgotPasswordPage`, `ResetPasswordPage`, `ConfirmEmailPage` | barrel `viewer/pages/auth-lazy-group.ts` |
| Workspace | `MainPage`, `TeamsPage`, `TeamDetailPage`, `ApiKeysPage` | barrel `viewer/pages/workspace-lazy-group.ts` |
| Admin | `AdminPage` and its tabs | own `import()` |
| Hook state | `HookStatePage` | own `import()` |

Grouping uses barrel files because Rollup merges dynamic-import targets only when they share the same
`import()` specifier. One `import()` per page file would produce one tiny chunk per page (9 instead of 2).

**In-page chunks.** Three heavy tabs are boundaries inside their host page, each in its own
`<Suspense fallback={<LazyFallback />}>` (not full-screen, so it fills the tab content area):
`RepositoryView`'s Analytics tab (`RepositoryAnalytics`) and Reports tab (`ReportsPanel`), and
`SessionDetailPane`'s Charts, Change surface, Harness usage and Bash tabs (`SessionChartsTab`,
`SessionChangeSurfaceTab`, `SessionHarnessUsageTab`, `SessionBashTab`). Their code is fetched only when the
tab opens.

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
  MainNav                     — top bar: logo, NotificationBell, user email, logout
  AppLeftNav                  — collapsible, resizable left sidebar (default 320px)
    TeamNavItem[]             — collapsible team rows; fetches team repos on expand
    [My Repos section]        — flat list of user's own repos
    [API Keys link]
  <page content>              — flex-1 area, route-dependent
```

### `MainNav`
Top bar: app title, Help button (`HelpCircle` icon — opens `HelpModal`), `NotificationBell`, user email from `useAuth()`, logout button. Calls `logout()` API then redirects to `#/login`.

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
  - **Inner tab bar** (`SessionTabBar.tsx`, ids in `tab-ids.ts` `SESSION_TABS`): Summary | Info | Logs | Bash | Charts | [Advisor] | Statistics | Change surface | Harness usage | [Raw Logs]. The entries below describe the older core tabs; Call Tree is now a Charts sub-tab (`tab=call-tree` redirects to Charts).
    - **Logs tab** (`SessionLogView`): structured prompt-turn list with context side panel.
    - **Bash tab** (`SessionBashTab`, tab id `bash`): every Bash command of the session tree (main + sub-agents) in a keyboard-navigable list, with the readable command view of the selected one. The selected call lives in the `bashCall` search param (`useBashCallParam`, `setSearchParams(next, { replace: true })`); a missing or unknown id selects the first row without rewriting the URL.
    - **Call Tree tab** (`CallTreeView`): hierarchical token-cost breakdown tree (System Context → Prompt turns → per-turn children). Token counts and cost-share percentages with progress bars. Expandable rows for prompt turns, groups (Skills, Rules, Code, Docs), and sub-agent rows.
    - **Charts tab** (`SessionChartsTab`): five sub-tabs (Timeline, Agent Tree, Tool Heatmap, Context Usage, Context Growth).
    - **Info tab** (`SessionInfoTab`): session metadata panel with sections — Identity, Timeline, Activity, Tokens & Cost, Files & Tools, MCP Usage, Vision, Productivity, CLAUDE.md Context.
    - **Usage tab** (`SessionUsageTab`): transcript-derived analytics for this session only — productivity counters, per-tool table, cache-TTL/service-tier breakdown, iterations drill-down. Computed client-side from the already-fetched `/logs` payload; carries only figures not already shown by Charts → Tool Heatmap or Info → Tokens & Cost.
    - **Raw Logs tab** (`RawLogsTab`): Kibana-style table of all raw log entries.
  - Tab value is persisted in URL search params so it is bookmarkable (`call-tree` maps to value `'call-tree'`).
- **Analytics tab** — `RepositoryAnalytics` component with date range picker, group-by, bar/horizontal chart layouts, and view selector (work-time/cost/files/vision/mcp/productivity/log-lines/cache-read-ratio/tools/tokens/productivity-counters/active-sessions — the last four are usage-analytics table views, not charts).
- **Settings tab** — `RepositorySettings` modal for team/user file-category config.

### `HookStatePage` (`pages/hook-state/HookStatePage.tsx`)
Standalone page (not a `RepositoryView` tab). Reads `repoId` via `useParams()`. `useQuery(['hook-state', repoId])` → `fetchHookState`. Renders, in order: header (repo URL) with a manual refresh button; `HookStatusCard` (orange/green status summary — installed vs. latest version, last activity, "Copy upgrade cmd" button); Recommendations card; Non-uploadable logs table; Errors & warnings list; a dark monospace hook-log-tail `<pre>` block (intentional dark-surface exception — see `ui-principles.md`). 404/403 responses render "not reported yet" / "No access" via `PageState`.

### `TeamDetailPage` (`pages/teams/TeamDetailPage.tsx`)
Detail view for a team. Uses `PageTabs` with three tabs: **Members**, **Repositories**, **Invitations**.
- Members tab: list with inline role/invite controls, transfer ownership.
- Repositories tab: list team repos, add from URL or from "My Repos", remove.
- Invitations tab: `TeamInvitationsTab` sub-component — send/cancel invitations.

### `TeamsPage` (`pages/teams/TeamsPage.tsx`)
List of all teams; click navigates to `TeamDetailPage`. Owner can delete.

### `ApiKeysPage` (`pages/api-keys/ApiKeysPage.tsx`)
Manage personal API keys (create, list, delete).

### `AdminPage` (`pages/admin/AdminPage.tsx`)
Admin-only panel. Wraps content in `<TooltipProvider>`. Uses `PageTabs` with five tabs:
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
Placeholder — "Select an item from the left panel".

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
Full-screen dialog opened from the Help button in `MainNav`. Left sidebar lists help articles grouped by section (navigation driven by `help/articles/index.ts`). Right pane renders the selected Markdown article via `ReactMarkdown` + `remark-gfm`. Articles are static files served from `public/help/<slug>.md`; `HelpModal` fetches the active article at runtime via `fetch('/help/<slug>.md')`. Default article is the first entry in the nav. `React.lazy()`-loaded from `MainNav.tsx`, its own chunk — see [Code splitting](#code-splitting).

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

**Tab navigation** — `RepositoryView` and `AdminPage` use URL-backed tab state via `useSearchParams()` (see `useRepositoryViewState.ts` and `useAdminTabState.ts`) so the active tab is bookmarkable/shareable and survives refresh. `TeamDetailPage.tsx` is a known exception — it still uses local `useState` for its tab state.

**Hash routing** — uses `react-router-dom`'s `createHashRouter`. `viewer/hooks/useHashRoute.ts` exports only the `routes` path-builder object (e.g. `routes.repo(id)`, `routes.teamRepo(tid, rid)`). Page navigation uses `useNavigate()` from react-router-dom with `routes.*` paths. In-page URL sync (tabs, filters, selected item) uses `useSearchParams()`: copy the current params, mutate the copy, then call `setSearchParams(next, ...)`. Never set `window.location.hash` directly.

- **Opening a session pushes history.** `handleSessionSelect` (`useRepositoryViewState.ts`) calls `setSearchParams(next)` **without** `replace`, so Back returns to the previously open session.
- **Every other param replaces.** The tab, top-N and users-filter setters keep `{ replace: true }`, so switching tabs or filters creates no history entry.
- **The URL `session` param is the only source of the selected session.** `useRepositoryData.ts` uses the branch-local selection only while its `sessionId` equals the URL's; otherwise the session is resolved from the sessions query, and `RepositoryView.tsx` clears a stale branch selection. Back/forward and hand-edited `?session=` therefore switch the pane without a reload.
- **The detail pane is keyed by session.** `RepositorySessionsPanel.tsx` renders `<SessionDetailPane key={selectedSession.sessionId}>`, so a session change remounts it and resets all per-tab local state — no per-tab reset code is needed.
- **Not-found state.** When `session` is set, the sessions query has settled (success, or 403/404) and no listed session (nor the matching branch query) has that id, the pane shows `SessionNotFoundState`. Its Close removes `session` and `tab` with `{ replace: true }`. With no `session` param the "Select a session…" placeholder stays.

**Left nav lazy loading** — team repositories are fetched only when the team node is expanded (`enabled: isExpanded`). The active item is scrolled into view after route changes.
