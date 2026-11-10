# Research findings 1 — 2026-11-10

I read the full requirements, all six wireframes, `notes.md`, the relevant KB articles and the related code. The main points:
- **One conflict with existing rules:** taking the higher OTEL cost goes against two documented rules, so it needs KB changes, not just new docs.
- **Two wireframe arithmetic bugs:** the spend-view card assumes today is 9 Nov, and the report's weekly forecast doesn't follow the stated formula.
- **No existing patterns** for team-page URL state, an owner-or-manager check, or caller-independent team spend for the job.

## Requirements summary
Budgets are display-only: Log Hub never blocks usage. A budget is a USD amount (stored in micro-USD) with a period (day, week from Monday, or calendar month) and an IANA time zone. Its scope is a personal repository, a team repository or a team, and each scope has at most one budget per period type. Budgets are created and edited in a new Settings › Budgets sub-tab on all three scopes; the team page gets new Settings and Spend tabs.

- **Spend (FR-2):** per root session tree, the larger of the hook-upload tree cost and `otel_session_totals.cost_usd_micros`, compared in micro-USD. The whole tree lands on the root's start day; OTEL-only sessions count once their upload links them to a repository.
- **Budget card (FR-3):** bar, burn rate, linear forecast, days left and an overspend-risk flag. A day budget uses hours.
- **Spend tab:** Day/Week/Month picker with ‹ › periods, both in the URL.
- **Slices (FR-4):** model, user, repository, branch, skill, sub-agent and MCP server, each with a "Not reported" remainder row so shares add to 100 %.
- **Anomalies (FR-5):** days ≥ 2× the daily average; sessions at 2σ / 3σ.
- **Threshold job (FR-6):** runs every 5 minutes. It writes one notice per (budget, period start, threshold) under a unique key; when several are crossed at once only the highest fires. Email goes out only when mail is configured.
- **Access (FR-7):** follows the existing team rules.
- **Bell and banner (FR-9):** read state is per user.
- **Event log (FR-10):** budget events with time and actor.
- **Budget report (FR-11) and Analytics "Budget burn" view (FR-12):** repository-only, and they reuse the Spend service.
- **Docs (FR-13):** user docs plus the dev KB.
- **Data (FR-14):** snapshot columns survive budget deletion, cascade with the team or repository, and every route gets a contract row.

## Wireframes
All six are in `docs/tasks/todo/2026-11-05-budgets-threshold-alerts/wireframes/`.

**`spend-view.svg`**
- Picker with "‹ ›", then "Manage budgets in Settings →" (only for managers).
- Card: "Monthly budget · $50.00", ⚠ Overspend risk, "$41.20 of $50.00 · 82 % · resets on 1 Dec 2026". Bands are green < 75 %, amber 75–99 %, red ≥ 100 %, with threshold ticks.
- Four tiles: BURN RATE $4.58/day ("9 days elapsed"), FORECAST $137.33 (275 %), RUNS OUT IN ~2 days, PREVIOUS PERIOD $38.90 / 78 % plus the all-time total.
- An unpriced / OTEL-only note.
- Daily spend chart with the budget pace line ($1.67/day) and an anomaly bar "▲ 5 Nov · $16.30 · 3.6× avg".
- Slice table (COLUMN / SESSIONS / COST / SHARE, Not reported row, Total).
- "Unusually costly sessions" list (2σ / 3σ, mean and σ shown).
- With no budget, the card becomes "Spent this month $X · previous $Y".

**`budget-form.svg`**
- New `budgets` sub-tab between Session Attributes and Maintenance.
- Table columns: PERIOD, AMOUNT, NOTIFY AT, TIME ZONE, CURRENT PERIOD, then Edit / Delete.
- The inline form opens under the edited row. It shows the scope read-only, a Day/Week/Month radio, the amount ("was $80.00 · applies to the whole period"), the time zone, and threshold chips with "+ Add" (1–200).
- It names the recipients, shows the duplicate-period error, and has Delete (with confirmation), Cancel and Save.
- "+ Add budget" is disabled while a form is open.
- Users who can see but not manage get a read-only table with "Managed by team owner".

