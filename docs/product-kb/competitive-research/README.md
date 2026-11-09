---
type: "Research"
title: "Competitive Research — Claude Code telemetry tools vs Log Hub"
description: "Feature-parity study of 14 Claude Code telemetry/observability tools against Log Hub (as of 2026-11-01): one file per tool, a combined verdict matrix, the gaps where competitors lead and a backlog of ideas worth borrowing."
tags:
  - competitive-research
  - product
timestamp: "2026-11-01T00:00:00+04:00"
---

# Competitive Research — Claude Code telemetry tools

Research date: **2026-11-01**. A separate agent researched each tool from its official site, docs,
GitHub README and pricing page. Every tool was checked against the same 25 capabilities: rows `C*` are
capture, `A*` analysis, `T*` team and deployment. Each tool's own file has the full table, with evidence
and sources for every row. Facts that could not be confirmed are marked "unknown" or "not documented" there.

**Screenshot pass.** After the text pass, a second agent per tool downloaded and looked at the product's
own screenshots (README images, docs, blog posts, marketplace pages) and corrected the table where the UI
contradicted the text. The results are in each file's "What the UI shows (screenshots)" section. One
verdict changed (agents-observe A2 → parity). Claude Hindsight publishes no screenshots, and Langfuse has
none of a Claude Code session.

**Caveat.** No tool was installed and run. Each verdict is the researcher's judgement from docs and
screenshots. Re-verify a row before quoting it
externally. The product-level summary (who the competitors are and how Log Hub is positioned) is in the KB:
`docs/product-kb/competitors.md`.

## Tools covered

| Tool | Category | Deployment | License / pricing | Maturity (2026-11-01) |
|---|---|---|---|---|
| [Anthropic built-in analytics](anthropic-builtin-analytics.md) | vendor-builtin | SaaS (Claude Console / claude.ai) + Admin API | Included in Team/Enterprise | Vendor GA; contribution metrics in beta |
| [ccusage](ccusage.md) | local-cli | Local CLI over `~/.claude` JSONL | MIT | ~19.3k stars |
| [Claude Code Usage Monitor](claude-code-usage-monitor.md) | local-cli | Local terminal app | MIT | ~8.8k stars |
| [ccboard](ccboard.md) | local-cli | Local TUI / web, single binary | MIT / Apache-2.0 | ~100 stars |
| [Claude Hindsight](claude-hindsight.md) | hook-dashboard | Local binary + hooks | MIT | ~22 stars |
| [agents-observe](agents-observe.md) | hook-dashboard | Local plugin + SQLite server | MIT | ~712 stars |
| [Multi-Agent Observability (disler)](disler-multi-agent-observability.md) | hook-dashboard | Local Bun + Vue demo | No license detected | ~1.56k stars, demo-grade |
| [claude-code-otel](claude-code-otel.md) | otel-dashboard | Self-hosted Docker (Collector, Prometheus, Loki, Grafana) | MIT | ~520 stars, template |
| [Grafana Cloud integration](grafana-cloud.md) | otel-dashboard | SaaS | Grafana Cloud usage tiers | Vendor, v1.0.1 |
| [Langfuse + Claude Code plugin](langfuse.md) | llm-observability | Self-host or SaaS | MIT core; free and paid cloud tiers | ~36.8k stars (platform) |
| [Datadog Agent Console](datadog.md) | apm-vendor | SaaS | Datadog pricing | Preview |
| [Dynatrace Claude Code monitoring](dynatrace.md) | apm-vendor | SaaS | Dynatrace platform | Vendor-supported |
| [Coralogix Code Agents](coralogix.md) | apm-vendor | SaaS | Usage-based | Vendor GA |
| [Jellyfish AI Impact](jellyfish.md) | eng-analytics | SaaS | Sales-led | Established vendor |

Added after the snapshot (not in the matrix below; the file has the same 25-row table):

| Tool | Category | Deployment | License / pricing | Researched |
|---|---|---|---|---|
| [Beezi Analytics](beezi.md) | hook-dashboard (SaaS) | SaaS only, hook plugin sends summaries | Free single seat; $7.99/user/month team | 2026-11-09; competitor ahead on A8, A10, A11, T6, T7, T9 |

These variants are mentioned in the tool files but were not researched on their own: ccusage-live,
li0nel/claude-otel and the community Grafana dashboards, Respan, Claudescope, claude-trace-replay, DX,
LinearB and Worklytics.

## Parity matrix

`LH` = Log Hub ahead, `=` = parity, **`C`** = competitor ahead, `–` = not applicable. The row
definitions and Log Hub's own baseline are in each tool file.

