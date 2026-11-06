---
type: "Research"
title: "Jellyfish AI Impact — feature parity with Log Hub"
description: "Commercial SaaS engineering-intelligence platform that ties Claude Code adoption and spend to delivery outcomes (PRs, cycle time); org-level ROI where Log Hub is per-session deep."
tags:
  - competitive-research
  - eng-analytics
timestamp: "2026-11-01T00:00:00+04:00"
---

# Jellyfish AI Impact

- **What it is:** The AI Impact module of Jellyfish, an engineering-management platform. It tracks Claude Code adoption by engineer and team and links usage and spend to delivery metrics from Jira, Git and CI/CD. A dedicated "Claude Code Dashboard" compares Claude Code with Copilot, Cursor and other tools.
- **Vendor / author:** Jellyfish (jellyfish.co), a commercial vendor.
- **Links:** [Claude Code Dashboard](https://jellyfish.co/platform/claude-code-dashboard/), [Claude Code integration](https://jellyfish.co/?p=30868), [announcement](https://jellyfish.co/blog/ai-impact-claude-code/)
- **License / pricing:** Proprietary. Pricing is not published (sales-led).
- **Maturity:** Established vendor with 4.5/5 ratings on G2 and Gartner (vendor claim). Claude Code support has been announced and is shipped.
- **Data source:** Not documented publicly ("system-derived signals" and "Claude Code telemetry"). It is most likely Anthropic's org analytics or Admin API data joined with Git, Jira and CI. Unconfirmed.
- **Deployment:** SaaS. A self-hosted option is not documented.

## Feature parity

| ID | Capability | Jellyfish AI Impact | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Undisclosed telemetry plus Git/Jira/CI integrations | Hook + transcripts + OTel | n/a |
| C2 | Full content capture | No (aggregate usage only, as far as documented) | Yes | LH ahead |
| C3 | Sub-agents / multi-agent tree | No; only an "agentic vs human-assisted" work comparison | Yes | LH ahead |
| C4 | Real-time view | No; adoption data arrives "within days" | Partial | LH ahead |
| C5 | Native OTel ingestion | Not documented | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | No | Yes | LH ahead |
| A2 | Tokens & cost per session/turn | Spend at org/team level (separate AI Token Cost Management module); no per-turn data | Yes | LH ahead |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | No | Yes | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | PR/throughput level, via Git; UI lists agent-assisted PRs with collaborators, agent:human commit ratio and outcome (merged/open/closed) | Yes, per session | Parity |
| A8 | Recommendations / cost advisor | Highlights high-adoption teams to copy; AI Assistant | Turn-end cost advisor | Parity |
| A9 | Dashboards / trends | Yes: Report Builder, adoption trends, inflection points; UI shows usage-over-time per tool, monthly throughput bars split with/without Claude, a work-type radar | Yes | Parity |
| A10 | Productivity / ROI metrics | Yes: cycle time, throughput, PR velocity, change-failure rate, quality, active days | Limited | Competitor ahead |
| A11 | Alerts / budgets | Not documented | No | n/a |
| T1 | Multi-user / team views | Yes (org, team and engineer views; UI filters by division, job title, manager, location and adoption cohort) | Yes | Parity |
| T2 | Authentication options | Enterprise SaaS (details not documented) | 4 modes incl. Azure OAuth | n/a |
| T3 | Self-hosted / offline | No (SaaS) | Yes | LH ahead |
| T4 | Data retention controls | Not documented | Yes | n/a |
| T5 | Export / import sessions | No session concept | Yes | LH ahead |
| T6 | Install effort | SaaS connectors; no per-project install | Docker + `npx` per project | Competitor ahead |
| T7 | Other agents supported | Copilot, Cursor, Windsurf, Gemini Code Assist, Amazon Q, Devin, CodeRabbit, and more | Claude Code only | Competitor ahead |
| T8 | License / pricing | Proprietary, paid, price not published | Free MIT | LH ahead |
| T9 | Query/API access | Not documented | REST API | n/a |

## Where it is ahead of Log Hub

- Joins AI usage with delivery outcomes: cycle time, throughput, PR velocity, merge time and change-failure rate, with comparisons across adoption levels.
- Benchmarks several vendors in one measurement model (Claude Code against Copilot, Cursor and others).
- Classifies work by type (new features, tech debt, code review) and checks whether gains go to roadmap work, using Jira.
- Compares agent-driven work with human-assisted work across the whole org.
- Needs no install on developer machines; it uses central connectors only.
- Visible "with vs without Claude" cohort comparison on every outcome card (cycle time, throughput), with a delta badge in hours.

## Where Log Hub is ahead

- Everything at session level: transcripts, turn log, context anatomy, harness, tools/MCP and KB usage.
- Explains why a session costs what it does; Jellyfish only reports how much is used.
- Self-hosted, offline-capable, free and open source.
- OTel ingestion and real-time data.

## Ideas worth borrowing

- Link sessions to Git outcomes (commits/PRs produced by a session, merge time) to start closing the A10 gap.
- Adoption analytics: active days per user and team, plus adoption inflection and stall detection on the analytics timeline.
- Classify sessions by work type (feature, bug fix, refactor, review), from prompts or linked issue keys.
- Highlight "high-adopter" teams and users and their harness setups, so others can copy them (ties into compare-setups).

- "With vs without" comparison cards: one big % delta plus two bars (sessions with a feature, e.g. a skill/MCP/KB, vs without) showing cost or duration difference.
- Radar ("AI Utilization Matrix") of work types per tool or per harness setup — a compact visual for compare-setups.
- Agent-assisted PR table: collaborator avatars (human + agent), agent:human commit ratio bar, outcome badge.

## Variants (same category, Claude Code coverage confirmed)

- **DX (getdx):** Claude Code connector via Anthropic's Analytics API, or an OpenTelemetry connector, plus an Enterprise connector ([docs](https://docs.getdx.com/connectors/claude-code)).
- **LinearB:** Claude Code via the Admin API (per-user daily usage, sessions, commits, PRs, accepted/rejected tool actions) or the Enterprise Analytics API. Backfills 90 days, then updates daily; Bedrock is not supported ([docs](https://linearb.helpdocs.io/article/d4c2syukwf-configuring-claude-code-admin-api)).
- **Worklytics:** a blog post describes matching Claude Code activity to merged PRs, but no connector documentation was found, so coverage is unconfirmed.

## What the UI shows (screenshots)

No screenshot shows a session, transcript, token or per-turn view; everything is aggregate at PR/team level, which confirms C2, A1–A6.

- AI Impact tab: tool selector (All Tools, Claude Code, Cursor, GitHub Copilot, Windsurf, Amazon Q); Issue/PR Cycle Time cards "with Claude" vs "without Claude"; Tool Breakdown table with users, adoption and allocation stacked bars. ([image](https://jellyfish.co/wp-content/uploads/2026/03/Feature-claude-code.webp))
- "Maximize Impact" page: left nav Manage Adoption / Enable Users / Maximize Impact; filters Division, Job Title, Manager, Location, Adoption Cohort ("Showing 6,708 PRs from 23 users"); cycle-time cards can show a regression (7% slower reviews, red); Throughput chart of PRs merged per month stacked with/without Claude. Cohort filters and the regression display were not described in the text. ([image](https://jellyfish.co/wp-content/uploads/2025/08/Jellyfish-AI-Impact-dashboard_Claude-Code-1024x640.png))
- PR and Issue Cycle Time cards: % change, with-Claude bar with hour delta, without-Claude bar. ([image](https://jellyfish.co/wp-content/uploads/2026/03/claude-metrics-issue-cycle.webp))
- Usage Over Time: weekly active users per tool (Claude, Copilot, Cursor) as lines with hover tooltip. ([image](https://jellyfish.co/wp-content/uploads/2026/03/claude-usage-over-time.webp))
- AI Utilization Matrix: radar over Writing, Debugging, Code Testing, Code Review, Documentation, Refactoring, one polygon per tool — work-type classification visualised. ([image](https://jellyfish.co/wp-content/uploads/2026/03/claude-Utilization-matrix.webp))
- Agent reporting: tiles (agent-assisted PRs, commits on them, human contributors) and a PR table with collaborators (human and agent avatars), agent:human commit ratio and outcome (Closed/Merged/Open). Per-PR attribution was not described in the text. ([image](https://jellyfish.co/wp-content/uploads/2026/03/claude-ai-impact-agent-reporting.webp))
- Logo banner only (Jellyfish + Claude), no UI. ([image](https://jellyfish.co/wp-content/uploads/2025/08/Jellyfish-AI-Impact_Claude-Code-1024x561.png))

## Sources

- [Jellyfish Claude Code Dashboard](https://jellyfish.co/platform/claude-code-dashboard/)
- [Jellyfish Claude Code Integration](https://jellyfish.co/?p=30868)
- [Jellyfish blog: AI Impact for Claude Code](https://jellyfish.co/blog/ai-impact-claude-code/)
- [Jellyfish: Claude Code Usage Analytics article](https://jellyfish.co/?p=33006)
- [DX Claude Code connector](https://docs.getdx.com/connectors/claude-code)
- [LinearB: Claude Code Admin API](https://linearb.helpdocs.io/article/d4c2syukwf-configuring-claude-code-admin-api)
- [Worklytics: tracking Claude Code usage](https://www.worklytics.co/blog/tracking-claude-code-usage)
- [Screenshot Feature-claude-code.webp](https://jellyfish.co/wp-content/uploads/2026/03/Feature-claude-code.webp)
- [Screenshot Jellyfish-AI-Impact-dashboard_Claude-Code-1024x640.png](https://jellyfish.co/wp-content/uploads/2025/08/Jellyfish-AI-Impact-dashboard_Claude-Code-1024x640.png)
- [Screenshot claude-metrics-issue-cycle.webp](https://jellyfish.co/wp-content/uploads/2026/03/claude-metrics-issue-cycle.webp)
- [Screenshot claude-usage-over-time.webp](https://jellyfish.co/wp-content/uploads/2026/03/claude-usage-over-time.webp)
- [Screenshot claude-Utilization-matrix.webp](https://jellyfish.co/wp-content/uploads/2026/03/claude-Utilization-matrix.webp)
- [Screenshot claude-ai-impact-agent-reporting.webp](https://jellyfish.co/wp-content/uploads/2026/03/claude-ai-impact-agent-reporting.webp)
- [Screenshot Jellyfish-AI-Impact_Claude-Code-1024x561.png](https://jellyfish.co/wp-content/uploads/2025/08/Jellyfish-AI-Impact_Claude-Code-1024x561.png)
