# Research findings 1 — 2026-11-02

## Requirements summary
Client-only navigation overhaul in six parts, built in order A→F (GH-74); no server change, and every existing deep link (`tab=`, `mtab=`, `stab=`, admin `tab=`) and `data-testid` keeps working. **A** — `tab-ids.ts` becomes a single tab registry over all 7 tab groups (id, label, scope, group, description, synonyms, visibility predicate over `{hasAdvisorResult, canSeeRawLogs, canSeeTeamWideTabs, canSeeOtel, isAdmin}`; `call-tree` stays as an `aliasOf:'charts'` row); every tab bar renders from it and every tab gets a description tooltip. **B** — the session tab bar becomes two-level: groups Overview / Transcript / Cost & context / Effects on top, that group's tabs below; each group remembers its last tab per user; "More ▾" overflow per row; a failure dot on Tools/MCP. **C** — lenses (What happened, Cost, Harness & context, Failed tool call, All), optional `lens=` URL value plus per-user browser storage, default lens Cost; a URL without `tab=` always opens Summary and an explicit `tab=` always wins. **D** — Summary becomes a hub with 6–8 "Where to look next" cards and "Explore" chips built only from data the pane has already loaded. **E** — a new `#/map` "All views" route: a tree of every view with a context rail (Team/Repository/Session), a filter that highlights matches, Explorer-style keyboard handling and a "Start from a question" section; opened by Ctrl/Cmd+K and a top-nav button; with its own help article. **F** — `/main` Home: per-repo entries (top 10 by last activity), question cards, Recent (browser storage), Pinned (user setting `home.pins` plus session favorites), Needs attention, This week (executive-summary cost per repo and per team), Get started; every widget loads on its own. Release: bump the root `package.json` version 1.1.0 → 1.2.0.

## Wireframes
30 SVGs in `wireframes/`, plus the design note `tab-map-idea.md` (NavNode model, missing-context resolution, gaps table rows 1–20); `requirements.md` wins wherever they differ.
- c3 / d3 use the URL values `lens=failed-tool` and `lens=harness`, which fixes the lens id vocabulary: likely `what-happened`, `cost`, `harness`, `failed-tool`, `all` (only the first is a guess).
- Lens default tabs (c3): What happened → Summary; Cost → Statistics (`usage`); Harness & context → System context anatomy (`sysctx`); Failed tool call → Tools/MCP (`tools`); All → Summary.
- Promoted tabs per lens (from `docs/product-kb/ux-analysis/wave-1/03-use-case-lenses.md`):
  - What happened: summary, logs, bash, charts, change-surface
  - Cost: summary, usage, charts, advisor, otel
  - Harness: sysctx, harness-usage, okf, info
  - Failed tool: tools, logs, bash, otel
- c2: the Harness lens row is sysctx, harness-usage, okf, info, with Summary appended after a divider (the c4 rule: a tab outside the lens is shown at the end).
- b1 / g1 order the Overview group Summary, Info, Statistics, Advisor; today's flat bar puts Advisor before Statistics.
- d2 card set:
  - Statistics ($ cost, cache read / out tokens)
  - Charts (peak context, % of window)
  - Info (sub-agents, workflows, % of cost)
  - Change surface (files, folders, +/− lines)
  - Bash (calls)
  - Advisor (severity, issue count)
  - Tools/MCP and OKF (no figure)
- d2 Explore chips: Why so expensive? → Cost; What happened? → What happened; What gets loaded? → Harness; Which tool failed? → Failed tool call.
- d1: three card states — with a figure, dimmed with no data, no figure.
- e1, g1, g2, g6 (the map):
  - a right-hand "What it answers" column, a synonym chip on a match, a "13 of 78 views" counter
  - greyed nodes with "choose a session ▸" and an inline picker (Recent + Latest + search + "Open the session list instead →")
  - g6 visibility matrix: permission-gated nodes are hidden; data-gated nodes are greyed in the map and hidden in the bar
