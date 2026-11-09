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

Originally (2026-11-05): set a spend budget per user / team / repository and day / week / month, get
alerted at 50 / 80 / 100 %, see burn rate and a forecast to period end. Top gap in the competitor parity
study (alerts, budgets, burn rate — 10 of 14 tools ahead). Reworked 2026-11-09 after the user's note
("we cannot limit, but we can show different slices, forecasts and so on") and a competitor study:
`docs/product-kb/competitive-research/budgets-forecasts-waiting.md` (what 18 tools show, display vs
enforcement) and `docs/product-kb/competitive-research/beezi.md`.

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
  (`docs/knowledgebase/otel-tabs.md`) is a possible near-realtime source.
- Metric scope: root + sub-agents, never double counted (`docs/knowledgebase/session-metrics-scope.md`).
- Data visibility: repositories are private to their owner, the admin role grants no session-data
  access, teams have their own access modes (`docs/knowledgebase/authorization-and-authentificaiton.md`).
- Analytics never reads transcripts per request (`docs/knowledgebase/server-conventions.md`).
- Branch-group cost already exists in the session list; a branch view is `2026-10-28-branch-summary-view`.

## Functional Requirements

- FR-1 A budget is a USD amount for a scope (user, team or repository) and a period (day, week or
  calendar month; week starts Monday). It is a reference only — the UI says that Log Hub does not stop
  usage when it is reached.
- FR-2 Spend for a budget is the total cost of the scope's sessions in the current period, computed with
  the app's existing cost formula.
- FR-3 Budget view per budget: a bar "spent of amount · % · resets on <date>" with colour bands, burn
  rate (spend per day so far), linear forecast of spend at period end, "days until the budget runs out"
  at the current rate, and an "overspend risk" flag when the forecast exceeds the amount. The previous
  period's spend is shown next to the current one.
- FR-4 Cost slices for the budget's scope and period: by model, user, repository, branch, skill,
  sub-agent and MCP server, each with its share of spend; clicking a slice opens the matching sessions.
- FR-5 Anomaly markers: a day whose spend is ≥ 2× the period's daily average, and the sessions whose cost
  is ≥ 2σ / 3σ above the scope's mean; each links to the sessions.
- FR-6 Threshold notices: each budget has percentage thresholds (default 75 / 90 / 100). Crossing one
  creates one in-app notice per threshold per period and, when SMTP is configured, one email to the
  people who manage the budget; the user whose spend it is sees their own notices.
- FR-7 Who can create, see and edit a budget and who gets its notices follows the existing access rules
  (owner for user / repository, team roles for team).
- FR-8 Everything works offline: no external alerting service, no webhooks required.

## Non-Functional Requirements

- Offline first: in-app notices work when SMTP is not configured.
- Backward compatibility: older hooks need no update; budgets use data the server already has.
- Checking thresholds and computing forecasts must not slow down ingest or the session list.

## Acceptance Criteria

- [ ] FR-1 A user can create, edit and delete a budget for each scope they may manage; amount, period
  and scope persist; the budget view states that usage is not blocked.
- [ ] FR-2 A budget's spend equals the sum of its scope's session costs in the period as shown elsewhere
  in the app.
- [ ] FR-3 For a budget with known spend on known days, burn rate, forecast and days-left match the linear
  formula (algorithm rows); the risk flag shows exactly when the forecast exceeds the amount; the
  previous period is shown.
- [ ] FR-4 Slice shares add up to 100 % of the period's spend; a slice links to its sessions.
- [ ] FR-5 A seeded day at 2× the average and a session above 2σ are marked; normal ones are not.
- [ ] FR-6 Crossing 90 % creates exactly one in-app notice for that period (and one email with SMTP set);
  the next period starts clean.
- [ ] FR-7 A user cannot see or edit a budget for a scope they have no access to (API contract row).
- [ ] FR-8 With SMTP unset, in-app notices still appear and nothing errors.

## Open Questions

- Time zone for day / week / month boundaries: server TZ, user TZ, or UTC?
- Spend from hook-upload cost only, or also OTEL near-realtime cost to warn earlier?
- Org-wide budget for admins, given the admin role has no session-data access today?
- Where do notices appear: top-nav bell, a notifications page, or a banner?
- Should slices and anomalies also exist without a budget (an Analytics "Spend" view), with the budget
  only adding the bar and forecast?
- Later increments, not in this task unless decided otherwise: 5-hour block view with P90 personal limit
  (ccusage / Usage Monitor), capturing the statusline `rate_limits` / `spend_limit` through the hook for
  the real subscription quota, actual billing vs API-equivalent cost (Beezi), what-if model pricing.

## Notes

<!-- Append timestamped notes here as work progresses -->

**2026-11-09:** Reworked as display-only after the user's note that Log Hub cannot limit spend;
competitor study in `docs/product-kb/competitive-research/budgets-forecasts-waiting.md`.