**`budget-settings.svg`**
- Team tabs: Members, Repositories, Invitations, OTEL, Spend, Settings.
- The "Budget event log" window has Budget and Event filters, columns TIME / ACTOR / BUDGET / EVENT / DETAILS, and "Load older events" (paged).
- Actor is either an email or "system · threshold job". Deleted budgets show as "Weekly $250 (deleted)".

**`threshold-banner.svg`**
- Banners stack, highest threshold first: amber below 100 %, red at 100 % and above, each with "Open spend →" and ×.
- The tray is titled "Budget notices · N unread · newest first" with "Mark all read" (not in the FRs). Rows show threshold, scope, budget, time, spend and period; unread rows get a blue dot. Older notices load on scroll.

**`budget-burn.svg`**
- View "Budget burn" with a budget picker; the layout toggle is hidden.
- Header: "$151.00 of $300.00 · 50 % … burn $15.10/day · forecast $453.00 · runs out ~20 Nov".
- Cumulative area, dashed forecast, budget line, threshold lines, previous-period line, anomaly marker.
- The wireframe's notes predate the requirements and contradict them in three places. It shows a stacked Group by, but FR-12 disables Group by. It says "no budget → tab's time window", while FR-12 says the x-axis is the budget period. It lists ‹ › as an open question, which FR-4a settles for the Spend tab only. **Requirements win.**

**`budget-report.svg`**
- Parameters: DATE RANGE plus a BUDGET picker ("All budgets (2)"). That picker is not in FR-11; FR-11 only says "each budget's periods".
- Per budget, a table: PERIOD, SPEND, % USED, FORECAST, THRESHOLDS CROSSED, ANOMALY DAYS; then top slices for the current period.
- The weekly budget is shown as a compact line.
- With no budget: "No budget is set for this scope." followed by spend per calendar month.

**Numeric check (computed, not estimated)**
- `spend-view.svg` with 9 elapsed days:
  - Rate 41.2 / 9 = 4.577777…, shown as $4.58.
  - Forecast 41.2 + 4.577777… × 21 = 137.3333…, shown as $137.33; 274.67 %, shown as 275 %.
  - Days left (50 − 41.2) / 4.577777… = 1.92233.
  - Anomaly 16.3 / 4.577777… = 3.56068, shown as 3.6×.
  - Pace 50 / 30 = 1.6667; previous 38.9 / 50 = 77.8 %.
  - The card is internally consistent but implies **today = 9 Nov**. The burn wireframe uses "day 10" (today = 10 Nov).
- `budget-burn.svg`:
  - Rate 151 / 10 = 15.1.
  - Forecast 151 + 15.1 × 20 = 453 (151 %).
  - Days left 149 / 15.1 = 9.86755, shown as ~20 Nov.
  - Anomaly 32 / 15.1 = 2.1192, shown as 2.1×.
  - All consistent.
- **`budget-report.svg` weekly row is inconsistent.** 2026-11-10 is a Tuesday (getUTCDay = 2), so for the week of 9–15 Nov elapsed = 2 days:
  - By FR-3 the forecast is 32.80 + 16.40 × 5 = **$114.80**.
  - The wireframe's $57.40 equals 32.80 + 8.20 × 3, which assumes 4 elapsed days.
  - Algorithm rows must not be copied from this number.

## Knowledgebase
- **`docs/knowledgebase/algorithms/otel-cost-selection.md`**
  - Says "shown cost is always the calculated one … OTEL never stands in".
  - FR-2 requires a new budget-only exception rule with new rows in `docs/algorithm-examples/otel-cost-selection.json`. The table test is `server/src/logs/otel-cost.sql.algo.spec.ts`, which uses `kind` discriminators and `loadExamples`.
  - "Where the result is visible" needs a budget entry.
- **`algorithms/README.md`** — the new budget-forecast doc needs:
  - Front matter `reviewed`/`reviewer`.
  - Sections Purpose, Code, Rules, Edge cases, Examples, Mutations, Where visible.
  - A rows file `docs/algorithm-examples/<name>.json` (never an inline table).
  - Listing in `index.md`.
