---
type: "Architecture Guide"
title: "Budgets, Spend tab and threshold notices"
description: "How spend budgets work end to end: the three scope kinds (personal repo, team repo, team) stored by repository URL, route-to-scope resolution and who may view or manage, the caller-independent root set behind every spend figure, root session selection and its anchor time, the budget-only higher-of-hook-and-OTEL tree cost, the plain-member own-spend view, period bounds, the 5-minute threshold job, notices / recipients / read state / email, the event log, scope cleanup on repository and team removal, the routes and the server and client file map."
tags:
  - budgets
  - cost
  - teams
  - notifications
  - reports
timestamp: "2026-11-10T00:00:00+04:00"
---

# Budgets, Spend tab and threshold notices

A budget is a reference amount per day, week or month for a scope. Log Hub never blocks usage; it
shows the spend against the budget (the **Spend** tab, Analytics **Budget Burn**, Reports
**Budget**) and raises notices when thresholds are crossed. Task:
`docs/tasks/*/2026-11-05-budgets-threshold-alerts` (DD-n below refers to its `impl-plan.md`).
User doc: `user-docs/budgets.md`.

Related articles: tables in [db-tables.md](db-tables.md#budgets) and
[db_state.sql](db_state.sql); route access in
[server-endpoint-map.md](server-endpoint-map.md) (**Budgets: owner-or-manager**); the pure math in
[algorithms/budget-spend-math.md](algorithms/budget-spend-math.md); the cost rule in
[algorithms/otel-cost-selection.md](algorithms/otel-cost-selection.md) (rule 6, the budget-only
exception); URL state in [client-routing-and-layout.md](client-routing-and-layout.md).

## Scope model (DD-1)

A budget's scope is stored as columns, with **no FK** to `repositories` / `team_repositories`:
a repository budget is keyed by its repository URL.

| `scope_kind` | `user_id` | `team_id` | `repo_url` | Who manages | Who views in full |
|---|---|---|---|---|---|
| `repo` (personal repository) | owner | NULL | URL | the `repositories` row owner | the owner |
| `team-repo` | NULL | team | URL | team owner, `team_members.is_manager` | `resolveTeamScope(...).analyticsAllowed` |
| `team` | NULL | team | NULL | team owner, managers | `analyticsAllowed` |

TypeScript: `BudgetScope` in `budget-scope.ts` (`{kind:'repo', userId, repoUrl} |
{kind:'team-repo', teamId, repoUrl} | {kind:'team', teamId}`). One budget per scope and period
(unique expression index `budgets_scope_period_uq`; a duplicate is a 409). Amounts are integer
micro-USD (`bigint` in `mode: 'number'`).

## Route → scope and access (DD-2)

`BudgetAccessService` returns one `ScopeAccess = {scope, canManage, fullView, teamScope}` per
request:

- `/repositories/:repoId/…` without `teamId` → `assertRepoAccess(user, repoId)` → `repo` scope of
  the row's `(user_id, repo_url)`; `canManage` and `fullView` are true.
- `/repositories/:repoId/…?teamId=T` → `assertRepoAccess(user, repoId, T)` → `team-repo`.
- `/teams/:teamId/…` → the caller must be a team member (403 otherwise) → `team`.
- Team kinds: `canManage` = team owner or `is_manager` (in transparent teams too);
  `fullView` = `teamScope.analyticsAllowed`. Mutations without `canManage` → 403.

## Spend rows are caller-independent (DD-3)

Every spend figure — Spend tab, report, burn view and the threshold job — reads the same root set
for a scope, so the bar and the notices always agree (`resolveScopeRows` in `spend-read.sql.ts`):

- `repo`: repo ids = the `(user_id, repo_url)` row; user filter `[userId]` (only the owner's
  sessions, even when others uploaded to the same URL).
- `team-repo`: repo ids = every member's `repositories` row with that URL (the `resolveRepoIds`
  join); user filter = `resolveExportVisibleUserIds(teamId)` (`null` = no filter, transparent
  team).
- `team`: the same over every URL in the team's `team_repositories`.

**Root selection (DD-4, `loadPeriodTrees`).** `sessions s` joined to an `artisyn` log `l` that is
linked through `log_repositories` to the scope's repo ids; `l.first_prompt IS NOT NULL`,
`s.deleted = false`, `DISTINCT s.id`. There is **no** `claude`-log requirement, so OTEL-only
roots count once linked. Anchor time = `l.start_time` when a `claude` log exists, else
`COALESCE(otel_session_totals.first_call_at, l.start_time)`; a root is in the period when
`period_start <= anchor < period_end`. A tree's whole cost lands on its anchor day.

**Tree cost (DD-5).** `selectBudgetTreeCostMicros({hookUsd, otelMicros})` in
`logs/otel-cost.sql.ts`: the larger of the hook tree cost (`readTreeCost(row).total`, utility
calls included, `null` when unpriced) and `otel_session_totals.cost_usd_micros` (0 / no row =
missing). One side present → that side; neither → 0, source `none`, counted in
`unpricedTrees`. The comparison runs in TypeScript only — no SQL twin. This is the one place
where the higher OTEL figure wins over Log Hub's price (see the algorithm doc).

