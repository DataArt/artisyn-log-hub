# Implementation plan — 2026-11-05 Budgets, Spend Forecasts and Cost Slices

## TL;DR

- **New server module** `server/src/logs/budgets/`: `BudgetsService` (CRUD + event log), `BudgetAccessService` (who may view / manage a scope), `SpendService` (the one spend read shared by the Spend tab, the Budget report and the Budget burn view), `BudgetThresholdScheduler` (5-minute job, new env `BUDGET_CHECK_INTERVAL_MS` and `BUDGET_CHECK_ENABLED`), `BudgetNoticesService` (tray, read state), `BudgetsCleanup` (scope deletion helper), pure `budget-math.ts`.
- **New pure function in `otel-cost.sql.ts`**: `selectBudgetTreeCostMicros` — the budget-only "larger of hook tree cost and `otel_session_totals`" rule, a documented exception to "Log Hub's price is the source of truth".
- **DB**: migration `0093_budgets.sql` adds four tables — `budgets`, `budget_notices`, `budget_notice_recipients`, `budget_events`. Existing tables are unchanged.
- **API**: 18 new routes. Budgets CRUD, events and spend live under `/api/v1/repositories/:repoId/…` (personal and team-repo via `?teamId`) and `/api/v1/teams/:teamId/…`. Repository-only `analytics/budget-burn` and `reports/budget`. User-wide `/api/v1/budget-notices`, with read marking only via POST.
- **Mail**: new public `MailService.sendBudgetNoticeEmail`, sent only when `isConfigured()`. `MailModule` is added to the `LogsModule` imports.
- **Existing services touched**: repository/team-repo delete and URL-rewrite paths in `admin.service.ts`, `account-deletion.service.ts`, `teams.service.ts` and `repo-backfill.service.ts` call the DI-free `budgets-cleanup.ts` functions.
- **Config, perf and docs**:
  - `release-template/.env.example` gets `BUDGET_CHECK_*`.
  - A `spend-heavy` perf entry is added.
  - A new `user-docs/budgets.md` page, plus edits to 11 existing user docs.
  - KB: new `budgets.md` and algorithm doc `budget-spend-math.md`.
- **Client**:
  - New Spend tab (repository + team page) and a new Settings › Budgets sub-tab.
  - New team Settings tab, and URL state on the team page (`ttab`, `sp`, `so`).
  - Bell extended with budget notices, plus a global banner in `AppShell`.
  - New Analytics view `budget-burn` and new report `budget`.
- **Tests**:
  - Algorithm doc + rows `budget-spend-math`, plus new `budget-tree-cost` rows in `otel-cost-selection.json`.
  - Contract family `f26-budgets.ts`.
  - New scenario `S-BUDG-01` (a new feature with no existing scenario), plus steps in `S-TEAM-02` and `S-AUTH-01` (mode B, Mailpit).

## Reference

Requirements: [requirements.md](requirements.md) (wireframes in `wireframes/`; research trail in `research/findings-1.md`).

## Design Decisions

**DD-1 Scope model.** A budget's scope is one of three kinds, stored as columns (no FK to `repositories` / `team_repositories`, per FR-1 "stored by repository URL"):

| `scope_kind` | `user_id` | `team_id` | `repo_url` | Who manages | Who views (full) |
|---|---|---|---|---|---|
| `repo` (personal repository) | owner | NULL | URL | the `repositories` row owner | owner |
| `team-repo` | NULL | team | URL | team owner, team managers (`team_members.is_manager`) | `resolveTeamScope(...).analyticsAllowed` |
| `team` | NULL | team | NULL | team owner, team managers | `resolveTeamScope(...).analyticsAllowed` |

TypeScript shape, used by every chunk:
`type BudgetScope = { kind: 'repo'; userId: number; repoUrl: string } | { kind: 'team-repo'; teamId: number; repoUrl: string } | { kind: 'team'; teamId: number }`.

**DD-2 Route → scope resolution** (`BudgetAccessService.resolveScope`):
- `/repositories/:repoId/...` without `teamId`: `assertRepoAccess(user, repoId)`, then `{kind:'repo', userId: repo.userId, repoUrl: repo.repoUrl}`.
- `/repositories/:repoId/...?teamId=T`: `assertRepoAccess(user, repoId, T)`, then `{kind:'team-repo', teamId:T, repoUrl: repo.repoUrl}`.
- `/teams/:teamId/...`: the caller must be a team member, as `isTeamMember` does in `otel-team-facts.controller.ts:102` (403 otherwise). The scope is `{kind:'team', teamId}`.

It returns `ScopeAccess = { scope: BudgetScope; canManage: boolean; fullView: boolean; teamScope: TeamScope }`:
- `canManage`: `repo` kind is always true after `assertRepoAccess`. Team kinds are true for the team owner or `isManager`.
- `fullView`: `repo` kind is true. Team kinds use `teamScope.analyticsAllowed`.
- A non-manager calling a mutating route gets 403.

**DD-3 Budget spend rows are caller-independent.** One root set per scope, used identically by the Spend tab, report, burn view and threshold job, so the bar and the notices always agree:
- `repo`: repo ids = the `repositories` row `(user_id, repo_url)`; user filter `[userId]`.
- `team-repo`: repo ids = every member's `repositories` row with that URL (the `resolveRepoIds` join, `repositories.service.ts:311`); user filter = `resolveExportVisibleUserIds(teamId)` (`repositories.service.ts:516`; `null` = no filter for a transparent team).
- `team`: the same, over every URL in `team_repositories` of the team.

**DD-4 Root session selection (FR-2).** Roots are `sessions s` joined to an `artisyn` log `l` linked through `log_repositories` to the scope's repo ids, with:
- `l.first_prompt IS NOT NULL` and `s.deleted = false`;
- **no** `claude`-log requirement, so OTEL-only roots count once linked (pattern: `scopedTreeCtes`, `tool-usage-read.sql.ts:147`);
- `DISTINCT s.id`.

The anchor time is `l.start_time` when a `claude` log exists for the session. Otherwise it is `COALESCE(otel_session_totals.first_call_at, l.start_time)`. A root is in the period when `period_start <= anchor < period_end`.

**DD-5 Per-tree budget cost.** Each root's cost comes from `selectBudgetTreeCostMicros({ hookUsd, otelMicros })`:
- `hookUsd` is `readTreeCost(row).total` (`session-tree-cost.sql.ts:171`): the cost "as shown elsewhere", utility calls included, `null` when any part is unpriced.
- `otelMicros` is `otel_session_totals.cost_usd_micros` of the root; `0` or no row counts as missing.

The rule:
- `hookMicros = Math.round(hookUsd * 1e6)`.
- Both present: the larger value. `source` is `'otel'` only when OTEL is strictly larger, else `'hook'`.
- One side present: that side.
- Neither: `{micros: 0, source: 'none'}`, counted in `unpricedTrees`.

The SQL path loads the hook rows via `treeCostCtes` + `readTreeCost` and the OTEL value in the same query. The comparison runs in TypeScript through this one function; there is no SQL twin.

**DD-6 Period bounds** (`budgetPeriodSql`, one SQL round-trip). `unit ∈ {day, week, month}`, `tz` an IANA name validated with `isValidOtelTimeZone` (`otel/otel-classify.ts:98`), `offset ≤ 0` (the ‹ › picker; clamped to ≥ −400).
- `period_start = (date_trunc(unit, now() AT TIME ZONE tz) + offset * interval '1 unit') AT TIME ZONE tz`.
- `period_end` is the same with `offset + 1`. Postgres `date_trunc('week')` starts on Monday.
- Day-based periods (week, month):
  - `total_days = (period_end AT TIME ZONE tz)::date - (period_start AT TIME ZONE tz)::date`.
  - `elapsed_days = LEAST(total_days, (now() AT TIME ZONE tz)::date - (period_start AT TIME ZONE tz)::date + 1)`.
- Day period, counted in hours (`period = 'day'`):
  - `total_hours = round(extract(epoch FROM period_end - period_start) / 3600)`, which is 23, 24 or 25 across DST.
  - `elapsed_hours = LEAST(total_hours, floor(extract(epoch FROM now() - period_start) / 3600) + 1)`.
- `is_current = offset = 0`. Past periods use elapsed = total, have no forecast and no days-left, and `overspendRisk` is false.
- Daily buckets are local dates `to_char(anchor AT TIME ZONE tz, 'YYYY-MM-DD')`. A day budget uses hourly buckets `HH24`.

**DD-7 Budget math (`server/src/logs/budgets/budget-math.ts`, pure, pinned by `budget-spend-math` rows).**

`computeBudgetForecast({spendMicros, amountMicros, elapsedUnits, totalUnits, isCurrent})` returns `BudgetForecast` (shape in API changes).
- `burnRate = spend / elapsedUnits`.
- `forecast = Math.round(spend + burnRate × (totalUnits − elapsedUnits))`.
- `percentUsed = spend / amount × 100`, or `null` without an amount.
- `status`:
  - `'exceeded'` when `spend ≥ amount`;
  - else `'no-rate'` when `burnRate = 0`;
  - else `'ok'`.
- `unitsLeft = (amount − spend) / burnRate`, only when `status = 'ok'`, otherwise `null`.
- `overspendRisk = isCurrent && amount != null && forecast > amount`.
- Past period: `forecast = spend` and `unitsLeft = null`.