- **`server-endpoint-map.md`**
  - Says "Costs shown by any route are … never the OTEL total". This needs a budget exception.
  - Guards legend: `team-member` is `TeamAccessGuard`, `team-owner` is `TeamOwnerGuard`; there is no owner-or-manager guard.
  - Repository access goes through `assertRepoAccess(user, repoId, teamId?)`. Team reads resolve `resolveTeamScope`, and `analytics/*` and `reports/*` return 403 when `!analyticsAllowed`.
  - No GET mutates (a read-mark must be a POST/PUT).
  - Literal route segments go before `:param` ones.
  - Each `reports/X` must be byte-identical to `analytics/X` (same service).
  - Contract registry: `server/test/contract/registry/f<NN>-*.ts`; add a controller row to the index.
- **`authorization-and-authentificaiton.md`** (§ Team access modes)
  - Roles count only in restricted teams. Members who haven't acknowledged the disclosure are invisible. The admin role grants no data access.
- **`server-conventions.md`**
  - Never bind a JS array as one Drizzle parameter: use `textList()` or the `{…}::int[]` literal.
  - Never read `logs.body` in analytics.
  - Add new analytics reads to the perf `-heavy` scenarios (`server/perf-tests/`).
  - Schedulers follow the `SchedulerRegistry` + `setInterval` pattern.
  - Startup schema steps go only in `initializeDatabase()`.
- **`twins-and-cross-cutting-rules.md`**
  - A new env var (e.g. the job interval) needs a line in `release-template/.env.example`.
  - A new background job uses the queue / `SKIP LOCKED` pattern. FR-6 instead uses unique-key insert dedup, which is closer to the log-hub-release "DB claim".
  - New lazy tabs join an existing barrel (9 of a budget of about 10 lazy chunks are already used).
- **`upload-queue.md`** — background-job pattern reference.
- **`db-schema-code.md`**
  - Edit `server/src/database/schema/index.ts`.
  - Hand-write `server/drizzle/migrations/0093_<name>.sql` (the latest is `0092_model_pricing_fable_5_2.sql`), with `COMMENT ON` and IF NOT EXISTS guards.
  - Add `meta/_journal.json` and run `npm run migrations:lock`.
  - Never `drizzle-kit generate`.
  - Partial unique indexes must be raw SQL.
  - Then run the db-state-update skill.
- **`db-tables.md`**
  - `otel_session_totals`: one row per root, hidden calls included, `first_call_at`.
  - `otel_cost_buckets` has no repo column; scope roots via `scopedTreeCtes`.
  - `''` means "not reported".
  - A `session_stats` row is not a "has transcript" signal.
  - Soft and hard delete purge paths are described here.
- **`session-metrics-scope.md`**
  - Use `descendantSessionsCte` (`session-tree.sql.ts`) and `treeCostCtes` / `readTreeCost` (`session-tree-cost.sql.ts`); never hand-roll the walk.
  - Keep the OTEL-only `EXISTS` guard.
  - Cost rollups use `depth > 0` plus the root's own cost.
- **`otel-tabs.md`**
  - Bucket grain includes `skill` and `mcp_server` (from `otel_calls.skill_name` / `mcp_server_name`).
  - `tz` is validated with `isValidOtelTimeZone` (`server/src/logs/otel/otel-classify.ts:98`) and rolled up with `date_trunc(unit, …, tz)`.
  - Scope: `scopedTreeCtes` needs the root's `artisyn` log linked to the repository.
  - The team OTEL route checks membership and `analyticsAllowed` in the handler.
- **`client-routing-and-layout.md`**
  - `TeamDetailPage` tabs are local `useState` seeded from `location.state`, with **no URL param**.
  - Repository tabs use the URL params `mtab` and `stab`; `setSearchParams` with `{replace:true}`.
  - Per-user localStorage goes through `lib/user-storage.ts`.
  - Lazy barrels: `repository-tabs-lazy-group.ts`; Reports has its own chunk.
- **`ui-principles.md`**
  - Light theme only.
  - Status colours: amber = warning, red = failure, emerald = OK, blue = cost (`#3b82f6`); pale badges `bg-<c>-50 text-<c>-700 ring-1 ring-<c>-100`.
  - Popups must stay inside the viewport.
  - Icons from `lucide-react`.