**Period bounds (DD-6, `loadPeriodBounds` / `loadPeriodBoundsSeries`).** One SQL round-trip in
the budget's IANA zone: `date_trunc(unit, now() AT TIME ZONE tz) + offset * interval` (week starts
Monday), offset clamped to `[-400, 0]`. Week / month count days; a day budget counts hours (23–25
across DST). Daily buckets are local `YYYY-MM-DD`, hourly `HH24`.

**Slices (DD-8).** Model, user, repository, branch, sub-agent, skill, MCP server. Every slice sums
to the spend; the remainder is the `Not reported` row (`SLICE_NOT_REPORTED_KEY`). OTEL slices
pick calls by `session_id = ANY(period roots)`, never by call time (`loadSliceParts`).

## Plain-member view (DD-9)

When `fullView` is false (team kinds without analytics access):

- `GET …/spend` answers 200 with `restricted: true`: the caller's **own** spend (DD-3 rows with
  user filter `[caller.id]`) and only the budgets that own spend exceeds; `daily`, `slices`,
  `costlySessions` and `previous` are empty.
- `budgets` list, `budgets/events` and `spend/sessions` → 403.
- `analytics/budget-burn` and `reports/budget` keep the usual analytics 403.

The client mounts the repository Spend tab **outside** `RepositoryTeamWideTabs` and gives its
registry rows no `visible` predicate, so a plain member reaches it (DD-16).

## Threshold job (DD-14)

`BudgetThresholdScheduler` (template: `export-import-job-cleanup.scheduler.ts`):
`OnApplicationBootstrap`, `SchedulerRegistry.addInterval('budget-threshold-tick')`, an
`isTickRunning` guard and the in-flight tick awaited on shutdown. Interval
`BUDGET_CHECK_INTERVAL_MS` (default 300 000), `BUDGET_CHECK_ENABLED=false` disables it (env in
`release-template/.env.example`). Each tick: `loadAllBudgets` → per budget
`SpendService.computeBudgetSpend` (current period) → `BudgetNoticesService.recordCrossings`. An
error is logged per budget and never aborts the tick. It runs in every cluster worker; the
notices' unique key dedups. It is **never** called from ingest.

## Notices (DD-7, DD-10, DD-18)

- `selectThresholdNotices` (pure, `budget-math.ts`): of the newly crossed thresholds only the
  highest gets a shown notice; the others are written with `superseded_by` (and a
  `threshold_superseded` event). Thresholds are compared in BigInt.
- `budget_notices`: one row per `(budget_id, period_start, threshold)`; `superseded_by` NULL =
  shown. One transaction does `INSERT … ON CONFLICT DO NOTHING RETURNING id`, then the recipient
  rows and the events. Only the worker that got the id back sends email, after the commit.
- `budget_notice_recipients(notice_id, user_id, read_at)` exists only for shown notices.
  Recipients (`resolveNoticeRecipients`): `repo` → the owner; team kinds → the team owner plus
  managers. Plain members get none.
- Email: `MailService.sendBudgetNoticeEmail`, only when `mailService.isConfigured()` (Modes 2/3
  with `SMTP_HOST`); events `email_sent` / `email_failed` per recipient, or one `email_skipped`.
  The link base is `getEmailLinkBaseUrl()`; null → no link.
- A notice stays after an edit or a spend drop; a threshold newly crossed after an edit fires once
  (it is a new key).
- Notice link `{teamId?, repoId?, period, offset}` (DD-15): `repoId` is the recipient's own
  `repositories` row for the URL, else `MIN(id)` among team members' rows, else none (a team-repo
  link then falls back to the team Spend tab). `offset` is computed against the current period.
- Tray / banner: `GET /api/v1/budget-notices` (paged by `before` id) never marks read; read
  marking is **POST only** (`/budget-notices/read` with `{ids}` or `{all: true}`), on the caller's
  own rows only.

## Event log (DD-11)

`budget_events` is append-only, written by `insertBudgetEvent` (`budget-events.sql.ts`) in the
same transaction as the change: `created`, `edited` (`{before, after}` snapshots), `deleted`
(written before the row is removed), `threshold_crossed`, `threshold_superseded`, `email_sent`,
`email_skipped`, `email_failed`. Actor = `actor_user_id` + `actor_email` snapshot; NULL = "system ·
threshold job". Notices and events copy the scope columns and `budget_label` (e.g.
`Monthly $50.00`), and their `budget_id` is `ON DELETE SET NULL`, so they outlive the budget
(`budgetDeleted: true` in the DTO).

## Cleanup (DD-13)

- Team deletion: `team_id` FK cascades on all three scope-carrying tables. User deletion: the
  `user_id` FK cascades the `repo` kind.
