# Group 2: UI tab walk — a pass over every screen and tab

Status: design (nothing is implemented, the tests have not been run). The **[inference]** mark is my inference from the code, not checked by a run.

The result in one line: **10 tests (9 stories + 1 meta-test) / ~104 registry rows / ~98 screens (2 of them behind a flag).**

Sources: `client/src/main.tsx` (router), `useRepositoryViewState.ts`, `SessionDetailPane.tsx`, `SessionChartsTab.tsx`, `useAdminTabState.ts`, `useRepositorySettingsTabState.ts`, `report-catalog.ts`, `analytics-state.ts`, `help/articles/index.ts`, `RepositoryView.tsx`, KB `client-routing-and-layout.md`, `client-feature-flags.md`.

---

## 1. Screen inventory

### 1.1 Routes (hash router, `createHashRouter`)

| Route | Screen | How to get there | Who sees it | Data | Anchor check |
|---|---|---|---|---|---|
| `#/login` | LoginPage | anonymous, AuthGuard redirect | anonymous; mode `password`/`password-confirm` (password form), `azure-oauth` (Azure button), `none` — see the risks | none | Email field + login button (per the mode from `/auth/config`) |
| `#/signup` | SignupPage | link from login | anonymous, `password*` only (in `none` the server returns 404) | none | Email/Password fields + submit |
| `#/forgot-password` | ForgotPasswordPage | link from login | anonymous, `password*` | none | Email field + submit |
| `#/reset-password?token=` | ResetPasswordPage | link from the e-mail | anonymous, `password*` | a reset token (create it through the API/admin button) | new-password form; with a garbage token, a meaningful message, not a crash |
| `#/confirm-email?token=` | ConfirmEmailPage | link from the e-mail | anonymous, `password-confirm` | a confirmation token | status page (success/error) without a crash |
| (consent) | DataCollectionConsentScreen — replaces the whole shell | any route for a user who has not accepted the notice | signed in without consent | a fresh user without `user_settings.dataCollectionNotice` | notice text + Accept button; no navigation |
| `#/` , `*` | redirect to `#/main` | any hash | all signed-in users | — | the URL became `#/main` |
| `#/main` | MainPage | logo / redirect | all signed-in users | none | "Select an item from the left panel" + left navigation |
| `#/teams` | TeamsPage | left navigation / "Teams" | signed-in users | the user's team | the seeded team's name in the list |
| `#/teams/:teamId` | TeamDetailPage (Members / Repositories / Invitations tabs, **local useState, not the URL** — a known exception) | click on a team | member; management buttons by role | team + members + repos + invite | Members: a member's e-mail; Repositories: the golden repo URL; Invitations: a pending invite |
| `#/api-keys` | ApiKeysPage (Install / API Keys tabs) | the "API Keys" link | signed-in users | 1 API key (the golden seed creates it) | Install: the block with the install command; Keys: the seeded key's name |
| `#/repos/:repoId` | RepositoryView (personal repo) | "My Repos" in the left panel | the owner; others get 403/an error | golden repo | header: repo URL, sessionCount = N |
| `#/teams/:teamId/repos/:repoId` | RepositoryView (team) | team → repo in the left panel | a team member | the repo is linked to the team | the same + team context; for a restricted member, `data-testid=restricted-sessions-notice` |
| `#/repos/:repoId/hook-state` | HookStatePage | left panel "Installed Hooks" (visible with >=1 API key) | the repo owner | hook-state with an issue (as in `hook-state.spec.ts`) | "N issue(s)", version card, "Copy upgrade cmd" button |
| `#/admin` | AdminPage | the "Admin Panel" icon in the left panel | admin only; non-admin -> `#/main` | see 1.5 | page heading + 9 tabs |

State parameters in the URL (the `?` part of the hash): `mtab` (analytics/reports/settings), `session`, `tab`, `stab`, `av`, `report`, `users=all`, `top`. An empty/invalid `tab` -> Summary (`parseSessionTab`); an invalid `tab` on admin -> System Info.

### 1.2 Repository tabs (`RepositoryView`)