- **`user-docs-and-site.md`**
  - New page: `user-docs/<slug>.md` plus a `nav.json` entry ("Using Log Hub" section) with a required unique `description` of 50–160 chars, then `npm run build:help`.
  - One text, one place.
- **`client-component-map.md`** must be updated by the plan, along with `test/index.md` and the scenario and contract conventions.

## Existing patterns
**Spend / cost (server)**
- `server/src/logs/otel-cost.sql.ts:30` — `otelCostsCte` reads `session_stats.telemetry_cost`. This is the durable cost, which FR-2 says **not** to use; there is no per-tree max(hook, OTEL) helper here yet.
- `server/src/logs/otel-cost.sql.ts:78` — `resolveSessionTotalCost`; `:305` `selectSubagentCost` is the model for a pure TypeScript twin pinned by rows.
- `server/src/logs/session-tree-cost.sql.ts:47` — `treeCostCtes`; `:171` `readTreeCost`; `:218` `loadTreeCostRows(db, rootIds)`. Together they are the hook-side tree cost.
- `server/src/database/schema/index.ts`:
  - `:702` `otelSessionTotals`: PK `session_id` (root), `cost_usd_micros` bigint, `first_call_at`.
  - `:487` `otelCalls`: `model`, `agent_id`, `skill_name`, `mcp_server_name`, `cost_usd_micros`, `event_time`, `structure`.
  - `:600` `otelCostBuckets`.
- `server/src/logs/analytics/scoped-sessions.sql.ts`:
  - `:162` `loadScopedRootSessions`: phase A root selection on `log_repositories`, `artisyn` with `first_prompt`, `deleted=false`, `start_time` range.
  - It **requires a `claude` log**, which excludes OTEL-only roots.
  - `:139` `scopedUserFilterSql`, `:117` `textList`, `:145` `sessionIdsArray`, `:229` `dayKey` (UTC).
- `server/src/logs/tool-monitoring/tool-usage-read.sql.ts:147` — `scopedTreeCtes`: root selection with **no `claude`-log requirement**. This is the right base for "OTEL-only counts once linked".
- `server/src/logs/repositories.service.ts`:
  - `:231` `assertRepoAccess`, `:285` `assertRepoOwnerOrTeamOwner`.
  - `:330` `resolveRepoIds(repoId, repoUrl, teamId)`.
  - `:397` `resolveTeamScope`.
  - `:485` `resolveAcknowledgedUserIds` (private).
  - `:666` `canEditTeamConfig` is **team owner only**.
- `server/src/logs/team-scope.ts` — `TeamScope` type.
- `server/src/logs/otel/otel-team-facts.controller.ts:95` — the team-level route pattern (member check, `resolveTeamScope`, 403 when `!analyticsAllowed`). `otel-facts.reader.ts` (`getTeamOtelFacts`) shows multi-repo team selection.
- `server/src/logs/reports/reports.controller.ts:128` — report route template: `startDate`/`endDate` validation, `assertRepoAccess`, `resolveRepoIds`, scope, then service.

**Background job / mail**
- `server/src/logs/export-import-job-cleanup.scheduler.ts` and `server/src/log-hub-release/log-hub-release.scheduler.ts` — scheduler template: `OnApplicationBootstrap` + `SchedulerRegistry.addInterval`, `isTickRunning`, `inFlightTick` awaited in `onModuleDestroy`, env read at bootstrap.
- `server/src/mail/mail.service.ts:98` — `isConfigured()` is true only when `AUTH_MODE` is `password` or `password-confirm` and `SMTP_HOST` is set. `send` is private; the plan adds a public `sendBudgetNoticeEmail` returning `EmailDelivery` ('sent'/'failed').
- `server/src/common/public-base-url.ts:44` — `getEmailLinkBaseUrl` returns null when `PUBLIC_BASE_URL` is missing; the auth flow then skips the email (`auth.service.ts:387`).

**Schema patterns**
- `teamRepoConfig` / `teamRepoToolMonitorConfig` — FK `team_repositories.id` with `onDelete: 'cascade'`. This is the existing "team repository" keying.
- `repositories` is per user, unique `(user_id, repo_url)`.
- `teams` FK cascades `team_members` / `team_repositories`.
- Repository deletion paths that must also remove budgets: `admin/admin.service.ts:365` (by URL), `teams/teams.service.ts:658`, `logs/repo-backfill.service.ts:95` (duplicate merge), `users/account-deletion.service.ts:167`.

