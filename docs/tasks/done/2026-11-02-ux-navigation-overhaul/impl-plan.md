# Implementation plan — 2026-11-02 UX Navigation Overhaul (GH-74)

## TL;DR

- **Client-only, no server/API/DB change.**
  - The existing `tab-ids.ts` becomes the tab registry: rows, `visibleTabs()` and `tabRow()`.
  - New modules. All but `user-storage.ts` are pure; it wraps `localStorage`.
    - `session-tab-groups.ts`
    - `session-lenses.ts`: `lensRow()` and `lensDefaultTab()`.
    - `summary-cards.ts`
    - `nav-tree.ts`: `buildNavTree()` and `matchNavFilter()`.
    - `nav-questions.ts`
    - `home-pins.ts`
    - `user-storage.ts`
    - `recent-visits.ts`, model only; the hook lives in `useRecentVisits.ts`.
    - `week-window.ts`
  - New hooks: `useHomePins`, `useRecentVisits`, `useHomeRepos`, `useNavTreeInput` and `useAllViewsShortcut`.
- **New route `#/map` ("All views")** as a lazy chunk in the Workspace barrel, opened from:
  - a global Ctrl/Cmd+K hook in `AppShell`
  - a top-nav button
  - Home links
- **New URL params:**
  - `lens=` on the session view
  - `teamId`, `repoId`, `session`, `q` on `#/map`
  - every existing `tab=`, `mtab=`, `stab=` value and every `data-testid` stays as it is
- **New per-user browser storage:** lens, per-group last-used tab, Recent visits and map expand state, keyed `artisyn:<userId>:<name>`.
- **Charts and tab handoff:**
  - The new `writeChartTab()` writes the sub-tab and fires the DOM event `loghub:charts-sub-tab`, so a mounted Charts tab follows the map.
  - The Team and API keys tabs take their first tab from `location.state` (`teamTab`, `apiKeysTab`).
- **New user-setting key `home.pins`.** It goes through the existing user-settings endpoint, which treats the value as opaque, so old clients ignore it.
- **Points that need approval:**
  - **Proposal**: the descriptions and synonyms in DD-5 and the question → route table in DD-12.
  - **Departs from the requirements**, all because there is no server change:
    - Home repo order is not a true "last activity" sort (DD-13).
    - "Why was this session expensive?" opens Analytics › Cost for 1 week instead of a cost-sorted session list (DD-12).
    - Failed-tool lines in Needs attention are one line per repo and open the repo's Tools/MCP tab filtered to errors (DD-14).
    - Admin nodes appear on the map for admins only (DD-11).
- **Tests:**
  - two new algorithm docs, each with a `*.algo.test.ts`: lens row resolution and map filter matching
  - new steps in existing scenarios
  - existing scenario, tour and legacy e2e selectors adapted to the grouped bar and lenses (the user asked for this on 2026-11-02)
  - a new dedicated navigation scenario `S-NAV-01` on a seeded team, repos and sessions (also requested by the user on 2026-11-02)
- **Release and site:**
  - the root `package.json` version goes to `1.2.0`
  - new screenshots for the site (navigation, lenses, focus), picked by a `model: "fable"` judge subagent
  - two new help articles and a lens section in `user-docs/`

## Reference

- Requirements: [requirements.md](requirements.md)
- Design note: [tab-map-idea.md](tab-map-idea.md); wireframes: [wireframes/](wireframes/). Wireframe codes (b1, c4, d2, f1, g1…) in this plan are the SVG file-name prefixes there, and they are part of the plan input.
- UX analysis: `docs/ux-analysis/wave-1/*.md`, `docs/ux-analysis/wave-2/*.md`
- Research archive: [research/findings-1.md](research/findings-1.md)

## Design Decisions

**DD-1: Registry shape (`client/src/viewer/tab-ids.ts`).**

```ts
export type TabScope = 'session' | 'repo' | 'settings' | 'admin' | 'team' | 'apikeys' | 'chart';
export type SessionGroup = 'overview' | 'transcript' | 'cost-context' | 'effects';
export interface TabVisibilityContext {
  hasAdvisorResult?: boolean; canSeeRawLogs?: boolean; canSeeTeamWideTabs?: boolean;
  canSeeOtel?: boolean; isAdmin?: boolean;
}
export interface TabRow {
  id: string; label: string; scope: TabScope; description: string; synonyms: string[];
  group?: SessionGroup; parent?: 'charts';           // parent only on scope 'chart'
  aliasOf?: string;                                   // redirect-only row, never rendered
  visible?: (ctx: TabVisibilityContext) => boolean;   // absent = always visible
  gate?: 'permission' | 'data';                       // why `visible` can be false (map, FR-E6)
}
export const TAB_REGISTRY: readonly TabRow[];
export function tabsOf(scope: TabScope): TabRow[];               // rendered rows, aliases dropped
export function visibleTabs(scope: TabScope, ctx: TabVisibilityContext): TabRow[];
export function tabRow(scope: TabScope, id: string): TabRow | undefined;
```

- The `*_TABS` arrays stay `as const` literal tuples. Their types cannot be derived from a runtime array, and the scenario tooling imports them.
- A module-load assertion (`assertRegistryMatchesArrays()`) throws when the ids of the registry rows and the arrays differ in order or content. The registry is the source of order, and the arrays mirror it.
- Visibility predicates:

  | Row(s) | Predicate | Gate |
  |---|---|---|
  | session `advisor` | `ctx.hasAdvisorResult` | data |
  | session `raw-logs` | `ctx.canSeeRawLogs` | permission |
  | repo tabs other than `sessions` | `ctx.canSeeTeamWideTabs` | permission |
  | team `otel` | `ctx.canSeeOtel` | permission |
  | admin tabs other than `data-retention` | `ctx.isAdmin` | permission |

**DD-2: Row order.**

- In Part A every scope keeps today's rendered order.
- In Part B the session rows move to group order, because after Part B no flat bar is rendered:

  | Group | Rows, in order |
  |---|---|
  | `overview` | summary, info, usage, advisor |
  | `transcript` | logs, bash, raw-logs |
  | `cost-context` | charts, call-tree (alias), sysctx, harness-usage, otel |
  | `effects` | change-surface, tools, okf |

- `parseSessionTab` keeps defaulting to `summary`. Admin and settings arrays already match the rendered order, so their default tab (`ARRAY[0]`) does not change.
- Part-A session order: summary, info, logs, bash, charts, call-tree (alias), advisor, usage, change-surface, harness-usage, okf, tools, raw-logs, sysctx, otel.

**DD-3: Group labels.** `overview` = "Overview", `transcript` = "Transcript", `cost-context` = "Cost & context", `effects` = "Effects". They are exported as `SESSION_GROUPS: readonly {id, label}[]` from `tab-ids.ts`.

**DD-4: Test ids and DOM contract.**

| Element | `data-testid` |
|---|---|
| A tab trigger, in a row or inside an open "More" menu (only one exists at a time) | `tab-session-<id>` |
| A group trigger | `tab-session-group-<group>` |
| "More ▾" on the tab row / on the group row | `session-tabs-more` / `session-groups-more` |
| A lens trigger | `session-lens-<lens>` |
| The Tools/MCP dot | `session-tools-failure-dot` |
| The Summary card block | `summary-next-cards` |
| A Summary card | `summary-card-<tabId>` |
| An Explore chip | `summary-explore-<lens>` |
| A map node | `map-node-<nodeId>` (node ids per DD-10) |
| The map filter / counter | `map-filter` / `map-counter` |
| The map rail fields | `map-rail-team`, `map-rail-repo`, `map-rail-session` |
| The map session picker | `map-picker` |
| Home widgets | `home-repos`, `home-questions`, `home-recent`, `home-pinned`, `home-attention`, `home-week`, `home-get-started` |
| A pin toggle | `pin-toggle` |
| The top-nav "All views" button | `nav-all-views` |

- An active tab gets `aria-selected="true"`, a group trigger `aria-pressed`, and a lens trigger `aria-pressed`.

**DD-5: Descriptions and synonyms (drafted for approval).** These are registry `description` / `synonyms` values, and `description` / `synonyms` on reports and Analytics views.