- e4: a Charts sub-tab jump writes the stored sub-tab, then opens `tab=charts`.
- f1–f6 (Home):
  - layout, and per-widget loading and failure with Retry
  - pin toggles in the repo header and in report headers
  - where each Needs-attention line opens (Hook state, `tab=advisor`, `tab=tools`)
  - Get started links to API Keys › Install and the help articles `getting-started` and `connect-repository`
- Count mismatch: g1/e3 say "16 reports", but `report-catalog.ts` has exactly **17** reports in 7 categories. "13 views" and "23 articles" (`nav.json` has 23 slugs) match.

## Knowledgebase
- `docs/knowledgebase/client-routing-and-layout.md`
  - Use `routes.*` with `useNavigate`. For in-page state, copy the params and call `setSearchParams(next, {replace:true})`. Only selecting a session pushes history. Never set `window.location.hash` directly.
  - Lazy-chunk budget is about 8 chunks, never more than 10. `MainPage` lives in the Workspace barrel `workspace-lazy-group.ts`; the map should be a lazy route chunk there too.
  - `HelpModal` takes `initialSlug` / `initialAnchor`.
  - `TeamDetailPage` tab selection is local state on purpose.
- `docs/knowledgebase/client-component-map.md:47,171,172,649` covers `tab-ids.ts`, `SessionDetailPane`, `SessionTabBar` and `PageTabs`; update it for every new or renamed component.
- `docs/knowledgebase/ui-principles.md`
  - §102: every floating surface stays inside the viewport (applies to the More menu, the picker and tooltips).
  - §125: every hint surface shares one style — `ui/tooltip` with `variant="light"`, never a native `title`.
  - The app is light-only.
- `docs/knowledgebase/user-docs-and-site.md`: to add a page, create `user-docs/<slug>.md`, add it to `nav.json` and run `npm run build:help`; the relative-link rules apply. Use it for the lens docs (likely in `session-log.md`) and the new map article.
- `docs/knowledgebase/executive-summary-report.md:30`: `startDate` / `endDate` are required ISO 8601 values; the server parses them with `new Date()` (`reports.controller.ts:147`), so full timestamps from now−7d to now work.
- `docs/knowledgebase/algorithms/README.md`: a pure algorithm such as the map filter matcher or lens/tab resolution may get a new doc plus a `*.algo.test.ts` table test (pattern: `client/src/viewer/lib/format.algo.test.ts`); that is the only allowed unit-test form.
- `docs/knowledgebase/test/index.md`, `test/scenarios.md`: new behaviour is checked by steps in existing scenarios.
- `docs/knowledgebase/release-pipeline.md`: version rules for the 1.2.0 bump.

## Existing patterns
- `client/src/viewer/tab-ids.ts:1-127`
  - A pure module holding the 7 `*_TABS` arrays and `tabTestId`.
  - `SESSION_TABS` array order (summary, logs, bash, info, call-tree, …) differs from the rendered order.
  - Loaded from Node by `tests/scenarios/tours/tour-10-registry.spec.ts:28-52` and by `tests/scenarios/auth/s-adm-01.spec.ts:25,154`, which asserts that rendered admin labels equal the `ADMIN_TABS` order.
- `client/src/viewer/pages/repository/SessionTabBar.tsx:44-101`
  - A hard-coded `TabEntry[]` with `visible` / `wrap`.
  - Bash count `data-testid="session-bash-count"` at :53-60.
  - Raw Logs amber tooltip at :80-97 (`bg-amber-50 border-amber-300`).
  - Rendered order: summary, info, logs, bash, charts, advisor, usage ("Statistics"), change-surface, harness-usage, okf, tools, raw-logs, sysctx, otel.
- `client/src/viewer/ui/page-tabs.tsx:5-58`: `PageTab {value,label}` plus `testIdGroup`; add the optional `description` here.
- `client/src/viewer/ui/tooltip.tsx`: Radix tooltip, `TooltipContent variant='light'|'dark'`, `TooltipProvider delayDuration=0`.
- `client/src/viewer/ui/notification-dot.tsx`: a red-dot primitive with a hard-coded `data-testid="new-session-badge"` and aria-label; it needs a variant before reuse.
- `client/src/viewer/pages/repository/SessionDetailPane.tsx`
  - :160-163 `canSeeRawLogs`.
  - :178-182 Raw Logs fallback; :228-246 the `call-tree` → charts and advisor → summary redirects (deep-link fallbacks to keep).
  - :193-206 the `usage`, `codeImpact` and `bashCount` memos.
  - :215-224 the change-surface aggregate query, already fired on every open, so the Summary card can use it.
  - :237 `turnEndAdvisor`; :291-297 where the tab bar mounts.