- Repository / team-repository removal and URL rewrites have no FK, so every path calls the DI-free
  `budgets-cleanup.ts` inside its own transaction: `deletePersonalRepo`, `deleteTeamRepo`,
  `rewritePersonalRepoUrl`, `rewriteTeamRepoUrl`. Callers: `admin/admin.service.ts`,
  `users/account-deletion.service.ts`, `teams/teams.service.ts`, `logs/repo-backfill.service.ts`.
- URL merge rule: when the target URL already has a budget of the same period, the source budget is
  deleted (target wins); the source's notices and events get the new `repo_url` and keep
  `budget_id` NULL.

## Routes

`R = /api/v1/repositories/:repoId` (with `?teamId=` for team-repo), `T = /api/v1/teams/:teamId`.
Cookie session (`JwtAuthGuard`). Contract family `f26`.

| Route | Notes |
|---|---|
| `GET/POST R\|T/budgets`, `PUT/DELETE R\|T/budgets/:budgetId` | list needs `fullView`; mutations need `canManage`; 400 invalid (DD-12, `validateBudgetInput`), 409 duplicate period, 404 id outside the scope |
| `GET R\|T/budgets/events` | `budgetId?`, `event?`, `before?`, `limit?` (1–100, default 50); `fullView` |
| `GET R\|T/spend` | `period`, `offset ≤ 0`, `tz` (viewer zone, used without a budget); every member, DD-9 when `!fullView` |
| `GET R\|T/spend/sessions` | `slice` (`model\|user\|repo\|branch\|subagent\|skill\|mcp\|day\|costly`), `key`; max 200 costliest, `truncated`; `fullView` |
| `GET R/analytics/budget-burn` | `budgetId?` (default month › week › day), `branches?`, `users?`, `tz`; filters narrow only the cumulative line (`filtered: true`) |
| `GET R/reports/budget` | `startDate`, `endDate`, `tz`; each budget's periods overlapping the range |
| `GET /api/v1/budget-notices`, `POST /api/v1/budget-notices/read` | caller's own recipient rows |

Literal segments (`events`, `sessions`) are declared before `:budgetId`. Types:
`logs/budgets/budgets.types.ts`, mirrored in client `models/budgets.ts`.

## File map

Server, `server/src/logs/budgets/`:

| File | Role |
|---|---|
| `budget-scope.ts` | `BudgetScope`, `ScopeAccess`, labels (`budgetLabel`, `scopeLabel`, `periodLabel`), DTO mapping, `validateBudgetInput` |
| `budget.constants.ts` | DD-22 limits, `budgetMailSubject` |
| `budgets.types.ts` | DTOs, `PeriodBounds`, `BudgetRow` |
| `budget-math.ts` | pure forecast, anomaly days, costly sessions, threshold selection |
| `spend-read.sql.ts` | period bounds, scope rows, period trees, slice parts, `loadScopeBudgets` / `loadAllBudgets` |
| `spend.service.ts` | `getSpendView`, `getSpendSessions`, `getBudgetBurn`, `getBudgetReport`, `computeBudgetSpend` |
| `budget-access.service.ts` | DD-2 |
| `budgets.service.ts` | CRUD, events read |
| `budget-events.sql.ts` | `insertBudgetEvent` |
| `budget-notices.service.ts` | job writes, recipients, links, tray list, read marks |
| `budget-threshold.scheduler.ts` | the job |
| `budgets-cleanup.ts` | DD-13 helpers |
| `budgets.controller.ts`, `budget-notices.controller.ts`, `budget-query.ts` | routes and query parsing |

Also `logs/otel-cost.sql.ts` (`selectBudgetTreeCostMicros`), `mail/mail.service.ts`
(`sendBudgetNoticeEmail`), `analytics/usage-analytics.controller.ts` (`budget-burn`),
`reports/reports.controller.ts` (`budget`).

Client, `client/src/`:

| Path | Role |
|---|---|
| `models/budgets.ts`, `viewer/api.ts` | types and fetchers |
| `viewer/pages/budgets/` | `BudgetsSection` (Settings › Budgets, team Settings tab), `BudgetForm`, `BudgetEventLog`, `budget-format.ts` (`BUDGET_LIMITS` mirror, bands, `formatUnitsLeft`, notice paths), `budget-event-format.ts`, `budget-form-model.ts` |
| `viewer/pages/spend/` | `SpendTab`, `BudgetCard`, `DailySpendChart`, `SliceTable`, `CostlySessionsList`, `SpendSessionsModal`, `useSpendUrlState` (`sp` / `so`), `spend-format.ts` |
| `viewer/pages/repository/analytics/BudgetBurnView.tsx`, `budget-burn-series.ts` | Analytics view `budget-burn` |
| `viewer/pages/repository/reports/BudgetReport.tsx`, `budget-report-rows.ts` | report `budget` (category Cost) |
| `viewer/hooks/useBudgetNotices.ts`, `viewer/components/top-nav/BudgetNoticeTray.tsx`, `NotificationBell.tsx`, `viewer/components/BudgetNoticeBanner.tsx` | bell, tray and the banner mounted in `AppShell` |
| `viewer/tab-ids.ts` | repo `spend`, settings `budgets`, team `spend` / `settings` rows |