| Scope › id | Description | Synonyms |
|---|---|---|
| session › summary | The session at a glance and where to look next. | overview, glance, start |
| session › info | Who ran it, branch, models, sub-agents, workflows and their share of cost. | details, metadata, sub-agents, workflows |
| session › usage (Statistics) | Turns, tokens, tool calls and errors of this session, by model and tool. | statistics, tokens, cost, usage, errors |
| session › advisor | What the Turn-End Cost Advisor found and how much it could save. | advice, savings, issues, cost |
| session › logs | The conversation turn by turn: prompts, replies, tool calls. | transcript, conversation, turns, prompts |
| session › bash | Every shell command the session tree ran, with exit status. | shell, commands, terminal, cli, fail |
| session › raw-logs | The unfiltered uploaded log lines (only visible to you). | raw, jsonl, source |
| session › charts | Context growth, timeline, agent tree, tool heatmap and call tree. | graphs, context, timeline, cost |
| session › sysctx | What Claude loads at startup and how many tokens each part costs. | system prompt, startup, claude.md, context, loaded |
| session › harness-usage | Which skills, agents, hooks and MCP servers the session tree used. | harness, skills, agents, hooks, mcp |
| session › otel | OTEL cost over time and the trace waterfall of the session tree. | telemetry, traces, cost, opentelemetry |
| session › change-surface | Which files and folders this session tree changed. | files, diff, lines, changes, code impact |
| session › tools | MCP and monitored CLI tool calls of this session, with failures. | mcp, tools, failed, errors, fail |
| session › okf | How the session tree read the repository's knowledge bases. | knowledge base, kb, docs, okf |
| repo › sessions | Every session of the repository, by branch and date. | list, history, sessions |
| repo › analytics | Charts across sessions over a period: work time, cost, tokens, tools. | charts, trends, cost, time |
| repo › reports | Ready-made reports: executive summary, cost, code, harness. | report, summary, export |
| repo › tools | Monitored CLI tools and MCP servers: calls, outputs and failures. | mcp, tools, failed, errors, fail |
| repo › okf | How the repo's knowledge bases were read over a period. | knowledge base, kb, docs |
| repo › otel | OTEL cost over time, cost structure and hidden calls over a period. | telemetry, cost, traces |
| repo › settings | Repository display, analysis, tools and maintenance settings. | configure, options, preferences |
| settings › display | How sessions of this repository are shown. | view, appearance |
| settings › file-categories | Which paths count as code, docs, tests and so on. | paths, categories, files |
| settings › analysis | Which analyses run on uploaded sessions. | advisor, analysis, rules |
| settings › monitored-tools | The CLI tools the hook wraps and reports. | cli, wrap, tools |
| settings › session-attribution | Session attributes extracted from prompts and branches. | jira, ticket, attribution, attributes |
| settings › maintenance | Recompute and clean-up actions for this repository. | recompute, cleanup, delete |
| settings › import-export | Move sessions of this repository between servers. | export, import, backup, migrate |
| admin › system-info | Server version, database and runtime facts. | version, server, about |
| admin › all-repos | Every repository on this server. | repositories, repos |
| admin › all-teams | Every team on this server. | teams, groups |
| admin › all-users | Every user, role and status. | users, accounts, roles |
| admin › error-logs | Server errors recorded recently. | errors, failures, logs |
| admin › upload-queue | Uploads waiting or failing to be processed. | queue, ingest, upload |
| admin › data-retention | How long session data is kept and what was removed. | retention, delete, purge |
| admin › auth | Authentication mode and sign-in settings. | login, sso, password |
| admin › model-pricing | Model prices used to compute cost. | price, cost, tokens |
| team › members | Who is in the team and with which role. | people, roles, users |
| team › repositories | Repositories shared with the team. | repos, projects |
| team › invitations | Invitations sent and pending. | invite, pending |
| team › otel | OTEL cost of every team repository. | telemetry, cost |
| apikeys › install | How to install the hook in a repository. | hook, setup, install, get started |
| apikeys › keys | Your API keys for uploading sessions. | token, key, secret |
| chart › dashboard | Key session charts on one screen. | overview |
| chart › context-growth | How the context window filled up turn by turn. | context, window, growth, tokens |
| chart › context-usage | What the context is made of at its peak. | context, composition, tokens |
| chart › agent-tree | The main thread and its sub-agents as a tree. | sub-agents, delegation, tree |
| chart › timeline | When each agent worked, on one time axis. | time, gantt, duration |
| chart › tool-heatmap | Which tools were used when. | tools, heatmap, frequency |
| chart › call-tree | Cost of every call in the session tree. | cost, calls, expensive, spend |

- Reports: each `ReportDefinition` gains `synonyms`. Its existing description text, if any, becomes `description`; otherwise the drafts are:
  - executive-summary: "Cost, sessions, users and trends of the period." (cost, summary, spend, week)
  - session-timeline: "When sessions ran." (time, calendar)
  - work-time: "Agent work time by hour." (time, hours)
  - tool-analytics: "Tool calls and their success rate." (tools, fail, errors)
  - active-sessions: "Sessions active in the period." (running, active)
  - branch-summary: "Work per branch." (branch, git)
  - change-surface: "Files touched in the period." (files, diff)
  - cost-by-branch: "Cost per branch." (cost, spend, expensive)
  - cost-by-user: "Cost per user." (cost, spend, who, people, expensive)
  - cache-read-ratio: "How much input came from cache." (cache, tokens, cost)
  - token-usage: "Tokens by kind and model." (tokens, cost)
  - productivity: "Output per hour and per dollar." (productivity, lines)
  - productivity-counters: "Counts of produced work." (counters, lines)
  - harness-usage: "Which skills, agents and CLAUDE.md files sessions used." (claude.md, skills, harness, used)
  - claude-version-usage: "Claude Code versions in use." (version, upgrade)
  - attribution-breakdown: "Cost and sessions per attribute." (jira, ticket, attribution)
  - attribution-usage: "How attribute extraction is used." (jira, attribution)
- Analytics views keep their existing `description` and gain `synonyms`:
  - cost: expensive, spend, money
  - work-time: hours, time
  - files: files, tools
  - vision: images
  - mcp: mcp, servers
  - productivity: lines
  - log-lines: lines, volume
  - cache-read-ratio: cache
  - change-surface: files, diff
  - tools: fail, errors
  - tokens: tokens
  - productivity-counters: counters
  - active-sessions: running, active

**DD-6: Per-user storage helper `client/src/viewer/lib/user-storage.ts`.**

- Exports `readUserItem<T>(userId, name, parse)`, `writeUserItem(userId, name, value)` and `removeUserItem`. Every access is wrapped in try/catch, and a parse failure returns `undefined`.
- Key: `artisyn:<userId>:<name>`.
- Names:
  - `session-lens` (string)
  - `session-group-tabs` (`Record<SessionGroup, SessionTab>`)
  - `recent-visits` (DD-15)
  - `map-expanded` (string[] of node ids)
- Named constants:

  | Constant | Value | Module |
  |---|---|---|
  | `USER_STORAGE_PREFIX` | `'artisyn'` | `user-storage.ts` |
  | `HOME_REPO_LIMIT` | 10 | `useHomeRepos.ts` |
  | `RECENT_REPO_LIMIT` | 10 | `recent-visits.ts` |
  | `RECENT_SESSION_LIMIT` | 10 | `recent-visits.ts` |
  | `PINS_LIMIT` | 50 | `home-pins.ts` |
  | `PINS_SETTING_KEY` | `'home.pins'` | `home-pins.ts` |
  | `ATTENTION_LINES_PER_KIND` | 5 | `HomeNeedsAttention.tsx` |
  | `HOME_STALE_TIME_MS` | 60 000 | `useHomeRepos.ts` |
  | `DEFAULT_LENS` | `'cost'` | `session-lenses.ts` |
  | `CHART_TAB_EVENT` | `'loghub:charts-sub-tab'` | `chart-tab.ts` |

- The user id always comes from `useAuth().user.id` (`client/src/viewer/context/AuthContext.tsx:20`). Without a user, nothing is read or written.

**DD-7: Lenses (`client/src/viewer/pages/repository/session-lenses.ts`, pure).**

| Lens id | Label | Promoted tabs (order) | Default tab |
|---|---|---|---|
| `what-happened` | What happened | summary, logs, bash, charts, change-surface | summary |
| `cost` | Cost | summary, usage, charts, advisor, otel | usage |
| `harness` | Harness & context | sysctx, harness-usage, okf, info | sysctx |
| `failed-tool` | Failed tool call | tools, logs, bash, otel | tools |
| `all` | All | (two-level bar) | summary |

- `parseLens(v): LensId | null` returns `null` for an unknown value. Default lens = `cost` (FR-C3a).
- Effective lens = `lens=` from the URL if valid, else the remembered `session-lens`, else `cost`.
- `lensRow(lens, activeTab, visible: SessionTab[])` returns `{ row: SessionTab[]; extra: SessionTab | null; more: {group, tabs}[] }`:
  - `row` = the promoted tabs ∩ `visible`.
  - `extra` = `activeTab` when it is visible and not in `row`, shown after a divider (c4).
  - `more` = the remaining visible tabs, grouped by `SESSION_GROUPS` order, empty groups dropped.