- `client/src/viewer/pages/repository/session-log/usage/session-usage-derive.ts:187-192,680-704`: `usage.mcpServers[].failures`; a sum above 0 drives the Tools/MCP dot.
- `client/src/viewer/pages/repository/useRepositoryViewState.ts`
  - :35-39 `parseSessionTab` (unknown or missing → summary); :65-70 `mtab` parse.
  - :173-182 `setSessionTab` (replace; deletes `tab` for summary; drops `TOOLS_PARAM_KEYS`); add `lens` handling here.
  - :214-234 selecting a session pushes history.
- `client/src/viewer/pages/admin/useAdminTabState.ts:11-16,28-36` and `pages/repository/useRepositorySettingsTabState.ts:12-16`: the default tab is `ARRAY[0]` and is omitted from the URL, so reordering an array changes the default tab.
- `client/src/viewer/pages/admin/AdminPage.tsx:19-46`: the TABS list, the non-admin `data-retention` filter and the fallback to the first visible tab.
- `client/src/viewer/pages/repository/RepositoryView.tsx`
  - `MAIN_TAB_LABELS` :62-70; `canSeeTeamWideTabs` :116; `visibleMainTab` fallback :359.
  - `PageTabs` with `testIdGroup="repo"` :381-388; `RepositoryHeader` (the pin-toggle host) renders just above.
