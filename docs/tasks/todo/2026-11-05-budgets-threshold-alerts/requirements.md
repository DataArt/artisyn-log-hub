# 2026-11-05: Budgets, Spend Forecasts and Cost Slices (Display-Only)

**Status:** todo
**Priority:** high
**Type:** feature
**Module(s):** server, client
**Owner:** denis.tsyplakov
**Created:** 2026-11-05
**Tracker:** GH-102 https://github.com/DataArt/artisyn-log-hub/issues/102

## Description

Log Hub **cannot limit or block** Claude Code spend — it only sees what the hook uploads. So a
"budget" here is a reference number the app measures spend against: it shows where spend stands, where
it is heading, what drives it, and warns people before the number is reached. Nothing is stopped.

Budgets, alerts and burn rate are the top gap in the competitor parity study (10 of 14 tools ahead).
Competitor research: `docs/product-kb/competitive-research/budgets-forecasts-waiting.md` (what 18 tools
show, display vs enforcement) and `docs/product-kb/competitive-research/beezi.md`.

What competitors show that fits a display-only, offline product:

- Budget bar "$X of $Y · N % · resets <date>" with colour bands (ccboard 60 / 80, ccusage 70 / 90).
- Month-end forecast from the run rate with an early "overspend risk" flag (Beezi, New Relic,
  Jellyfish); nobody shows "days until the budget runs out" explicitly.
- Threshold notices at 75 / 90 % for the budget owner and 75 / 95 % for the user (Anthropic, GitHub),
  once per threshold per period (LiteLLM dedup).
- Cost slices: model, user, repo, branch, skill, sub-agent, MCP server, effort (Beezi, Claude Code
  `/usage`, Grafana dashboard 25255).
- Anomalies: a day ≥ 2× the average, sessions at 2σ / 3σ (ccboard), "high spend, low output" (Datadog).
- Current period next to the previous period and the total (LiteLLM, Anthropic MTD / QTD / YTD).

Context in the code base:

- Spend must come from the same cost math the rest of the app uses (`docs/knowledgebase/llm-call-math.md`,
  `docs/knowledgebase/algorithms/cost-formula.md`, `@loghub/pricing`). OTEL cost
  (`docs/knowledgebase/otel-tabs.md`) is the near-realtime source; it is Claude Code's own estimate
  (`cost_usd`), not the Log Hub price, and arrives before the hook upload.
- Metric scope: root + sub-agents, never double counted (`docs/knowledgebase/session-metrics-scope.md`).
- Data visibility: repositories are private to their owner, the admin role grants no session-data
  access, teams have their own access modes (`docs/knowledgebase/authorization-and-authentificaiton.md`).
- Analytics never reads transcripts per request (`docs/knowledgebase/server-conventions.md`).
- Branch-group cost already exists in the session list; a branch view is `2026-10-28-branch-summary-view`.

## Functional Requirements