| URL parameter | Tab | Who sees it | Data | Anchor |
|---|---|---|---|---|
| (default) | **Sessions** — list + session detail | everyone with access | >=3 golden sessions | the session's first prompt in the list; the session counter in the header |
| `?mtab=analytics` | **Analytics** | `canSeeTeamWideTabs`: a non-restricted team, or the team owner, admin, manager. A restricted member does NOT see it | sessions | a chart/table is rendered (svg/table, not "No data") |
| `?mtab=reports` | **Reports** | same as Analytics | sessions | the report tree on the left + the active report's heading |
| `?mtab=settings` | **Settings** | same as Analytics | — | 6 sub-tabs |

Session list view (`ViewMode`): `branch` / `date` / `user` / `plain` — 4 toggles (localStorage). The "hide hook sessions" filter, `users=all` and AttributeFilterPopover are states, not screens; the walk includes only the 4 grouping modes (1 pass = 4 clicks, a registry row per mode is not needed — see 2.2).

### 1.3 Session tabs (`SessionDetailPane`, the `tab` parameter)

| `tab` | Button label | Visibility | Data | Anchor |
|---|---|---|---|---|
| `summary` (default) | Summary | everyone | a session with logs | `data-testid=session-summary-tab`, `summary-executive-band`, `summary-prompt-costs` |
| `info` | Info | everyone | logs | Identity / Timeline / Tokens & Cost sections, a non-zero cost |
| `logs` | Logs | everyone | logs with >=2 prompt turns | the list of prompt turns, the text of the first prompt |
| `charts` | Charts | everyone | logs | 7 sub-tabs (1.4) |
| `advisor` | Advisor | **conditional**: only when `logsQuery.data.turnEndAdvisor != null`; otherwise there is no button, and a `tab=advisor` deep link redirects to Summary | the seed needs a session with an advisor result **[inference: the way to seed it needs clarifying — `session-item-advisor-badge.test.tsx`/`AdvisorTab.test.tsx` give the data shape]** | the list of recommendations |
| `usage` | **Statistics** (internal id `usage`, do not confuse them!) | everyone | logs | productivity counters, the tools table |
| `change-surface` | Change surface | everyone | a session with Edit/Write tool calls | headline + file tree (>=1 file) |
| `harness-usage` | Harness usage | everyone | a session with a sub-agent + skill/rule | the session tree (main + sub-agent), the item list |
| `raw-logs` | Raw Logs (with a lock) | **only the session owner or admin** (`canSeeRawLogs`); otherwise hidden and redirected to Summary | logs | Kibana table, >=1 row |
| `call-tree` | — (an obsolete deep link) | redirects to `charts` | — | URL -> `tab=charts` |

Plus the Favorite / Refresh / Remove buttons (Remove is owner/admin only) — these are actions, not screens; the walk only checks that they are present and does not click them.

### 1.4 Charts sub-tabs (`SessionChartsTab`, localStorage `charts-sub-tab`)

Dashboard, Context Growth, Context Usage, Agent Tree, Timeline (+ a turns/time toggle), Tool Heatmap, Call Tree = **7**. **Token Flow** is the 8th, **behind a flag**: visible only with `VITE_ENABLE_TOKEN_FLOW=true` AND the admin role; plus a preview card on the Dashboard (`showTokenFlow`).

Anchors: Dashboard — KPI cards; Context Growth/Usage — svg + table; Agent Tree — the main node + a sub-agent node (needs a seed with a sub-agent); Timeline — Gantt bars; Tool Heatmap — cells with numbers; Call Tree — the "System Context" row and percentages.

### 1.5 Admin panel (`?tab=`, 9 tabs, admin-only)

system-info (default, "System Info"), all-repos ("Repos"), all-teams ("Teams"), all-users ("Users"), error-logs ("Error Logs"), upload-queue ("Upload Queue"), data-retention ("Data Retention"), auth ("Auth"), model-pricing ("Model Pricing"). The KB talks about 5 tabs — **the KB is outdated**, there are 9 now (the source of truth is `ADMIN_TABS`).