| ID | Capability | [Anthropic](anthropic-builtin-analytics.md) | [ccusage](ccusage.md) | [CC Usage Mon.](claude-code-usage-monitor.md) | [ccboard](ccboard.md) | [Hindsight](claude-hindsight.md) | [agents-observe](agents-observe.md) | [disler MAO](disler-multi-agent-observability.md) | [cc-otel](claude-code-otel.md) | [Grafana Cloud](grafana-cloud.md) | [Langfuse](langfuse.md) | [Datadog](datadog.md) | [Dynatrace](dynatrace.md) | [Coralogix](coralogix.md) | [Jellyfish](jellyfish.md) | C count |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| C1 | Data source | LH | LH | LH | LH | = | LH | LH | LH | LH | LH | LH | LH | LH | – | 0 |
| C2 | Full content capture | LH | LH | LH | = | = | LH | LH | LH | LH | LH | LH | LH | LH | LH | 0 |
| C3 | Sub-agent / workflow tree | LH | LH | LH | = | LH | = | LH | LH | LH | LH | LH | LH | LH | LH | 0 |
| C4 | Real-time / live view | LH | = | **C** | **C** | **C** | **C** | **C** | **C** | **C** | = | **C** | **C** | = | LH | 9 |
| C5 | Native OTel ingestion | LH | LH | LH | LH | = | LH | LH | = | = | LH | = | = | = | LH | 0 |
| A1 | Turn-by-turn session log | LH | LH | LH | = | = | = | LH | LH | LH | LH | LH | LH | LH | LH | 0 |
| A2 | Tokens & cost per session/turn | = | = | LH | = | LH | = | LH | LH | LH | = | = | LH | = | LH | 0 |
| A3 | Context-window anatomy | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | 0 |
| A4 | Harness config analysis | LH | LH | LH | = | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | 0 |
| A5 | Tool / MCP monitoring | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | = | LH | LH | 0 |
| A6 | KB usage analysis | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | 0 |
| A7 | Code change surface | = | LH | LH | LH | LH | LH | LH | LH | LH | LH | = | LH | = | = | 0 |
| A8 | Recommendations / advisor | **C** | LH | LH | LH | LH | LH | LH | LH | LH | LH | **C** | LH | LH | = | 2 |
| A9 | Dashboards / reports / trends | = | LH | LH | = | LH | LH | LH | = | = | = | = | = | = | = | 0 |
| A10 | Productivity / ROI metrics | **C** | LH | LH | = | = | LH | LH | **C** | **C** | = | **C** | **C** | **C** | **C** | 7 |
| A11 | Alerts / budgets / burn rate | **C** | **C** | **C** | **C** | = | = | = | **C** | **C** | **C** | **C** | **C** | **C** | – | 10 |
| T1 | Team views + access control | = | LH | LH | LH | LH | LH | LH | LH | = | = | = | = | = | = | 0 |
| T2 | Authentication options | – | – | – | LH | LH | LH | LH | LH | = | **C** | = | = | – | – | 1 |
| T3 | Self-hosted / offline | LH | = | = | = | = | = | LH | = | LH | LH | LH | LH | LH | LH | 0 |
| T4 | Data retention controls | LH | LH | LH | LH | LH | LH | LH | = | = | = | = | = | = | – | 0 |
| T5 | Export / import | LH | LH | LH | = | LH | LH | LH | LH | LH | LH | LH | LH | LH | LH | 0 |
| T6 | Install effort | **C** | **C** | **C** | **C** | **C** | **C** | LH | = | **C** | = | = | = | **C** | **C** | 9 |
| T7 | Other agents supported | = | **C** | = | **C** | = | = | = | = | = | **C** | **C** | **C** | **C** | **C** | 7 |
| T8 | License / pricing | LH | = | = | = | = | = | LH | = | LH | = | LH | LH | LH | LH | 0 |
| T9 | Query / API access | = | LH | LH | LH | LH | LH | LH | **C** | **C** | **C** | **C** | **C** | **C** | – | 6 |
| | **Competitor ahead, total** | 4 | 3 | 3 | 4 | 2 | 2 | 1 | 4 | 5 | 4 | 6 | 5 | 5 | 3 | |

## Findings

### Where Log Hub has no competitor

- **Context-window anatomy (A3)** and **knowledge-base usage analysis (A6)**: Log Hub is ahead of all 14 tools.
- **Harness configuration analysis (A4)** and **tool/MCP outcome monitoring (A5)**: only ccboard (config
  editing) and Dynatrace (tool metrics) reach parity, each on one of the two rows.
