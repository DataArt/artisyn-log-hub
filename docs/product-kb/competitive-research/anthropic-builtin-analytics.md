---
type: "Research"
title: "Anthropic built-in Claude Code analytics — feature parity with Log Hub"
description: "Anthropic's own analytics dashboards, Analytics Admin API and in-CLI /usage, /context, /insights: strong on adoption/ROI (PRs, accept rate, DAU), spend caps and per-user aggregates, but no content-level session, harness or tool analysis — Log Hub's core."
tags:
  - competitive-research
  - vendor-builtin
timestamp: "2026-11-01T00:00:00+04:00"
---

# Anthropic built-in Claude Code analytics

- **What it is:** First-party usage reporting for Claude Code: the Team/Enterprise analytics dashboard on claude.ai (adoption + GitHub contribution metrics), the Console dashboard for API customers, the Claude Code Analytics Admin API (daily per-user aggregates), the Enterprise Analytics API, and in-CLI commands `/usage` (session cost, prompt-cache stats, plan-usage attribution and recommendations), `/context` and `/insights`.
- **Vendor / author:** Anthropic.
- **Links:** [Analytics dashboard docs](https://code.claude.com/docs/en/analytics), [Claude Code Analytics API](https://platform.claude.com/docs/en/build-with-claude/claude-code-analytics-api), [Manage costs](https://code.claude.com/docs/en/costs), [OTel monitoring](https://code.claude.com/docs/en/monitoring-usage) (context only).
- **License / pricing:** Proprietary; included with Team/Enterprise plans and Console orgs; Analytics Admin API is free for orgs with Admin API access. Enterprise Analytics API is Enterprise-only.
- **Maturity:** Vendor GA product; contribution metrics in public beta (as of 2026-11-01).
- **Data source:** Anthropic's server-side usage records + Claude GitHub app (PR attribution); CLI features read local session history.
- **Deployment:** SaaS (claude.ai / platform.claude.com); `/usage`, `/insights` local in the CLI.

## Feature parity

| ID | Capability | Anthropic built-in | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Server-side usage records, GitHub app; CLI reads local history | Hook + full transcript + native OTel | LH ahead |
| C2 | Full content capture | No (aggregates only in dashboards/API) | Yes | LH ahead |
| C3 | Sub-agents / workflows tree | Only usage share attribution to subagents in `/usage` | Full tree, root vs tree metrics | LH ahead |
| C4 | Real-time / live view | No (API ≥1 h delay, dashboard daily); `/usage` live for own session only | Partial (OTel realtime tab) | LH ahead |
| C5 | Native OTel ingestion | No ingestion (Claude Code exports OTel to your stack) | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | No | Yes | LH ahead |
| A2 | Tokens & cost per session/turn | Per-session in `/usage` (incl. cache stats, contracted `modelPricing`); org per-user/day/model | Yes per session/turn | Parity |
| A3 | Context-window anatomy | `/context` locally for current session | Yes (persisted, team-wide) | LH ahead |
| A4 | Harness config analysis | `/usage` attributes usage to skills, plugins, MCP servers, flags large CLAUDE.md; org analytics UI lists Skills (cost per use, uses) and Connectors (users, reads, writes) | Yes (Harness Usage, compare setups) | LH ahead |
| A5 | Tool / MCP monitoring | Edit/Write tool accept/reject counts only | Outcomes, errors, permission attribution | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Lines added/removed per user/day; lines in merged PRs | Per-session files/lines | Parity |
| A8 | Recommendations / cost advisor | `/usage` recommendations with `f` to auto-apply; `/insights` HTML report on friction | Turn-end cost advisor | Competitor ahead |
| A9 | Dashboards / trends | Adoption, PRs, leaderboard, spend charts, CSV | Timeline, exec summary, export | Parity |
| A10 | Productivity / ROI | PRs/lines with CC, % PRs with CC, accept rate, DAU, commits, PRs per user, leaderboard | Limited | Competitor ahead |
| A11 | Alerts / budgets / quotas | Org/group/member spend limits, workspace spend & rate limits, `--max-budget-usd` | No | Competitor ahead |
| T1 | Team views + access control | Admin/Owner roles, per-user tables, leaderboard | Teams, transparent/restricted modes | Parity |
| T2 | Authentication | claude.ai / Console SSO and roles | none, password, email confirm, Azure OAuth | n/a |
| T3 | Self-hosted / offline | No (SaaS only) | Yes | LH ahead |
| T4 | Retention controls | Not documented for analytics (API: "no specified deletion period"); ZDR disables contribution metrics | Yes | LH ahead |
| T5 | Export / import sessions | CSV of contributions/spend; no session export | Yes | LH ahead |
| T6 | Install effort | Zero for usage; GitHub app + owner toggles for contribution metrics | Docker + `npx` per project | Competitor ahead |
| T7 | Other agents | Claude surfaces only (Enterprise API also chat/Cowork) | None | Parity |
| T8 | License / pricing | Bundled in paid plans, proprietary | Free MIT | LH ahead |
| T9 | Query/API access | Claude Code Analytics Admin API, Enterprise Analytics API | REST API with keys | Parity |

## Where it is ahead of Log Hub

- GitHub PR attribution: merged-PR line matching against session output (21-day window, normalization, generated-file exclusions), `claude-code-assisted` PR label, % of PRs with Claude Code.
- Suggestion accept rate per edit tool (accepted/rejected Edit, MultiEdit, Write, NotebookEdit).
- Spend caps at org / group / member level, workspace rate limits, `--max-budget-usd`.
- `/usage` recommendations ranked by share of usage, with one-key auto-apply (`f`), plus prompt-cache miss diagnostics ("likely cause: tool definitions changed").
- `/insights` qualitative report on friction points (misunderstood requests, buggy code).
- Zero-install for usage metrics; contracted-rate pricing via managed `modelPricing`.
- Covers usage authoritative to billing (server-side), incl. users who never installed anything.

## Where Log Hub is ahead

- Full transcript content and turn-by-turn viewer; nothing comparable exists in the built-in dashboards.
- Sub-agent/workflow tree, tool outcomes and permission denials, KB usage, context anatomy — persisted and team-wide, not just for the local current session.
- Works with Bedrock/Vertex/Foundry and subscription plans uniformly (built-in analytics split by plan; cloud-provider usage not covered at all).
- Self-hosted, offline, retention controls, free and open source.
- Per-session/per-turn granularity vs daily per-user aggregates.

## Ideas worth borrowing

- PR/commit attribution: link sessions to merged commits/PRs (git hook data + diff-line matching) and show "% of merged lines written in Claude Code sessions".
- Edit-tool accept/reject rate per user/repo, derived from permission decisions already captured by the hook.
- Cache-miss diagnostics per turn with a likely cause (tool definitions changed, TTL expired, compaction).
- Usage-share recommendations ranked by % of tokens ("Trim CLAUDE.md · 49k tokens per request") feeding the cost advisor.
- Spend-by-model stacked daily bars with a table of spend, % of total and "vs prior period" delta; a budget progress bar ("$123.77 of $300.00 · 41% used · resets …").
- Adoption funnel (all members → monthly → weekly → daily active) and DAU/MAU "stickiness" bars; skills ranked by cost per use.
- Optional ingestion of the Claude Code Analytics Admin API to reconcile Log Hub estimates with Anthropic's per-user daily cost.

## What the UI shows (screenshots)

The Claude Code docs pages (analytics, costs) contain no screenshots; the two below come from the Claude Help Center article on Team/Enterprise usage analytics (claude.ai-wide, not Claude Code-only).

- [Member usage, 30 days by model](https://downloads.intercomcdn.com/i/o/lupk8zyo/2533906328/1f5cd0a57def40676410f8f379b4/member-usage-30d-model.png): "Your usage limits" spend bar ($ of limit, % used, reset date); Group by Model, Daily/Weekly toggle, date-range picker; stacked "Daily spend by model" bars; table of model spend, % of total and vs-prior-period change; "Top skills" with cost per use and uses; "Last updated N minutes ago" with refresh. Not described in the Claude Code docs: per-skill cost per use and period-over-period deltas.
- [Org "How are they using Claude?"](https://downloads.intercomcdn.com/i/o/lupk8zyo/2583875713/e3cb3c329f3b643cb9a3809876b3/image.png): adoption level bars (all members / monthly / weekly / daily), product stickiness DAU/MAU per product (Claude Code, Cowork, Claude.ai, Office Agents), Skills table (cost per use, uses), Connectors table (users, reads, writes; "By users" selector). No per-session or tool-outcome detail visible.

## Sources

- [Track team usage with analytics](https://code.claude.com/docs/en/analytics)
- [Claude Code Analytics API](https://platform.claude.com/docs/en/build-with-claude/claude-code-analytics-api)
- [Manage costs effectively](https://code.claude.com/docs/en/costs)
- [Monitoring usage with OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage) (context only; not re-read for this file)
- [Help Center: usage analytics for Team and Enterprise](https://support.claude.com/en/articles/12883420-view-usage-analytics-for-team-and-enterprise-plans)
- Screenshot: https://downloads.intercomcdn.com/i/o/lupk8zyo/2533906328/1f5cd0a57def40676410f8f379b4/member-usage-30d-model.png
- Screenshot: https://downloads.intercomcdn.com/i/o/lupk8zyo/2583875713/e3cb3c329f3b643cb9a3809876b3/image.png