| Tab | Data | Anchor |
|---|---|---|
| System Info | the server is alive | metric cards (uptime, workers), not "NaN" |
| Repos | golden repo | the golden repo URL in the table |
| Teams | golden team | the team name, the member count |
| Users | 4-5 e2e users | the admin e-mail + the regular e-mail; the own-row button is disabled |
| Error Logs | may be empty | the Timestamp/Source/Message column headers (an empty state is allowed; declare `dataOptional` in the registry) |
| Upload Queue | — | the worker statistics block (T-111) |
| Data Retention | — | the "retention days" stat + chart |
| Auth | — | the current mode card (`AUTH_MODE`) |
| Model Pricing | — | the price table, a row with the seeded session's model |

### 1.6 Repository Settings sub-tabs (`stab`, 6)

Display, File Categories, Analysis, Session Attributes, Maintenance, Import/Export. Visible to the same people who see Settings. Anchor: Display — the "hide hook sessions" toggle; File Categories — the category editor with defaults; Analysis — the threshold + the Turn-End Advisor toggle; Session Attributes — the form; Maintenance — the section; Import/Export — the Export/Import panels.

### 1.7 Analytics (the `av` parameter, 13 views)

work-time (default), cost, files, vision, mcp, productivity, log-lines, cache-read-ratio, change-surface, tools, tokens, productivity-counters, active-sessions. The source is `VIEW_OPTIONS`. There are also `layout=vertical/horizontal` and groupBy — these are modes, not screens; the walk checks horizontal once on one view. Anchor: every view is not an empty state (`svg` with >=1 bar or a table with >=1 row). **[inference]** MCP/Vision may be empty without special data in the seed — the golden session must contain an mcp call and an image, otherwise the row is marked `dataOptional`.

### 1.8 Reports (the `report` parameter, 17 reports, source `REPORT_CATEGORIES`)

Summary: executive-summary. Activity: session-timeline, work-time, tool-analytics, active-sessions. Code: branch-summary, change-surface. Cost: cost-by-branch, cost-by-user, cache-read-ratio, token-usage. Productivity: productivity, productivity-counters. Harness: harness-usage, claude-version-usage. Attributes: attribution-breakdown, attribution-usage.
The anchor of each: `ReportDocumentHeader` with the report title + a KPI table with >=1 row/number. Special data: attribution-* (needs session attributes / evaluation runs — otherwise `dataOptional` with a check for a meaningful empty state); claude-version-usage (the Claude Code version in the logs — the seed sets it); harness-usage (skills/rules). The PDF button is not clicked (a separate group covers it).

### 1.9 Help modal (14 articles, source `helpNav`)

Getting Started: getting-started, data-collection-notice. Reference: connect-repository, session-list, session-log, analytics-reports, cost-and-context, tuning-your-setup, data-collection. Technical Info: component-reference, security-hardening, responsibility-matrix, third-party-components. Changelog: whats-new. Opening: the `aria-label="Help"` button in MainNav. Anchor: the article's H1 heading is not empty, there is no "404"/"<!doctype" text (the SPA fallback may serve index.html instead of the .md — **[inference]**, a typical breakage when a file is deleted from `public/help/`). The Download button on 6 articles (`downloadable`) — check that it is present.

### 1.10 Other

| Element | How | Who | Data | Anchor |
|---|---|---|---|---|
| NotificationBell popover | the bell in MainNav | everyone | a pending team invite for the current user | badge "1" + the invite row + Accept/Decline |
| PendingDisclosureGate (team disclosure modal, FR-17a) | automatically, if the user was added without Accept | member | a team with a disclosure + a member without an acknowledgement | the disclosure text + the confirm button |
| Left panel: Teams (expand), My Repos, API Keys, Installed Hooks, Admin Panel | always | by condition | — | the items are present; Admin only for admin |
| Bootstrap error "Unable to connect to the server" + Retry | the server is unreachable | everyone | — | **not walked** (the server would have to be brought down; it stays in client-unit) |
| 403/404 for someone else's repo/team/hook-state | a direct URL | a non-owner | an existing repo of someone else | "No access"/"not reported yet" through `PageState`, without a crash |
| Deep-level modals (ToolCallDetail, AgentDetail, FileDetail, SkillDetail, RuleDetail, McpServer, HorizontalSessionModal, ErrorLogDetail, UploadQueueEntryDetail, ChangePassword, DeleteAccount, SessionExportProgress) | click on an element | by context | — | **outside the walk** — this is "entering a modal", not a screen; the walk only checks that the parent screen opens. Candidates for an extension: one modal per story (optional) |