- **Full content and the sub-agent tree on a team server (C2, C3, T1)**: the local viewers (ccboard,
  Hindsight, agents-observe) read transcripts, but each serves one user. The team-grade tools (the APM
  vendors, Anthropic, Jellyfish) work only on aggregate OTel metrics or the usage API and have no transcripts.
- **Self-hosted and offline, with team features (T3 + T1)**: the SaaS vendors cannot run air-gapped. The
  self-hosted options (claude-code-otel, Langfuse) have no analysis specific to Claude Code.

Positioning in one line: competitors answer *how much and how often*; Log Hub answers *why, and whether the
harness works as designed*.

### Where competitors lead (gaps, by how many tools lead)

| Gap | Row | Tools ahead | Notes |
|---|---|:-:|---|
| Alerts, budgets, burn rate and limit prediction | A11 | 10 | The most common feature Log Hub lacks: every local CLI and every vendor has some form of it |
| Live view of a running session | C4 | 9 | Hook dashboards stream hook events over WebSocket/SSE; OTel stacks show live metrics |
| Install effort | T6 | 9 | Competitors install with `npx ccusage`, a single binary or a one-click SaaS integration; Log Hub needs a Docker server plus a hook in each project |
| Productivity / ROI (commits, PRs, accepted edits, DAU) | A10 | 7 | Claude Code already emits these as OTel metrics; Log Hub receives them but does not chart them |
| Other agents (Cursor, Codex, Copilot, OpenCode, …) | T7 | 7 | Vendors, ccusage and ccboard cover several agents; Log Hub covers only Claude Code |
| Query access (PromQL/DQL, SQL, MCP server, CLI) | T9 | 6 | Log Hub has only a REST API |
| Recommendations | A8 | 2 | Anthropic (`/insights`) and Datadog (waste patterns with estimated savings) |
| SSO / SCIM | T2 | 1 | Langfuse |

## Ideas worth borrowing (backlog candidates)

Merged from the "Ideas worth borrowing" sections of the tool files and ordered by how many tools have the
gap. These are candidates for tasks, not decisions.

1. **Budgets and alerts.** Spend thresholds per user, team or repo with notifications, plus burn rate and
   projected spend, and a 5-hour billing-block view with a limit bar
   ([ccusage](ccusage.md), [Usage Monitor](claude-code-usage-monitor.md), [ccboard](ccboard.md), the
   vendors). Notifications must work offline (email through the existing mailer, or in-app).
2. **Live session feed.** Push hook events to the web app over SSE before the transcript upload lands,
   with a swim lane per agent and an events-per-minute pulse
   ([disler](disler-multi-agent-observability.md), [agents-observe](agents-observe.md),
   [Hindsight](claude-hindsight.md)).
3. **Productivity panel from the OTel metrics Log Hub already receives.** Commits, PRs, lines of code,
   edit accept/reject rate, active time, DAU/WAU ([claude-code-otel](claude-code-otel.md),
   [Grafana](grafana-cloud.md), [Coralogix](coralogix.md), [Dynatrace](dynatrace.md)). Later, link
   sessions to merged commits and PRs ([Anthropic](anthropic-builtin-analytics.md), [Jellyfish](jellyfish.md)).
4. **Faster first value.** On hook install, offer to upload the user's existing `~/.claude/projects/`
   history so the first dashboard is not empty ([ccusage](ccusage.md), [Hindsight](claude-hindsight.md)).
   Offer a light single-user mode without Docker ([agents-observe](agents-observe.md)).
5. **An MCP server over the Log Hub API**, so Claude Code can query its own session history and cost
   ([Langfuse](langfuse.md), [Dynatrace](dynatrace.md)).
6. **Waste-pattern detection in the cost advisor.** Retry loops, re-reading the same file and skipped
   checks, with estimated savings per repo ([Datadog](datadog.md)).
7. **Rate-limit capture.** Record Claude Code's `rate_limits` from the statusline input to show the
   remaining quota ([Usage Monitor](claude-code-usage-monitor.md)).
8. **CI gate report.** Exit non-zero when a token budget or error-rate threshold is exceeded
   ([ccboard](ccboard.md)).
9. **Managed vs unmanaged repositories.** Flag sessions in repos outside the configured organisations
   ([Coralogix](coralogix.md)).
10. **Support for other agents (Cursor, Codex).** A strategic decision that is outside the current product
    purpose; it is listed so that the decision is made explicitly.