`markAnomalyDays({dailyMicros, elapsedUnits, spendMicros})` returns the indices `i < elapsedUnits` with `dailyMicros[i] ≥ 2 × spend / elapsedUnits`. It returns none when `elapsedUnits ≤ 1` or the spend is 0.

`markCostlySessions(trees: {id: number; micros: number; source: 'hook'|'otel'|'none'}[])`:
- Uses only trees with `source ≠ 'none'`.
- Population mean and σ. No marks when n < 5 or σ = 0.
- `level = 3` when `micros ≥ mean + 3σ`, else `2` when `micros ≥ mean + 2σ`.
- Returns `{mean: number, sigma: number, marks: {id: number; level: 2 | 3}[]}`. Mean and σ are 0 when there are no marks because n < 5.

`markAnomalyDays` returns `number[]` (indices). `computeBudgetForecast` returns `BudgetForecast` without `unit`; the caller adds it.

`selectThresholdNotices({thresholds, spendMicros, amountMicros, existing: number[]})`:
- `crossed = {t : spend × 100 ≥ t × amount}`, compared in BigInt.
- `fresh = crossed \ existing`.
- If `fresh` is empty: `{notify: null, superseded: []}`.
- Otherwise, with `top = max(fresh)` and `maxExisting = max(existing, 0)`:
  - `top > maxExisting`: notify `top`; every other fresh threshold is superseded by `top`.
  - Otherwise every fresh threshold is superseded by `maxExisting`.
- Returns `{notify: number | null, superseded: {threshold: number; supersededBy: number}[]}`, with `superseded` sorted ascending by threshold.

**DD-8 Cost slices (FR-4).** Every slice adds up to `spendMicros`. Each slice has a `Not reported` row equal to `max(0, spend − attributed)`.
- **model**
  - `hook` source: `main_cost` goes to `main_model`; each `tree_subagent_rows` cost goes to its `model_id`; `utility_cost` goes to the row `Utility calls`.
  - `otel` source: the root's `otel_calls` grouped by `model` (the OTEL per-call model).
  - The gap between the parts and the tree's budget cost goes to `Not reported`.
- **user**: the root's `logs.user_id` email, full tree cost.
- **repository**: the root's repo URL, full tree cost.
- **branch**: `COALESCE(l.git_branch, 'no branch')`, full tree cost.
- **sub-agent**
  - `hook` source: `Main agent` gets `main_cost + utility_cost`; each sub-agent gets its cost, labelled `COALESCE(NULLIF(s.agent_description, ''), 'Unnamed sub-agent')`.
  - `otel` source: `otel_calls` with `agent_id IS NULL` go to `Main agent`; the rest are grouped by `COALESCE(agent_name, 'Unnamed sub-agent')`.
- **skill**: `otel_calls.cost_usd_micros` of the period's roots, grouped by `skill_name` (`''` / NULL goes to `Not reported`).
- **mcp**: the same, grouped by `mcp_server_name`.

OTEL slices select calls by `session_id = ANY(period root ids)`, never by call time. Each row carries `{key, label, sessions, micros, share}`, where `share = micros / spend`. Rows are sorted by micros descending, with `Not reported` last.

**DD-9 Plain-member view (FR-7).** When `fullView` is false (team kinds, no analytics access):
- The Spend route computes the caller's own spend: the DD-3 rows with user filter `[caller.id]`.
- It returns only the budgets where own spend > amount, as `{restricted: true}` cards with own spend.
- `daily`, `slices`, `costlySessions` and `previous` are empty.
- `spend/sessions` returns 403.
- The `budgets` list returns 403. The `events` route returns 403 (FR-10: "visible to whoever can see the scope's budgets").

**DD-10 Notices.**
- `budget_notices` holds one row per `(budget_id, period_start, threshold)` (unique). `superseded_by` is NULL for the shown notice and holds the superseding threshold otherwise.
- `budget_notice_recipients(notice_id, user_id, read_at)` exists only for shown notices. Recipients:
  - `repo`: the owner.
  - team kinds: the team owner plus `team_members.is_manager`.
- One transaction does `INSERT … ON CONFLICT DO NOTHING RETURNING id`, then the recipients and events. Only a worker that got the id back sends email, after the commit.
- Email events: `email_sent` / `email_failed` per recipient, or one `email_skipped` when `!mailService.isConfigured()`.
- The email link base is `getEmailLinkBaseUrl()` (`common/public-base-url.ts:44`). When it is null, the email is sent without a link.

**DD-11 Event types** (`budget_events.event_type`): `created`, `edited`, `deleted`, `threshold_crossed`, `threshold_superseded`, `email_sent`, `email_skipped`, `email_failed`.

`details` jsonb shape:
- `edited`: `{before: BudgetSnapshot, after: BudgetSnapshot}`, where `BudgetSnapshot = {period, amountMicros, thresholds, timeZone}`.
- `threshold_*`: `{threshold, spendMicros, periodStart, supersededBy?}`.
- `email_*`: `{noticeId, recipientEmail?, error?}`.

Actor: `actor_user_id` plus an `actor_email` snapshot; NULL means "system · threshold job". `budget_label` snapshot is e.g. `Monthly $50.00`.

**DD-12 Budget validation** (server, 400; duplicate period is 409):
- `period ∈ {day, week, month}`.
- `amountUsd` is a number > 0 and ≤ 1 000 000 with at most 2 decimals. Stored as `amount_micros = Math.round(amountUsd × 1e6)`.
- `thresholds` are 1–10 distinct integers 1–200, stored sorted ascending; the default is `[75, 90, 100]`.
- `timeZone` must pass `isValidOtelTimeZone`.
- A second budget with the same scope and period gets 409 `{message: 'A <period> budget already exists for this scope'}`.

**DD-13 Deletion cascade** (FR-14):
- Team deletion: `team_id` FK `ON DELETE CASCADE` on all three tables carrying scope columns.
- User deletion: the `user_id` FK cascades the `repo` kind.
- Repository / team-repository removal goes through `BudgetsCleanup`, which every code path calls inside its existing transaction:
  - `deletePersonalRepo(tx, repoUrl, userId?)`
  - `deleteTeamRepo(tx, teamId, repoUrl)`
- Delete call sites:
  - `admin/admin.service.ts:365` (personal, by URL, all users), `:369` and `:448` (team repo);
  - `users/account-deletion.service.ts:192` (team repo);
  - `teams/teams.service.ts` `unlinkTeamRepository` (~:547) and `removeTeamRepository` (~:576) (team repo), and `:658` (personal repo delete).
- URL rewrites use `rewritePersonalRepoUrl(tx, userId, oldUrl, newUrl)` and `rewriteTeamRepoUrl(tx, teamId, oldUrl, newUrl)`. Call sites in `repo-backfill.service.ts`:
  - `migrateLocalRepoIdentities`: ~:227 personal, ~:244 team.
  - `backfillRepoUrls`: ~:333 personal.
  - `backfillTeamRepoUrls`: ~:370 rewrite; ~:383 duplicate delete → `deleteTeamRepo`.
- **Merge conflict rule:** when the target URL already has a budget of the same period, the rewritten (source) budget is deleted. The target budget wins. Notices and events of the source get their `repo_url` rewritten and keep `budget_id` NULL.
- `budget_id` on notices and events is `ON DELETE SET NULL`, so they survive budget deletion with their snapshot columns.

**DD-14 Threshold job.**
- `BudgetThresholdScheduler` follows the `export-import-job-cleanup.scheduler.ts` template: `OnApplicationBootstrap`, `SchedulerRegistry.addInterval('budget-threshold-tick')`, an `isTickRunning` guard and `inFlightTick` awaited in `onModuleDestroy`.
- Interval: `Number(process.env.BUDGET_CHECK_INTERVAL_MS) || 300000`. `BUDGET_CHECK_ENABLED=false` disables it.
- Each tick, for every budget: `SpendService.computeBudgetSpend(budget)` (current period, DD-3/4/5), then `selectThresholdNotices`, then the DD-10 writes. Errors are logged per budget and never abort the tick.
- It runs in every cluster worker; the unique key dedups. It is never called from ingest.

**DD-15 Client URL state.**
- Repository page: `mtab=spend`, `sp=day|week|month` (default `month`), `so=<offset ≤ 0>` (default 0).
- Team page: new `ttab=<TeamTab>` (falls back to the `location.state` seed, then `members`), with the same `sp` / `so`.
- All writes use `setSearchParams(..., {replace: true})`.
- Notice links come from the server as `link: {teamId?: number, repoId?: number, period, offset}`; the client builds `#/repos/:repoId?...`, `#/teams/:teamId/repos/:repoId?...` or `#/teams/:teamId?ttab=spend&...`.
- The server resolves `repoId` as the recipient's own `repositories` row for the URL, else `MIN(id)` among team members' rows with that URL, else none. With no repo row, a team-repo link falls back to the team Spend tab.

**DD-16 Spend tab placement.** The repository `PageTabsContent value="spend"` renders **outside** `RepositoryTeamWideTabs`, so a plain member reaches it (DD-9). The registry row has no `visible` predicate. The team-page Spend tab is likewise visible to every member.