### 1.11 Flags and modes

- `VITE_ENABLE_TOKEN_FLOW` is the only flag. The Token Flow tab + the Dashboard preview.
- `AUTH_MODE`: `none` (permanently on the dev stand!), `password`, `password-confirm`, `azure-oauth`. Determined by `GET /api/v1/auth/config`; e2e already publishes it in `E2E_AUTH_MODE` (`helpers/auth-mode.ts`).
- Team mode: `accessMode === 'restricted'` hides Analytics/Reports/Settings and other people's sessions (except for owner/admin/manager).

---

## 2. Walk design

### 2.1 Principle (per the owner's clarification): 5-10 stories, not a test per screen

The route registry is **data** (`tests/e2e/walk/registry.ts`), the tests are **stories by role**; each goes through dozens of screens in `test.step(row.id, ...)` steps. A registry row:

```ts
interface ScreenRow {
  id: string;                 // 'repo.session.charts.agent-tree'
  hash: string | ((ctx) => string);   // '#/repos/{repoId}?session={s1}&tab=charts'
  via?: (page, ctx) => Promise<void>; // click path instead of a direct goto (at least for button tabs)
  roles: Role[];              // who must see it
  hiddenFor?: Role[];         // who must NOT: absence check (negative rows)
  anchor: (page, ctx) => Locator | Promise<void>;  // a concrete text/number/element
  expectedNetwork?: { url: RegExp; status: number }[]; // allowed 4xx
  allowConsole?: RegExp[];
  flag?: 'TOKEN_FLOW';
  dataOptional?: boolean;     // a meaningful empty state is acceptable
  tags: string[];             // 'screenshot' -> goes to Group 3
}
```

Each story: `for (const row of rowsFor(role)) await step(row)`. One shared helper `visit(page, row, ctx)` does: navigation (a click along the `via` path or `page.goto`), waiting for the anchor, then the checks below.

### 2.2 What is checked on EVERY screen

1. No React error boundary: no `Unexpected Application Error`, `Something went wrong`, `Cannot read properties` text in `body`.
2. No `pageerror` (unhandled exceptions) during the step — a listener on `page.on('pageerror')`, the buffer is cleared before the step.
3. No `console.error` outside the allowlist (`page.on('console')`). The allowlist is only data in the registry plus a short shared list (for example, 401 on `/auth/me` for an anonymous user, ResizeObserver noise). Every entry has a "why" comment.
4. No failed network calls: `page.on('response')`, any `/api/*` with status >=400 outside `expectedNetwork` is a failure (negative stories: 403/404 are declared in the row).
5. **Anchor check** — a concrete text/number/element; a "shell without data" does not pass. For data, golden-seed constants are used (session count, repo URL, e-mail), not "any non-empty text".
6. Optionally `tags: ['screenshot']` -> `page.screenshot({path: tmp/walk/<role>/<id>.png})` for the LLM documentation audit (Group 3). The screenshot is taken after the anchor, at a fixed 1440x900 viewport; by default it is on for ~25 "key" screens, not for all 100.
7. For tabs based on Radix `role=tab`: after the page opens, the `[role=tab]` list is compared with the registry's child rows (the runtime part of the meta-test, see 2.4).

Error mode: a step does NOT stop the story at the first failure — errors are collected (`expect.soft` / try-catch in `step`) and the story fails at the end with a list of "which screens are broken". Otherwise one failure hides the other 90 screens.

### 2.3 Stories (10 tests)