**Client**
- `client/src/viewer/components/top-nav/NotificationBell.tsx` — invitations-only bell (react-query, `refetchInterval: 60_000`, panel `w-80`, Escape and outside-click close, badge "9+"). Mounted in `pages/main/MainNav.tsx:107`.
- `client/src/viewer/components/AppShell.tsx` — `<MainNav/>` above the content row; the global banner slot goes here. `pages/admin/NewReleaseBanner.tsx` is an existing banner.
- `client/src/viewer/tab-ids.ts`:
  - Tab id arrays: `REPO_MAIN_TABS` `:58`, `SETTINGS_TABS` `:85`, `TEAM_TABS` `:97`.
  - `TAB_REGISTRY` rows with synonyms, `visible`, `gate`.
  - `teamWideAccess`; `assertRegistryMatchesArrays` (arrays and registry must match in order).
- `client/src/viewer/pages/teams/TeamDetailPage.tsx` — `PageTabs testIdGroup="team"`, `canSeeOtel = teamWideAccess(...)`, `initialTeamTab(location.state)`.
- `client/src/viewer/pages/repository/RepositoryTeamWideTabs.tsx` — where the Spend `PageTabsContent` goes. All team-wide tabs render only when `canSeeTeamWideTabs`, which interacts with FR-7's plain-member case.
- `client/src/viewer/pages/repository/RepositorySettings.tsx` — settings sub-tabs via `tabsOf('settings')`, with `readOnly = isTeamView && !canEditTeam`; `useRepositorySettingsTabState.ts` handles the `stab` param.
- `client/src/viewer/pages/repository/useRepoTeamAccess.ts` — `canSeeTeamWideTabs`, `showRestrictedNotice`.
- `client/src/viewer/pages/repository/repository-tabs-lazy-group.ts` — barrel for a lazy Spend tab.
- `client/src/viewer/pages/repository/reports/report-catalog.ts` — `ReportId`, `ReportDefinition` flags (`supportsGroupBy`, `supportsBranchFilter`, `supportsUserFilter`, `supportsAttributeFilter`), `REPORT_CATEGORIES` with category `cost`. Siblings: `ReportsPanel`, `ReportParameterStrip`, `ReportDocumentShell`, `downloadReportPdf.ts`, `report-url.ts`, `CostByBranchReport.tsx`.
- `client/src/viewer/pages/repository/analytics/analytics-state.ts` — `AnalyticsState.view` union plus `VIEW_OPTIONS` with synonyms. A new view must also go into the `av` whitelist in `analytics-url.ts`. `AnalyticsControls.tsx:136` hides Group by via `isUsageAnalyticsView`. `HorizontalSessionModal.tsx` shows a bucket's sessions.
- Browser time zone: `Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'` (`teams/otel/TeamOtelTab.tsx:129`, `RepoOtelTab.tsx:65`).
- Session list filter params today are only `branch`, `attr` and `otelReason` (`useRepositoryViewState.ts:109`, `api.ts:421`). There is no model, user, date, skill, MCP or session-set filter.

**Tests**
- Contract registry: `server/test/contract/registry/f01…f25` plus `index.ts`. A new family, e.g. `f26-budgets.ts`, needs an import and an array entry plus `f26.contract-spec.ts`. Row shape: `id`, `route`, `actor` (owner/member/outsider), `params`, `expect.status`, optional `read.sql` oracle.
- Scenarios to extend:
  - `tests/scenarios/view/s-cost-01.spec.ts` (one cost everywhere).
  - `view/s-rept-01.spec.ts` (report and PDF).
  - `view/s-anlt-01.spec.ts` (Analytics).
  - `auth/s-team-02.spec.ts` / `s-team-03.spec.ts` (restricted / transparent visibility).
  - `view/s-otel-02.spec.ts` (synthetic OTEL lines, `tests/scenarios/fixtures/otel/otel-lines.ts`).
  - `auth/s-auth-0x` (mode B Mailpit email).
  - A genuinely new feature may justify a new `S-BUDG-01`.
