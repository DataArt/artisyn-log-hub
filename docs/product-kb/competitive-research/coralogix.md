---
type: "Research"
title: "Coralogix Code Agents — feature parity with Log Hub"
description: "Coralogix SaaS observability module ingesting Claude Code native OTel (plus Cursor/Codex/Copilot) for org-level cost, usage, code-impact and repo dashboards; ahead on multi-agent and PR/commit/repo ROI, behind on session content, harness and context analysis."
tags:
  - competitive-research
  - apm-vendor
timestamp: "2026-11-01T00:00:00+04:00"
---

# Coralogix Code Agents (Claude Code integration)

- **What it is:** A module of the Coralogix observability SaaS ("AI Center > Code Agents") that ingests Claude Code's built-in OpenTelemetry metrics/logs and shows per-agent dashboards (Insights, Activity, Tokens, Users, Enterprise Plan Cost, Code Impact, Git Repositories), plus a cross-agent Overview.
- **Vendor / author:** Coralogix (commercial APM / observability vendor).
- **Links:** [Code Agents docs](https://coralogix.com/docs/user-guides/ai/code-agents/), [Claude Code integration](https://coralogix.com/docs/integrations/ai-observability/claude-code/), [coralogix.com](https://coralogix.com)
- **License / pricing:** Proprietary SaaS; pricing for this module not documented on the pages reviewed (Coralogix platform is usage-based).
- **Maturity:** Generally available vendor product; documents Claude Code 2.1.38+ server-managed settings. Some features (data scopes for Claude Code) marked "forthcoming".
- **Data source:** Claude Code native OTel (metrics + log events) over OTLP http/protobuf; optional PostToolUse hook for Git repository attribution.
- **Deployment:** SaaS only.

## Feature parity

| ID | Capability | Coralogix | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Native OTel metrics/logs + optional repo-tracking hook | Hook + full transcript + native OTel | LH ahead |
| C2 | Full content capture | No transcripts; logs may include tool inputs, shell commands, file paths, MCP/Skill params; prompt text not documented | Yes, by design | LH ahead |
| C3 | Sub-agents / multi-agent tree | Not documented | Yes | LH ahead |
| C4 | Real-time / live view | Near-real-time via OTel streaming into dashboards/Logs | Partial (OTel realtime tab) | Parity |
| C5 | Native OTel ingestion | Yes (core data path) | Yes | Parity |
| A1 | Turn-by-turn session log viewer | No (raw log events only) | Yes | LH ahead |
| A2 | Tokens & cost incl. cache | Tokens by model/type, client-estimated cost, Enterprise Plan cost | Own pricing + price sync, tiers | Parity |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | Tool results/decisions log events, MCP tool names with detail logging; no dedicated tools view documented | Yes (Tools/MCP tab) | LH ahead |
| A6 | Knowledge-base usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Lines added/removed, code-edit decisions, per-repo attribution | Yes (files/lines) | Parity |
| A8 | Recommendations / cost advisor | "Insights"/Key insights tab (summary stats); no advisor documented | Yes | LH ahead |
| A9 | Dashboards / trends | Yes, plus importable custom dashboard, Metrics Explorer | Yes | Parity |
| A10 | Productivity / ROI metrics | Commits, PRs, active time, unique users, power users, managed vs unmanaged repos | Limited | Competitor ahead |
| A11 | Alerts / budgets / quotas | "Create alert" button in the Code Agents header (platform alerting on these metrics); Cursor budget view | No | Competitor ahead |
| T1 | Multi-user / team views + access control | Users table, app/subsystem per team, RBAC permissions; data scopes forthcoming for Claude | Yes | Parity |
| T2 | Authentication options | Coralogix platform SSO/accounts | none/password/email/Azure OAuth | n/a |
| T3 | Self-hosted / air-gapped | No (SaaS) | Yes | LH ahead |
| T4 | Data retention controls | Platform retention (paid tiers) | Yes | Parity |
| T5 | Export / import sessions | CSV export of some lists; no session import | Yes | LH ahead |
| T6 | Install effort | Env vars via admin console / MDM / settings.json; org-wide rollout | Docker + `npx` per project | Competitor ahead |
| T7 | Other agents | Cursor, Codex CLI, GitHub Copilot, Claude Cowork, claude.ai | None | Competitor ahead |
| T8 | License / pricing | Commercial SaaS | Free, MIT | LH ahead |
| T9 | Query / API access | Full Coralogix query (DataPrime/PromQL), Metrics Explorer, APIs | REST API | Competitor ahead |

## Where it is ahead of Log Hub

- Cross-agent coverage (Cursor, Codex, Copilot, Cowork, claude.ai) with an Overview comparing Activity/Cost/Impact.
- ROI metrics from OTel: commits, pull requests, active time, code-edit accept/reject decisions, power users.
- Git repository attribution with Managed vs Unmanaged repos (by configured Organizations) — a shadow-AI / governance view.
- Org-wide zero-touch rollout via Claude.ai admin console server-managed settings or MDM `managed-settings.json`.
- Platform alerting and a full query language over the telemetry.

## Where Log Hub is ahead

- Full transcripts and turn-by-turn viewer; Coralogix only sees OTel events.
- Context anatomy, harness usage, KB usage, sub-agent tree, cost advisor — none exist there.
- Self-hosted, offline, free/MIT; no data leaves the network.
- Session export/import.

## Ideas worth borrowing

- Ingest and display OTel `commit_count`, `pull_request_count`, `code_edit_tool.decision` and `active_time` as ROI metrics per user/team (closes A10).
- Managed vs unmanaged repository view: flag sessions in repos outside configured organizations.
- Document an org-wide rollout path via Claude server-managed settings / MDM `managed-settings.json` for the OTel part.
- Budget / burn-rate alerts per user or team on cost metrics (closes A11).
- "Power users" / top-users insights card on the team dashboard.
- Key Insights strip at the top of the overview: Total Sessions, Unique Users, Top Model, Models Used (chips with "+N"), Power Users — one-line answer before the charts.
- Users table with model chips ("claude-sonnet-5 +17") and sortable cost/sessions/tokens columns.
- "Top Users on Unmanaged Repositories" table with a "% of user's tokens" column and Export to CSV — a governance drill-down Log Hub could mirror for repos outside configured orgs.

## What the UI shows (screenshots)

- [overview-activity](https://coralogix.com/docs/assets/images/overview-activity-05491075222ace751158d56a5d610f98.webp) — Overview > Activity: left nav lists Claude, Codex, Cursor, GitHub Copilot (ChatGPT "coming soon"); header has time range, "Create alert" and "Olly AI" assistant; Key Insights strip (Total Sessions, Unique Users, Top Model, Models Used, Power Users) and Sessions Over Time per agent.
- [overview-usage-models](https://coralogix.com/docs/assets/images/overview-usage-models-c4186167401313139dc65839575190fd.webp) — Usage by Agent pie with value/percent legend, and Top Models horizontal bar chart (Claude and GPT models mixed).
- [overview-users](https://coralogix.com/docs/assets/images/overview-users-d44c927d708187cfb5206b85ec3397a6.webp) — Users table: user email, primary agent, Claude cost, sessions (sortable), tokens, model chips with "+N" overflow. No per-session drill-down visible.
- [overview-cost](https://coralogix.com/docs/assets/images/overview-cost-3df3e3aeba1df73ceda33132a0b37331.webp) — Cost tab: Total Cost tile, Cost Over Time per agent (Claude, Copilot); Tokens section with input/output token tiles and Tokens Over Time. No cache-token split visible.
- [overview-tokens](https://coralogix.com/docs/assets/images/overview-tokens-34dd6afccf7846f1374038824c36636f.webp) — Tokens by Model and Top Users by Tokens (per alt text; image not reviewed).
- [overview-impact-repos](https://coralogix.com/docs/assets/images/overview-impact-repos-2f1a3c0f191270f7a76ed77feec5cba5.webp) — Impact > Git Repos: Repository Token Distribution bars coloured managed/unmanaged, Managed vs Unmanaged pie, "Configure repo settings" link, filter chip Application=claude-code.
- [overview-unmanaged-users](https://coralogix.com/docs/assets/images/overview-unmanaged-users-604e2f5bb9fd47de8df78668076fcda7.webp) — Top Users on Unmanaged Repositories: sessions, tokens, repo chips, models, "% of user's tokens", Export to CSV.
- Not shown by the README text: the alert button and the "Olly AI" assistant in the header, the "% of user's tokens" governance column. Nothing visible contradicts C2/A1/A3: the UI is aggregate charts and tables only, no transcript or session viewer.

## Sources

- [Coralogix — Code Agents Intelligence](https://coralogix.com/docs/user-guides/ai/code-agents/)
- [Coralogix — Claude Code integration](https://coralogix.com/docs/integrations/ai-observability/claude-code/)
- [Coralogix docs screenshot — overview-activity](https://coralogix.com/docs/assets/images/overview-activity-05491075222ace751158d56a5d610f98.webp)
- [Coralogix docs screenshot — overview-usage-models](https://coralogix.com/docs/assets/images/overview-usage-models-c4186167401313139dc65839575190fd.webp)
- [Coralogix docs screenshot — overview-users](https://coralogix.com/docs/assets/images/overview-users-d44c927d708187cfb5206b85ec3397a6.webp)
- [Coralogix docs screenshot — overview-cost](https://coralogix.com/docs/assets/images/overview-cost-3df3e3aeba1df73ceda33132a0b37331.webp)
- [Coralogix docs screenshot — overview-tokens](https://coralogix.com/docs/assets/images/overview-tokens-34dd6afccf7846f1374038824c36636f.webp)
- [Coralogix docs screenshot — overview-impact-repos](https://coralogix.com/docs/assets/images/overview-impact-repos-2f1a3c0f191270f7a76ed77feec5cba5.webp)
- [Coralogix docs screenshot — overview-unmanaged-users](https://coralogix.com/docs/assets/images/overview-unmanaged-users-604e2f5bb9fd47de8df78668076fcda7.webp)
