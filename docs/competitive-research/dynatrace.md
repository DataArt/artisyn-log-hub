---
type: "Research"
title: "Dynatrace Claude Code Agent Monitoring — feature parity with Log Hub"
description: "Dynatrace Hub integration that ingests Claude Code's native OTel into Dynatrace AI Observability; strong on alerting, multi-agent coverage and engineering-output metrics, weak on transcripts, harness and context analysis."
tags:
  - competitive-research
  - apm-vendor
timestamp: "2026-11-01T00:00:00+04:00"
---

# Dynatrace Claude Code Agent Monitoring

- **What it is:** A Dynatrace Hub integration that takes Claude Code's built-in OpenTelemetry metrics and events over OTLP. The data goes through GenAI enrichment in OpenPipeline or a Collector and then shows up in the Dynatrace AI Observability app, with an optional example dashboard. It is part of a wider "AI coding agent monitoring" offering.
- **Vendor / author:** Dynatrace (commercial APM vendor). The example configs and dashboards are in `dynatrace-oss`.
- **Links:** [Hub listing](https://www.dynatrace.com/hub/detail/claude-code-agent-monitoring), [Blog](https://www.dynatrace.com/news/blog/dynatrace-expands-ai-coding-agent-monitoring/), [Examples repo](https://github.com/dynatrace-oss/dynatrace-ai-agent-instrumentation-examples), [OTel docs](https://docs.dynatrace.com/docs/get-started/opentelemetry)
- **License / pricing:** Commercial Dynatrace platform. The Hub page links only to a "Free trial", and no price for the integration is documented. The examples repo license was not checked.
- **Maturity:** Vendor-supported. The blog post was published 2026-04-30 and updated 2026-05-19. GitHub stars for the examples repo were not checked.
- **Data source:** Claude Code native OTel only: metrics plus the events `api_request`, `api_error`, `tool_decision`, `tool_result` and `user_prompt`.
- **Deployment:** SaaS (a Dynatrace environment with OTLP ingest; the related Claude Platform page requires Grail). Data is sent directly or through an OTel Collector.

## Feature parity

| ID | Capability | Dynatrace | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Native OTel only (metrics + events) | Hook + full transcript + native OTel | LH ahead |
| C2 | Full content capture | Only what OTel events carry (prompt text if opted in, tool events); no assistant text or full transcript | Yes, by design | LH ahead |
| C3 | Sub-agents / multi-agent tree | Not for Claude Code; the AI Observability "Agents topology" (Preview) graph covers instrumented GenAI app agents (agent → model → provider → service), not Claude Code sub-agents | Sub-agent tree, workflow rows | LH ahead |
| C4 | Real-time / live view | Yes, live OTel streams and a recent-events stream | Partial (OTel realtime tab) | Competitor ahead |
| C5 | Native OTel ingestion | Yes (core of the product) | Yes | Parity |
| A1 | Turn-by-turn session log viewer | Flat "Live Event Feed" table (timestamp, event_name, tool_name, prompt, model, cost, duration); prompt is null unless `OTEL_LOG_USER_PROMPTS=1`; no per-session transcript | Rich renderers | LH ahead |
| A2 | Tokens & cost incl. cache | Total cost/tokens tiles, cost and tokens over time, avg cost per session, avg tokens per request, cost by user, cost by speed mode (from OTel `cost.usage`); no cache split visible | Own pricing, tiers, per turn | LH ahead |
| A3 | Context-window anatomy | Not documented | Yes | LH ahead |
| A4 | Harness config analysis | Not documented | Yes | LH ahead |
| A5 | Tool / MCP monitoring | Top tools, tool duration, success rate, allow/deny decisions | Outcomes, errors, permission attribution | Parity |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Lines added/removed totals (OTel), no per-file view | Change Surface per file | LH ahead |
| A8 | Recommendations / cost advisor | Not documented (general Dynatrace AI is not shown applied here) | Turn-end cost advisor | LH ahead |
| A9 | Dashboards / trends | Ready-made dashboard plus the full Dynatrace dashboard/notebook stack | Timeline, exec report, export | Parity |
| A10 | Productivity / ROI metrics | Commits, PRs, lines added/removed, active time, sessions per user | Limited | Competitor ahead |
| A11 | Alerts / budgets | Alerts on failures, latency, cost regressions, unusual token use | No | Competitor ahead |
| T1 | Multi-user / team views + access | Dynatrace IAM / platform permissions; "Sessions by user" / "Cost by user" bars (users shown as hashed IDs), no team grouping visible | Teams, modes, admin | Parity |
| T2 | Authentication options | Dynatrace platform SSO/IAM | none/password/email/Azure | Parity |
| T3 | Self-hosted / offline | SaaS; needs network access to the Dynatrace endpoint | Fully offline | LH ahead |
| T4 | Data retention controls | Grail retention settings (platform-level) | Yes | Parity |
| T5 | Export / import sessions | Generic data export; no session import | Yes | LH ahead |
| T6 | Install effort | Env vars plus OpenPipeline/Collector enrichment config; requires a Dynatrace tenant | Docker + `npx` | Parity |
| T7 | Other agents | Gemini CLI, Codex CLI, OpenCode, GitHub Copilot SDK | None | Competitor ahead |
| T8 | License / pricing | Commercial, paid platform (trial) | Free MIT | LH ahead |
| T9 | Query / API access | DQL, platform APIs, Dynatrace MCP server from the IDE | REST + API keys | Competitor ahead |

## Where it is ahead of Log Hub

- Alerting on cost regressions, unusual token use, failures and latency, which supports FinOps budgets.
- Engineering-output KPIs: commits, PRs, lines added/removed and active time per user.
- One pane for several coding agents (Claude Code, Gemini CLI, Codex CLI, OpenCode, Copilot SDK).
- Ad-hoc querying with DQL, plus an MCP server so developers can query telemetry from the IDE.
- API reliability view: request volume, errors and latency over time, by model.
- Coding-agent data sits next to the rest of the org's APM, logs and traces.

## Where Log Hub is ahead

- Full transcripts and a turn-by-turn viewer with rich renderers. Dynatrace sees only OTel events.
- Sub-agent and workflow trees, context-window anatomy, harness and setup analysis, KB usage, per-file change surface.
- The cost advisor and its "why it costs that much" explanations, compared with aggregate cost charts.
- Free, MIT-licensed, self-hosted and fully offline. Dynatrace needs a paid SaaS tenant.
- Session export and import.

## Ideas worth borrowing

1. Threshold alerts and budgets (cost per user, team or day; unusual token spikes), delivered by email or webhook.
2. Output/ROI tiles built from OTel `commit` / `pull_request` / `lines_of_code` counters plus active time.
3. An API-health panel: api_error rate and latency by model over time, from OTel events.
4. An MCP server over Log Hub data, so developers can query their sessions from Claude Code.
5. A stacked "event volume by type" chart (api_request / api_error / tool_decision / tool_result / user_prompt) as an at-a-glance activity pulse on the timeline.
6. A "trend and forecast" chart with a one-click "New alert" button on the chart itself (seen in the AI Observability Explorer).
7. A KPI strip on top of the dashboard (users, cost, tokens, sessions, active time), then sections "Trends and cost breakdown", "Engineering metrics", "User activity", "Event stream" — a simple, readable single-page layout.

## What the UI shows (screenshots)

- [Claude Code Monitoring dashboard, top](https://news.cdn.dm.dynatrace.com/wp-content/uploads/2026/04/dashboard-claude-code-monitoring-1.png) (the same image is the third Hub screenshot): KPI tiles for Total Users, Cost (USD), Tokens, Sessions and Active Time; Cost over time, Token usage over time, a stacked Event volume by type chart; an "Engineering metrics" section with lines added/removed tiles and a chart, git commits, PRs and PRs over time. The time picker has auto-refresh set to "Off", so it is a time-ranged dashboard, not a live view.
- [Prompt activity / user activity](https://news.cdn.dm.dynatrace.com/wp-content/uploads/2026/04/prompt-activity.png): avg active time per session, avg cost per session, avg tokens per request, Sessions by user and Cost by user bars (users appear as hashed IDs), Cost by speed mode, and a "Live Event Feed" table with the prompt column null (redacted by default).
- [AI Observability Explorer](https://cdn.hub.central.dynatrace.com/hub/console/claude-code-agent-monitoring/media/b106e8e9-e337-430d-b125-2a92080f9d06.png): facets for provider, model, service and agent; failure rate, problems and invocation error count with deltas; error rate over time; HTTP 4xx/5xx types; an "HTTP error trend and forecast" chart with a "New alert" button; "Manage all alerts"; a per-model table with request count, AVG/p50/p90 latency and a sparkline trend. The demo data is generic GenAI apps, not Claude Code.
- [Agents topology (Smartscape)](https://cdn.hub.central.dynatrace.com/hub/console/claude-code-agent-monitoring/media/04057e57-67c0-4530-9cba-01b270140da2.png): a graph of agents, LLM models, providers and AI services (uses / calls / is_part_of / belongs_to), with a node card showing LLM requests, token usage and response time sparklines plus "View Prompts". The data is generic GenAI agents, not Claude Code sub-agents.
- [Distributed Tracing](https://news.cdn.dm.dynatrace.com/wp-content/uploads/2026/04/copilot-chat-scaled.png): a span waterfall (server → chat / execute_tool spans) with gen_ai.* attributes such as tokens and cost. It is from GitHub Copilot SDK tracing; the Claude Code integration sends metrics and events, not spans.
- Not seen in any screenshot: a per-session transcript, context or harness analysis, or a cache-token breakdown.

## Sources

- [Dynatrace Hub — Claude Code Agent monitoring](https://www.dynatrace.com/hub/detail/claude-code-agent-monitoring)
- [Dynatrace blog — expands AI coding agent monitoring](https://www.dynatrace.com/news/blog/dynatrace-expands-ai-coding-agent-monitoring/)
- [dynatrace-ai-agent-instrumentation-examples (GitHub)](https://github.com/dynatrace-oss/dynatrace-ai-agent-instrumentation-examples)
- [Dynatrace docs — Claude Platform integration](https://docs.dynatrace.com/docs/observe/dynatrace-for-ai-observability/integrations/claude-platform)
- [Dynatrace docs — Using OpenTelemetry](https://docs.dynatrace.com/docs/get-started/opentelemetry)
- Screenshots: [dashboard](https://news.cdn.dm.dynatrace.com/wp-content/uploads/2026/04/dashboard-claude-code-monitoring-1.png), [prompt activity](https://news.cdn.dm.dynatrace.com/wp-content/uploads/2026/04/prompt-activity.png), [tracing](https://news.cdn.dm.dynatrace.com/wp-content/uploads/2026/04/copilot-chat-scaled.png), [Hub Explorer](https://cdn.hub.central.dynatrace.com/hub/console/claude-code-agent-monitoring/media/b106e8e9-e337-430d-b125-2a92080f9d06.png), [Hub Smartscape](https://cdn.hub.central.dynatrace.com/hub/console/claude-code-agent-monitoring/media/04057e57-67c0-4530-9cba-01b270140da2.png), [Hub metrics](https://cdn.hub.central.dynatrace.com/hub/console/claude-code-agent-monitoring/media/d3bbf836-7964-42f7-94ae-1b0077618327.png)