- Algorithm test template: `server/src/logs/otel-cost.sql.algo.spec.ts` using `scripts/algo-docs/load-examples.cjs`.

## Open gaps
1. **"Hook-upload cost" is defined two ways.** FR-2 says "`session_costs` sum over root and descendants", while AC FR-2 says "as shown elsewhere". `readTreeCost` also adds utility calls and returns null for a partly unpriced tree. The plan must pick one, including how a partly unpriced tree with OTEL is treated.
2. **The per-tree max does not exist** in `otel-cost.sql.ts`; the FR-2 wording "reusing the per-tree comparison" has nothing to reuse. A new helper plus a TypeScript twin pinned by rows is needed. The current OTEL helper uses `telemetry_cost`, not `otel_session_totals`.
3. **OTEL-only roots.** Analytics phase A requires a `claude` log; `scopedTreeCtes` does not. The plan must choose the root selection. The day rule is `logs.start_time` vs `otel_session_totals.first_call_at`, bucketed by the budget's time zone (existing `dayKey` is UTC only).
4. **Caller-independent team scope for the job.** `resolveTeamScope` and `resolveAcknowledgedUserIds` are caller-relative and private. The 5-minute job and the notice recipients need a "team spend" rule with no caller (transparent = all members; restricted = acknowledged members).
5. **No owner-or-manager guard or check.** `canEditTeamConfig` is team owner only. FR-1/FR-7 let managers manage budgets, so a new check is needed. The wireframe says "Managed by team owner".
6. **Plain-member exception (FR-7).** The Spend tab sits inside `RepositoryTeamWideTabs`, which is hidden without team-wide access, and the team Spend tab would be gated like OTEL. There is no pattern for "visible only when own spend exceeds the amount".
7. **No team page URL state.** FR-4a and FR-9 links need tab and period in the URL; the team page uses `location.state` only. New params on the team route are needed, and the Spend period params are needed on the repo route too.
8. **"Opens matching sessions"** has no filter for model, user, skill, MCP, sub-agent, day or session set. Options are a new list param or reusing the analytics `HorizontalSessionModal`. The team page has no session list at all.
9. **Scope keying.**
   - Personal repository: user id + `repo_url`, or FK `repositories.id`? The duplicate merge in `repo-backfill.service.ts` and the admin delete-by-URL matter here.
   - Team repository: FK `team_repositories.id` (like `team_repo_config`) or team id + URL.
   - Cascade on deletion vs snapshot columns that must survive budget deletion.
   - A partial or unique index for "one budget per scope and period type".
10. **Notice read state and the banner.** A per-user read table needs a POST/PUT, since no GET may mutate. The tray route is user-wide like `/api/v1/otel/live` (a new controller). "Mark all read" appears only in the wireframe. A banner host in `AppShell` is new.
11. **Email.**
    - Mail works only in `password` / `password-confirm`; `azure-oauth` and `none` are in-app only.
    - The link base needs `PUBLIC_BASE_URL`; behaviour when it is missing is not specified. Event types are sent / skipped / failed.
    - A new env var for the job interval (if any) goes into `release-template/.env.example`.
    - **Cluster dedup:** it's unclear whether "worker whose insert succeeds" means `INSERT … ON CONFLICT DO NOTHING RETURNING`, and whether a superseded record is a notice row with a flag or an event only.
12. **Day budget in hours, and the run-out date.** No existing time-zone-aware period helper exists, and no DST rule for 23- or 25-hour days is specified. FR-4a's ‹ › moves the period, but the formulas are defined for the current period; past periods show spend only.
13. **Wireframe vs requirements.** Use the requirements over the stale burn-chart notes and the report's extra Budget picker. Don't take algorithm rows from the inconsistent $57.40 weekly forecast.
14. **Docs to update.**
    - Exceptions in the KB: `server-endpoint-map.md` (Costs bullet), `otel-cost-selection.md` (Purpose and rule list), `db-tables.md`.
    - Contract: a new family file, `f26` is free.
    - Perf: a `-heavy` perf scenario for the Spend read.
    - Lazy chunk: Spend should join `repository-tabs-lazy-group.ts`.