- `lensDefaultTab(lens, visible)` returns the table default, or `summary` when that tab is not visible.
- **A lens switch** (switcher or Explore chip) writes `lens=` and the default tab in one `setSearchParams(…,{replace:true})`, and stores `session-lens`. `tab` is deleted when the default is `summary`, as `setSessionTab` does today.
- **Any other tab change**, including the map, never writes `lens=`.

**DD-8: Two-level bar and overflow.**

- `session-tab-groups.ts` (pure) exports:
  - `groupOf(tab)`
  - `visibleGroups(visible)`
  - `groupTabs(group, visible)`
  - `pickGroupTab(group, remembered, visible)`: the remembered tab when it is visible, else the first visible tab of the group.
- Every tab selection writes `session-group-tabs[groupOf(tab)] = tab`.
- `client/src/viewer/ui/overflow-row.tsx` (`OverflowRow`) renders items in one row.
  - A `ResizeObserver` on the container measures the item widths once, through a hidden measuring copy. Items that do not fit go into a "More ▾" `Popover` (existing `ui/popover`), which stays inside the viewport (ui-principles §102).
  - The active item is never moved into More; the item before it moves instead.
  - The row height is fixed, `h-9`, so it does not jump while counts load.
- Menu entries carry the same test id as the bar trigger they replace (DD-4). With `sections` set, More lists items under group headers (lens mode).

**DD-9: Tools/MCP dot.** It shows when `sum(usage.mcpServers[].failures) > 0`, using the memoised `usage` already in `SessionDetailPane` (`client/src/viewer/pages/repository/session-log/usage/session-usage-derive.ts:187-192`). `ui/notification-dot.tsx` gets optional `testId` and `label` props; the defaults keep `new-session-badge`.

**DD-10: Map model (`client/src/viewer/pages/map/nav-tree.ts`, pure).**

```ts
export interface NavNode {
  id: string;               // stable path id, e.g. 'repo:12/tab:analytics/view:cost'
  kind: 'container' | 'leaf';
  label: string; description: string; synonyms: string[];
  icon: 'team' | 'repo' | 'session' | 'group' | 'tab' | 'report' | 'view' | 'help' | 'question';
  needs?: 'team' | 'repo' | 'session';   // context missing → greyed + picker
  greyReason?: string;                    // data-gated (e.g. "No advisor result for this session")
  target?: NavTarget;                     // leaves only
  children?: NavNode[];
}
export type NavTarget =
  | { kind: 'route'; path: string; search?: Record<string, string>; state?: Record<string, string> }
  | { kind: 'chart'; repoPath: string; session: string; chartTab: ChartTab }
  | { kind: 'help'; slug: string };
export function buildNavTree(input: NavTreeInput): NavNode[];
export function matchNavFilter(nodes: NavNode[], query: string):
  { matches: string[]; expand: string[]; total: number; synonymHit: Record<string, string> };
```

- `NavTreeInput` = `{ teams, repos (with teamId?), context: {teamId?, repoId?, sessionId?, sessionCtx: TabVisibilityContext}, isAdmin, helpNav, reports, analyticsViews, questions }`.
- **Per-container visibility.**
  - `teams` carry `{id, name, accessMode, ownerId, myIsManager}` from `['teams']`, and the input has `userId`.
  - `teamWideAccess(team, userId) = team.accessMode !== 'restricted' || team.ownerId === userId || team.myIsManager`. It is the rule of `RepositoryView.tsx:106-117` and `TeamDetailPage.tsx:44-50`, exported from `tab-ids.ts` and reused by both.
  - The result gives `canSeeOtel` for each team and `canSeeTeamWideTabs` for each team repo. Personal repos get `true`.
  - **Raw Logs** is listed only when the context session's `userId === userId`. The map never fetches logs, so a team viewer's server-side permission is unknown and the node is omitted.
- **Help leaves.** `nav.json` articles have only `slug` and `title`. The label is the title, the description is "Help › <section>", and the synonyms are the slug words.
- **Import safety.** `nav-tree.ts` and `nav-questions.ts` may import `routes` from `client/src/viewer/hooks/useHashRoute.ts`, which has no imports at all, so it is safe to load from Node. They must not import React, the router or `api.ts`.
- **Tree structure, top-level order:**
  1. "Start from a question": one leaf per `NAV_QUESTIONS` entry, with `needs:'repo'`.
  2. "Teams": one container per team, holding the `TEAM_TABS` leaves.
  3. "Repositories": one container per repo, holding:
     - the repo tabs (`REPO_MAIN_TABS` except `analytics`, `reports` and `settings`, which become containers)
     - "Analytics", with one leaf per `VIEW_OPTIONS` entry
     - "Reports", with one container per `REPORT_CATEGORIES` entry and its report leaves
     - "Settings", with the `SETTINGS_TABS` leaves
     - "Hook state" (leaf)
     - "Sessions", with one "Session" container (`needs:'session'` until the rail has one), then the four `SESSION_GROUPS` containers, then the session-tab leaves; `charts` is a container of the `CHART_TABS` leaves (scope `chart`)
  4. "API keys", with the `API_KEYS_TABS` leaves.
  5. "Admin panel", with the `ADMIN_TABS` leaves (DD-11).
  6. "Help", with one container per `nav.json` section and its article leaves.
- **Row decorations** match the tab bar: the Bash count when the context session's `bashCount` is known, the Raw Logs lock icon, and the Tools/MCP dot when known. Nothing extra is fetched to show them.
- **Matcher rules (FR-E4).**
  - The query is lower-cased and split on whitespace; every word must match one of the node's fields.
  - A word matches a field when it is a prefix of any word in the field, or, if the word has ≥ 3 chars, a substring of the field.
  - Fields are tried in this order: label, then synonyms, then description.
  - `synonymHit` records the synonym that matched when label did not.
  - `total` = the leaf count. An empty query → no matches, `total` only.
- Node ids:
  - `team:<id>/tab:<tab>`
  - `repo:<id>/tab:<mtab>`
  - `repo:<id>/view:<av>`
  - `repo:<id>/report:<id>`
  - `repo:<id>/settings:<stab>`
  - `repo:<id>/hook-state`
  - `repo:<id>/session/group:<g>/tab:<tab>`
  - `…/chart:<id>`
  - `apikeys/tab:<id>`
  - `admin/tab:<id>`
  - `help/<section>/<slug>`
  - `question:<id>`
- **Team and API-keys tabs** have no URL param. The target passes `state: {teamTab}` / `{apiKeysTab}` through `navigate(path, {state})`. `TeamDetailPage` and `ApiKeysPage` read `location.state` once as their `useState` initial value, so no URL param is added.

**DD-11: Map visibility.**

- Permission-gated rows (`gate:'permission'` with `visible(ctx)` false) are omitted.
- Data-gated rows are kept with `greyReason`. The only one is Advisor: "No advisor result for this session".
- The Admin container is listed only when `user.role === 'admin'`. `AdminGuard` (`client/src/main.tsx:199-205`) redirects every non-admin today, so a non-admin owner's "Data retention" node would be a dead link ("shown as today").
- Repos come from the queries `['my-repos']`, `['teams']` and `['team-repos', teamId]`, the same keys `AppLeftNav` / `TeamAccordion` use.

**DD-12: Question → route table (drafted for approval).** `R` = the repository's base path (`routes.repo(id)` or `routes.teamRepo(teamId,id)`), `W` = the last 7 days ending now (DD-16).

| Question | Target | Preset |
|---|---|---|
| Why was this session expensive? | `R?mtab=analytics&av=cost&ar=1w` (`analytics-url.ts:24-31` parses `av=cost`) | Analytics view "Cost", 1 week |
| Which tools fail most? | `R?mtab=tools&tstatus=error&tfrom=<W.from date>&tto=<W.to date>` | errors only |
| Is my hook healthy? | `routes.hookState(id)` | — |
| What context does Claude load at startup? | the repo's most recent session in Recent: `R?session=<id>&tab=sysctx&lens=harness`; with none, `#/map?repoId=<id>&q=startup` (map picker) | Harness lens |
| Is my CLAUDE.md being used? | `R?mtab=reports&report=harness-usage&startDate=<W.from date>&endDate=<W.to date>` | 1 week |
| Who spent how much this week? (map only) | `R?mtab=reports&report=cost-by-user&startDate=…&endDate=…` | 1 week |

- The table lives in `client/src/viewer/pages/map/nav-questions.ts` as `NAV_QUESTIONS: {id, label, synonyms, build(repoCtx, recent, now): NavTarget}[]`. Home and the map share it.
- Synonyms:
  - expensive: cost, spend, why, money
  - tools: fail, failed, error, broken
  - hook: hook, healthy, install, status
  - startup: startup, loaded, context, system prompt
  - claude-md: claude.md, used, instructions
  - who-spent: who, spent, users, team, week