- FR-1 A budget is a USD amount for a scope (personal repository, team repository or team) and a period
  (day, week or calendar month; week starts Monday). It is a reference only — the UI says that Log Hub
  does not stop usage when it is reached. Budgets are created, edited and deleted in a new "Budgets"
  sub-tab of the scope's Settings: the personal repository's Settings tab, the repository's Settings
  tab in team context (team repository), or a new "Settings" tab on the team page (`TeamDetailPage.tsx`,
  tab registry group `team`, team-wide access rule). The add / edit form opens inline in that sub-tab;
  it has no scope selector — the scope is the page it was opened from, shown as read-only text. A
  scope has at most one budget per period type; saving a second budget with the same period is
  rejected with a validation error. There is no per-user budget and no single org-wide
  budget for admins: different teams (or whole organisations, modelled as teams) get their own budgets.
  Each budget stores an IANA time zone
  (default: the creator's browser time zone at creation); its period boundaries, "resets on <date>"
  and daily buckets use it. A Spend view without a budget uses the viewer's browser time zone. A
  repository scope is stored by repository URL, like team repositories.
- FR-2 Spend for a budget is the total cost of the scope's sessions in the current period. Per root
  session tree (root plus all sub-agents) it takes the larger of the hook-upload cost (the app's
  existing `session_costs` sum over the root and all descendants) and the near-realtime OTEL cost
  (`otel_session_totals.cost_usd_micros` per root session), reusing the per-tree comparison in
  `server/src/logs/otel-cost.sql.ts` rather than a new one; amounts are compared in micro-USD, so a budget
  warns as early as possible. A missing side is ignored; a tree with neither counts $0 and the view
  shows "N sessions unpriced". The whole tree cost lands on the day the root session started (its
  first OTEL call for an OTEL-only session). A session with only OTEL data counts once its first upload
  links it to a repository (within seconds of the first prompt). Using the
  higher OTEL cost is a budget-only exception to "Log Hub's price is the source of truth", documented
  with rows in `docs/knowledgebase/algorithms/otel-cost-selection.md`.
- FR-3 Budget view per budget: a bar "spent of amount · % · resets on <date>" with colour bands, burn
  rate, linear forecast of spend at period end, "days until the budget runs out" at the current rate,
  and an "overspend risk" flag when the forecast exceeds the amount. The previous period's spend is
  shown next to the current one, with its % against the current amount. Formulas (new algorithm doc
  in `docs/knowledgebase/algorithms/` with a rows file): elapsed days = whole days so far including
  today; burn rate = spend / elapsed days; forecast = spend + burn rate × remaining days; days left =
  (amount − spend) / burn rate, "—" when burn rate is 0, "exceeded" when spend ≥ amount. The current
  amount applies to the whole current period, also after a mid-period edit. A day budget uses the same
  formulas in elapsed hours (current hour included) in the budget's time zone, and shows the run-out
  point as a time ("~16:40").
- FR-4a Spend tab: a new "Spend" tab (between Analytics and Reports) on the repository page — personal
  and team context — and on the team page, registered in the tab registry with synonyms budget / spend /
  forecast. It has a Day / Week / Month period picker with ‹ › to previous periods, both in the URL so
  FR-9 links open the right period; the picker selects the scope's budget of that period type, or the
  plain Spend view when there is none. It shows the FR-3 budget card, daily spend with FR-5 markers, the
  FR-4 slices and a costly-sessions list.
- FR-4 Cost slices for a scope and period: by model, user, repository, branch, skill, sub-agent and MCP
  server, each with its share of spend; clicking a slice opens the matching sessions. Slices are
  available for any scope the user can see, with or without a budget (a "Spend" view); a budget only
  adds the bar, forecast and notices on top. Every slice sums to the budget spend (FR-2). Model, user,
  repository, branch and sub-agent use the tree cost; the sub-agent slice shows the root's own cost as
  a "Main agent" row; for an OTEL-only session the model slice uses OTEL's per-call model. Skill and MCP
  server attribute the OTEL cost of the calls made inside that skill / after that MCP call. Whatever a
  slice cannot attribute goes to a "Not reported" row (budget spend minus the attributed sum, clamped at
  0), so shares always add up to 100 %. The skill, MCP and OTEL-model slices select OTEL calls by the
  period's set of root sessions (the FR-2 set), never by call or bucket time.
- FR-5 Anomaly markers: a day whose spend is ≥ 2× the period's daily average (period spend / elapsed
  days, today and zero-spend days included; no day markers on the first elapsed day), and the sessions
  whose cost is ≥ 2σ / 3σ above the mean (population σ over the root session trees of the same scope and
  period; no session markers with fewer than 5 priced trees or σ = 0); each links to the sessions. Like
  slices, they are shown with or without a budget.