- `client/src/viewer/pages/repository/RepositorySettings.tsx:33-41,226-234`: `SETTINGS_TAB_LABELS` and `PageTabs`.
- `client/src/viewer/pages/teams/TeamDetailPage.tsx:16-21,27,48-50,66`: `TAB_LABELS`, a local `useState` tab, `canSeeOtel`.
- `client/src/viewer/pages/api-keys/ApiKeysPage.tsx:18-25`: labels "Install" and "API Keys"; local state.
- `client/src/viewer/pages/repository/session-log/charts/chart-tab.ts:7-25`: `CHART_TAB_STORAGE_KEY='charts-sub-tab'` and `readChartTab()` with try/catch.
- `client/src/viewer/pages/repository/session-log/SessionChartsTab.tsx:27-35,77,116-124`: `CHART_TAB_LABELS`; the active sub-tab is read once at mount via `useState(readChartTab)`.
- `client/src/viewer/pages/repository/session-log/summary/SessionSummaryTab.tsx:233-260`: the order band → `SummaryDetectedIssues` → `SummaryExtendedDetails`; the cards go after the band; `onSessionTabChange` is already passed in.
- `client/src/viewer/pages/repository/session-log/summary/SummaryExecutiveBand.tsx:290-347`: seven tiles (Cost, Peak context, Turns, Code impact, Delegation, Session shape, Change surface), the figure sources for the cards.
- `client/src/viewer/pages/repository/session-log/summary/SummaryExtendedDetails.tsx:54,153-310`: existing "View on … tab →" links; note the stale label "View on Usage tab →".
- `client/src/viewer/pages/repository/session-log/summary/SummaryStatTile.tsx`: tile visuals and loading/incomplete states, to reuse for the card style.
- `client/src/viewer/pages/repository/reports/ReportsTree.tsx:10-60`: a collapsible tree with localStorage expand state; its writes are not wrapped in try/catch, so don't copy that part.
- `client/src/viewer/pages/repository/reports/report-catalog.ts:66-294`: `REPORT_CATEGORIES` and `ALL_REPORTS` (17), pure; add `description` / `synonyms` here. URL: `mtab=reports&report=<id>&startDate&endDate` (`report-url.ts:23-47`, date-only).
- `client/src/viewer/pages/repository/analytics/analytics-state.ts:46+`: `VIEW_OPTIONS` (13, already with `description`), pure. URL: `mtab=analytics&av=<view>&ar=1w` (`analytics-url.ts`).
- `client/src/viewer/pages/repository/tools/tools-url-state.ts`: `tstatus=error` with `tfrom` / `tto` is the target for "Which tools fail most?".
- `client/src/viewer/hooks/useHashRoute.ts`: the `routes` builders; add `routes.map`.
- `client/src/app-routes.ts`: `ROUTE` / `ROUTE_ACCESS`. A new `/map` route needs a row in `tests/scenarios/tours/screen-registry.ts`, or the tour-10 meta-test fails.
- `client/src/main.tsx:63-66,199-205,274`: lazy `MainPage`, `AdminGuard`, the router.
- `client/src/viewer/pages/main/MainNav.tsx:64-75,97-101`: the Help button and its own `HelpModal`; the top-nav "All views" button goes here.
- `client/src/viewer/pages/repository/otel/OtelHelpLink.tsx:9-52`: a component that owns its own `HelpModal initialSlug`; the pattern for Help leaves in the map.
- `client/src/viewer/components/AppLeftNav.tsx:48-100,322`: queries `['teams']`, `['api-keys']`, `['hook-repos']` (polled every 60 s) and `['my-repos']`, plus team repos fetched on expand; Home and the map should reuse these keys.
- `client/src/viewer/components/top-nav/NotificationBell.tsx:72-76`, `UserMenu.tsx:43-47`: the window keydown listener pattern, for Ctrl+K.
- `client/src/viewer/pages/repository/session-log/bash-tab/BashCallList.tsx:54-69`: an element-level keyboard list that Ctrl+K must not break.
- `client/src/viewer/lib/consent-queries.ts:21-35`: `userSettingsQuery(userId)`, key `['user-settings', userId]`, `staleTime: Infinity`; with `saveUserSetting` (`api.ts:2542`) it gives `home.pins`.
- Server user settings (`server/src/user-settings/user-settings.controller.ts:18`): the name pattern `/^[A-Za-z0-9._-]{1,100}$/` accepts `home.pins`; values up to 64 KB, opaque to the server.
- Home data sources in `client/src/viewer/api.ts`:
  - `fetchMyRepositories` :402 — `{id, repoUrl}` only.
  - `fetchRepositorySessions` :412 — no period or sort params.
  - `fetchHookRepositories` :520 — `{id, repoUrl, hookVersion, outdated, issueCount}`.
  - `fetchExecutiveSummaryReport` :622 — `totalCost`, `totalSessions`.
  - `fetchToolCalls` :1060 — `status`, `from`, `to`, page.
  - `fetchTeamRepositories` :2082 — `TeamRepository.sessionCount`.
  - session favorite :1373.
- `client/src/models/repositories.ts:164`: `hasAdvisorAdvice` and `isFavorite` on `RepositorySession`.
- Scenario helper `tests/scenarios/helpers/session-view.ts:81-92`: `openSession(page, user, repoId, sessionId, {tab, teamId})`; add `lens` here plus any "open via More" helper. `tests/scenarios/helpers/teams.ts:107` shows the `addInitScript` pattern for seeding storage.
- Scenarios that click `tab-session-*` directly:
  - `view/s-sess-01.spec.ts:112,130,161`; `view/s-sess-04.spec.ts:120-143`; `view/s-cost-01/02/03`
  - `repos/s-repo-17.spec.ts:370,381`; `sessions/s-slife-09.spec.ts:186`; `hook/s-compat-01.spec.ts:472`; `view/s-otel-01.spec.ts:489`
  - `tours/tour-05-session-detail.spec.ts:97`, where `expectTabsOnScreen` asserts every session trigger is in the DOM (`tour-kit.ts:265-273`)
  - legacy e2e, clicking by role and name: `tests/e2e/session-log-view.spec.ts:142,150,592,600,694`, `repo-panel.spec.ts:467,482`