**DD-13: Home repository entries.**

- Visible repos = `['my-repos']` ∪ the team repos of `['teams']` (with `repositoryId != null`), deduplicated by repo id. A personal entry wins over a team entry.
- Order: last Recent visit time (DD-15) desc, then repoUrl asc. Then 10 entries, plus a "Show all (N)" toggle that expands in place.
- No API returns the last activity of every repo, so the shown last activity comes from `fetchHookState(repoId, teamId).lastActivity`, requested for shown entries only. The list is not re-sorted after loading, so it does not jump. A true activity order is the aggregate-endpoint follow-up of FR-F5a.
- Each shown entry makes three requests, all via TanStack Query with its own placeholder:
  - `fetchExecutiveSummaryReport(repoId, {teamId, startDate:W.from, endDate:W.to})` for the session count and cost
  - hook status from `['hook-repos']`
  - `fetchHookState` only when the repo is in `['hook-repos']`
- **Requests.**
  - All Home queries use `staleTime: HOME_STALE_TIME_MS` and are `enabled` only for shown entries; "Show all" turns them on for the newly shown ones.
  - Per entry, at most: the executive summary, the hook state, `['home-sessions', …]` and the tool-calls total. Needs attention, This week and Pinned reuse the same query keys, so nothing is fetched twice.
- **Hook links.** `['hook-repos']` covers only the user's own repos, so hook status, the "Is my hook healthy?" chip and Hook-state links appear only for repos in it. A team-only repo shows "—".
- Entry actions:
  - "Open" goes to `R`.
  - "All views of this repo" goes to `#/map?repoId=<id>[&teamId=…]`.
  - The question chips build their targets from DD-12.

