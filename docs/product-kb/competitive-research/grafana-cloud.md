---
type: "Research"
title: "Grafana Cloud Claude Code integration — feature parity with Log Hub"
description: "Official Grafana Cloud integration that sends Claude Code's native OTLP metrics and logs to Grafana Cloud with four prebuilt dashboards; strong on aggregate dashboards and alerting, with no transcripts and no harness or context analysis."
tags:
  - competitive-research
  - otel-dashboard
timestamp: "2026-11-01T00:00:00+04:00"
---

# Grafana Cloud — Claude Code integration

- **What it is:** An integration in the Grafana Cloud catalog. Claude Code's built-in OpenTelemetry exporter is pointed at the Grafana Cloud OTLP endpoint, and the integration installs four prebuilt dashboards: "Claude Code", "Claude Code stats", "Claude Code usage breakdown" and "Claude Code productivity".
- **Vendor / author:** Grafana Labs.
- **Links:** [Integration reference](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-claude-code/), [Grafana MCP for Claude Code (a separate product)](https://grafana.com/docs/grafana-cloud/machine-learning/mcp/clients/claude-code/)
- **License / pricing:** Commercial SaaS (Grafana Cloud). The integration page does not document pricing; costs follow the standard Grafana Cloud usage tiers for metrics and logs. Pricing details were not verified.
- **Maturity:** Vendor-supported. Version 1.0.0 was released in March 2026; version 1.0.1 followed in October 2026 (docs fixes and the Windows managed-settings path).
- **Data source:** Claude Code's native OTel only (metrics and logs/events over OTLP). No hook and no transcript upload.
- **Deployment:** SaaS (Grafana Cloud). You can set it up per developer in `~/.claude/settings.json` or the shell, or roll it out organization-wide through managed settings.

## Feature parity

| ID | Capability | Grafana Cloud | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Native OTel metrics and logs only | Hook, full transcripts and native OTel | LH ahead |
| C2 | Full content capture | Not documented. Only what Claude Code's OTel events carry; prompts are redacted unless the user opts in | Yes, by design | LH ahead |
| C3 | Sub-agents / workflows tree | Not documented | Yes | LH ahead |
| C4 | Real-time / live view | Yes: near-real-time metrics on live dashboards | Partial | Competitor ahead |
| C5 | Native OTel ingestion | Yes (core mechanism) | Yes | Parity |
| A1 | Turn-by-turn session log viewer | No. Raw OTel events can be explored in Loki, but there is no session viewer | Yes | LH ahead |
| A2 | Tokens and cost per session/turn incl. cache | Token and cost metrics from Claude Code's OTel (aggregate; cost as Claude Code computes it) | Yes, with its own pricing and tiers | LH ahead |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | A "Tools" section: tool acceptance rate, average execution time per tool, top tools used, accept/reject decisions (donut and over time), tool uses per team member. Aggregate only, no per-call drill-down | Yes | LH ahead |
| A6 | Knowledge-base usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Lines-of-code metric only (aggregate) | Yes | LH ahead |
| A8 | Recommendations / cost advisor | No | Yes | LH ahead |
| A9 | Dashboards / trends | Four prebuilt dashboards plus Grafana's ad-hoc querying and dashboard editing | Yes | Parity |
| A10 | Productivity / ROI metrics | A "Productivity" section with stat tiles for lines of code, commits, pull requests and active time, plus "Lines added vs removed" and "Session outcome" panels | Limited | Competitor ahead |
| A11 | Alerts / budgets / burn-rate | Grafana Alerting on any metric (generic, not prebuilt for Claude Code) | No | Competitor ahead |
| T1 | Multi-user / team views + access control | Grafana org, team and folder permissions; per-user attributes in the metrics | Yes | Parity |
| T2 | Authentication options | Grafana Cloud SSO (SAML, OAuth and others, depending on plan) | none, password, email confirm, Azure OAuth | Parity |
| T3 | Self-hosted / air-gapped | No for this integration (Cloud). Self-hosted Grafana with an OTel stack would need manual work | Yes | LH ahead |
| T4 | Data retention controls | Plan-defined retention for metrics and logs | Yes | Parity |
| T5 | Export / import sessions | No session concept; data exportable via the query APIs | Yes | LH ahead |
| T6 | Install effort | Environment variables plus a token, then click Install. No server to run | Docker server plus `npx` per project | Competitor ahead |
| T7 | Agents besides Claude Code | Grafana catalogs other integrations separately; this one covers Claude Code only | Claude Code only | Parity |
| T8 | License / pricing | Commercial SaaS (free tier exists) | Free, MIT | LH ahead |
| T9 | Query / API access | PromQL, LogQL, HTTP APIs and the Grafana MCP server | REST API with API keys | Competitor ahead |

## Where it is ahead of Log Hub

- Generic alerting on any metric (cost spikes, token burn, error rates), with notification routing.
- A productivity dashboard built on Claude Code's OTel productivity metrics (commits, PRs, lines of code, edit-accept decisions).
- Zero infrastructure: no server to run, and an org-wide rollout through managed settings only.
- A mature query layer (PromQL/LogQL), ad-hoc dashboard building, and querying via the MCP server.
- Live time-series view of usage across the whole organization.

## Where Log Hub is ahead

- Full transcripts and a turn-by-turn viewer; Grafana Cloud sees only the aggregate metrics and events that OTel exposes.
- The sub-agent/workflow tree, context-window anatomy, harness analysis, KB usage and the cost advisor have no equivalent.
- Its own pricing table with 1M-context tiers, versus the cost Claude Code self-reports.
- Fully offline and self-hosted, with free, MIT-licensed software.
- Per-session Change Surface, versus an aggregate lines-of-code counter.

## Ideas worth borrowing

1. Budget and burn-rate alerts on the OTel cost and token metrics Log Hub already ingests, per user/team/repo, with email or webhook notification (closes A11).
2. A productivity row of stat tiles (lines of code, commits, PRs, active time) built from Claude Code's OTel metrics (`commit.count`, `pull_request.count`, `lines_of_code.count`, `code_edit_tool.decision`) (closes A10).
3. A documented org-wide rollout via Claude Code managed settings (OTel env vars plus hook), to reduce per-project install effort.
4. An environment breakdown row (OS, host architecture, terminal type, Claude Code version donuts) and API latency p50/p95, both from OTel resource attributes Log Hub already receives.
5. A sticky filter bar (organization, team member, model) over the whole dashboard, with the same filters applied to every panel.
6. A PromQL-compatible or Grafana data-source endpoint, so teams already on Grafana can chart Log Hub data next to other metrics.

## What the UI shows (screenshots)

- [Overview](https://storage.googleapis.com/grafanalabs-integration-assets/claude-code/claude-code-1.png): filter bar (Job, Organization, Team Member, Model) and 5m auto-refresh; stat tiles for total cost, total tokens, sessions and active users; "Cost usage" stacked bars per minute split by model; "API calls by model" and a "Cost by model" donut with $ and %.
- [Latency, environment, productivity](https://storage.googleapis.com/grafanalabs-integration-assets/claude-code/claude-code-2.png): "API request latency" with p50/p95; "Cost by team member" donut (per-user email); OS type, host architecture, terminal type and Claude Code version donuts (not mentioned in the docs text); Productivity tiles for lines of code, commits, pull requests, active time; "Lines added vs removed" and "Session outcome" panels.
- [Tools](https://storage.googleapis.com/grafanalabs-integration-assets/claude-code/claude-code-3.png): tool acceptance rate, average execution time per tool (Agent, Glob, Bash...), top tools used, tool decisions donut and over time, "Tools used by members" table.
- No screen shows a session list, a per-session view or a transcript; everything is an aggregate over the time range.

## Sources

- [Grafana Cloud: Claude Code integration reference](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-claude-code/)
- [Grafana Cloud: Claude Code integration (markdown)](https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-claude-code.md)
- [Grafana Cloud: integration reference (observe-and-act path)](https://grafana.com/docs/grafana-cloud/observe-and-act/monitor-infrastructure/integrations/integration-reference/integration-claude-code/)
- Dashboard screenshots: [1](https://storage.googleapis.com/grafanalabs-integration-assets/claude-code/claude-code-1.png), [2](https://storage.googleapis.com/grafanalabs-integration-assets/claude-code/claude-code-2.png), [3](https://storage.googleapis.com/grafanalabs-integration-assets/claude-code/claude-code-3.png)
- [Grafana MCP: Claude Code client](https://grafana.com/docs/grafana-cloud/machine-learning/mcp/clients/claude-code/)