**DD-17 Settings tabs.**
- `SETTINGS_TABS` gains `budgets` between `session-attribution` and `maintenance`.
- `TEAM_TABS` becomes `members, repositories, invitations, otel, spend, settings`.
- The team Settings tab holds one sub-view: the Budgets section.
- In team-repo context the Budgets section is read-only when `!canManage`, with the note "Managed by the team owner and managers".
- When `GET budgets` returns 403 (a plain member, DD-9), the Budgets sub-tab shows only "Team budgets are visible to the team owner, managers and members with team analytics access", with no table and no event log.
- The team `settings` tab row has `visible: canSeeOtel` (`teamWideAccess`, the same predicate as the analytics rule).

**DD-18 Notice tray and banner.**
- `NotificationBell` merges a second query `['budget-notices']` (`refetchInterval: 60_000`). The unread badge is invitations plus budget `unreadCount`.
- The tray lists budget notices under the invitations, newest first. Older pages load on scroll via `before=<id>`. A "Mark all read" button posts `{all: true}`.
- Opening a notice posts `{ids: [id]}` and navigates to its link.
- `BudgetNoticeBanner`, mounted in `AppShell` under `MainNav`, shows unread notices from the same query, highest threshold first, at most 3 stacked.
- Colours: amber `bg-amber-50 text-amber-700 ring-1 ring-amber-100` below 100 %, red `bg-red-50 text-red-700 ring-1 ring-red-100` at ≥ 100 %.
- Banner × posts `{ids: [id]}`.

**DD-19 Report and burn view.**
- `reports/budget` and `analytics/budget-burn` call `SpendService` only.
- The report iterates each budget's periods overlapping `[startDate, endDate]`. It reports the current period with forecast, and past ones with spend and % only.
- The burn view's `branches` / `users` filters narrow only the cumulative line (`filtered: true`). `budget`, `forecast` and `thresholds` stay whole-scope.
- With no budget on the scope, the burn view covers the current calendar month in the viewer's `tz` and draws cumulative spend only.

**DD-20 "Opens matching sessions".** A click on a slice, an anomaly day or a costly session opens `SpendSessionsModal`. It is fed by `GET …/spend/sessions` and shows the root sessions (start, user, branch, cost, masked first prompt via `maskFirstPrompt`). Each row links to `#/repos/:repoId?session=<sessionId>` or its team variant. No session-list filter params are added.

**DD-21 Service contracts** (pinned for later chunks; `BudgetRow = typeof budgets.$inferSelect`).

Shared types:
- `ScopeAccess` (DD-2) and `BudgetScope` (DD-1) live in `budget-scope.ts` (Chunk 3). `ScopeAccess.teamScope` is the `TeamScope` from `RepositoriesService.resolveTeamScope`.
- `PeriodBounds = { start: Date; end: Date; isCurrent: boolean; elapsedUnits: number; totalUnits: number; unit: 'day' | 'hour'; offset: number; period: BudgetPeriod; timeZone: string }`, returned by `loadPeriodBounds(db, {period, tz, offset})`.

`spend-read.sql.ts`:
- `loadScopeBudgets(db, scope): Promise<BudgetRow[]>` reads the `budgets` table directly. `SpendService` and `BudgetsService.list` both use it, so Chunk 3 does not depend on Chunk 4.
- `loadAllBudgets(db): Promise<BudgetRow[]>` is used by the scheduler.
- `loadPeriodTrees(db, rows: {repoIds: number[]; userIds: number[] | null}, bounds: PeriodBounds, filters?: {branches: string[]; userEmails: string[]})` filters exactly like `loadScopedRootSessions` does for `branches` / `users`.
- `budget-burn` takes `branches` / `users` in the same format as the existing `reports.controller.ts` `branches` / `users` params, parsed by the same helper.

`budget-events.sql.ts` (Chunk 3; used by Chunks 4 and 5):
- `insertBudgetEvent(tx, e: {budget: BudgetRow; eventType: BudgetEventType; details: Record<string, unknown>; actor: {userId: number; email: string} | null})`.
- It copies `scope_kind`, `user_id`, `team_id`, `repo_url` and `budget_label = budgetLabel(period, amountMicros)` from `budget`. On `deleted` it is written before the row is removed.
- Notice rows take the same snapshot columns, plus `period`, `amount_micros` and `time_zone`, from the `BudgetRow`.

`SpendService` (Chunk 3):
- `getSpendView(access: ScopeAccess, viewerId: number, q: {period, offset, tz}): Promise<SpendView>`
- `getSpendSessions(access, viewerId, q: {period, offset, tz, slice, key}): Promise<{sessions: SpendSessionDto[]; truncated: boolean}>`
- `getBudgetBurn(access, viewerId, q: {budgetId?, branches: string[], users: string[], tz}): Promise<BudgetBurnView>`
- `getBudgetReport(access, viewerId, q: {startDate: Date, endDate: Date, tz}): Promise<BudgetReport>`
- `computeBudgetSpend(budget: BudgetRow): Promise<{spendMicros: number; bounds: PeriodBounds; scope: BudgetScope}>` — the current period, caller-independent (DD-3).

Chunk 4:
- `BudgetsService.toDto(row: BudgetRow, bounds?: PeriodBounds): BudgetDto`.
- `BudgetSnapshot = {period, amountMicros, thresholds, timeZone}` is declared in `budgets.types.ts` (Chunk 3).

`BudgetNoticesService` (Chunk 5):
- `resolveNoticeRecipients(scope): Promise<{userId: number; email: string}[]>`
- `recordCrossings(budget: BudgetRow, spendMicros: number, bounds: PeriodBounds): Promise<void>`

**DD-22 Constants and labels.**

Constants: `server/src/logs/budgets/budget.constants.ts`, mirrored as `BUDGET_LIMITS` in the client `budget-format.ts`:

| Constant | Value |
|---|---|
| `BUDGET_DEFAULT_THRESHOLDS` | `[75, 90, 100]` |
| `BUDGET_MAX_THRESHOLDS` | `10` |
| `BUDGET_THRESHOLD_MIN` / `_MAX` | `1` / `200` |
| `BUDGET_MAX_AMOUNT_USD` | `1_000_000` |
| `BUDGET_MIN_OFFSET` | `-400` |
| `BUDGET_EVENTS_PAGE` | default `50`, max `100` |
| `BUDGET_NOTICES_PAGE` | default `20`, max `100` |
| `BUDGET_ANOMALY_DAY_FACTOR` | `2` |
| `BUDGET_COSTLY_MIN_TREES` | `5` |
| `BUDGET_CHECK_DEFAULT_INTERVAL_MS` | `300000` |
| `BUDGET_BANNER_MAX` (client only) | `3` |
| `BUDGET_AMOUNT_DECIMALS` | `2` |
| `BUDGET_SESSIONS_LIMIT` | `200` (`spend/sessions` returns `truncated: true` beyond it) |
| `BUDGET_TZ_MAX_LENGTH` | `64` |
| `BUDGET_MAIL_SUBJECT` | `` `Log Hub budget: ${threshold} % of ${budgetLabel} reached (${scopeLabel})` `` |

All bigint money columns use Drizzle `bigint(..., { mode: 'number' })`, to match the `number` DTO fields.

Labels:
- `scopeLabel`:
  - `repo` → the repository URL's last path segment (owner/name for git URLs);
  - `team-repo` → `<team name> / <repo segment>`;
  - `team` → `<team name>`.
- `periodLabel`: local dates in the budget tz:
  - month → `November 2026`;
  - week → `9–15 Nov 2026`;
  - day → `10 Nov 2026`.