- FR-6 Threshold notices: each budget has its own editable list of percentage thresholds (whole
  numbers 1–200, default 75 / 90 / 100), saved with the budget. A periodic server job (every 5 min,
  never inside ingest) checks budgets. Crossing thresholds creates one shared notice record per budget,
  period start and threshold (unique key, so cluster workers cannot duplicate it; only the worker whose
  insert succeeds sends the email); when several are crossed at once a record is written for each, but
  only the highest is shown and emailed as a notice — the others are logged as "crossed (superseded by
  N %)" and never fire later in that period.
  Recipients: the owner for personal repository budgets; the team owner and managers for team
  repository and team budgets. Email is sent only when the mail service is configured. Notices already
  sent stay after an edit or if spend later drops; a threshold newly crossed after an edit fires once.
- FR-7 Who can create, see and edit a budget and who gets its notices follows the existing access rules.
  Personal repository budgets: the repository owner; spend counts only the owner's sessions. Team
  repository and team budgets: created and edited by the team owner and managers; the bar and slices are
  visible to whoever has team analytics access; spend counts sessions in that repository (team
  repository) or in all the team's linked repositories (team), limited to acknowledged members visible
  under the team's access mode. A plain member without team analytics access sees a team repository or
  team budget only when their own spend in the current period exceeds its amount — then only the bar
  with their own spend, never the user slice or other members' sessions.
- FR-8 Everything works offline: no external alerting service, no webhooks required.
- FR-9 Notice tray: budget notices go into the existing top-bar bell (`NotificationBell.tsx`, today
  team invitations only); its unread count includes them and its tray lists all of the user's budget
  notices, newest first (scope, budget, threshold, spend, period, time), each linking to the
  scope's Spend tab for that budget and period. A new unread notice is also shown as a dismissible banner at the
  top of the app; dismissing the banner or opening the notice in the tray marks it read for that user
  only, and the notice stays in the tray. Read state is stored per user.
