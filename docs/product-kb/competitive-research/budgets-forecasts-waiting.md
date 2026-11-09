---
type: "Research"
title: "Budgets, forecasts and waiting time — what competitors show"
description: "Cross-tool study (2026-11-09) of display-only budgets, burn rate, forecasts, cost slices and session waiting-time breakdowns, split into what Log Hub can copy (display) and what needs enforcement (not applicable)."
tags:
  - competitive-research
  - budgets
  - work-time
timestamp: "2026-11-09T00:00:00+04:00"
---

# Budgets, forecasts and waiting time — what competitors show

Research date **2026-11-09**, from official docs, READMEs and press releases; nothing was installed.
"UNVERIFIED" = marketing copy or undocumented. Log Hub cannot block spend, so every pattern is marked
**DISP** (display, applicable) or **ENF** (enforcement, not applicable).
Tasks that use this: `2026-11-05-budgets-threshold-alerts` (GH-102),
`2026-11-09-session-waiting-breakdown` (GH-116).

## Corrections to the tool files

- **ccusage:** `--live` was removed in v18.0.0; the docs point to the `statusline` command instead.
- **ccboard:** budgets are monthly USD, global or per project (`monthlyBudgetUsd`,
  `alertThresholdPct` default 80, in each project's settings); "4-level alerts" is config
  precedence, not severity levels. Forecast method undocumented.
- **Anthropic (2026-07-02):** spend limits per org / group / member, admin alerts at 75 / 90 %, user
  in-app alerts at 75 / 95 %
  ([blog](https://claude.com/blog/giving-admins-more-visibility-and-control-over-claude-usage-and-spend)).
- **Beezi:** only the `PermissionRequest` wait is documented; the other timeline categories and
  "blocked by rate limits" are homepage claims.
- **New Relic AI Coding Observability:** press release only ("forecast spend against budgets and
  alert before thresholds are hit"); docs 404 ([PR](https://newrelic.com/press-release/20260608)).

## Budgets, forecasts and slices

| Tool | Scope | Period | Burn rate / forecast | Bar / thresholds | Slices | Notify | Kind |
|---|---|---|---|---|---|---|---|
| ccusage | 5 h block token limit; `-t max` = highest past block | 5 h block from first message | tokens/min, projected $/h, block total if the rate holds | green < 70, yellow 70–90, red ≥ 90 %; ⌛ gap rows | day, month, session, model; statusline "2h 45m left", 🔥 $/h | terminal | DISP |
| Claude Code Usage Monitor | plan presets or custom | 5 h | tokens/min over last hour; time to exhaustion; custom limit = **P90 of last 8 days** | 4 bars (cost, tokens, messages, reset) | day, month, model | exit codes 10 / 11 / 20 | DISP |
| ccboard | monthly USD, global / project | calendar month + 5 h blocks | 30-day forecast, "projected overage"; spike = day > 2× average; session z-score 2σ / 3σ | 60 / 80 % colours | model, project, day, top sessions, tool, skill | macOS notification, CI gate | DISP |
| Anthropic claude.ai | org, group, member, seat tier | month; seat 5 h + weekly | none; Admin API flags users near limit / rapid change | 75 / 90 admin, 75 / 95 user; "$X of $Y · % · resets …" | user × model × product; actual vs list price MTD / QTD / YTD; spend concentration | in-app | limits ENF, views DISP |
| Claude Code client | `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`), `spend_limit` | rolling 5 h / 7 d | — | statusline input | `/usage`: % by skill, subagent, plugin, MCP; OTel `cost.usage` by `model`, `query_source`, `effort`, `skill.name`, `mcp_server.name` | — | data source |
| Datadog | not in Agent Console docs | — | monitors on high token use, low cache hit | generic | user, agent, model, team; "high spend, low output" | monitors | DISP |
| Grafana Cloud / dashboard 25255 | none prebuilt | — | generic alerting | — | user, model, `query_source`, `effort` | alerting | DISP |
| New Relic | UNVERIFIED | UNVERIFIED | forecast vs budget | pre-threshold alert | UNVERIFIED | alerts | DISP |
| Beezi | monthly, org | month | month-end forecast, "overspend risk" | — | group, person, model, skill, subagent, repo, **actual billing vs API-equivalent** | — | DISP |
| Jellyfish | budget planning | YTD | YTD spend, projected spend, run rate | — | tool, team, model | — | DISP |
| LiteLLM | key, user, team, member, customer, model, tag, org | rolling `budget_duration` or calendar (midnight UTC, Monday, 1st) | `projected_limit_exceeded` | `soft_budget` alert vs `max_budget` block; 85 / 95 % | current-cycle vs total spend; weekly / monthly reports | Slack, email, webhook; 24 h dedup | ENF + DISP |
| Helicone | global, user, property | ≥ 60 s window | — | cost alerts with a `Min Requests` guard | user, property | email, Slack | ENF + DISP |
| Portkey | provider, workspace | none / week (Sun UTC) / month (1st UTC) | — | email at threshold, key expires at limit | analytics | email | ENF + DISP |
| Langfuse | project | lookback 1 h / 1 d / 1 w | — | alert / warning thresholds on aggregates | trace dims | Slack, webhook | DISP |
| Cursor | member, group, team | billing cycle | — | spend alerts; "alerts don't stop usage" | usage events | email | ENF + DISP |
| GitHub Copilot | account, org, repo, cost center, user (overrides with expiry) | month | — | 75 / 90 / 100 % | 45-day report | UI + email | ENF + DISP |

No tool shows a what-if price ("this month on Sonnet instead of Opus"); the nearest are Beezi's
plan / model fit, `/usage` recommendations and Datadog's estimated savings.

## Waiting / active-time breakdown

| Tool | Working vs waiting | Waiting by cause | Rate-limit blocked time | API vs tool time |
|---|---|---|---|---|
| Anthropic OTel (data) | `active_time.total`, `type=user` / `cli`, idle excluded | permission only: span `claude_code.tool.blocked_on_user` vs `tool.execution`; `interaction.duration_ms` per turn | none; `api_error` has `attempt`, `status_code` | `api_request.duration_ms`, `tool_result.duration_ms` |
| Claude Code statusline | `total_duration_ms` vs `total_api_duration_ms` | — | `resets_at` only | API only |
| Beezi | working, planning, waiting for you, idle, break | plan approval, question, tool approval, next instruction | "Blocked time 3h 12m" (UNVERIFIED method) | "running vs waiting, retries" |
| ccboard | live status Running / WaitingInput / Stopped, no durations | — | — | — |
| Grafana 25255, Dynatrace, Coralogix | active time (25255: cli vs user) | — | — | API latency p50 / p95 |
| agents-observe, Hindsight, Datadog, ccusage, Usage Monitor | status or events only | — | — | — |

Beezi is the only tool that splits waiting by cause, and its method is undocumented.

## Patterns to copy (display-only, offline)

1. Thresholds with two audiences: budget owner 75 / 90 %, user 75 / 95 % (Anthropic, GitHub,
   LiteLLM 85 / 95), in-app + existing mailer, once per threshold per period.
2. Scopes user / team / repo × period; calendar (1st of month, Monday) and rolling; "current period"
   next to "total".
3. Bar "$X of $Y · N % · resets <date>" with 60 / 80 or 70 / 90 colours.
4. Month-end forecast with an early "overspend risk" flag, linear run rate first; "days until
   exhausted" (no one shows it explicitly).
5. 5 h block view: tokens/min, projected block total, ⌛ gaps, `max` = highest past block; P90 of the
   last 8 days as a personal limit when the plan limit is unknown.
6. Capture statusline `rate_limits` / `spend_limit` through the hook for the real quota.
7. Actual billing vs API-equivalent (Beezi); actual vs list price (Anthropic).
8. Anomalies: day ≥ 2× average, session z-score 2σ / 3σ, "high spend, low output".
9. Slices only transcripts give: skill, subagent, MCP server, repo, branch, effort.
10. Waiting by cause from transcripts (`ExitPlanMode`, `AskUserQuestion`, permission prompt cross-checked
    with OTel `blocked_on_user`, next prompt); API vs tool time from OTel `duration_ms`; rate-limit time
    from `api_error` / usage-limit messages.
11. Scriptable near-limit status (endpoint or CLI exit codes).

## Not applicable (enforcement)

Anthropic org / member limits, `--max-budget-usd`, gateway caps; LiteLLM `max_budget`; Helicone 429;
Portkey key expiry; Cursor and Copilot hard limits; session killers such as budgetclaw.

## Sources

- ccusage: [blocks](https://ccusage.com/guide/blocks-reports), [statusline](https://ccusage.com/guide/statusline)
- [Claude Code Usage Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor), [ccboard](https://github.com/FlorianBruniaux/ccboard)
- Anthropic: [blog](https://claude.com/blog/giving-admins-more-visibility-and-control-over-claude-usage-and-spend), [costs](https://code.claude.com/docs/en/costs), [statusline](https://code.claude.com/docs/en/statusline), [monitoring](https://code.claude.com/docs/en/monitoring-usage), [analytics](https://support.claude.com/en/articles/12883420-view-usage-analytics-for-team-and-enterprise-plans)
- [Datadog Agent Console](https://docs.datadoghq.com/ai_agents_console/), [Datadog Anthropic costs](https://www.datadoghq.com/blog/anthropic-usage-and-costs/)
- [Grafana integration](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-claude-code/), [dashboard 25255](https://grafana.com/grafana/dashboards/25255)
- [Dynatrace](https://docs.dynatrace.com/docs/observe/dynatrace-for-ai-observability/integrations/claude-platform), [New Relic PR](https://newrelic.com/press-release/20260608), [Beezi](https://beezi.ai/), [Beezi plugin](https://docs.beezi.ai/coding-tool/beezi-claude-plugin/), [Jellyfish](https://jellyfish.co/platform/jellyfish-ai-impact/ai-token-usage-monitoring/)
- LiteLLM: [users](https://docs.litellm.ai/docs/proxy/users), [alerting](https://docs.litellm.ai/docs/proxy/alerting); Helicone: [alerts](https://docs.helicone.ai/features/alerts), [limits](https://docs.helicone.ai/features/advanced-usage/custom-rate-limits); [Portkey](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits); [Langfuse](https://langfuse.com/docs/metrics/features/alerts)
- Cursor: [admin API](https://cursor.com/docs/account/teams/admin-api), [spend alerts](https://cursor.com/docs/account/billing/spend-alerts); [GitHub budgets](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
