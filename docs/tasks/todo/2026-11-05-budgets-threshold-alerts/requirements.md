# 2026-11-05: Budgets With Threshold Alerts

**Status:** todo
**Priority:** high
**Type:** feature
**Module(s):** server, client
**Owner:** denis.tsyplakov
**Created:** 2026-11-05
**Tracker:** GH-102 https://github.com/DataArt/artisyn-log-hub/issues/102

## Description

Budgets With Threshold Alerts — set a spend budget (per user, team, repository; period: day/week/month) and get alerted before it is reached (e.g. at 50/80/100%), with burn rate / forecast to period end. Top gap in the competitor parity study (alerts, budgets, burn rate — 10 of 14 tools ahead); New Relic AI Coding Observability (budgets + pre-threshold alerts, June 2026) and Grafana Cloud AI Observability (cost by user/repo/branch) ship it. Related: branch-grouped cost already exists in the session list; 2026-10-28-branch-summary-view. Must work offline (in-app + email via existing SMTP, no external services). This is the user's next task.

Context:

- `docs/product-kb/competitors.md` → "Gaps they expose": #1 is "Alerts, budgets, burn rate
  (10 of 14)". Found again by the morning check on 2026-11-05 (`docs/product-kb/competitive-watch/seen.md`).
- Spend must come from the same cost math the rest of the app uses (`docs/knowledgebase/llm-call-math.md`,
  `docs/knowledgebase/algorithms/cost-formula.md`, `@loghub/pricing`). OTEL cost
  (`docs/knowledgebase/otel-tabs.md`) is a possible near-realtime source.
- Data visibility rules apply: repositories are private to their owner, the admin role grants no
  session-data access, and teams have their own access modes (`docs/knowledgebase/authorization-and-authentificaiton.md`).
- Cost by branch is already shown as a branch-group total in the session list; a branch-level view is
  scoped in `2026-10-28-branch-summary-view`. It is not part of this task.

## Functional Requirements

- FR-1 A budget is an amount in USD for a scope (user, team or repository) and a period (day, week
  or month).
- FR-2 Spend for a budget is the total cost of the scope's sessions in the current period, computed
  with the app's existing cost formula.
- FR-3 Each budget has alert thresholds as percentages of the amount (default 50 / 80 / 100).
- FR-4 When spend crosses a threshold, an alert fires once per threshold per period. It is shown
  in the app and, when SMTP is configured, also sent by email.
- FR-5 The app shows burn rate (spend per day in the current period) and a forecast of spend at
  period end, and says when the forecast exceeds the budget.
- FR-6 Who can create, see and edit a budget, and who receives its alerts, follows the existing
  access rules for that scope (owner for user/repository, team roles for team).
- FR-7 Everything works without internet access: no external alerting service, no webhooks
  required.

## Non-Functional Requirements

- Offline first: in-app alerts must work when SMTP is not configured.
- Backward compatibility: older hooks need no update. Budgets use data the server already has.
- Checking thresholds must not slow down ingest or the session list.

## Acceptance Criteria

- [ ] FR-1 A user can create, edit and delete a budget for each scope type they are allowed to manage. Amount, period and scope persist.
- [ ] FR-2 A budget's displayed spend equals the sum of its scope's session costs in the period, as shown elsewhere in the app.
- [ ] FR-3 A new budget has thresholds 50/80/100 by default, and they can be changed.
- [ ] FR-4 Crossing 80% creates exactly one in-app alert for that period. When SMTP is configured, one email is sent too. The next period starts clean.
- [ ] FR-5 The budget view shows burn rate and forecast, and flags a forecast over budget.
- [ ] FR-6 A user cannot see or edit a budget for a scope they have no access to (checked by an API contract row).
- [ ] FR-7 With SMTP unset, in-app alerts still fire and nothing errors.

## Open Questions

- Which periods and time zone define "day/week/month" (server TZ, user TZ, calendar vs rolling)?
- Should alerts use hook-upload cost only, or also OTEL near-realtime cost to alert earlier?
- Should there be an org-wide budget for admins? Note that the admin role has no session-data access today.
- Where do alerts appear in the UI: the top nav, a notifications page, or a banner?
- Hard stop at 100% is out of scope, since Log Hub cannot block Claude Code. Should that be stated to users?

## Notes

<!-- Append timestamped notes here as work progresses -->