- FR-10 Budget event log: the Budgets sub-tab of the personal repository, team repository and team
  Settings each has a "Budget event log" window listing that scope's budget events, newest first, with time and actor:
  budget created, edited (old → new amount, period, thresholds, time zone), deleted, threshold crossed,
  notice email sent / skipped (mail not configured) / failed. Events are written when they happen (the
  edit's transaction, or the threshold job). The log is
  visible to whoever can see the scope's budgets.
- FR-11 Budget report: the Reports tab gets a "Budget" report in the Cost category
  (`report-catalog.ts`), with the usual parameter strip, on-page preview and PDF download. For the
  chosen scope and date range it shows each budget's periods: amount, spend (FR-2), % used, forecast
  and risk flag for the current period (FR-3), crossed thresholds (FR-6), the top cost slices (FR-4)
  and the anomaly days (FR-5). With
  no budget on the scope the report states that and still shows spend per period. Catalog flags: no
  Group by, no branch / user / attribute filter, so its spend always matches FR-2.
- FR-12 Analytics chart: the Analytics tab gets a "Budget burn" view — cumulative spend per day of the
  selected budget's current period against a horizontal budget line, with the linear forecast to period
  end drawn dashed and threshold lines marked. A budget picker chooses the budget (default: month, else
  week, else day); the x-axis is that budget's period and ignores the time window. Branches / Users
  filters narrow the cumulative line, labelled "filtered — budget line is for the whole scope"; Group by
  is disabled for this view. With no budget on the scope it shows cumulative spend only.
- FR-13 Documentation (offline, shipped with the product): a new user-docs page about budgets
  (concept "reference only, nothing is stopped", how to set one per scope in Settings, the spend rule
  of FR-2, forecast formulas, notices / tray / emails, event log) added to `user-docs/nav.json` and the
  in-app help; `user-docs/analytics-reports.md` lists the Spend view, the Budget burn view and the Budget
  report and adds rows to "Which one answers your question?"; the All views map gets the new view and
  report with synonyms (budget, forecast, burn rate, limit); `user-docs/server-configuration.md`
  describes the threshold job and that notice emails need the mail service; `user-docs/small-team-setup.md`
  and `user-docs/tuning-your-setup.md` mention setting a team budget; `user-docs/cost-and-context.md`
  explains why the budget may use the OTEL cost, and `user-docs/otel-tab.md` gets a short "Budgets use
  the higher OTEL cost" paragraph; `user-docs/responsibility-matrix.md` gets rows for setting a team
  budget (team owner, managers), setting a personal repository budget (end user) and receiving budget
  notices; `user-docs/getting-started.md` mentions budget notices in the bell; `user-docs/session-list.md`
  and the tab tables of `user-docs/all-views.md` list the Spend tab; `user-docs/changelog.md` gets an
  entry. In the development KB: the new algorithm doc and a KB article on budgets, both in
  `docs/knowledgebase/index.md`; `db-tables.md` and `client-component-map.md` updated; `db_state.sql`
  regenerated via the db-state-update skill.
- FR-14 Data and API: amounts are stored in micro-USD; notices and events keep snapshot columns and
  survive budget deletion; budgets, notices and events are removed with their team or repository. Every
  new route gets an API contract row with its FR-7 access rule; the Budget report and Budget burn view
  reuse the Spend tab's server service, so all three agree.

![Spend tab with budget card, daily spend, cost slices and costly sessions](wireframes/spend-view.svg)

![Budget create / edit form](wireframes/budget-form.svg)

![Threshold notice banner and notice tray](wireframes/threshold-banner.svg)

![Budgets section and Budget event log in Settings](wireframes/budget-settings.svg)

![Budget burn view on the Analytics tab](wireframes/budget-burn.svg)

![Budget report on the Reports tab](wireframes/budget-report.svg)

## Non-Functional Requirements

- Offline first: in-app notices work when SMTP is not configured.
- Backward compatibility: older hooks need no update; budgets use data the server already has.
- Checking thresholds and computing forecasts must not slow down ingest or the session list.

## Acceptance Criteria

- [ ] FR-1 From the Settings of a personal repository, a team repository and a team, a user who may
  manage that scope can create, edit and delete a budget; amount, period, scope, thresholds and time
  zone persist; the budget view states that usage is not blocked.
- [ ] FR-2 A budget's spend equals the sum, over its scope's root session trees in the period, of the
  larger of each tree's hook-upload cost (as shown elsewhere in the app) and its OTEL cost; a session
  linked to the repository whose OTEL cost exceeds its upload cost counts at its OTEL cost; an unpriced
  session with OTEL cost counts at its OTEL cost.
- [ ] FR-3 For a budget with known spend on known days, burn rate, forecast and days-left match the linear
  formula (algorithm rows); the risk flag shows exactly when the forecast exceeds the amount; the
  previous period is shown.
- [ ] FR-4 Slice shares add up to 100 % of the period's spend; a slice links to its sessions.
- [ ] FR-5 A seeded day at 2× the average and a session above 2σ are marked; normal ones are not.
- [ ] FR-6 Crossing each of 75, 90 and 100 % creates exactly one in-app notice for that period (and one
  email when mail is configured); a dismissed banner stays dismissed after reload; the next period
  starts clean.
- [ ] FR-7 A user cannot see or edit a budget for a scope they have no access to (API contract row).
- [ ] FR-8 With SMTP unset, in-app notices still appear and nothing errors.
- [ ] FR-9 A crossed threshold shows in the tray with the unread count increased and as a banner;
  dismissing the banner clears the unread mark for that user only and the notice stays in the tray
  after reload.
- [ ] FR-10 Creating, editing and deleting a budget and a crossed threshold each add one event to the
  scope's Budget event log with time and actor; an edit shows old and new values; events of a deleted
  budget remain; a user without access to the scope cannot read its log (API contract row).
- [ ] FR-11 The Budget report for a seeded scope shows the same spend, % and forecast as the Spend view
  for the same period and downloads as a PDF.
- [ ] FR-4a The Spend tab opens on the personal repository, team repository and team pages; a tray
  link opens it at the notice's budget and period.
- [ ] FR-12 The Budget burn view draws the cumulative spend, the budget line and the dashed forecast;
  with no filters, its last point equals the budget spend (FR-2).
- [ ] FR-13 The budgets help page opens from the in-app help menu with the network off, and
  `analytics-reports.md` and the All views map list the new view and report.

## Open Questions

- Out of scope for now (possible later increment): a 5-hour window view built from session costs.
- Rejected (user decision 2026-11-09): capturing the real subscription quota (5-hour / 7-day window %
  used) — it is only available through a status-line wrapper in the hook, which is complex and fragile
  (see the PoC in `notes.md`); actual plan billing vs API-equivalent cost — plan prices change
  too often, people see it in their vendor dashboard; what-if model pricing — different models solve the
  same task with very different numbers of calls, so re-pricing the same tokens is misleading.
- Out of scope (separate task `2026-11-10-team-analytics-reports`): Analytics and Reports for the team
  page. Here the Budget report (FR-11) and Budget burn view (FR-12) are repository-only; a team budget
  is shown on the team Spend tab.

## Common sense considerations

- Period boundaries use a time zone stored per budget, defaulting to the creator's browser time zone.
- A session tree's whole cost lands on the day its root started; it is not split per call.
- Burn rate counts today as an elapsed day; days left shows "—" at zero rate and "exceeded" at or over the amount.
- The current amount applies to the whole period; no amount history is kept, the previous period's % uses the current amount.
- A missing cost side is ignored; a tree with neither counts $0 and is reported as unpriced.
- Hook vs OTEL comparison is made once per root session tree.
- The budget uses the near-realtime OTEL totals, not the later durable `telemetry_cost`.
- The higher-OTEL rule is a budget-only exception, documented in the OTEL cost-selection algorithm doc.
- OTEL-only sessions count once their first upload links them to a repository.
- Every slice sums to the budget spend with a "Not reported" remainder row; skill / MCP use per-call OTEL cost.
- The sub-agent slice has a "Main agent" row; the model slice uses OTEL's model for OTEL-only sessions.
- Team spend = team repositories' sessions of acknowledged members visible under the team's access mode.
- Team budgets are managed by the team owner and managers; visible to whoever has team analytics access.
- A personal repository budget counts only its owner's sessions.
- Thresholds are an editable per-budget list of whole percentages 1–200.
- Team notices go to the team owner and managers, not plain members.
- Thresholds are checked by a periodic 5-minute job, never inside ingest.
- When several thresholds are crossed at once, only the highest gets a notice.
- A notice is one shared record per (budget, period start, threshold) with a unique key; read state is per user.
- Sent notices stay after edits or spend drops; a threshold newly crossed after an edit fires once.
- Email is sent only when the mail service is configured; no separate SMTP setup for notices (auth mode `none` → in-app only).
- A plain team member sees a team budget only after personally exceeding it, and only their own spend.
- A repository budget scope is stored by repository URL.
- Budget event log and tray times are shown in the viewer's browser time zone.
- Notice acceptance covers all default thresholds and dismissal persistence.
- Budgets are a Settings sub-tab; the team page gets new Settings and Spend tabs.
- The Spend tab has a Day / Week / Month picker and ‹ › periods in the URL; no separate "My spend" view.
- At most one budget per scope and period type.
- Budget burn: budget picker (month › week › day), x-axis = budget period, filters narrow the line, no Group by.
- The Budget report has no Group by and no filters.
- Budget spend reuses `otel-cost.sql.ts` and compares in micro-USD.
- OTEL slices select calls by the period's root sessions; "Not reported" is clamped at 0.
- Day budgets compute in hours.
- Anomaly baselines: elapsed-day average; population σ over the period's trees; min 5 trees.
- Superseded thresholds are recorded and never fire later in the period.
- Budget notices use the existing bell.
- Schema and routes are decided in the plan; notices and events keep snapshots.

## Notes

<!-- Append timestamped notes here as work progresses -->

Scope history and the subscription-quota PoC findings: see `notes.md`.