## Open gaps
1. **The default Cost lens conflicts with "existing scenarios pass unchanged".** Under Cost, Info and Logs are only in "More ▾", yet scenarios click `tab-session-info` / `tab-session-logs` directly. Tour-05's `expectTabsOnScreen(page,'session', all)` needs every trigger in the DOM, and the legacy e2e tests click the "Logs" button by name. The plan must choose: seed `lens=all` in `openSession` and storage, keep hidden triggers addressable, or update the scenarios.
2. **Reordering arrays changes default tabs.** Admin and Settings take their default from `ARRAY[0]` and omit it from the URL. Their arrays already match the rendered order, so only `SESSION_TABS` changes, plus where the `call-tree` alias row goes. The Overview group order (Advisor after Statistics) also differs from the flat bar order that FR-A2 calls "today's rendered order".
3. **Non-admin team owners can't reach the Admin panel today.** `AdminGuard` (`main.tsx:199-205`) sends every non-admin to `/main`, though `AppLeftNav:322` shows the link to team owners and `AdminPage` has a data-retention-only branch. FR-E1's "non-admin team owner sees Data retention" is unreachable now; the plan must decide whether the map lists it.
4. **No existing source can sort Home repo entries by last activity.** `/repositories` returns only `{id, repoUrl}`. FR-F0 allows per-repo requests only for the 10 entries shown, yet sorting needs last activity for every repo first. A source is needed (sessions list `startTime`? executive summary?) without a new endpoint.
5. **The session list can't sort by cost or filter by period.** "Why was this session expensive?" is specified as the session list sorted by cost for "This week", but `SessionListPanel.tsx` has neither feature and `fetchRepositorySessions` takes no range. The plan needs a new client-side URL param on the list, or a different target such as Analytics `av=cost&ar=1w` or a report.
6. **No question → route table exists yet.** "What context does Claude load at startup?" needs a session (`sysctx`). "Is my CLAUDE.md being used?" has no obvious target (repo OKF, the Harness usage report, or session `sysctx`). Home cards are per repo with no session picker, while the map forbids silent picks.
7. **Needs attention can't link failed tool calls to root sessions.** `ToolCallListItem.sessionId` is the node holding the call, which may be a sub-agent; only the call detail carries `rootSessionId`. It is also one request per repo.
8. **There is no shared storage helper.** Nothing exists for per-user keys with try/catch (`artisyn:<userId>:…`), for Recent (`useRecentVisits`), or for a shared help-modal opener (`HelpModal` state is local to `MainNav`).
9. **A mounted Charts tab won't follow the map.** `SessionChartsTab` reads the sub-tab once at mount, and a same-tab `storage` event doesn't fire. FR-E9 needs a notification mechanism (a custom event or a small store).
10. **There is no overflow or dropdown primitive.** `viewer/ui` has `popover`, `tabs`, `tooltip` and `ViewportPopover`, but no DropdownMenu. "More ▾" fitting needs ResizeObserver measuring (chart components have precedents), and the bar must not jump while counts load.
11. **There is no global shortcut or keyboard tree.** Ctrl/Cmd+K must suppress the browser's own Ctrl+K and must not fire while a modal's focus trap has priority. Explorer-style tree keyboard handling is new.
12. **The `NavNode` / matcher module and the lens id strings need defining.** The module (`nav-tree.ts`, pure and Node-loadable) is new; an algorithm doc plus a `*.algo.test.ts` is the only allowed unit test for the matcher and the lens/tab resolution. Lens ids beyond `failed-tool` and `harness` are not fixed by the wireframes.
13. **All descriptions and synonyms still need drafting.** That is about 50 registry rows, 17 reports and 13 Analytics views; the plan drafts them for approval. Wireframe text gives starting points, e.g. Statistics = "Turns, tokens, tool calls and errors of this session, by model and tool."
14. **Several test-registry rows need adding.** The new `/map` route, the new help article slug and any `user-docs` page need rows in `tests/scenarios/tours/screen-registry.ts`. No contract registry row is needed, since there is no new server route.
15. **Get started and the new-user nudge overlap.** `useNewUserNudge` already sends zero-repo, zero-team users to `/#/api-keys` once per browser session; the plan must decide how the nudge and the F6 Get started block interact.