| # | Test | Role / storageState | Screens (rows) | Contents |
|---|---|---|---|---|
| 1 | `anon: auth pages & guards` | anonymous (empty storageState) | ~9 | login, signup, forgot, reset (a valid token and a garbage one), confirm-email, redirect `#/repos/1` -> login, `#/admin` -> login. In `none` mode the password-flow pages are `test.skip` by `isNoAuthMode()` (`modes: [...]` in the registry). After the walk, in B/C only, one step checks the "Forgot password?" link state: on `#/login` it is enabled in B (`password-confirm` with Mailpit as the relay); in C (`password` without `SMTP_HOST`) it is disabled with the hint "SMTP server is not configured" visible, and `#/forgot-password` shows the same hint (`role="note"`) with a disabled "Send reset link" button |
| 2 | `admin: admin panel tour` | admin (`primary`) | 9 tabs + a link + the negative "regular does not see it" (1 row) | 9 tabs through clicks, deep link `?tab=`, an unknown `tab` -> System Info |
| 3 | `owner: repo tour` | the repo owner (golden) | main, repos/:id, 4 main tabs (header), 4 list modes, 6 settings sub-tabs, hook-state, api-keys (2 tabs), `#/main`, `*` redirect ≈ 20 | a run through a personal repo without the session detail |
| 4 | `owner: analytics & reports tour` | owner | 13 analytics + 17 reports = 30 | the "longest" step; reports through clicks in the `ReportsTree` tree, analytics through the `av` Select |
| 5 | `session: detail tour` | the session owner (admin for the token-flow row) | 9 tabs + 7 chart sub-tabs (+1 flagged) + the call-tree redirect + the raw-logs negative for someone else's session ≈ 20 | a golden session with a sub-agent, a skill, a rule, Edit calls, advisor |
| 6 | `team owner: teams tour` | the team owner (must NOT be admin: `regular`) | teams, team detail ×3 tabs, the team-repo route, Installed Hooks ≈ 7 | checks that a non-admin owner sees Analytics/Reports/Settings in a restricted team |
| 7 | `restricted member` | a member of a restricted team (a new storageState `member`) | ≈ 6 | no Analytics/Reports/Settings tabs; the notice; `?mtab=settings` -> Sessions; no Raw Logs of someone else's session; `#/admin` -> `#/main` |
| 8 | `non-member` | `nonowner` | ≈ 5 | someone else's repo, someone else's team, someone else's hook-state -> the declared 403/404 without a crash, no data leak |
| 9 | `help, notifications, consent` | `regular` + a "fresh" user | 14 articles + bell + disclosure + consent = 17 | consent: a user without the notice sees only the consent screen on a deep link to `#/api-keys` |
| 10 | `registry completeness (meta)` | no browser / lightweight | — | see 2.4 |

Total steps (registry rows) ≈ 104 with 10 tests. Stories 3 and 4 are split on purpose: Reports/Analytics is a separate story, so that a failure in one of the 30 reports does not mix with the settings walk.

### 2.4 Meta-test "the registry does not rot"

Goal: if a route/tab/report/article/sub-tab is added to the application and not to the registry, the test goes red.

Two layers:

**Layer A (static, node without a browser).** Import constants from the client sources (plain TS modules, Playwright transpiles them; `import.meta.env` is not touched — so `feature-flags.ts` is not imported, the flag is set in the registry by hand and checked against the text):
- routes: today `router` is not exported from `main.tsx` (`createRoot`, a side effect, is there too). Minimal refactoring: move the route-config array into `routes-config.ts` and import it in both places. Without the refactoring, the fallback: the regex `path:\s*'([^']+)'` over the text of `main.tsx` (fragile, but it catches a new `path`). Also compare `Object.keys(routes)` from `hooks/useHashRoute.ts`.
- `ADMIN_TABS`, `SETTINGS_TABS`, `parseSessionTab` (the `validTabs` array is local today -> export `SESSION_TABS`), `CHART_TABS` (in `SessionChartsTab.tsx`, not exported today as an array for outside access — to check; the dependency on a React component may require moving it to a separate file), `VIEW_OPTIONS`, `REPORT_CATEGORIES`/`ALL_REPORTS`, `helpNav`.
- files: compare `client/public/help/*.md` (14 files) with `helpNav` and with the registry — this catches both "an article in the nav without a file" and "a file without a nav entry".
- Rule: the set of ids from the sources == the set of ids "covered" by the registry (`covers: ['admin-tab:upload-queue']`); a difference in either direction is a failure with a clear message, "add a row to registry.ts" or "the registry has a screen the application does not have".