**DD-14: Needs attention (shown entries' repos, window W, newest first, at most 5 lines per kind, "Show all" expands in place).**

- **Hooks:** `['hook-repos']` rows with `issueCount > 0 || outdated`, opening `routes.hookState(id)`.
- **Advisor:** sessions from `fetchRepositorySessions(repoId, teamId)` (key `['home-sessions', repoId, teamId ?? null]`) with `hasAdvisorAdvice && startTime ≥ W.from`, opening `R?session=<id>&tab=advisor`.
- **Failed tool calls:** `fetchToolCalls(repoId, {teamId, status:'error', from, to, pageSize: 1})` gives the `total` per repo. One line per repo with `total > 0`, "N failed tool calls in <repo>", opens the DD-12 "Which tools fail most?" target.
  - A tool-call list item's `sessionId` may be a sub-agent node; only the call detail carries `rootSessionId`.
  - This replaces FR-F4's per-session `tab=tools` line and needs approval.

**DD-15: Recent (`client/src/viewer/lib/recent-visits.ts`).**

- Value: `{v:1, repos:[{repoId, teamId?, at}], sessions:[{repoId, teamId?, sessionId, tab, label, at}]}`.
- Rules:
  - At most 10 repos plus 10 sessions, newest first, deduplicated by repo id or session id.
  - Visits are recorded by `RepositoryView` on a repo open and on a session or tab change.
  - Before anything is shown or used, the list is filtered against the visible repos.
  - A session whose open fails (`SessionNotFoundState`) is removed.
- The model and its pure functions live in `recent-visits.ts`. The hook is in `client/src/viewer/lib/useRecentVisits.ts`: `useRecentVisits()` returns `{recent, recordRepo, recordSession, dropSession}` and is keyed by the current user id (FR-F2a).

**DD-16: Week window.** `weekWindow(now)` lives in `client/src/viewer/lib/week-window.ts`.

- It returns `{from: ISO(now − 7×24 h), to: ISO(now), fromDate, toDate}`, where the dates are local `YYYY-MM-DD` values for the date-only URL params.
- The executive summary takes the full ISO values (the server parses them with `new Date()`).

**DD-17: Pins (`client/src/viewer/lib/home-pins.ts`, pure).**

- `parsePins(raw: unknown): Pin[]`:
  - parses `{v:1, items:[{kind:'repo'|'view', repoId, teamId?, view?, addedAt}]}`
  - skips an unknown `v` or `kind`
  - caps the list at 50
- `togglePin(pins, pin)` and `serializePins(pins)` are the other exports.
- The React hook `useHomePins()` lives in its own file, `client/src/viewer/lib/useHomePins.ts`, so `home-pins.ts` stays pure.
- Storage goes through `userSettingsQuery(userId)` (`client/src/viewer/lib/consent-queries.ts:21-35`) and `saveUserSetting('home.pins', …)` (`api.ts:2542`), with an optimistic query-cache update.
- Pin keys:
  - Repo pin: `{kind:'repo', repoId, teamId}`.
  - Analytics pin: `{kind:'view', repoId, teamId, view:'analytics:<av>'}`.
  - Report pin: `view:'report:<id>'`.
- Pinned sessions are `isFavorite` sessions from the `['home-sessions', …]` lists of the shown entries. No endpoint lists favorites across repos.

**DD-18: Map doors and keyboard.**

- `useAllViewsShortcut()` is mounted once in `client/src/viewer/components/AppShell.tsx`.
  - It adds a `window` keydown listener in the capture phase. On `(ctrlKey||metaKey) && !altKey && !shiftKey && key.toLowerCase()==='k'` it calls `preventDefault()` and opens the map, from text inputs too.
  - On `/map` it focuses the filter instead.
  - No other key is handled.
- Opening the map calls `navigate(routes.map(ctx), {state:{from: location.pathname + location.search}})`, with the rail context taken from the current route params.
- Esc on an empty filter, or "Back", calls `navigate(-1)` when `state.from` is set, else goes to `routes.main`.
- Tree keys: ↑/↓, →/←, Enter, Home/End and `/`, with roving `tabIndex` on `role="tree"` / `role="treeitem"` and `aria-expanded`.
- With a filter, ↑/↓ cycle through the matches only.

**DD-19: Charts sub-tab follow.**

- `chart-tab.ts` exports `CHART_TAB_EVENT = 'loghub:charts-sub-tab'` and gains `writeChartTab(tab)`. It stores `CHART_TAB_STORAGE_KEY` in try/catch and dispatches `window.dispatchEvent(new CustomEvent(CHART_TAB_EVENT, {detail: tab}))`.
- `SessionChartsTab` subscribes and calls its `setTab`.
- A map chart target calls `writeChartTab` and then navigates to `tab=charts`.

**DD-20: Summary cards (`client/src/viewer/pages/repository/session-log/summary/summary-cards.ts`, pure).**

- `buildSummaryCards(input)` builds cards from values already computed for `SummaryExecutiveBand` / `SessionDetailPane`, in this order:

  | Card (target tab) | Headline | Sub-line | Dimmed when |
  |---|---|---|---|
  | Statistics (`usage`) | cost, `$` 4 decimals | "cache read X · out Y tokens" | — |
  | Charts (`charts`) | peak context tokens | "N % of window" | no usage data |
  | Info (`info`) | sub-agent count | "W workflows · P % of cost" | — |
  | Change surface (`change-surface`) | changed files | "F folders · +A / −R lines" | 0 changed paths |
  | Bash (`bash`) | `bashCount` calls | — | `bashCount === 0` |
  | Advisor (`advisor`) | issue count | top severity | card omitted without an advisor result |
  | Tools/MCP (`tools`) | — | description only | never dimmed |
  | OKF (`okf`) | — | description only | never dimmed |

- That is 7 or 8 cards.
- A dimmed card reads "No data in this session".
- Explore chips:

  | Chip | Lens | Default tab (DD-7) |
  |---|---|---|
  | Why so expensive? | `cost` | `usage` |
  | What happened? | `what-happened` | `summary` |
  | What gets loaded? | `harness` | `sysctx` |
  | Which tool failed? | `failed-tool` | `tools` |

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `client/src/viewer/tab-ids.ts` | Registry (DD-1, DD-2, DD-3, DD-5) | keep the `*_TABS` exports and `tabTestId` |
| `client/src/viewer/ui/page-tabs.tsx` | optional `description` → light tooltip | FR-A4 |
| `client/src/viewer/ui/overflow-row.tsx` | **new**, `OverflowRow` + More menu | DD-8 |
| `client/src/viewer/ui/notification-dot.tsx` | `testId`/`label` props | DD-9 |
| `client/src/viewer/lib/user-storage.ts` | **new**, per-user storage | DD-6 |
| `client/src/viewer/lib/recent-visits.ts` | **new**, pure Recent model | DD-15 |
| `client/src/viewer/lib/useRecentVisits.ts` | **new**, hook | DD-15 |
| `client/src/viewer/lib/week-window.ts` | **new** | DD-16 |
| `client/src/viewer/lib/home-pins.ts` | **new**, pure | DD-17 |
| `client/src/viewer/lib/useHomePins.ts` | **new**, hook | DD-17 |
| `client/src/viewer/pages/repository/SessionTabBar.tsx` | chooses the lens row or the two-level bar | DD-7, DD-8 |
| `client/src/viewer/pages/repository/SessionGroupBar.tsx` | **new**, two-level bar ("All" lens) | DD-8 |
| `client/src/viewer/pages/repository/SessionLensRow.tsx` | **new**, single lens row + divider + More by group | DD-7 |
| `client/src/viewer/pages/repository/session-tab-groups.ts` | **new**, pure | DD-8 |
| `client/src/viewer/pages/repository/session-lenses.ts` | **new**, pure | DD-7 |
| `client/src/viewer/pages/repository/SessionLensSwitcher.tsx` | **new** | FR-C1, FR-C5 |
| `client/src/viewer/pages/repository/SessionDetailPane.tsx` | wire lens, groups, dot, context | :160-246, :291-297 |
| `client/src/viewer/pages/repository/useRepositoryViewState.ts` | `lens` parse/set, lens switch | :35-39, :173-182 |
| `client/src/viewer/pages/repository/RepositoryView.tsx` | labels from registry, Recent recording | :62-70, :381-388 |
| `client/src/viewer/pages/repository/RepositoryHeader.tsx` | pin toggle | FR-F3 |
| `client/src/viewer/pages/repository/RepositorySettings.tsx` | labels from registry | :33-41 |
| `client/src/viewer/pages/admin/AdminPage.tsx` | labels and visibility from registry | :19-46 |
| `client/src/viewer/pages/teams/TeamDetailPage.tsx` | labels from registry, `location.state.teamTab` | DD-10 |
| `client/src/viewer/pages/api-keys/ApiKeysPage.tsx` | labels from registry, `location.state.apiKeysTab` | DD-10 |
| `client/src/viewer/pages/repository/session-log/SessionChartsTab.tsx` | labels from registry, event subscription | DD-19 |
| `client/src/viewer/pages/repository/session-log/charts/chart-tab.ts` | `writeChartTab` | DD-19 |
| `client/src/viewer/pages/repository/reports/report-catalog.ts` | `description`, `synonyms` | DD-5 |
| `client/src/viewer/pages/repository/reports/ReportDocumentHeader.tsx` | pin toggle (`report:<id>`) | FR-F3 |
| `client/src/viewer/pages/repository/analytics/analytics-state.ts` | `synonyms` | DD-5 |
| `client/src/viewer/pages/repository/analytics/AnalyticsControls.tsx` | pin toggle next to the view select (`analytics:<av>`) | FR-F3 |
| `client/src/viewer/pages/main/home/useHomeRepos.ts` | **new**, visible repos, order, per-entry queries | DD-13 |
| `client/src/viewer/pages/repository/session-log/summary/summary-cards.ts` | **new**, pure | DD-20 |
| `client/src/viewer/pages/repository/session-log/summary/SummaryNextCards.tsx` | **new**, card block | FR-D1–D4 |
| `client/src/viewer/pages/repository/session-log/summary/SummaryExploreChips.tsx` | **new** | FR-D5 |
| `client/src/viewer/pages/repository/session-log/summary/SessionSummaryTab.tsx` | mount cards and chips after the band | :233-260 |
| `client/src/viewer/pages/map/nav-tree.ts` | **new**, pure | DD-10 |
| `client/src/viewer/pages/map/nav-questions.ts` | **new**, pure | DD-12 |
| `client/src/viewer/pages/map/MapPage.tsx` | **new**, route page | FR-E1–E10 |
| `client/src/viewer/pages/map/MapContextRail.tsx` | **new** | FR-E3 |
| `client/src/viewer/pages/map/MapTree.tsx` | **new**, tree + keyboard | FR-E2, FR-E8 |
| `client/src/viewer/pages/map/MapSessionPicker.tsx` | **new** | FR-E3 |
| `client/src/viewer/pages/map/useNavTreeInput.ts` | **new**, gathers queries into `NavTreeInput` | DD-11 |
| `client/src/viewer/hooks/useAllViewsShortcut.ts` | **new** | DD-18 |
| `client/src/viewer/hooks/useHashRoute.ts` | `routes.map(params?)` | builds `/map?…` |
| `client/src/app-routes.ts` | `ROUTE.map='/map'`, access `auth` | |
| `client/src/main.tsx` | route element `withSuspense(<MapPage/>)` | |
| `client/src/viewer/pages/workspace-lazy-group.ts` | export `MapPage` | no new chunk |
| `client/src/viewer/components/AppShell.tsx` | mount `useAllViewsShortcut` | |
| `client/src/viewer/pages/main/MainNav.tsx` | "All views" button | `nav-all-views` |
| `client/src/viewer/pages/main/MainPage.tsx` | Home layout | FR-F0–F7 |
| `client/src/viewer/pages/main/home/*.tsx` | **new**: `HomeRepoEntries`, `HomeQuestions`, `HomeRecent`, `HomePinned`, `HomeNeedsAttention`, `HomeThisWeek`, `HomeGetStarted`, `HomeWidget` (shell with placeholder, error and Retry) | FR-F5a |
| `client/src/viewer/components/PinToggle.tsx` | **new** | FR-F3 |
| `docs/knowledgebase/algorithms/session-lens-row.md` | **new** algorithm doc | `lensRow`, `lensDefaultTab`, `pickGroupTab` |
| `docs/knowledgebase/algorithms/nav-filter-match.md` | **new** algorithm doc | `matchNavFilter` |
| `client/src/viewer/pages/repository/session-lenses.algo.test.ts` | **new** table test | loads the doc's examples |
| `client/src/viewer/pages/map/nav-tree.algo.test.ts` | **new** table test | loads the doc's examples |
| `docs/knowledgebase/algorithms/README.md` | two rows | |
| `user-docs/session-log.md` | "Lenses and tab groups" section | FR-C6 |
| `user-docs/all-views.md` | **new** help article for the map and Ctrl+K | FR-E10 |
| `user-docs/getting-started.md` | Home page paragraph | |
| `user-docs/nav.json` | `all-views` entry | |
| `client/public/help/*` | regenerated by `npm run build:help` | |
| `docs/knowledgebase/client-component-map.md`, `client-routing-and-layout.md`, `index.md` | new components, route, storage keys | |
| `package.json` (root) | `version` 1.2.0 | |
| `tests/scenarios/helpers/session-view.ts` | `openSession({lens})`, `selectSessionTab`, `selectLens` | |
| `tests/scenarios/helpers/nav.ts` | **new**, map/home helpers | |
| `tests/scenarios/tours/tour-kit.ts`, `tour-05-session-detail.spec.ts` | grouped-bar aware `expectTabsOnScreen` | |
| `tests/scenarios/tours/screen-registry.ts` | `/map` route and `all-views` help rows | |
| scenarios listed in Chunk 13 | selector adaptation | |
| `tests/scenarios/tours/tour-10-registry.spec.ts`, `tests/scenarios/auth/s-adm-01.spec.ts` | check against the reordered `SESSION_TABS`; imports only | |
| `docs/knowledgebase/test/scenarios.md` | S-NAV-01 entry | |
| `tests/e2e/session-log-view.spec.ts`, `tests/e2e/repo-panel.spec.ts` | selector adaptation | |
| `tests/scenarios/view/s-nav-01.spec.ts` | **new** dedicated navigation scenario | user request |
| `site/assets/shots/*.png`, `site/pages/features.html`, `site/pages/home.html` | new screenshots | |
| `docs/knowledgebase/user-docs-and-site.md` | shot list | |

## API changes

None on the server. Client-side URL contract additions:

| Route | New params | Meaning |
|---|---|---|
| `#/repos/:id`, `#/teams/:t/repos/:id` (session view) | `lens=what-happened\|cost\|harness\|failed-tool\|all` | active lens; an unknown value counts as absent |
| `#/map` (new) | `teamId`, `repoId`, `session`, `q` | rail context and filter; unknown values are ignored |

Existing endpoints used by Home and the map:

- `GET /api/v1/repositories`
- `GET /api/v1/teams`
- `GET /api/v1/teams/:id/repositories`
- `GET /api/v1/repositories/hooks`
- `GET /api/v1/repositories/:id/hook-state`
- `GET /api/v1/repositories/:id/reports/executive-summary`
- `GET /api/v1/repositories/:id/sessions`
- tool-monitoring `calls`
- user-settings GET/PUT

No contract-registry row is needed.

## Test coverage plan

- **Algorithm:** two new docs, each with a table test.
  - `session-lens-row.md` covers `lensRow` (per-lens rows, the visible-set intersection, `extra` after the divider, `more` grouping), `lensDefaultTab` (including a hidden default falling back to summary) and `pickGroupTab`. It is tested by `session-lenses.algo.test.ts`.
  - `nav-filter-match.md` covers word prefix, the ≥ 3-char substring, all-words-must-match, the label > synonym > description order with `synonymHit`, the empty query and the `expand` ancestors. It is tested by `nav-tree.algo.test.ts`.
  - Both run under client `bun run test`.
- **API contract:** none, since there is no route change.
- **Scenario, existing:**
  - Adapt the existing scenarios to the grouped bar and lenses: helper-based tab selection, tour-05 group-aware tab inventory, legacy e2e selectors. Assertions stay unchanged.
  - Add steps:
    - `s-sess-01`: open Info through "More ▾" under the Cost lens; `?tab=logs&lens=cost` shows Logs as active after the divider.
    - `s-sess-04`: a lens switch opens the default tab and writes `tab=`; reload keeps the lens; under All, a group remembers its last tab.
    - `s-sess-01`: Summary cards (Change surface dimmed on a no-change fixture or figure parity, OKF without a figure, "Open →" switches tab); no new network request on Summary open.
    - `tour-05`: map filter "cost" → Charts › Call tree jump onto a mounted Charts tab.
  - Register `/map` in `screen-registry.ts` so tour-10 passes.
- **Scenario, new (user request 2026-11-02):** `tests/scenarios/view/s-nav-01.spec.ts`, `@S-NAV-01 @mode-a`, for the end-to-end navigation walk. Steps are listed in Chunk 15.

## Visual/UX notes

- **Lens switcher:** a segmented control (`h-8`, `text-sm`) above the bar. The active lens has a filled `bg-primary/10 text-foreground font-medium` look plus `aria-pressed` (FR-C5).
- **Group row:** top row with `text-sm`, the active group underlined. The tab row below it is `text-sm` with a muted background strip. Both rows are a fixed `h-9`.
- **"More ▾":** shown last in its row. Its menu lists group headers (`text-xs uppercase text-muted-foreground`) in lens mode. The active tab is never inside More.
- **Divider for an out-of-lens active tab:** a `border-l` separator, then the tab (c4).
- **Tooltips:** `TooltipContent variant="light"`, `max-w-[280px]`, `side="bottom"`; Raw Logs keeps its amber classes, with the description first.
- **Summary cards:**
  - a grid `grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3`, not stretched beyond `max-w-5xl` (wide-screen rule)
  - card styles reused from `SummaryStatTile`
  - a dimmed card is `opacity-60` plus "No data in this session"
  - "Open →" is a text button
- **Map:** the content is limited to `max-w-5xl`.
  - The filter is at the top, then the rail and the question section, then the tree.
  - The "What it answers" column is visible at `md+`; below `md` it moves into the row tooltip.
  - Greyed nodes use `text-muted-foreground` with the "choose a session ▸" link.
  - The counter reads "N of M views".
- **Home:** a two-column grid at `lg+` (repo entries and questions on the left; Needs attention, This week, Pinned and Recent on the right), one column below that.
  - Every widget is a `HomeWidget` card with a skeleton, an error line and Retry.
  - Get started replaces the empty sections when the user has no repos and no teams. The existing `useNewUserNudge` redirect stays as it is: it fires once per browser session, so a new user sees Get started on their next visit to `/main`. Scenarios reach Home through `skipNewUserNudge` (`tests/scenarios/helpers/teams.ts:106`).

## Wireframes

No wireframe change. The plan departs from them in four places:

- Reports count 17, not 16 (g1/e3).
- The DD-12 "Why expensive" target.
- The DD-14 failed-tool line is per repo.
- In f1 the Home repo order comes from Recent visits (DD-13).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | A — registry module | 6 | foundation, pure |
| 2 | A — tab bars from registry + tooltips | 8 | needs 1 |
| 3 | B — shared primitives | 5 | needs 1 |
| 4 | B — two-level session bar | 6 | needs 3 |
| 5 | C — lenses | 7 | needs 4 |
| 6 | D — Summary hub | 5 | needs 5 (chips use lens switch) |
| 7 | E — map model, questions, Charts follow | 4 | needs 1, 3 (week window), 5 |
| 8 | E — map route and page | 7 | needs 7 |
| 9 | E — doors, picker, help | 6 | needs 8 |
| 10 | F — Home data layer and pins | 6 | needs 7 (questions) |
| 11 | F — Home widgets | 8 | needs 10 |
| 12 | Docs, KB, release | 6 | needs 1–11 |
| 13 | Tests — adapt existing scenarios and e2e | 8 | needs 4–5; session scenarios and e2e that click tabs are expected red from Chunk 4 until this chunk, so iterate with the fast set only |
| 14 | Tests — algorithm docs and new steps in existing scenarios | 7 | needs 13 |
| 15 | Tests — new navigation scenario S-NAV-01 | 6 | needs 14 |
| 16 | Site screenshots with a Fable judge | 6 | last; needs a working build |

### Chunk 1 — A: registry module
- [ ] In `client/src/viewer/tab-ids.ts` add `TabScope`, `SessionGroup`, `TabVisibilityContext`, `TabRow`, and `SESSION_GROUPS` per DD-1 and DD-3; keep the module pure (no React/router/asset imports).
- [ ] Add `TAB_REGISTRY` rows for all seven scopes with labels from today's components (DD-5 list), `description`/`synonyms` per DD-5, the visibility and `gate` per DD-1, session rows in Part-A order per DD-2, and `call-tree` as `aliasOf:'charts'`.
- [ ] Reorder the `SESSION_TABS` literal to the DD-2 Part-A order; leave the other `*_TABS` arrays unchanged; keep all `*_TABS` exports, types and `tabTestId`.
- [ ] Add `tabsOf`, `visibleTabs`, `tabRow` and `assertRegistryMatchesArrays()` (DD-1), and call the assertion at module load.
- [ ] In `reports/report-catalog.ts` add `description` and `synonyms` to `ReportDefinition` and fill every report per DD-5.
- [ ] In `analytics/analytics-state.ts` add `synonyms` to `VIEW_OPTIONS` entries per DD-5.

### Chunk 2 — A: tab bars from registry + tooltips
- [ ] `ui/page-tabs.tsx`: add optional `description` to `PageTab`; when it is set, wrap the trigger in `Tooltip` + `TooltipContent variant="light" side="bottom" className="max-w-[280px]"`.
- [ ] `RepositoryView.tsx`: replace `MAIN_TAB_LABELS` with `visibleTabs('repo', {canSeeTeamWideTabs})` rows mapped to `{value,label,description}`; keep the `visibleMainTab` fallback (:359).
- [ ] `RepositorySettings.tsx`, `AdminPage.tsx` (keep the non-admin `data-retention` filter through `visibleTabs('admin',{isAdmin})` and the first-visible fallback), `TeamDetailPage.tsx` (`canSeeOtel`) and `ApiKeysPage.tsx`: build their tab lists from the registry.
- [ ] Add `teamWideAccess(team, userId)` to `tab-ids.ts` (rule in DD-10, Per-container visibility) and use it for `canSeeTeamWideTabs` in `RepositoryView.tsx:106-117` and `canSeeOtel` in `TeamDetailPage.tsx:44-50`.
- [ ] `SessionChartsTab.tsx`: replace `CHART_TAB_LABELS` with `tabsOf('chart')` labels and descriptions.
- [ ] `SessionTabBar.tsx`: render `visibleTabs('session', ctx)` in registry order; decorations stay keyed by id (Bash count `session-bash-count`, Raw Logs lock); every trigger gets the description tooltip.
- [ ] `SessionTabBar.tsx`: Raw Logs amber tooltip shows the registry description as its first line, then the existing privacy text.
- [ ] `SessionDetailPane.tsx`: build the `TabVisibilityContext` (`hasAdvisorResult`, `canSeeRawLogs`) and pass it to the bar; keep the redirects at :178-182 and :228-246.

### Chunk 3 — B: shared primitives
- [ ] Create `client/src/viewer/lib/user-storage.ts` per DD-6 (try/catch on every access, key `artisyn:<userId>:<name>`).
- [ ] Create `client/src/viewer/ui/overflow-row.tsx` (`OverflowRow`) per DD-8: ResizeObserver fitting, active item kept, fixed `h-9`, More `Popover` with optional `sections`, configurable `moreTestId`.
- [ ] `ui/notification-dot.tsx`: add optional `testId` and `label` props per DD-9, defaulting to today's values.
- [ ] Create `pages/repository/session-tab-groups.ts` with `groupOf`, `visibleGroups`, `groupTabs` and `pickGroupTab` per DD-8.
- [ ] Create `lib/week-window.ts` per DD-16.

### Chunk 4 — B: two-level session bar
- [ ] In `tab-ids.ts` move the session rows and the `SESSION_TABS` literal to the DD-2 group order.
- [ ] Create `SessionGroupBar.tsx`: a group row (`tab-session-group-<g>`, `aria-pressed`) and a tab row of the active group, each in an `OverflowRow` (`session-groups-more`, `session-tabs-more`); `SessionTabBar.tsx` renders it.
- [ ] Active group = `groupOf(sessionTab)`; clicking a group calls `onSessionTabChange(pickGroupTab(g, remembered, visible))`; hide groups with no visible tabs.
- [ ] `SessionDetailPane.tsx`: on every `sessionTab` change, write `session-group-tabs[groupOf(tab)]` via `user-storage` for the current user id.
- [ ] Add the Tools/MCP failure dot (DD-9) from the memoised `usage` in `SessionDetailPane` and pass it to the bar as `toolsFailure: boolean`.
- [ ] Make More-menu entries use the same `tab-session-<id>` test ids, decorations and tooltips as bar triggers (DD-4); selecting one calls `onSessionTabChange`; update `client-component-map.md` for `SessionTabBar`, `SessionGroupBar`, `OverflowRow`, `session-tab-groups.ts` and `user-storage.ts`.

### Chunk 5 — C: lenses
- [ ] Create `pages/repository/session-lenses.ts`: `LENSES` table, `parseLens`, `DEFAULT_LENS='cost'`, `lensRow` and `lensDefaultTab` per DD-7.
- [ ] `useRepositoryViewState.ts`: expose `lensParam` (parsed `lens=`) and `switchLens(lens, defaultTab)`, which writes `lens` and the tab in one `setSearchParams(…,{replace:true})` per DD-7; `setSessionTab` leaves `lens` untouched.
- [ ] `SessionDetailPane.tsx`: compute the effective lens (URL → `session-lens` storage → `cost`); on `switchLens`, store `session-lens`.
- [ ] Create `SessionLensSwitcher.tsx` (segmented control, `session-lens-<id>`, `aria-pressed`, Visual/UX notes) and mount it above the tab bar.
- [ ] Create `SessionLensRow.tsx`: an `OverflowRow` with the `lensRow` row, a `border-l` divider plus `extra` when set (wireframe c4: out-of-lens active tab shown last), and More `sections` = the `more` groups. `SessionTabBar.tsx` renders it for `lens !== 'all'` and `SessionGroupBar` for `all`.
- [ ] Make sure a session URL without `tab=` opens Summary under every lens, and that an explicit `tab=` wins (no default-tab write on load).
- [ ] Update `client-component-map.md` and `client-routing-and-layout.md` (the `lens=` param, storage keys `session-lens` and `session-group-tabs`).

### Chunk 6 — D: Summary hub
- [ ] Create `summary/summary-cards.ts` with `buildSummaryCards(input)` per DD-20; input = the values the band already uses, plus `bashCount`, the change-surface aggregate and the advisor result.
- [ ] Create `summary/SummaryNextCards.tsx`: a "Where to look next" heading, `summary-next-cards` grid, `summary-card-<tab>` cards with headline, sub-line, the dimmed state and "Open →" calling `onSessionTabChange`.
- [ ] Create `summary/SummaryExploreChips.tsx`: four chips per DD-20 (`summary-explore-<lens>`) calling `switchLens`.
- [ ] `SessionSummaryTab.tsx`: mount cards then chips right after `SummaryExecutiveBand` (:233-260); thread `switchLens`, `bashCount` and the change-surface data from `SessionDetailPane` without new queries.
- [ ] Update `client-component-map.md` for the new summary components.

### Chunk 7 — E: map model, questions, Charts follow
- [ ] Create `pages/map/nav-tree.ts` with `NavNode`, `NavTarget`, `NavTreeInput`, `buildNavTree` (structure FR-E1, ids and visibility per DD-10/DD-11) and `matchNavFilter` (rules in DD-10); keep it pure.
- [ ] Create `pages/map/nav-questions.ts` with `NAV_QUESTIONS` per DD-12, using `weekWindow` and `routes` (import-safe, DD-10).
- [ ] `charts/chart-tab.ts`: add `writeChartTab` per DD-19; `SessionChartsTab.tsx` subscribes to `loghub:charts-sub-tab` and unsubscribes on unmount.
- [ ] `TeamDetailPage.tsx` and `ApiKeysPage.tsx`: seed the initial tab from `location.state.teamTab` / `apiKeysTab` when it is a valid id (DD-10).

### Chunk 8 — E: map route and page
- [ ] Add `ROUTE.map='/map'` with access `auth` in `app-routes.ts`, `routes.map(params?)` in `useHashRoute.ts`, the `MapPage` export in `workspace-lazy-group.ts` and the router entry in `main.tsx`.
- [ ] Create `pages/map/useNavTreeInput.ts`: read the queries `['my-repos']`, `['teams']`, `['team-repos', id]`, the auth user, `nav.json` (the help index the `HelpModal` already loads), `REPORT_CATEGORIES`, `VIEW_OPTIONS`, `NAV_QUESTIONS` and the URL rail params.
- [ ] Create `MapPage.tsx`: title "All views", the `map-filter` input autofocused with `q=` synced via `setSearchParams(replace)`, the `map-counter`, the question section on top, then `MapTree`.
- [ ] Create `MapTree.tsx`: tree rows (icon, label, decorations, "What it answers" column / tooltip below `md`, child count when collapsed), expand state in `map-expanded` (DD-6), default top level + context path open.
- [ ] `MapTree.tsx`: filter highlighting from `matchNavFilter`, a synonym chip, dimmed non-matches, auto-expanded match branches without touching stored state, and the keyboard per DD-18.
- [ ] Map leaf activation: `route` targets via `navigate(path+search,{state})`, `chart` via `writeChartTab` then navigate, `help` via a local `HelpModal initialSlug` (pattern `otel/OtelHelpLink.tsx`).
- [ ] Add `/map` rows to `tests/scenarios/tours/screen-registry.ts`.

### Chunk 9 — E: doors, picker, help
- [ ] Create `MapContextRail.tsx`: Team / Repository / Session fields prefilled from URL params, else Recent (marked "from Recent"), else "choose…"; test ids per DD-4.
- [ ] Create `MapSessionPicker.tsx` (`map-picker`): Recent sessions of the rail repo, latest sessions (`fetchRepositorySessions`), search by id or first prompt, "Open the session list instead →"; a pick fills the rail and opens the clicked node.
- [ ] Greyed `needs` nodes show "choose a session ▸" (or repo / team) and open the picker; nothing is picked silently.
- [ ] Create `hooks/useAllViewsShortcut.ts` per DD-18 and mount it in `components/AppShell.tsx`; Esc on an empty filter or Back returns per DD-18.
- [ ] `MainNav.tsx`: add the "All views" button (`nav-all-views`, light tooltip "All views (Ctrl+K)") next to Help; it navigates to `routes.map()` with the current route's team/repo/session params and `state.from` (DD-18).
- [ ] Write `user-docs/all-views.md` (map, rail, filter, keys, questions), add it to `nav.json`, add its `screen-registry.ts` row, and run `npm run build:help`.

### Chunk 10 — F: Home data layer and pins
- [ ] Create `lib/recent-visits.ts` (pure model) and `lib/useRecentVisits.ts` (hook) per DD-15.
- [ ] `RepositoryView.tsx`: record repo opens and session/tab visits through `recordRepo` / `recordSession`; `SessionNotFoundState` path calls `dropSession`.
- [ ] Create `lib/home-pins.ts` (`parsePins`, `togglePin`, `serializePins`) and `lib/useHomePins.ts` over `userSettingsQuery` + `saveUserSetting('home.pins')` with an optimistic update (DD-17).
- [ ] Create `components/PinToggle.tsx` (`pin-toggle`, light tooltip "Pin to Home" / "Unpin") taking a `Pin`.
- [ ] Mount `PinToggle` in `RepositoryHeader.tsx` (repo pin), `analytics/AnalyticsControls.tsx` next to the view select (`analytics:<av>`) and `reports/ReportDocumentHeader.tsx` (`report:<id>`).
- [ ] Create `pages/main/home/useHomeRepos.ts`: the visible-repo union and order per DD-13, `showAll` state, and per-entry queries (executive summary for `weekWindow`, `['hook-repos']`, hook state).

### Chunk 11 — F: Home widgets
- [ ] Create `home/HomeWidget.tsx`: card shell with title, skeleton placeholder, error line + Retry (`refetch`), and the widget test id.
- [ ] Create `home/HomeRepoEntries.tsx`: name, last activity, sessions and cost this week, hook status, question chips (DD-12), "All views of this repo", and "Show all (N)" (DD-13).
- [ ] Create `home/HomeQuestions.tsx` (question cards for a chosen shown repo, first entry by default) and "All views →" to `routes.map()`.
- [ ] Create `home/HomeRecent.tsx` (from `useRecentVisits`, filtered by visible repos) and `home/HomePinned.tsx` (pins + favorites per DD-17, unpin on each line).
- [ ] Create `home/HomeNeedsAttention.tsx` per DD-14 (three kinds, 5 lines each, in-place "Show all").
- [ ] Create `home/HomeThisWeek.tsx`: cost per shown repo (shared executive-summary query keys) and cost per team = the sum of the per-repo executive summaries with `teamId` over the visible team repos.
- [ ] Create `home/HomeGetStarted.tsx` (links: `routes.apiKeys` with `state.apiKeysTab='install'`, help `getting-started`, `connect-repository`), shown when there are no repos and no teams.
- [ ] Rewrite `pages/main/MainPage.tsx` to the Visual/UX Home layout, rendering the shell before any data; update `client-component-map.md` for all Home and map files.

### Chunk 12 — Docs, KB, release
- [ ] `user-docs/session-log.md`: add a "Lenses and tab groups" section (lens list, defaults, More, `lens=` link, groups remembering a tab).
- [ ] `user-docs/getting-started.md`: add a Home page paragraph (widgets, pins, Recent, questions); run `npm run build:help`.
- [ ] Update `docs/knowledgebase/client-routing-and-layout.md` (`/map`, Ctrl+K, storage keys, the `loghub:charts-sub-tab` event, `location.state` tab seeding) and `docs/knowledgebase/index.md` descriptions.
- [ ] Add `session-lens-row.md` and `nav-filter-match.md` to `docs/knowledgebase/algorithms/README.md`.
- [ ] Set the root `package.json` `version` to `1.2.0`.
- [ ] After `npm run build`, count the dynamically loaded chunks in the client build output and check they stay within the budget in `client-routing-and-layout.md:69-71` (about 8, never more than 10); the map goes into the Workspace barrel.

### Chunk 13 — Tests: adapt existing scenarios and e2e
- [ ] `tests/scenarios/helpers/session-view.ts`: add `lens` to `openSession` options (appends `&lens=`); add `selectSessionTab(page, id)` (click `tab-session-<id>` if visible, else `session-tabs-more` then the entry; else the owning group first) and `selectLens(page, lens)`.
- [ ] Replace direct `getByTestId('tab-session-…').click()` with `selectSessionTab` in `view/s-sess-01.spec.ts` (:112,130,161) and `view/s-sess-04.spec.ts` (:120-143).
- [ ] Do the same in `view/s-cost-01/02/03.spec.ts`, `view/s-otel-01.spec.ts` (:489) and `repos/s-repo-17.spec.ts` (:370,381).
- [ ] Do the same in `sessions/s-slife-09.spec.ts` (:186) and `hook/s-compat-01.spec.ts` (:472); grep `tab-session-` across `tests/scenarios` for any remaining direct clicks.
- [ ] `tours/tour-kit.ts` (:265-273): make `expectTabsOnScreen` for `session` open `lens=all` and walk each group, asserting every visible registry tab of that group; update `tour-05-session-detail.spec.ts` (:97).
- [ ] Check `tours/tour-10-registry.spec.ts` and `auth/s-adm-01.spec.ts` against the reordered `SESSION_TABS` and registry exports; adjust only imports, not assertions.
- [ ] Legacy e2e `tests/e2e/session-log-view.spec.ts` (:142,150,592,600,694) and `tests/e2e/repo-panel.spec.ts` (:467,482): open the session with `lens=all`, click the owning group, then the tab by test id.
- [ ] Run each touched scenario with `npm run test:scenarios -- --mode a --only scenarios --grep "<tag>"` until green.

### Chunk 14 — Tests: algorithm docs and new steps in existing scenarios
- [ ] Write `docs/knowledgebase/algorithms/session-lens-row.md` (rules from DD-7/DD-8, examples block covering every lens, hidden Advisor, `extra` divider, More grouping, a hidden default, `pickGroupTab`) and `session-lenses.algo.test.ts` loading it via `scripts/algo-docs/load-examples.cjs`.
- [ ] Write `docs/knowledgebase/algorithms/nav-filter-match.md` (DD-10 matcher rules; examples: "cost", "expensive", "fail", "co", "cl md", empty) and `nav-tree.algo.test.ts`.
- [ ] `s-sess-01`: add steps for Info through More under the default Cost lens, and `?tab=logs&lens=cost` showing Logs active after the divider.
- [ ] `s-sess-04`: add steps for a lens switch writing `tab=` (the default tab opens), a reload keeping the lens, and All → group switch → back reopening the last tab.
- [ ] `s-sess-01`: add Summary-card steps: Statistics card cost equals the band Cost tile; Change surface card is dimmed on a fixture session with no changed paths; OKF card has no figure; "Open →" switches tab; no new request while Summary opens (`page.on('request')` diff).
- [ ] `tour-05`: add steps for Ctrl+K opening the map with the filter focused, typing "cost" highlighting Charts › Call tree, Enter opening Charts on Call tree while another sub-tab was mounted, and Esc returning.
- [ ] Run `bun run test` in `client/` and the touched scenarios until green.

### Chunk 15 — Tests: new navigation scenario S-NAV-01
- [ ] Create `tests/scenarios/view/s-nav-01.spec.ts` (`@S-NAV-01 @mode-a`) and `tests/scenarios/helpers/nav.ts` (`openMap`, `mapFilter`, `mapNode`, `homeWidget`). Seed one owner, one member, one team, three repos (two personal, one team) and sessions via `uploadGoldenRepo` (`helpers/session-view.ts`), `tests/scenarios/helpers/prompt-session.ts` and `uploadHookStatusSession` (`tours/tour-seed.ts`).
- [ ] Home steps: owner sees an entry per visible repo, every widget fills after its placeholder, Needs attention lists the hook repo and opens Hook state, a question card opens its DD-12 target, and Get started shows for a fresh user (after `skipNewUserNudge`).
- [ ] Session steps: Home → repo → session lands on Summary under Cost; walk all lenses, the All groups with remembered tabs, More at a narrow viewport (`page.setViewportSize`), a Summary card and an Explore chip.
- [ ] Map steps: from a session the rail shows team / repo / session; from Home with empty Recent the session nodes are greyed and the picker opens the chosen tab; filter "expensive" hits the question; keyboard ↑/↓/→/←/Enter; Back returns.
- [ ] Visibility and identity steps: the member sees no admin nodes and not the owner's private repo; a pin is shown on another browser context; after switching identity Recent shows none of the first user's visits, and after switching back they reappear; deep links `tab=`, `mtab=`, `stab=` and admin `tab=` open the same tabs as before.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-NAV-01"` until green; add S-NAV-01 to `docs/knowledgebase/test/scenarios.md`.

### Chunk 16 — Site screenshots with a Fable judge
- [ ] Start the dev server and client (CLAUDE.md Environment); import the demo repository export from local prod via Settings › Import/Export into the test identity; using the `use-playwright` skill, capture candidate PNGs (≥ 3 framings each) into `tmp/site-shots/` of: two-level bar, lens switcher + Cost row with More open, Summary hub cards, the map filtered "cost", Home.
- [ ] Check every candidate for the site shot rule in `docs/knowledgebase/user-docs-and-site.md:163-166` (demo repository, English UI, no e-mail, user name or local path; content pane cropped) and drop violators.
- [ ] Spawn an `Agent` with `model: "fable"` giving it the candidate paths and a rubric (clarity of the navigation idea, readability at 900 px, visual balance, no clutter, 1–10 score and a one-line reason each); keep the best per subject, retake subjects whose best is below 7.
- [ ] Copy the winners into `site/assets/shots/` (`nav-two-level.png`, `nav-lenses.png`, `summary-hub.png`, `all-views-map.png`, `home.png`).
- [ ] Add `<figure class="shot">` blocks with "where in the app" captions to `site/pages/features.html` (new "Navigation" section) and one hero shot on `site/pages/home.html`; run `npm run build:site` and check `tmp/site/`.
- [ ] Update the screenshot list in `docs/knowledgebase/user-docs-and-site.md`.