Client helper `budgetNoticeHref(link)` (DD-15 URL builder) lives in `budget-format.ts`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/src/database/schema/index.ts` | 4 new tables | per Database changes |
| `server/drizzle/migrations/0093_budgets.sql` | migration | hand-written, `COMMENT ON` every table/column, `IF NOT EXISTS` guards |
| `server/drizzle/migrations/meta/_journal.json` | journal entry | then `npm run migrations:lock` |
| `docs/knowledgebase/db_state.sql` | regenerated | db-state-update skill |
| `server/src/logs/otel-cost.sql.ts` | `selectBudgetTreeCostMicros` | DD-5 |
| `server/src/logs/otel-cost.sql.algo.spec.ts` | handle kind `budget-tree-cost` | existing table test |
| `server/src/logs/budgets/budget-math.ts` | pure math | DD-7 |
| `server/src/logs/budgets/budget-math.algo.spec.ts` | table test | loads `docs/algorithm-examples/budget-spend-math.json` |
| `server/src/logs/budgets/budgets.types.ts` | DTO / shared types | per API changes |
| `server/src/logs/budgets/budget-scope.ts` | `BudgetScope`, `budgetLabel()`, DD-12 validator | |
| `server/src/logs/budgets/budget-access.service.ts` | DD-2 | |
| `server/src/logs/budgets/spend-read.sql.ts` | period, roots, tree cost, slices SQL | DD-3/4/6/8 |
| `server/src/logs/budgets/spend.service.ts` | Spend view, sessions, burn, report, `computeBudgetSpend` | |
| `server/src/logs/budgets/budgets.service.ts` | CRUD + event writes + events read | |
| `server/src/logs/budgets/budgets-cleanup.ts` | DD-13 helper | |
| `server/src/logs/budgets/budget-notices.service.ts` | job writes, tray, read marks, links | |
| `server/src/logs/budgets/budget-threshold.scheduler.ts` | DD-14 | |
| `server/src/logs/budgets/budgets.controller.ts` | repo + team budget/spend routes | |
| `server/src/logs/budgets/budget-notices.controller.ts` | `/api/v1/budget-notices` | |
| `server/src/logs/reports/reports.controller.ts` | `reports/budget` | |
| `server/src/logs/analytics/usage-analytics.controller.ts` | `analytics/budget-burn` | |
| `server/src/logs/logs.module.ts` | register providers / controllers | `MailModule` import if not present |
| `server/src/mail/mail.service.ts` | `sendBudgetNoticeEmail` | |
| `server/src/admin/admin.service.ts`, `server/src/users/account-deletion.service.ts`, `server/src/teams/teams.service.ts`, `server/src/logs/repo-backfill.service.ts` | DD-13 calls | |
| `release-template/.env.example` | `BUDGET_CHECK_INTERVAL_MS`, `BUDGET_CHECK_ENABLED` | |
| `tests/scenarios/modes.ts` | `FAST_TICK_ENV.BUDGET_CHECK_INTERVAL_MS: '200'` | |
| `server/perf-tests/scenarios.ts`, `server/perf-tests/budgets.json` | `spend-heavy` perf entry | perf tooling per `server-conventions.md`, not a test kind |
| `client/src/viewer/api.ts` | budget / spend / notice fetchers + types | |
| `client/src/viewer/tab-ids.ts` | `spend`, `budgets`, team `spend` / `settings` rows | DD-16/17 |
| `client/src/viewer/pages/budgets/BudgetsSection.tsx` | table + inline form | wireframe `budget-form.svg` |
| `client/src/viewer/pages/budgets/BudgetForm.tsx` | inline form | |
| `client/src/viewer/pages/budgets/BudgetEventLog.tsx` | event log window | wireframe `budget-settings.svg` |
| `client/src/viewer/pages/budgets/budget-format.ts` | `formatUsdMicros`, `budgetLabel`, band colour | |
| `client/src/viewer/pages/spend/SpendTab.tsx` | Spend tab root | wireframe `spend-view.svg` |
| `client/src/viewer/pages/spend/BudgetCard.tsx` | bar + 4 tiles | |
| `client/src/viewer/pages/spend/DailySpendChart.tsx` | Recharts bars + pace line + markers | |
| `client/src/viewer/pages/spend/SliceTable.tsx` | slice picker + table | |
| `client/src/viewer/pages/spend/CostlySessionsList.tsx` | 2σ / 3σ list | |
| `client/src/viewer/pages/spend/SpendSessionsModal.tsx` | DD-20 | |
| `client/src/viewer/pages/spend/useSpendUrlState.ts` | `sp` / `so` params | |
| `client/src/viewer/pages/repository/RepositoryView.tsx` | mount Spend content outside the team-wide wrapper | DD-16 |
| `client/src/viewer/pages/repository/RepositorySettings.tsx` | `budgets` sub-tab | |
| `client/src/viewer/pages/repository/repository-tabs-lazy-group.ts` | export `SpendTab` | no new chunk |
| `client/src/viewer/pages/teams/TeamDetailPage.tsx` | `ttab` URL state, Spend + Settings tabs | |
| `client/src/viewer/components/top-nav/NotificationBell.tsx` | budget notices | |
| `client/src/viewer/components/BudgetNoticeBanner.tsx` | banner | wireframe `threshold-banner.svg` |
| `client/src/viewer/components/AppShell.tsx` | mount banner | |
| `client/src/viewer/pages/repository/analytics/analytics-state.ts`, `analytics-url.ts`, `AnalyticsControls.tsx` | `budget-burn` view | |
| `client/src/viewer/pages/repository/analytics/BudgetBurnView.tsx` | chart | wireframe `budget-burn.svg` |
| `client/src/viewer/pages/repository/reports/report-catalog.ts`, `ReportsPanel.tsx` | `budget` report | |
| `client/src/viewer/pages/repository/reports/BudgetReport.tsx` | report document | wireframe `budget-report.svg` |
| `docs/knowledgebase/algorithms/budget-spend-math.md` + `docs/algorithm-examples/budget-spend-math.json` | new algorithm | |
| `docs/knowledgebase/algorithms/otel-cost-selection.md` + `docs/algorithm-examples/otel-cost-selection.json` | budget exception | |
| `docs/knowledgebase/budgets.md` | new KB article | |
| `docs/knowledgebase/index.md`, `db-tables.md`, `client-component-map.md`, `server-endpoint-map.md`, `client-routing-and-layout.md` | KB updates | |
| `user-docs/budgets.md`, `user-docs/nav.json` | new user-docs page | then `npm run build:help` |
| `user-docs/analytics-reports.md`, `all-views.md`, `server-configuration.md`, `small-team-setup.md`, `tuning-your-setup.md`, `cost-and-context.md`, `otel-tab.md`, `responsibility-matrix.md`, `getting-started.md`, `session-list.md`, `changelog.md` | user-docs updates | per Chunk 12 |
| `server/src/logs/budgets/budget-events.sql.ts` | `insertBudgetEvent` | DD-21 |
| `client/src/viewer/pages/repository/analytics/AnalyticsChartArea.tsx` | render `budget-burn` | |
| `server/test/contract/registry/f26-budgets.ts`, `registry/index.ts`, `f26.contract-spec.ts`, world fixture | contract rows | |
| `tests/scenarios/view/s-budg-01.spec.ts` | new scenario | |
| `tests/scenarios/auth/s-team-02.spec.ts`, `tests/scenarios/auth/s-auth-01.spec.ts` (mode B, Mailpit) | added steps | |
| `server/src/logs/budgets/budget.constants.ts` | DD-22 constants | |

## API changes

All routes are cookie-session (`JwtAuthGuard`, as their sibling controllers). `R = /api/v1/repositories/:repoId` (with `?teamId=` for team-repo) and `T = /api/v1/teams/:teamId`. Literal segments (`events`, `sessions`) are declared before `:budgetId`.

| Method | Route | Params / body | Response | Access (DD-2) |
|---|---|---|---|---|
| GET | `R/budgets`, `T/budgets` | — | `{budgets: BudgetDto[], canManage: boolean}` | `fullView`, else 403 |
| POST | `R/budgets`, `T/budgets` | `BudgetInput` | `BudgetDto` (201); 400 invalid; 409 duplicate period | `canManage` |
| PUT | `R/budgets/:budgetId`, `T/budgets/:budgetId` | `BudgetInput` | `BudgetDto`; 404 if not in the scope | `canManage` |
| DELETE | `R/budgets/:budgetId`, `T/budgets/:budgetId` | — | 204 | `canManage` |
| GET | `R/budgets/events`, `T/budgets/events` | `budgetId?`, `event?`, `before?` (id), `limit?` (1–100, default 50) | `{items: BudgetEventDto[], nextBefore: number \| null}` | `fullView` |
| GET | `R/spend`, `T/spend` | `period` (day/week/month), `offset` (≤ 0), `tz` (viewer tz, used when there is no budget) | `SpendView` | member; DD-9 when `!fullView` |
| GET | `R/spend/sessions`, `T/spend/sessions` | `period`, `offset`, `tz`, `slice` (`model\|user\|repo\|branch\|subagent\|skill\|mcp\|day\|costly`), `key` (row key / `YYYY-MM-DD` / `all`) | `{sessions: SpendSessionDto[], truncated: boolean}` (max `BUDGET_SESSIONS_LIMIT`, costliest first) | `fullView` |
| GET | `R/analytics/budget-burn` | `budgetId?` (default month › week › day), `branches?`, `users?`, `tz` | `BudgetBurnView` | as other `analytics/*` (403 when `!analyticsAllowed`) |
| GET | `R/reports/budget` | `startDate`, `endDate` (validated like `reports.controller.ts:128`), `tz` | `BudgetReport` | as other `reports/*` |
| GET | `/api/v1/budget-notices` | `before?`, `limit?` (default 20) | `{items: BudgetNoticeDto[], unreadCount: number, nextBefore: number \| null}` | the caller's own recipient rows |
| POST | `/api/v1/budget-notices/read` | `{ids: number[]} \| {all: true}` | `{unreadCount}` | the caller's own rows only |

Types live in `server/src/logs/budgets/budgets.types.ts`; the client mirrors them in `api.ts`.

```ts
type BudgetPeriod = 'day' | 'week' | 'month';
interface BudgetInput { period: BudgetPeriod; amountUsd: number; thresholds: number[]; timeZone: string }
interface BudgetDto { id: number; scopeKind: 'repo'|'team-repo'|'team'; period: BudgetPeriod; amountMicros: number;
  thresholds: number[]; timeZone: string; label: string; currentPeriod: { start: string; end: string }; createdAt: string; updatedAt: string }
interface BudgetForecast { burnRateMicrosPerUnit: number; forecastMicros: number; percentUsed: number | null;
  unitsLeft: number | null; status: 'ok'|'exceeded'|'no-rate'; overspendRisk: boolean; unit: 'day'|'hour' }
interface SpendSlice { kind: 'model'|'user'|'repo'|'branch'|'subagent'|'skill'|'mcp';
  rows: { key: string; label: string; sessions: number; micros: number; share: number }[] }
interface SpendView { restricted: boolean; period: BudgetPeriod; offset: number; timeZone: string;
  periodStart: string; periodEnd: string; isCurrent: boolean; elapsedUnits: number; totalUnits: number;
  budget: BudgetDto | null; canManage: boolean; spendMicros: number; sessions: number; unpricedTrees: number; otelOnlyTrees: number;
  forecast: BudgetForecast | null; previous: { spendMicros: number; percentOfCurrentAmount: number | null } | null;
  daily: { key: string; micros: number; anomaly: boolean; ratioToAverage: number }[];
  slices: SpendSlice[]; costlySessions: { mean: number; sigma: number; items: SpendSessionDto[] } ; crossedThresholds: number[] }
interface SpendSessionDto { sessionId: string; repoId: number | null; teamId: number | null; startTime: string; userEmail: string;
  branch: string | null; micros: number; source: 'hook'|'otel'|'none'; firstPrompt: string | null; level?: 2 | 3 }
interface BudgetBurnView { budget: BudgetDto | null; budgets: BudgetDto[]; filtered: boolean; periodStart: string; periodEnd: string;
  points: { key: string; cumulativeMicros: number }[]; forecastMicros: number | null; previousCumulative: { key: string; cumulativeMicros: number }[];
  anomalyKeys: string[]; spendMicros: number }
interface BudgetReport { budgets: { budget: BudgetDto; periods: { start: string; end: string; isCurrent: boolean; spendMicros: number;
  percentUsed: number; forecast: BudgetForecast | null; crossedThresholds: number[]; anomalyDays: string[] }[];
  topSlices: SpendSlice[] }[]; noBudgetPeriods: { start: string; end: string; spendMicros: number }[] | null }
interface BudgetEventDto { id: number; createdAt: string; actorEmail: string | null; budgetId: number | null; budgetLabel: string;
  budgetDeleted: boolean; eventType: string; details: Record<string, unknown> }
interface BudgetNoticeDto { id: number; createdAt: string; read: boolean; threshold: number; spendMicros: number; amountMicros: number;
  budgetLabel: string; scopeLabel: string; period: BudgetPeriod; periodStart: string; periodEnd: string;
  link: { teamId?: number; repoId?: number; period: BudgetPeriod; offset: number } }
```

`SpendView.daily` for a day budget holds hourly keys `HH`. In `costlySessions.items`, `level` is set. A `restricted` view has `budget` set only when own spend > amount; `slices`, `daily` and `costlySessions.items` are empty; `spendMicros` is the caller's own spend. `offset` for a notice link is computed against the current period (0 for the current one, −N for older ones).

## Database changes

Migration `server/drizzle/migrations/0093_budgets.sql` (hand-written; additive only; Drizzle definitions mirrored in `schema/index.ts`).

`budgets`
| Column | Type | Constraint |
|---|---|---|
| `id` | serial | PK |
| `scope_kind` | varchar(16) | NOT NULL, CHECK in (`repo`,`team-repo`,`team`) |
| `user_id` | integer | FK `users.id` ON DELETE CASCADE |
| `team_id` | integer | FK `teams.id` ON DELETE CASCADE |
| `repo_url` | varchar(4000) | |
| `period` | varchar(8) | NOT NULL, CHECK in (`day`,`week`,`month`) |
| `amount_micros` | bigint | NOT NULL, CHECK > 0 |
| `thresholds` | smallint[] | NOT NULL DEFAULT `'{75,90,100}'` |
| `time_zone` | varchar(64) | NOT NULL |
| `created_by` | integer | FK `users.id` ON DELETE SET NULL |
| `created_at`, `updated_at` | timestamptz | NOT NULL DEFAULT now() |

- CHECK `budgets_scope_shape`:
  - `repo` → `user_id` and `repo_url` NOT NULL, `team_id` NULL;
  - `team-repo` → `team_id` and `repo_url` NOT NULL, `user_id` NULL;
  - `team` → `team_id` NOT NULL, `user_id` and `repo_url` NULL.
- Unique expression index `budgets_scope_period_uq` on `(scope_kind, COALESCE(user_id,0), COALESCE(team_id,0), COALESCE(repo_url,''), period)`.
- Indexes `idx_budgets_team_id`, `idx_budgets_user_id`.

`budget_notices`
| Column | Type | Constraint |
|---|---|---|
| `id` | bigserial | PK |
| `budget_id` | integer | FK `budgets.id` ON DELETE SET NULL |
| `scope_kind`, `user_id`, `team_id`, `repo_url` | as `budgets` | same FKs (CASCADE) — snapshot + cascade |
| `budget_label` | varchar(64) | NOT NULL |
| `period` | varchar(8) | NOT NULL |
| `amount_micros` | bigint | NOT NULL |
| `time_zone` | varchar(64) | NOT NULL |
| `period_start`, `period_end` | timestamptz | NOT NULL |
| `threshold` | smallint | NOT NULL |
| `spend_micros` | bigint | NOT NULL |
| `superseded_by` | smallint | NULL = shown notice |
| `created_at` | timestamptz | NOT NULL DEFAULT now() |

- Unique `budget_notices_budget_period_threshold_uq (budget_id, period_start, threshold)`.
- CHECK `budget_notices_scope_shape`, same rule as `budgets_scope_shape`.
- Indexes `idx_budget_notices_team_id (team_id)` and `idx_budget_notices_user_id (user_id)`.

`budget_notice_recipients`

- `notice_id` bigint, FK `budget_notices.id` ON DELETE CASCADE.
- `user_id` integer, FK `users.id` ON DELETE CASCADE.
- `read_at` timestamptz, NULL.
- PK `(notice_id, user_id)`.
- Index `idx_budget_notice_recipients_user (user_id, notice_id DESC)`.
- Partial index `idx_budget_notice_recipients_unread (user_id) WHERE read_at IS NULL`.

`budget_events`

- `id` bigserial PK.
- `budget_id` integer, FK `budgets.id` ON DELETE SET NULL.
- Scope columns as `budget_notices`, with CHECK `budget_events_scope_shape` (same rule).
- `budget_label` varchar(64) NOT NULL.
- `actor_user_id` FK `users.id` ON DELETE SET NULL; `actor_email` varchar(320) (NULL = system).
- `event_type` varchar(32) NOT NULL, with a CHECK over the DD-11 list.
- `details` jsonb NOT NULL DEFAULT `'{}'`.
- `created_at` timestamptz NOT NULL DEFAULT now().
- Indexes `idx_budget_events_team (team_id, id DESC)` and `idx_budget_events_user (user_id, id DESC)`.

Steps:
1. Write the SQL.
2. Add the `_journal.json` entry.
3. Run `npm run migrations:lock`, then `npm run migrate` against the dev DB.
4. Run the db-state-update skill.

Existing data is not touched.

## Test coverage plan

Per the CLAUDE.md test policy, only these three kinds.

- **Algorithm — `budget-spend-math` (new doc + rows file + new table test).** This is a genuinely new algorithm: DD-7 forecast, day anomalies, costly sessions and threshold selection. Rows, all values exact:
  - **forecast**
    - Monthly, spend 41 200 000, amount 50 000 000, elapsed 9 / 30 → burn 4 577 777.777…, forecast 137 333 333, unitsLeft 1.9223300970873785, risk true, percentUsed 82.4.
    - Weekly, 32 800 000 spend, elapsed 2 / 7 → forecast 114 800 000.
    - Day, 6 000 000 of 10 000 000, hours 15 / 24 → burn 400 000/h, forecast 9 600 000, unitsLeft 10, risk false.
    - Exceeded: 60 000 000 of 50 000 000 → status exceeded, unitsLeft null.
    - Zero spend → `no-rate`.
    - Past period (`isCurrent: false`) → forecast = spend, no risk.
    - No amount → percentUsed null.
  - **anomaly-days**
    - Daily [1,1,1,9,1] (USD × 1e6), elapsed 5 → index 3 only.
    - Elapsed 1 → none.
  - **costly-sessions**
    - Five × 1 plus one × 10 → mean 2.5, σ 3.3541019662496847, the 10 at level 2.
    - Eleven × 1 plus one × 20 → mean 2.5833333333333335, σ 5.251322584729384, the 20 at level 3.
    - Four trees → none.
    - All equal → none.
  - **threshold-notices**, thresholds [75,90,100] and amount 100 unless stated:
    - Spend 75, existing [] → notify 75.
    - Spend 95, existing [] → notify 90, 75 superseded by 90.
    - Spend 95, existing [75] → notify 90.
    - Spend 95, existing [75,90] → nothing.
    - Thresholds [50,75,90,100], spend 80, existing [75] → 50 superseded by 75, no notify.
    - Thresholds [75,90,100,200], spend 210 → notify 200, 75/90/100 superseded.
- **Algorithm — `otel-cost-selection` (extend).** New rows of kind `budget-tree-cost` in `docs/algorithm-examples/otel-cost-selection.json`:
  - hook 1.20 / OTEL 1 500 000 → 1 500 000 `otel`
  - hook 2.00 / OTEL 1 500 000 → 2 000 000 `hook`
  - hook null / OTEL 300 000 → `otel`
  - hook 0.40 / OTEL 0 → 400 000 `hook`
  - both missing → 0 `none`
  - equal → `hook`

  The spec `server/src/logs/otel-cost.sql.algo.spec.ts` gets a branch for that kind. The doc gets the "budget-only exception" rule and a "Where visible" entry.
- **API contract — new family `f26-budgets.ts`.** One row per new route (all 18) with actors owner / member / manager / outsider from world-v1:
  - CRUD by owner (201/200/204), by the plain member (403) and by the outsider (403); duplicate period → 409; invalid thresholds → 400.
  - Event log rows: an owner read with a `read.sql` oracle on `budget_events`; outsider 403.
  - Spend: the owner's spend equals a `read.sql` oracle written from DD-3/4/5 over the world sessions (use a period offset covering January 2026). Team spend as manager; plain member → `restricted: true`.
  - `spend/sessions`, `analytics/budget-burn`, `reports/budget`: owner 200, plain member of restricted T2 403.
  - `budget-notices` GET / POST read: own rows only. POST with a foreign id leaves it unread.

  Add the budget and notice fixture rows (one notice + recipient) to the world fixture if needed, and the import and array entry in `registry/index.ts`.
- **Scenario — new `tests/scenarios/view/s-budg-01.spec.ts` (`@S-BUDG-01`, mode a).** No existing scenario covers budgets. Steps:
  1. Create a monthly personal-repo budget in Settings › Budgets; check the event log has "created".
  2. Upload sessions with the existing ingest helpers, plus synthetic OTEL lines (`tests/scenarios/fixtures/otel/otel-lines.ts`) where OTEL > hook cost. The Spend tab shows that spend, a slice that sums to 100 %, and a slice click that opens the sessions modal.
  3. Lower the amount so 75/90/100 % are crossed in turn. After the job (fast tick), the bell count rises, the banner shows, banner × survives reload, and the tray link opens Spend at the right `sp` / `so`.
  4. Analytics › Budget burn: the last point equals the Spend total.
  5. Reports › Budget: same spend / % / forecast; the PDF downloads.
  6. Help: the budgets page opens from the help menu.
  7. Edit and delete the budget; the event log keeps the events with "(deleted)".
- **Scenario — `tests/scenarios/auth/s-team-02.spec.ts` (restricted team, extend).**
  - A manager creates a team budget on the team Settings tab and sees the team Spend tab with slices.
  - A plain member sees no budget card until their own spend exceeds the amount, then sees only their own spend and no user slice.
- **Scenario — `tests/scenarios/auth/s-auth-01.spec.ts` (mode B, Mailpit; extend).** A crossed threshold sends exactly one email to the owner (Mailpit), and the event log shows `email sent`. Mode A (auth `none`) is covered by S-BUDG-01 step 3 (in-app only, `email skipped`).

## Visual/UX notes

- **Spend tab** (`spend-view.svg`):
  - Header row: period segmented control Day / Week / Month, ‹ › buttons (› disabled at offset 0), the period label, and on the right "Manage budgets in Settings →" (only when `canManage`; navigates to `stab=budgets` or team `ttab=settings`).
  - Budget card: title "Monthly budget · $50.00", an "⚠ Overspend risk" amber pill when `overspendRisk`, and the line "$41.20 of $50.00 · 82 % · resets on 1 Dec 2026".
  - Bar bands: emerald < 75 %, amber 75–99 %, red ≥ 100 %, with threshold ticks.
  - Note "Log Hub does not stop usage when the budget is reached."
  - Four tiles: Burn rate (`$/day` or `$/hour`, "N days elapsed"), Forecast (`$` + `%`), Runs out in (`~N days` / `~16:40` / `—` / `exceeded`), Previous period (`$` + % of current amount).
  - Without a budget: "Spent this <period> $X · previous $Y".
  - A muted line "N sessions unpriced · M OTEL-only" when non-zero.
- **Daily chart:** blue `#3b82f6` bars, a dashed budget-pace line (amount / total units), and an anomaly bar outlined amber with "▲ 3.6× avg" on hover.
- **Slice table:** a column picker (Model, User, Repository, Branch, Sub-agent, Skill, MCP server); columns COLUMN / SESSIONS / COST / SHARE; `Not reported` row in muted text; a Total row. Rows are clickable. The User option is hidden when `restricted`.
- **Costly sessions:** a list with a `2σ` amber or `3σ` red pill, and the caption "mean $X · σ $Y".
- **Budgets section** (`budget-form.svg`):
  - Table columns: PERIOD / AMOUNT / NOTIFY AT / TIME ZONE / CURRENT PERIOD / actions.
  - "+ Add budget" is disabled while the form is open.
  - The inline form sits under the edited row and holds:
    - read-only scope text;
    - a Day / Week / Month radio;
    - the amount ("was $80.00 · applies to the whole period" when editing);
    - a time-zone combobox (default `Intl…timeZone`);
    - threshold chips with × and "+ Add" (1–200);
    - the recipients line;
    - an inline 409 error;
    - Delete (with confirm), Cancel and Save.
  - Read-only mode drops the actions and shows "Managed by the team owner and managers".
- **Event log** (`budget-settings.svg`): a "Budget event log" button next to "+ Add budget" opens a closable window (×) with Budget and Event filters, columns TIME / ACTOR / BUDGET / EVENT / DETAILS (times in the browser tz), and "Load older events".
- **Banner and tray** per DD-18. Popups stay inside the viewport. Icons come from `lucide-react` (`Wallet`, `AlertTriangle`, `Bell`). Light theme only.

## Wireframes

The wireframes were updated (2026-11-10) to match the requirements and this plan:
- `budget-burn.svg`:
  - The time window and Group by are greyed out.
  - The notes now say: no stacking; x-axis = budget period; no budget → current month in the viewer tz; repository-only.
  - The filter label is "filtered — budget line is for the whole scope".
- `budget-report.svg`:
  - The BUDGET picker is removed, and all budgets are listed.
  - The weekly forecast is fixed to $114.80 (144 %, risk ⚠) for day 2 of 7.
  - The open-question notes are replaced with repository-only notes.
- `budget-form.svg`: the read-only note now reads "Managed by the team owner and managers", plus the plain-member note. The one-budget-per-period rule is stated as decided (409).
- `budget-settings.svg`:
  - Spend is visible to every member; Settings follows the team-wide access rule.
  - New event type: Threshold superseded.
  - Email events are written per recipient. The log returns 403 for plain members.
- `spend-view.svg`: slice, day and costly-session clicks open a sessions modal (DD-20), not the Sessions tab.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | DB schema and migration | 5 | first; everything reads these tables |
| 2 | Budget math and cost-selection rule | 7 | pure TS + algorithm docs/rows; no DB. Algorithm table tests stay with their pure code on purpose (rows pin the function) |
| 3 | Spend read (SQL + SpendService) | 7 | uses 1, 2; owns the shared types (DD-21) |
| 4 | Budget access, CRUD, events, cleanup | 6 | uses 1–3 types and `loadScopeBudgets` |
| 5 | Threshold job, notices, mail | 6 | uses 3, 4 |
| 6 | Controllers, module wiring, endpoint docs | 6 | uses 3–5 |
| 7 | Client API, types, tab registry, team URL state | 6 | uses API changes |
| 8 | Client Budgets settings sub-tab and event log | 6 | uses 7 |
| 9 | Client Spend tab | 8 | uses 7 |
| 10 | Client bell, tray and banner | 5 | uses 7 |
| 11 | Client Budget burn view and Budget report | 7 | uses 7, 9 (shared formatters/chart bits) |
| 12 | User docs and development KB | 8 | after behaviour is final |
| 13 | API contract rows | 5 | tests |
| 14 | Scenarios and perf entry | 6 | tests, last |

`TeamDetailPage.tsx` is touched by chunks 7, 8 and 9 in sequence. Chunk 7 owns the tab list and `ttab`; chunks 8 and 9 each add only their own `PageTabsContent`.

### Chunk 1 — DB schema and migration
- [ ] Add Drizzle tables `budgets`, `budget_notices`, `budget_notice_recipients`, `budget_events` to `server/src/database/schema/index.ts`, columns/FKs per Database changes, each with a short comment naming migration 0093.
- [ ] Write `server/drizzle/migrations/0093_budgets.sql`: CREATE TABLE IF NOT EXISTS for the four tables, CHECKs, the raw-SQL expression unique index `budgets_scope_period_uq`, other indexes, and `COMMENT ON` for every table and column.
- [ ] Add the 0093 entry to `server/drizzle/migrations/meta/_journal.json`; run `npm run migrations:lock` and `npm run migrate` from `server/`.
- [ ] Run the db-state-update skill to regenerate `docs/knowledgebase/db_state.sql`.
- [ ] Add the four tables to `docs/knowledgebase/db-tables.md` (purpose, keys, cascade per DD-13, snapshot columns).

### Chunk 2 — Budget math and cost-selection rule
- [ ] Add `selectBudgetTreeCostMicros({hookUsd, otelMicros})` returning `{micros, source}` to `server/src/logs/otel-cost.sql.ts` per DD-5, with a doc comment naming the budget-only exception.
- [ ] Add `budget-tree-cost` rows (Test coverage plan) to `docs/algorithm-examples/otel-cost-selection.json`; add the matching `kind` branch to `server/src/logs/otel-cost.sql.algo.spec.ts`.
- [ ] Update `docs/knowledgebase/algorithms/otel-cost-selection.md`: add the budget exception rule (larger of hook tree cost and `otel_session_totals`, budgets only), and Spend / notices / report / burn under "Where visible".
- [ ] Create `server/src/logs/budgets/budget-math.ts` with `computeBudgetForecast`, `markAnomalyDays`, `markCostlySessions`, `selectThresholdNotices` per DD-7 (BigInt threshold comparison).
- [ ] Create `docs/algorithm-examples/budget-spend-math.json` with the four kinds of rows listed in Test coverage plan.
- [ ] Create `server/src/logs/budgets/budget-math.algo.spec.ts`, a table test over that rows file, modelled on `otel-cost.sql.algo.spec.ts` (`loadExamples`, switch on `kind`).
- [ ] Write `docs/knowledgebase/algorithms/budget-spend-math.md` per `algorithms/README.md` (front matter, Purpose, Code, Rules, Edge cases, Examples → rows file, Mutations, Where visible); list it in `docs/knowledgebase/index.md`.

### Chunk 3 — Spend read (SQL + SpendService)
- [ ] Create `server/src/logs/budgets/budget.constants.ts` (DD-22) and `budget-scope.ts`: `BudgetScope`, `ScopeAccess` (DD-21), `budgetLabel(period, amountMicros)` (`Monthly $50.00`), `scopeLabel` and `periodLabel` (DD-22), and `validateBudgetInput` (DD-12, throws `BadRequestException`).
- [ ] Create `server/src/logs/budgets/budgets.types.ts` with every DTO in API changes, plus `BudgetSnapshot` and `PeriodBounds` (DD-21).
- [ ] In `server/src/logs/budgets/spend-read.sql.ts` add `loadPeriodBounds` (DD-6, returns `PeriodBounds`), `loadScopeBudgets`, `loadAllBudgets` and `resolveScopeRows(db, scope, userFilterOverride?)` returning `{repoIds, userIds}` (DD-3). Create `budget-events.sql.ts` with `insertBudgetEvent` (DD-21).
- [ ] In `spend-read.sql.ts` add `loadPeriodTrees(db, rows, bounds, filters?)`. It returns, per root, id, sessionId, repoId, userId/email, branch, anchor, local day/hour key, tree-cost row and OTEL micros, per DD-4. It embeds `descendantSessionsCte` + `treeCostCtes`; ids are bound as `{…}::int[]` literals.
- [ ] In `spend-read.sql.ts` add `loadSliceParts(db, rootIds)`: hook model/sub-agent parts from `tree_subagent_rows`, and OTEL per-call sums by model, agent, skill and MCP server from `otel_calls` filtered by `session_id = ANY(rootIds)` (DD-8).
- [ ] Create `server/src/logs/budgets/spend.service.ts` with the five methods and signatures in DD-21, built on the chunk-3 SQL plus `selectBudgetTreeCostMicros` and `budget-math`. It applies DD-8 slices, DD-9 restricted view and DD-19.
- [ ] In `spend.service.ts`, mask `firstPrompt` in every `SpendSessionDto` with `maskFirstPrompt(access.teamScope, viewerId, rowUserId, value)` (`team-scope.ts`).

### Chunk 4 — Budget access, CRUD, events, cleanup
- [ ] Create `server/src/logs/budgets/budget-access.service.ts` with `resolveRepoScope(user, repoId, teamId?)` and `resolveTeamScope(user, teamId)` returning `ScopeAccess` per DD-2, plus `assertCanManage` / `assertFullView` (403).
- [ ] Create `server/src/logs/budgets/budgets.service.ts` with `list(scope)` (via `loadScopeBudgets` + `toDto`), `toDto` (DD-21), `create(access, user, input)`, `update(access, user, id, input)` and `delete(access, user, id)`. Map a unique violation on `budgets_scope_period_uq` to 409, and return 404 for an id outside the scope.
- [ ] In `budgets.service.ts` write the `created` / `edited` / `deleted` events with `insertBudgetEvent` (DD-21), in the same transaction as the change, with snapshots and actor per DD-11.
- [ ] Add `listEvents(scope, {budgetId?, event?, before?, limit})` to `budgets.service.ts`, newest first, with `budgetDeleted = budget_id IS NULL`.
- [ ] Create `server/src/logs/budgets/budgets-cleanup.ts` as plain exported functions taking `tx` (no Nest provider, no DI): `deletePersonalRepo`, `deleteTeamRepo`, `rewritePersonalRepoUrl` and `rewriteTeamRepoUrl` (signatures and merge-conflict rule per DD-13), covering budgets, notices and events.
- [ ] Call the cleanup helpers at every delete and rewrite call site listed in DD-13 (`admin.service.ts`, `account-deletion.service.ts`, `teams.service.ts`, `repo-backfill.service.ts`), inside each site's existing transaction or executor.

### Chunk 5 — Threshold job, notices, mail
- [ ] Add `sendBudgetNoticeEmail(email, {scopeLabel, budgetLabel, threshold, spendMicros, amountMicros, periodLabel, link: string | null}): Promise<EmailDelivery>` to `server/src/mail/mail.service.ts`, as plain text through the private `send`.
- [ ] Create `server/src/logs/budgets/budget-notices.service.ts` with `resolveNoticeRecipients(scope)` (DD-21: owner, or team owner + `is_manager` members, with emails) and `recordCrossings(budget, spendMicros, bounds)`. `recordCrossings` loads the existing thresholds for `(budget, period_start)`, calls `selectThresholdNotices`, and in one transaction inserts the notices `ON CONFLICT DO NOTHING RETURNING`, the recipients and the `threshold_*` events (DD-10/11).
- [ ] After that commit, in `budget-notices.service.ts`, the inserting worker sends the emails when `mailService.isConfigured()` and writes `email_sent` / `email_failed` / `email_skipped` events. The link comes from `getEmailLinkBaseUrl()`, or no link when it is null.
- [ ] Add `listForUser(userId, {before, limit})` to `budget-notices.service.ts`: the user's recipient rows joined to notices, `unreadCount`, `scopeLabel`, and a `link` resolved per DD-15.
- [ ] Add `markRead(userId, {ids} | {all})` to `budget-notices.service.ts`: an UPDATE of the caller's own recipient rows where `read_at IS NULL`; returns `unreadCount`.
- [ ] Create `server/src/logs/budgets/budget-threshold.scheduler.ts` per DD-14, and add `BUDGET_CHECK_INTERVAL_MS=300000` and `BUDGET_CHECK_ENABLED=true` with comments to `release-template/.env.example`.

### Chunk 6 — Controllers, module wiring, endpoint docs
- [ ] Create `server/src/logs/budgets/budgets.controller.ts` with the `R/budgets*`, `R/spend*` routes per API changes (`@Controller('api/v1/repositories')`, `teamId` via `ParseIntPipe({optional:true})`). Declare literal `events` / `sessions` routes before `:budgetId`.
- [ ] In `budgets.controller.ts` (second class, `@Controller('api/v1/teams')`) add the `T/budgets*` and `T/spend*` routes.
- [ ] Create `server/src/logs/budgets/budget-notices.controller.ts`: `GET /api/v1/budget-notices` and `POST /api/v1/budget-notices/read`, validating `ids` as integers (max 100).
- [ ] Add `GET :repoId/analytics/budget-burn` to `usage-analytics.controller.ts` and `GET :repoId/reports/budget` to `reports.controller.ts`, following the `reports.controller.ts:128` template (`assertRepoAccess`, `resolveTeamScope`, 403 when `!analyticsAllowed`), and delegate to `SpendService`.
- [ ] Register the new services, scheduler and controllers in `server/src/logs/logs.module.ts`, and add `MailModule` (`server/src/mail/mail.module.ts`) to its `imports`; today it is not imported there.
- [ ] Update `docs/knowledgebase/server-endpoint-map.md`: the new controllers in the index, the budget exception to "costs are never the OTEL total", the owner-or-manager rule (DD-2) and the POST-only read marking.
### Chunk 7 — Client API, types, tab registry, team URL state
- [ ] Add every API-changes type and fetcher to `client/src/viewer/api.ts`: `fetchBudgets`, `createBudget`, `updateBudget`, `deleteBudget`, `fetchBudgetEvents`, `fetchSpend`, `fetchSpendSessions`, `fetchBudgetBurn`, `fetchBudgetReport`, `fetchBudgetNotices`, `markBudgetNoticesRead`. Each takes `{repoId, teamId?} | {teamId}` like the existing team-aware fetchers.
- [ ] In `client/src/viewer/tab-ids.ts`: add `spend` to `REPO_MAIN_TABS` between `analytics` and `reports`, `budgets` to `SETTINGS_TABS` between `session-attribution` and `maintenance`, and `spend`, `settings` to `TEAM_TABS` after `otel`.
- [ ] Add matching `TAB_REGISTRY` rows: repo `spend` and team `spend` (synonyms budget, spend, forecast, burn rate, limit; no `visible`), settings `budgets` (synonyms budget, limit, alerts), and team `settings` (synonyms settings, budgets; `visible: canSeeOtel`, `gate: 'permission'`).
- [ ] Create `client/src/viewer/pages/budgets/budget-format.ts` with `BUDGET_LIMITS` (DD-22), `formatUsdMicros`, `budgetBand(percent)` (emerald/amber/red per Visual notes), `formatUnitsLeft(forecast, periodStart)` (`~N days`, `~HH:MM`, `—`, `exceeded`), `browserTimeZone()` and `budgetNoticeHref(link)` (DD-15).
- [ ] Create `client/src/viewer/pages/spend/useSpendUrlState.ts`, which reads and writes `sp` / `so` with `{replace: true}` (DD-15).
- [ ] In `TeamDetailPage.tsx`, add the `ttab` URL param (seeded from `location.state`, then `members`) and keep the tab state in the URL.

### Chunk 8 — Client Budgets settings sub-tab and event log
- [ ] Create `client/src/viewer/pages/budgets/BudgetsSection.tsx`: a `['budgets', scopeKey]` query, the table per Visual notes, "+ Add budget", read-only mode when `!canManage`, and the 403 note per DD-17 (hide the event log too). It takes a `scope` prop `{repoId, teamId?} | {teamId}`.
- [ ] Create `client/src/viewer/pages/budgets/BudgetForm.tsx`: the inline form per Visual notes; client validation mirrors DD-12; a 409 is shown inline; it invalidates `['budgets']`, `['budget-events']` and `['spend']` on success.
- [ ] Create `client/src/viewer/pages/budgets/BudgetEventLog.tsx`: a closable window opened by the "Budget event log" button of `BudgetsSection`, with an infinite query on `fetchBudgetEvents`, filters Budget / Event, columns per Visual notes, "system · threshold job" for a null actor, and "(deleted)" suffix.
- [ ] Mount `BudgetsSection` + `BudgetEventLog` as the `budgets` sub-tab in `RepositorySettings.tsx` (personal and team-repo context).
- [ ] Add the team `settings` tab content in `TeamDetailPage.tsx`, rendering `BudgetsSection` + `BudgetEventLog` with `{teamId}`.
- [ ] Add `data-testid`s used by the scenarios: `budget-add`, `budget-form`, `budget-save`, `budget-row-<period>`, `budget-event-row`.

### Chunk 9 — Client Spend tab
- [ ] Create `client/src/viewer/pages/spend/SpendTab.tsx`: a period picker plus ‹ › (from `useSpendUrlState`), a `['spend', scopeKey, sp, so]` query, the "Manage budgets" link (DD-15), and the restricted mode (DD-9).
- [ ] Create `client/src/viewer/pages/spend/BudgetCard.tsx`: the bar with bands and threshold ticks, the "not blocked" note, the four tiles, the no-budget variant, and the unpriced / OTEL-only line, per Visual notes.
- [ ] Create `client/src/viewer/pages/spend/DailySpendChart.tsx`: Recharts bars, the dashed pace line and anomaly markers. Clicking a bar opens `SpendSessionsModal` with `slice=day`.
- [ ] Create `client/src/viewer/pages/spend/SliceTable.tsx`: a column picker over `SpendView.slices`, Not reported and Total rows. A row click opens `SpendSessionsModal` with that `slice` / `key`.
- [ ] Create `client/src/viewer/pages/spend/CostlySessionsList.tsx` (2σ / 3σ pills, mean / σ caption) and `SpendSessionsModal.tsx` (DD-20, a viewport-safe modal listing sessions with links).
- [ ] Export `SpendTab` from `repository-tabs-lazy-group.ts`. Render `PageTabsContent value="spend"` in `client/src/viewer/pages/repository/RepositoryView.tsx`, next to the `sessions` content and outside `RepositoryTeamWideTabs` (DD-16).
- [ ] Add the team `spend` tab content to `TeamDetailPage.tsx` with `SpendTab scope={{teamId}}`.
- [ ] Add `data-testid`s: `spend-period-<p>`, `spend-prev`, `spend-next`, `budget-card`, `budget-percent`, `spend-total`, `slice-row`, `spend-sessions-modal`.

### Chunk 10 — Client bell, tray and banner
- [ ] Extend `NotificationBell.tsx` with a `['budget-notices']` infinite query (`refetchInterval: 60_000`) and the badge sum per DD-18.
- [ ] Add the budget notice rows to the bell panel (threshold pill, scope, budget, spend, period, time in the browser tz, blue unread dot) plus "Mark all read". Clicking a row marks it read and navigates to its link.
- [ ] Create `client/src/viewer/components/BudgetNoticeBanner.tsx`: unread notices, highest threshold first, at most 3, amber/red per DD-18, "Open spend →" and ×. × calls `markBudgetNoticesRead` and invalidates `['budget-notices']`.
- [ ] Mount `BudgetNoticeBanner` in `client/src/viewer/components/AppShell.tsx` directly under `MainNav`.
- [ ] Add `data-testid`s: `budget-notice-row`, `budget-notice-banner`, `budget-notice-dismiss`, `notification-badge` (reuse it if it exists).

### Chunk 11 — Client Budget burn view and Budget report
- [ ] Add view `budget-burn` to `AnalyticsState.view` and `VIEW_OPTIONS` (synonyms budget, forecast, burn rate, limit) in `analytics-state.ts`, plus the `av` whitelist in `analytics-url.ts`.
- [ ] Hide Group by and the time window for `budget-burn` in `AnalyticsControls.tsx` (as `isUsageAnalyticsView` does); keep Branches / Users.
- [ ] Create `client/src/viewer/pages/repository/analytics/BudgetBurnView.tsx` with the budget picker, a cumulative area, budget line, dashed forecast, threshold lines, the previous-period line, anomaly markers, and the "filtered — budget line is for the whole scope" label when `filtered`.
- [ ] Add `budget` to `ReportId` and a `ReportDefinition` in `report-catalog.ts` (category `cost`; `supportsGroupBy`, branch, user and attribute filters all false) and wire it in `ReportsPanel.tsx`.
- [ ] Create `client/src/viewer/pages/repository/reports/BudgetReport.tsx` (per-budget period table, top slices, the no-budget message plus monthly spend) inside `ReportDocumentShell`, with PDF via `downloadReportPdf.ts`.
- [ ] Render `BudgetBurnView` for `state.view === 'budget-burn'` in `analytics/AnalyticsChartArea.tsx`.
- [ ] Add `data-testid`s: `budget-burn-chart`, `budget-burn-last`, `report-budget-spend`, `report-budget-percent`.

### Chunk 12 — User docs and development KB
- [ ] Write `user-docs/budgets.md` covering FR-13: reference only, setting per scope, the spend rule, formulas, notices / tray / email, event log. Add it to `user-docs/nav.json` under "Using Log Hub" with a unique 50–160-character description.
- [ ] Update `user-docs/analytics-reports.md` (Spend view, Budget burn, Budget report, rows in "Which one answers your question?") and `user-docs/all-views.md` (Spend tab in the tab tables, the new view and report with synonyms).
- [ ] Update `user-docs/server-configuration.md` (threshold job, `BUDGET_CHECK_*`, emails need the mail service), `small-team-setup.md` and `tuning-your-setup.md` (team budget).
- [ ] Update `user-docs/cost-and-context.md` (why a budget may use the OTEL cost) and `otel-tab.md` ("Budgets use the higher OTEL cost" paragraph).
- [ ] Update `user-docs/responsibility-matrix.md` (three rows per FR-13), `getting-started.md` (budget notices in the bell), `session-list.md` (Spend tab) and `changelog.md` (entry); run `npm run build:help`.
- [ ] Write `docs/knowledgebase/budgets.md`: scope model, DD-2/3/4/9 rules, job, notices, routes, file map. Add it to `docs/knowledgebase/index.md`.
- [ ] Update `docs/knowledgebase/client-component-map.md` (new components) and `client-routing-and-layout.md` (`ttab`, `sp`, `so`, Spend outside the team-wide wrapper).
- [ ] Add a `docs/changelog/<YYYY-MM-DD-HHmm>-budgets-threshold-alerts.md` one-line entry per the changelog skill.

### Chunk 13 — API contract rows
- [ ] Add budget and notice fixture rows to the world-v1 fixture (`server/test/contract/fixtures/world-v1.sql.ts`): a monthly team-repo budget on T2/R1, a personal budget on the owner's R1, one shown notice (threshold 75) with a recipient row for the owner, and one `created` event per budget.
- [ ] Create `server/test/contract/registry/f26-budgets.ts` with the CRUD, event-log and notice rows listed in Test coverage plan, with `read.sql` oracles on `budgets` / `budget_events` / `budget_notice_recipients`.
- [ ] Add the spend, spend/sessions, budget-burn and budget-report rows to `f26-budgets.ts`. The spend oracle is written from DD-3/4/5 over the world sessions. For the plain member of restricted T2: `spend` → 200 with `restricted: true` and empty `slices`; `spend/sessions`, `budget-burn` and `reports/budget` → 403.
- [ ] Register F26 in `server/test/contract/registry/index.ts` and add `server/test/contract/f26.contract-spec.ts` modelled on `f25.contract-spec.ts`.
- [ ] Run `npm run test:scenarios -- --mode a --only contract` (repo root) in the background and fix F26 failures.

### Chunk 14 — Scenarios and perf entry
- [ ] Create `tests/scenarios/view/s-budg-01.spec.ts` (`@S-BUDG-01`, mode a) with the seven steps in Test coverage plan, reusing ingest and OTEL-line helpers from `tests/scenarios/fixtures/` and `helpers/`.
- [ ] Add the manager / plain-member budget steps to `tests/scenarios/auth/s-team-02.spec.ts` per Test coverage plan.
- [ ] Add the threshold email step to `tests/scenarios/auth/s-auth-01.spec.ts` (mode B, Mailpit): after login, upload one session, create a budget below its cost, and expect one Mailpit email plus an `email sent` event.
- [ ] Add `BUDGET_CHECK_INTERVAL_MS: '200'` to `FAST_TICK_ENV` in `tests/scenarios/modes.ts`.
- [ ] Add a `spend-heavy` entry for `GET R/spend?period=month` to `server/perf-tests/scenarios.ts`, following the existing `-heavy` entries, plus its limit in `server/perf-tests/budgets.json`; this is perf tooling run by `npm run perf`, not one of the three test kinds.
- [ ] Run each touched scenario with `npm run test:scenarios -- --mode <a|b> --only scenarios,contract --grep "<@S-TAG>"` in the background and fix failures.