**Layer B (runtime, inside the stories).** After a page with tabs opens, collect `[role=tab]`/the tab buttons and compare them with the registry's child rows. This catches tabs that do not live anywhere as an exported constant: PageTabs in `TeamDetailPage` (3), `ApiKeysPage` (2), `RepositoryView` (4), and also the session tab buttons (`SessionDetailPane` renders plain `<button>`s, not `role=tab` — **they need `data-testid="session-tab-<id>"`; this is a small client change, record it as a precondition**).

It is for layers A+B that the client changes "move the tab constants out" matter: they also help the code itself (`useRepositoryViewState` already uses the same technique — `validTabs`).

### 2.5 Seed and roles

Reuse the golden fixture based on `tests/e2e/helpers/seed.ts` (`seedRepoWithSessions`, supports `subAgents`, `claudeEvents`, `toolCalls`, `role`). Once in `beforeAll` for the whole walk (a shared `ctx`, read-only — the stories do not mutate the data, except story 9 with the invite Accept; it gets its own separate invite):

- **Golden repo**: a URL with the `E2E_REPO_PREFIX` prefix (the sweep cleans it), 3-4 sessions: (a) a "rich" one — several turns, sub-agents, a skill + a rule, Edit/Write, an mcp call, an image, a compact, an advisor result; (b) a short 1-turn one; (c) a session of another user (to check Raw Logs and `users=all`); (d) a hook session. Several branches (for the branch view and the branch reports), repo contexts.
- **Team T-open** (not restricted) and **T-restricted** (`accessMode: restricted`), the golden repo is linked to both (or two repos). The team owner is `regular` (not admin!). In `member`, a restricted member; in `T-open`, a pending invite for story 9; a disclosure case.
- **Hook-state**: a server request with issues for the golden repo (as in `hook-state.spec.ts`).
- **API key**: the seed creates it itself.
- **Admin**: `primary`. NB: `primary`/`admin`/`owner` today are one account, `muaddib@arrakis.test`, so "admin sees everything" and "owner sees everything" cannot be told apart. For clean role checks the repo owner in stories 3-6 must be `regular`; admin as a separate account stays only for 2 and 5 (token-flow, someone else's raw-logs).
- Roles in total: admin, owner(repo), team-owner, member(restricted), non-member (`nonowner`), anonymous, fresh-no-consent. New storageStates are added in `global.setup.ts` (`member`, `fresh`) — the only infrastructure change.
- The auth mode is permanently `none` now: the "anonymous" role = a request without a cookie; in `none`, AutoIdentify may sign the localhost browser in by itself **[inference, see the comment in `global.setup.ts`]** — so story 1 is meaningful only with `AUTH_MODE=password*`; in `none` it comes down to checking the redirect/identify screen. The owner's decision is needed (section 5).

### 2.6 Anti-flake

- No `waitForTimeout`. Waiting is `expect(anchor).toBeVisible()` + `page.waitForResponse` on the step's key API + `waitForLoadState('networkidle')` only as "settling" after navigation (not as the only criterion: `SESSION_POLL_INTERVAL_MS` means polling, so networkidle may never come — **[inference]**, hence the anchor is the main criterion).
- Lazy chunks: `LazyFallback` (a spinner) — wait for `[data-testid=lazy-fallback]` to disappear/the anchor to appear, not a sleep.
- The seed is deterministic: fixed dates/tokens in `claudeEvents`; the anchor uses seed constants. No "cost == $0.1234" (tied to pricing) — at most "the cost is displayed and > 0".
- Radix tabs and Select: open with a click and wait for `data-state=active`.
- One worker per story, the stories are independent of each other (the shared seed is only read); `fullyParallel` is acceptable, but story 9 (mutates an invite) and story 1 are isolated by their own data.
- Server/e2e share one real DB and `run-lock.ts` — run the walk the same way as the other e2e (not in parallel with the server jest).
- A long story (4: 30 screens) — set `test.setTimeout(120_000)`; the shared 30 s timeout from `playwright.config.ts` is not enough for it.

---

## 3. Counts

### 3.1 Screens and registry rows

| Group | Count |
|---|---|
| Auth pages (login, signup, forgot, reset, confirm-email) | 5 |
| consent screen | 1 |
| Redirects/guard states (`*`->main, admin->main, someone else's repo 403/404) | 3 |
| main, teams, api-keys (Install, Keys) | 4 |
| Team detail (Members, Repositories, Invitations) | 3 |
| Repo: sessions personal + team-route | 2 |
| Hook-state | 1 |
| Admin tabs | 9 |
| Settings sub-tabs | 6 |
| Analytics views | 13 |
| Reports | 17 |
| Session tabs (including Advisor, without call-tree) | 9 |
| Charts sub-tabs (without Token Flow) | 7 |
| Help articles | 14 |
| Notification popover, disclosure modal | 2 |
| **Total active screens** | **96** |
| Token Flow sub-tab + Dashboard preview (flag) | 2 |
| **All screens/tabs** | **98** |
| Negative "hiddenFor" rows (non-admin without Admin Panel, member without Analytics/Reports/Settings, non-owner without Raw Logs, advisor-redirect, call-tree-redirect, `?mtab=settings` fallback) | ~6 |
| **Registry rows** | **~104** |

(Session list modes, analytics layout, groupBy are states and do not count as rows; the 4 list modes are walked in one looping step inside the "repo.sessions" row.)

### 3.2 Time

~1-1.5 s per screen (click + API response + anchor + 4 checks) -> 104 rows ≈ 2-2.5 min in total; plus the golden seed ≈ 20-30 s (log POSTs); the stories run in parallel on 4 workers -> **roughly 1.5-3 min wall-clock, fits the "<3 min" @core loop**. **[inference, no measurements]** The bottleneck is story 4 (30 screens, 17 reports with heavy aggregates).

### 3.3 What becomes redundant

In total `tests/e2e/*.spec.ts` has ≈ **200 tests in 27 specs** (grep `test(`; 3 files — setup/teardown/helpers are not counted).

Fully replaced by the walk (only "opens/is visible/no console errors/redirect", ≈ 35-45 tests):
- `help-modal.spec.ts`: opening, the default article, switching, "no console errors" (~5 of 8; keep Escape/close, or leave them in client-unit).
- `admin-panel.spec.ts`: "renders tabs", Data Retention/Upload Queue "shows", the `?tab=` deep link and fallback, "no console errors", the regular redirect (~8 of 17); keep sorting/filter/Reset Password.
- `hook-state.spec.ts`: the list in the nav and the detail rendering (~2 of 3).
- `summary-tab.spec.ts`: three "no console errors" + the default tab (~4 of 5).
- `harness-usage-tab.spec.ts` the first test (reachable/deep-link/fallback, 1 of 6); `change-surface-tab.spec.ts` is behaviour and is not replaced.
- `token-flow.spec.ts`: 1-2 of 16 ("the tab is visible/not visible to a non-admin"); the rest is diagram behaviour.
- `reports-tab.spec.ts` (12) and `executive-summary-report.spec.ts` (15), `usage-analytics.spec.ts` (7), `cache-read-ratio.spec.ts` (8), `analytics-horizontal-view.spec.ts` (11): tests of the "the report/view opens" kind — roughly 8-12 in total; the tests on numbers/filters/PDF stay.
- `api-keys.spec.ts`, `repo-panel.spec.ts`, `session-log-view.spec.ts`, `session-raw-logs.spec.ts`: 1-3 "the tab opens" tests each (~6 in total); the rest is behaviour.
- `auth-guard.spec.ts` (2) — fully into story 1/7.

Not replaced: the mail specs (mailpit), password-reset, repo-export-import, raw-logs-owner-api, session-cost-consistency, data-collection-consent (the Accept behaviour; the walk only checks the gate), repo-file-categories, admin-releases.

Client component tests (`client/src/viewer/__tests__/components`: 51 files, ~590 `it/test`; 104 test files across the client): the walk makes redundant only the "renders without crashing" cases in ~15 files — `login-page`, `signup-page`, `forgot-password-page`, `reset-password-page`, `confirm-email-page`, `HookStatePage`, `MainNav`, `AppLeftNav`, `NotificationBell`, `Admin*Tab` (4), `reports-tree`, `session-*-tab` smoke — an estimate of **~25-35 tests (5-6%)**. The logic tests (form branching, derive functions, table layout) stay: the walk knows nothing about their behaviour. **[inference from the file names, the test bodies were not read]**

---

## 4. Rollout order

1. Client preconditions (small): export the tab constants (`SESSION_TABS`, `CHART_TABS`, route-config, team/api-keys tab arrays), `data-testid` on the session tab buttons and on `LazyFallback`.
2. The registry + the `visit` helper + the listeners (pageerror/console/response) in one module, `tests/e2e/walk/`.
3. The golden seed + 2 new storageStates (`member`, `fresh`).
4. Stories 2, 5, 4 (the highest value) -> 3, 6 -> 7, 8, 9 -> 1.
5. The meta-test; then delete the replaced e2e/component tests from 3.3 (after a green run).

---

## 5. Risks and open questions

1. **AUTH_MODE=none on the stand.** `/login` and `/signup` are 404 on the server in this mode, and `AutoIdentifyGuard` signs the browser in by itself. What the client shows on `#/login` in `none` has not been checked. The owner's decision: run story 1 only on a separate stand with `password` (a second instance is needed), or limit it to the redirects. Without this the auth pages (5 screens) cannot be covered.
2. **Token Flow.** Proposal: a registry row with `flag: 'TOKEN_FLOW'`; at runtime, check the tab's actual visibility. If the flag is not in the build, the row **automatically becomes negative** ("admin has no tab"); if the flag is there, it is positive (anchor: the toggle between 5 views). Then the walk is green in both configurations and does not force everyone to have a `.env.local`. The alternative is not to cover it at all; I would not recommend that (2 screens, but it is a "hidden" feature that rots). The owner's decision.
3. **Advisor** is shown only when `turnEndAdvisor` is present; exactly how to seed an advisor result through the public APIs has not been worked out (look at `AdvisorTab.test.tsx` and the Turn-End Advisor server code). If it is expensive, a `dataOptional` row with a negative check (no button, the deep link redirects).
4. **Data for "non-empty" screens**: attribution-breakdown/usage, vision, mcp, claude-version-usage, error-logs need special data; otherwise an empty state has to be allowed and the "there is data" check weakened. Resolution: either extend the golden seed, or mark them `dataOptional` (a check for a meaningful empty text, not just "did not crash").
5. **The KB is outdated**: `client-routing-and-layout.md` describes 5 admin tabs (the code has 9) and the session tabs "Logs/Call Tree/Charts/Info/Usage/Raw Logs" (the code has 9 tabs, Call Tree moved into Charts, "Usage" is called "Statistics"). The registry is built from the code, not the KB; the KB is worth fixing as a separate task.
6. **Meta-test fragility**: a regex over `main.tsx` breaks when the router is refactored; hence moving route-config out is in the plan. Without client changes layer A covers only what is already exported.
7. **Role distinguishability**: `admin == owner == primary` (one account). Negative checks (owner-not-admin, member) are possible only with new users — this adds work in `global.setup.ts` and in the seed.
8. **Console errors as a criterion**: the allowlist bloats over time and itself becomes a "blind spot". Rule: every allowlist entry has a reason and a date, plus a limit (for example, <=10 entries); the meta-test fails when it is exceeded.
9. **Screenshots for Group 3**: an agreed policy is needed (which ~25 screens, a fixed viewport, output to `tmp/` from `project-env.json`, not to the root). The owner's decision: is a diff mode needed.
10. **Deliberately not covered**: deep-level modals, actions (Remove/Delete/PDF/Export), the "Unable to connect" screen, a mobile viewport, the dark theme. These are either other groups or client-unit.
11. **Time/stability** are estimated without measurements; the first real run may change how the stories are split (especially 4).

## 6. Decisions needed from the owner

1. What to do with `AUTH_MODE=none` (story 1): a second stand with `password`, or a cut-down story?
2. Token Flow: a "smart" row (depends on the build), or exclude it?
3. Allow small client changes (exporting the tab constants, `data-testid` on the session tabs, route-config) — the meta-test needs them?
4. Add two users (`member`, `fresh`) to `global.setup.ts` and make a non-admin the repo owner.
5. Are `dataOptional` screens acceptable, or should the golden seed be grown to full data coverage?
