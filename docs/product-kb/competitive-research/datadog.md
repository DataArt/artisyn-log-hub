---
type: "Research"
title: "Datadog Agent Console (AI Agents Console) — feature parity with Log Hub"
description: "Datadog's SaaS console for coding-agent spend, adoption and DORA-style impact (Claude Code via OTel or Anthropic usage API); ahead on ROI, waste-pattern fixes and alerts, behind on per-session depth and self-hosting."
tags:
  - competitive-research
  - apm-vendor
timestamp: "2026-11-01T00:00:00+04:00"
---

# Datadog Agent Console (AI Agents Console)

- **What it is:** A Datadog product area that monitors AI coding and knowledge agents (Claude Code, Cursor, GitHub Copilot, Codex, opencode, Claude Chat/Cowork, ChatGPT, M365 Copilot) for spend, adoption, productivity and "waste patterns", tied to GitHub/Jira delivery data.
- **Vendor / author:** Datadog, Inc.
- **Links:** [Docs](https://docs.datadoghq.com/ai_agents_console), [Launch blog](https://www.datadoghq.com/blog/claude-code-monitoring/), [Docs PR (setup text)](https://github.com/DataDog/documentation/pull/32643/files)
- **License / pricing:** Proprietary SaaS. Console pricing not documented; requires a Datadog account (14-day trial). Logs/metrics ingestion is billed under normal Datadog pricing (not confirmed for this product).
- **Maturity:** Preview, "available to all Datadog customers" (docs, as of 2026-11-01); blog dated 2026-06-09.
- **Data source:** Claude Code native OTel (logs + metrics via OTLP direct or through the Datadog Agent's OTel collector, env vars in `settings.json`, MDM rollout) or the Anthropic Usage and Costs API integration; GitHub/Jira for productivity; open-source "Trajectory" capture for session/tool/skill detail.
- **Deployment:** SaaS only (not available on Datadog GovCloud sites).

## Feature parity

| ID | Capability | Datadog | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Native OTel logs/metrics or Anthropic Admin usage API; Trajectory for sessions | Hook + full transcript + native OTel | LH ahead |
| C2 | Full content capture | Not documented (OTel prompt logging is opt-in; no transcript viewer documented) | Yes | LH ahead |
| C3 | Sub-agents / multi-agent tree | Not documented | Yes | LH ahead |
| C4 | Real-time / live view | Yes, OTel metrics appear in minutes | Partial | Competitor ahead |
| C5 | Native OTel ingestion | Yes (OTLP intake / Agent collector) | Yes | Parity |
| A1 | Turn-by-turn log viewer | No viewer in UI; flagged-session list rows show only user, repo, agent, duration, cost | Yes, rich renderers | LH ahead |
| A2 | Tokens & cost incl. cache | Yes: spend by agent/team/user, stacked daily spend per agent, per-user model-mix bar, cost per line; cache split not visible | Yes, per turn, pricing tiers | Parity |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | Partial: skills/tools usage via Trajectory; Fix Library ships hooks/skills | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | Tools view (Trajectory-only); errors in metrics | Yes, outcome + permission attribution | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Lines generated per user (OTel) | Yes, files/lines per session | Parity |
| A8 | Recommendations | Waste-pattern detection (retry loops, rereads, skipped checks), savings estimate, Fix Library that opens PRs | Turn-end cost advisor | Competitor ahead |
| A9 | Dashboards / trends | Yes, full Datadog dashboards/notebooks | Yes | Parity |
| A10 | Productivity / ROI | Yes: AI-assisted commits/PRs %, change lead time, PR review time, CFR, recovery time with sparklines; per-user PR list with est. cost and +/- lines | Limited | Competitor ahead |
| A11 | Alerts / budgets | Yes: per-team cost alerts, Datadog monitors | No | Competitor ahead |
| T1 | Team views + access control | Yes: team comparison table (spend/eng, cost/PR, time to merge, sessions) with "You" vs org line chart, user cost table, Datadog RBAC | Yes | Parity |
| T2 | Authentication | Datadog SSO/SAML | none/password/email/Azure OAuth | Parity |
| T3 | Self-hosted / offline | No, SaaS only | Yes | LH ahead |
| T4 | Data retention | Datadog log/metric retention settings | Yes | Parity |
| T5 | Export / import sessions | Not documented (generic Datadog export) | Yes | LH ahead |
| T6 | Install effort | Env vars in settings.json + API key; MDM for org | Docker + `npx` per project | Parity |
| T7 | Other agents | Cursor, Copilot, Codex, opencode, Claude Chat/Cowork, ChatGPT, M365 Copilot | Claude Code only | Competitor ahead |
| T8 | License / pricing | Proprietary, paid SaaS | Free, MIT | LH ahead |
| T9 | Query/API access | Datadog APIs, log/metric query, MCP server | REST API | Competitor ahead |

## Where it is ahead of Log Hub

- ROI/impact views: AI-assisted commit and PR share, cost per merged PR, DORA lead time / change failure rate, Jira issues vs AI spend.
- Waste-pattern detection (retry loops, file rereads, skipped checks) with a Sankey by agent/pattern/repo and estimated monthly savings.
- Fix Library: vetted hooks/skills (e.g. "Verify before git" PreToolUse hook) deployed as a PR to one repo, a team or the org.
- Cost alerts per team and the full Datadog monitor/alerting stack.
- Multi-agent coverage (Cursor, Copilot, Codex, ChatGPT, M365 Copilot) in one console.
- Correlation with the rest of Datadog (APM, logs, CI) and Datadog query APIs.

## Where Log Hub is ahead

- Full transcript capture and a turn-by-turn viewer; sub-agent/workflow tree.
- Context anatomy, harness usage analysis, KB (OKF) usage, permission-denial attribution.
- Self-hosted, air-gapped, free and open source; no per-GB ingestion cost.
- Session export/import.

## Ideas worth borrowing

1. Waste-pattern detector over transcripts (retry loops, rereading the same file, skipped tests before commit) with per-repo estimated savings.
2. Team budget alerts / spend thresholds (closes A11).
3. "Fix library": suggest a ready hook/rule/skill for a detected pattern, linked from the cost advisor.
4. KPI strip with delta vs previous period (spend, users, sessions, time to merge, lines, avg turns) above the stacked spend chart.
5. Insight cards next to charts ("team spend rose 159% vs prior period", "top 2% on cost efficiency") with a drill-in button.
6. Editable pattern definition (metric predicates like `test_fix_cycle_count = 0`) with "Was this pattern helpful?" feedback and a flagged-sessions drawer.
7. Cost per merged PR and AI-assisted commit share via git/GitHub metadata (closes A10).

## What the UI shows (screenshots)

- [agent-console-hero.png](https://web-assets.dd-static.net/42588/1780520046-agent-console-hero.png) — Hero: Coding Agents tab with Teams/Users/Repository/Agents filters, Impact Metrics cards (Adoption, Velocity, Stability) and Detected Problems Sankey (Agent → Problem Pattern → Repository) with per-pattern clean/flagged bars and "View Sessions".
- [screenshot-2026-06-03-at-4-36-45-pm.png](https://web-assets.dd-static.net/42588/1780519057-screenshot-2026-06-03-at-4-36-45-pm.png) — Agent Findings: KPI strip (Total Spend, Users, Sessions, Time to Merge, Lines of Code, Avg Turns, each with % vs previous period) over a stacked daily spend bar chart per agent (Cursor / Claude Code / Copilot).
- [screenshot-2026-06-03-at-4-38-28-pm.png](https://web-assets.dd-static.net/42588/1780519118-screenshot-2026-06-03-at-4-38-28-pm.png) — Analytics → Comparison: spend-per-engineer lines for "You", each team and the whole org; toggles Spend / Cost Per Line / Model Usage; auto insight cards (top 2% efficiency, team spend +159% with "Investigate with Bits"); team table with spend/eng, cost/PR, time to merge, sessions, Team Details.
- [screenshot-2026-06-03-at-4-39-46-pm.png](https://web-assets.dd-static.net/42588/1780519196-screenshot-2026-06-03-at-4-39-46-pm.png) — Impact Metrics close-up: AI-assisted commits 77.5%, AI-assisted PRs 70.5%, change lead time, PR review time, change failure rate, recovery time, each with sparkline and delta vs "Others".
- [screenshot-2026-06-03-at-4-40-58-pm.png](https://web-assets.dd-static.net/42588/1780519268-screenshot-2026-06-03-at-4-40-58-pm.png) — User drill-down drawer: user spend, lines generated, PR count, model-mix bar (opus/sonnet %), recent PRs table with estimated cost, status and +/- lines; GitHub Pull Requests tab. Not described in docs text.
- [screenshot-2026-06-03-at-4-42-13-pm.png](https://web-assets.dd-static.net/42588/1780519348-screenshot-2026-06-03-at-4-42-13-pm.png) — Detected Problems Sankey full view plus Agents cards (users per agent, Active indicator).
- [screenshot-2026-06-03-at-4-43-08-pm.png](https://web-assets.dd-static.net/42588/1780519404-screenshot-2026-06-03-at-4-43-08-pm.png) — Pattern drawer: repo tabs, editable pattern definition as metric predicates (`commit_count > 0`, `test_fix_cycle_count = 0`), session estimate, View Recommendation, helpful thumbs; flagged sessions list (user, repo, agent, duration, cost) — no transcript shown.
- [screenshot-2026-06-03-at-4-44-10-pm.png](https://web-assets.dd-static.net/42588/1780519459-screenshot-2026-06-03-at-4-44-10-pm.png) — Fix Library: fixes per pattern (PreToolUse "Verify before git" hook, agent skill, git pre-commit lint) with adoption counts, "Author New Fix", and rollout target: this repo / all team repos / org-wide via PR.

## Sources

- [Datadog docs — Agent Console](https://docs.datadoghq.com/ai_agents_console)
- [Datadog blog — Claude Code / Agent Console](https://www.datadoghq.com/blog/claude-code-monitoring/)
- [DataDog/documentation PR #32643 (Claude Code setup)](https://github.com/DataDog/documentation/pull/32643/files)
- [Blog screenshot 1780520046](https://web-assets.dd-static.net/42588/1780520046-agent-console-hero.png)
- [Blog screenshot 1780519057](https://web-assets.dd-static.net/42588/1780519057-screenshot-2026-06-03-at-4-36-45-pm.png)
- [Blog screenshot 1780519118](https://web-assets.dd-static.net/42588/1780519118-screenshot-2026-06-03-at-4-38-28-pm.png)
- [Blog screenshot 1780519196](https://web-assets.dd-static.net/42588/1780519196-screenshot-2026-06-03-at-4-39-46-pm.png)
- [Blog screenshot 1780519268](https://web-assets.dd-static.net/42588/1780519268-screenshot-2026-06-03-at-4-40-58-pm.png)
- [Blog screenshot 1780519348](https://web-assets.dd-static.net/42588/1780519348-screenshot-2026-06-03-at-4-42-13-pm.png)
- [Blog screenshot 1780519404](https://web-assets.dd-static.net/42588/1780519404-screenshot-2026-06-03-at-4-43-08-pm.png)
- [Blog screenshot 1780519459](https://web-assets.dd-static.net/42588/1780519459-screenshot-2026-06-03-at-4-44-10-pm.png)
