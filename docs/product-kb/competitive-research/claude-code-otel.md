---
type: "Research"
title: "claude-code-otel — feature parity with Log Hub"
description: "Docker Compose OTel Collector + Prometheus + Loki + Grafana stack for Claude Code's native telemetry; strong on aggregate metrics and productivity counters, has no transcripts, sub-agent tree or harness analysis"
tags:
  - competitive-research
  - otel-dashboard
timestamp: "2026-11-01T00:00:00+04:00"
---

# claude-code-otel

- **What it is:** A ready-made Docker Compose observability stack (OTel Collector, Prometheus, Loki, Grafana)
  plus a prebuilt Grafana dashboard. Claude Code's built-in OpenTelemetry export
  (`CLAUDE_CODE_ENABLE_TELEMETRY=1`) feeds it.
- **Vendor / author:** Cole Murray (community, individual).
- **Links:** [GitHub repo](https://github.com/ColeMurray/claude-code-otel); background in the [Claude Code monitoring docs](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage)
- **License / pricing:** MIT, free.
- **Maturity:** About 520 stars and 86 forks; only 4 commits. The last commit date is not shown on the repo page (as of 2026-11-01). It is a small template, not an actively developed product.
- **Data source:** Claude Code native OTel only (metrics + log events; no hook, no transcripts).
- **Deployment:** Self-hosted (`make up`, Docker Compose), local or on a server.

**Variants.** Similar community stacks follow the same pattern: native OTel into a time-series and log
store, then Grafana. Examples are li0nel/claude-otel and the community Grafana dashboards 24993, 25052, 25255
and 25340 on grafana.com. Their parity profile is roughly the same as below. They differ only in which
panels they ship and the backend (Prometheus/Loki, or Grafana Cloud). These were not individually verified.

## Feature parity

| ID | Capability | claude-code-otel | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Native OTel metrics + log events only | Hook + full transcripts + native OTel | LH ahead |
| C2 | Full content capture | No; prompt text only if `OTEL_LOG_USER_PROMPTS=1`, no assistant text / tool I/O | Yes | LH ahead |
| C3 | Sub-agents / multi-agent tree | No | Yes | LH ahead |
| C4 | Real-time / live view | Yes, dashboard ships with 5 s auto-refresh and "Last 1 hour" stat tiles with sparklines | Partial | Competitor ahead |
| C5 | Native OTel ingestion | Yes (the whole product) | Yes | Parity |
| A1 | Turn-by-turn session log viewer | No; only a raw Loki "Tool Execution Events" log panel (timestamp, tool name, success tick, duration) | Yes | LH ahead |
| A2 | Tokens & cost incl. cache | Yes, by model and token type (cost as reported by Claude Code) | Yes, own pricing + tiers, per turn | LH ahead |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | Tool frequency, success rate, duration, accept/reject decisions | Yes, plus permission attribution, MCP detail | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Lines-of-code counter only | Files/lines per session | LH ahead |
| A8 | Recommendations / cost advisor | No | Yes | LH ahead |
| A9 | Dashboards / trends | Yes (Grafana, arbitrary PromQL/LogQL) | Yes | Parity |
| A10 | Productivity / ROI metrics | Yes: commits, PRs, LOC, edit accept rate, DAU/WAU/MAU | Limited | Competitor ahead |
| A11 | Alerts / budgets / burn rate | None shipped, but Grafana/Prometheus alerting is available for users to set up | No | Competitor ahead |
| T1 | Multi-user / team views + ACL | Per-user breakdown via account labels; no teams or row-level ACL | Yes | LH ahead |
| T2 | Authentication | Grafana auth (default admin/admin); OTLP header auth | 4 modes incl. Azure OAuth | LH ahead |
| T3 | Self-hosted / offline | Yes (all local containers) | Yes | Parity |
| T4 | Data retention controls | Prometheus/Loki retention config | Yes | Parity |
| T5 | Export / import sessions | No session concept to export | Yes | LH ahead |
| T6 | Install effort | `make up` + env vars per user | Docker one-liner + `npx` per project | Parity |
| T7 | Other agents | Any OTel-emitting agent could be wired in, but nothing is prebuilt | None | Parity |
| T8 | License / pricing | MIT, free | MIT, free | Parity |
| T9 | Query / API access | PromQL / LogQL / Grafana API | REST API with keys | Competitor ahead |

## Where it is ahead of Log Hub

- Productivity counters from native metrics: `commit.count`, `pull_request.count`, `lines_of_code.count`,
  `code_edit_tool.decision` (edit accept/reject rate), plus DAU/WAU/MAU adoption panels.
- Alerting is available through the standard Grafana/Prometheus stack (cost thresholds, error rate),
  although the repo ships no alert rules.
- Users can write their own queries in PromQL/LogQL and build their own panels without changing any code.
- Panels for API latency by model and API error rate.
- Near-real-time metric refresh.

## Where Log Hub is ahead

- It captures full transcripts and content: prompts, assistant text, tool inputs and outputs, attachments.
- Sub-agent and workflow trees, with root vs tree metrics.
- It explains why a session cost what it did: context anatomy, harness usage, KB usage, the cost advisor.
- It has session-level UX (turn viewer, change surface, export/import), where the OTel stack has only aggregates.
- Real team model: teams, transparent/restricted modes, owner-only raw logs, multiple auth modes.
- Its own pricing table with 1M-context tiers, instead of relying only on the client-reported cost.

## Ideas worth borrowing

1. A productivity panel built from the OTel metrics Log Hub already ingests: commits, PRs, LOC,
   edit accept/reject rate, DAU/WAU/MAU.
2. Simple alerts and budgets: daily/monthly cost thresholds per user/team, with notifications.
3. API latency and API error-rate charts by model in the analytics timeline.
4. A Prometheus `/metrics` endpoint (or a Grafana datasource / dashboard JSON) so teams with an existing
   Grafana can see Log Hub data next to their other dashboards.
5. (From dashboard 25255) a "Top sessions by cost" bar leaderboard, a cache-hit-ratio gauge, and cost split
   by query source (main / subagent / auxiliary) and by reasoning effort as donut charts.

## What the UI shows (screenshots)

- [Cost & usage dashboard](https://raw.githubusercontent.com/ColeMurray/claude-code-otel/HEAD/docs/images/cost-usage-analytics.png): Grafana dark theme, 5 s refresh, "Last 1 hour" range. Four stat tiles with sparklines: Active Sessions (shows "No data"), Cost, Token Usage, Lines of Code. Below are "Cost by Model (Hourly)" (USD per model with max/mean legend) and "Token Usage Rate by Type" (log scale: cacheCreation, cacheRead, input, output).
- [User activity dashboard](https://raw.githubusercontent.com/ColeMurray/claude-code-otel/HEAD/docs/images/user-activity.png): "Code Changes Rate" (added/removed lines per minute) and "Development Activity (Hourly)" (commits, PRs, both 0 here). The "Event Logs" row has a Loki "Tool Execution Events" list (tool name, success tick, ms duration, including MCP tools) and an empty "API Error Events" panel. The README does not mention the per-call tool log. There is no per-session drill-down.
- [Grafana dashboard 25255, overview](https://grafana.com/api/dashboards/25255/images/21084/image) (variant): stat tiles for Sessions, Users, Total Cost, Tokens, Commits, PRs, Lines added/removed. Active Time is split into cli and user. Also tokens by type, a Tool Decisions accept count and a cache-hit-ratio gauge (98.9 %). Leaderboards: Top Users by Cost/Tokens and **Top Sessions by Cost** (by session UUID). Donuts: Cost by Model, Edit Decisions by Language, Sessions by Terminal.
- [Grafana dashboard 25255, cost & tokens](https://grafana.com/api/dashboards/25255/images/21085/image) (variant): cost $/hour over several days, cost and tokens by model and by type. Donuts for **Cost by query_source** (main 72 % / subagent 25 % / auxiliary 3 %) and **Cost by effort** (xhigh/high). So native OTel can roughly separate sub-agent spend, but it cannot show a tree.
- Variants 24993, 25052, 25340: there is no screenshot in their grafana.com API image listings (24993's image entry returned JSON, not an image). Their panel descriptions list similar content: cost rate, sessions by terminal, language breakdown, cli/user active time, API errors table, MCP server connection outcomes (25052/25340), and daily commits / LOC added vs removed.

## Sources

- [ColeMurray/claude-code-otel README](https://github.com/ColeMurray/claude-code-otel)
- Screenshots: [cost-usage-analytics.png](https://raw.githubusercontent.com/ColeMurray/claude-code-otel/HEAD/docs/images/cost-usage-analytics.png), [user-activity.png](https://raw.githubusercontent.com/ColeMurray/claude-code-otel/HEAD/docs/images/user-activity.png), [Grafana 25255 image 21084](https://grafana.com/api/dashboards/25255/images/21084/image), [Grafana 25255 image 21085](https://grafana.com/api/dashboards/25255/images/21085/image); dashboard pages [24993](https://grafana.com/grafana/dashboards/24993), [25052](https://grafana.com/grafana/dashboards/25052), [25255](https://grafana.com/grafana/dashboards/25255), [25340](https://grafana.com/grafana/dashboards/25340)
- [Claude Code monitoring (OTel) docs](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage)
