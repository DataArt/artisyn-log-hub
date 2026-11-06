---
type: "Research"
title: "ccboard — feature parity with Log Hub"
description: "Single-binary Rust TUI/web dashboard over local ~/.claude files; strong on personal budgets, forecasting, config editing and audit, but single-user and local-only versus Log Hub's team server."
tags:
  - competitive-research
  - local-cli
timestamp: "2026-11-01T00:00:00+04:00"
---

# ccboard

- **What it is:** A single Rust binary (about 5.8 MB) that reads `~/.claude/` read-only and shows Claude Code sessions, costs, config, hooks, MCP servers, agents and skills in a terminal UI (`ccboard`), a web UI (`ccboard web`), or both at once (`ccboard both`).
- **Vendor / author:** Florian Bruniaux, an individual open-source author.
- **Links:** [GitHub repo](https://github.com/FlorianBruniaux/ccboard), [docs.rs crate](https://docs.rs/crate/ccboard/latest)
- **License / pricing:** Free. Dual-licensed MIT OR Apache-2.0.
- **Maturity:** About 100 GitHub stars and 9 forks. The latest crate on docs.rs is 0.24.0. I could not confirm a release date, because the GitHub Releases section was empty when fetched. Active since early versions 0.5.x.
- **Data source:** Local JSONL transcripts and config in `~/.claude`, cached in a SQLite FTS5 index under `~/.ccboard/`. Optional hooks added by `ccboard setup` feed live session status. It also imports Cursor, Codex CLI and OpenCode sessions.
- **Deployment:** Local CLI, TUI or web on one machine. Installs via Homebrew, cargo, a curl script or GitHub binaries. Windows support is "best-effort".

## Feature parity

| ID | Capability | ccboard | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Local `~/.claude` JSONL plus optional status hooks; no OTel | Hook + transcript upload + native OTel | LH ahead |
| C2 | Full content capture | Reads the full local transcripts (conversation viewer) | Yes | Parity |
| C3 | Sub-agents / multi-agent tree | Subagent trees in Sessions | Sub-agent tree, workflow rows, root vs tree metrics | Parity |
| C4 | Real-time / live view | Live running/waiting/finished status via hooks; SSE in web mode; macOS notifications | Partial (OTel realtime, async upload) | Competitor ahead |
| C5 | Native OTel ingestion | No | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | Conversation viewer with regex search, model timeline | Rich renderers | Parity |
| A2 | Tokens & cost incl. cache | Token analytics in 6 views, per-tool cost breakdown | Own pricing, live price sync, 1M tiers | Parity |
| A3 | Context-window anatomy | Only a single "Context" tile (avg % over 30 days) on the dashboard; no per-turn breakdown visible | Yes | LH ahead |
| A4 | Harness config analysis | Config view with Global / Project / Local / Merged (Active) columns: permissions allow/deny, hook counts per event, env, plugins on/off, MCP servers, CLAUDE.md; MCP tab offers "Edit config"; hooks, agents, skills and plugin browsers with usage leaderboards | Harness Usage, snapshot, compare | Parity |
| A5 | Tool / MCP call monitoring | MCP server status, usage stats, tool leaderboards; outcome/denial attribution not documented | Outcomes + permission attribution | LH ahead |
| A6 | Knowledge-base usage | "Brain" cross-session insight store (a different feature); no KB-read analysis | OKF usage tabs | LH ahead |
| A7 | Code change surface | Not documented | Yes | LH ahead |
| A8 | Recommendations / advisor | AI session summaries, anomaly detection; no cost advisor documented | Turn-end cost advisor | LH ahead |
| A9 | Dashboards / trends | 7-day activity, hourly heatmaps, 30-day forecast, history timeline | Timeline, exec report, stats export | Parity |
| A10 | Productivity / ROI | Not documented | Limited | Parity |
| A11 | Alerts / budgets / burn-rate | Dashboard plan-budget panel (today/week/month vs plan, e.g. Claude Max 20x), 5h billing-block table, daily cost-spike list, monthly budget, 4-level alerts, projected-overage and spike warnings, plan-budget estimates, CI gates on token budget and error rate | No | Competitor ahead |
| T1 | Multi-user / team + ACL | No (single user) | Yes | LH ahead |
| T2 | Authentication options | None (local) | none/password/email/Azure | LH ahead |
| T3 | Self-hosted / offline | Fully local and offline | Fully offline | Parity |
| T4 | Data retention controls | Not documented | Yes | LH ahead |
| T5 | Export / import | Exports sessions, stats, billing and conversations to CSV, JSON, MD or HTML; imports Cursor, Codex and OpenCode sessions | Export/import | Parity |
| T6 | Install effort | One binary (brew, cargo, curl); nothing per project | Docker + `npx` per project | Competitor ahead |
| T7 | Other agents | Imports Cursor, Codex CLI and OpenCode sessions | None | Competitor ahead |
| T8 | License / pricing | Free, MIT/Apache-2.0 | Free, MIT | Parity |
| T9 | Query/API access | Not documented; CLI `report` command | REST API + API keys | LH ahead |

## Where it is ahead of Log Hub

- Budget tracking: monthly budget, 4-level alerts, projected-overage and spike warnings, a 30-day forecast, and estimates against subscription plan budgets.
- `ccboard report` acts as a CI gate: it exits non-zero when a token budget or error-rate threshold is exceeded.
- Live session status (running, waiting for input, finished) with desktop notifications, plus web updates over SSE.
- An audit log that flags credentials found in transcripts, destructive commands and cross-session violations.
- An effective-config view (Global, Project, Local and Merged Active in four columns); MCP config can be opened for editing.
- Bookmarks, AI-generated session summaries, FTS5 full-text search across all sessions, and an hourly heatmap.
- Multi-agent import from Cursor, Codex CLI and OpenCode.
- Install is zero-config: one binary, no server, no per-project hook.

## Where Log Hub is ahead

- Team-wide: a central server, teams, access modes, authentication, admin, retention controls, and a REST API.
- Native OTel ingestion and a realtime OTel tab.
- Deeper "why" analysis: context-window anatomy, KB/OKF usage, change surface, and the turn-end cost advisor.
- Tool outcome and permission-denial attribution.
- Owned pricing table with live price sync and 1M-context tiers. ccboard's pricing source is not documented.

## Ideas worth borrowing

- **5-hour billing-block table.** Tokens, sessions and cost per 5h UTC window, colour-coded, matching how subscription limits reset.
- **Statistical anomaly list.** Per-session z-score and % deviation on tokens, plus daily cost spikes as "N.x avg", with configurable warn/crit thresholds and a 7d/30d/90d/all period switch.
- **Live process panel.** Running Claude processes with PID, CPU, RAM, tokens, last hook event and a "Waiting Answers" pane.

- **Budgets and forecasting.** Per user or team monthly budget, threshold alerts, projected-overage and spike detection, and a burn-rate forecast. This closes A11.
- **CI gate report.** A CLI/API endpoint that exits non-zero when a token budget or error-rate threshold is exceeded, for use in pipelines.
- **Security audit view.** Flag secrets and credentials in transcripts and destructive Bash commands across sessions.
- **Live session status.** Show "waiting for input" and "running" from hook events, with optional notifications.
- **Effective-config diff.** A layered view of default, global, project and local settings per harness snapshot.

## What the UI shows (screenshots)

All screenshots are of the TUI; no web-UI screenshots are in the README. Some come from an older build with a different tab order (Capabilities tab, breadcrumbs).

- [Dashboard](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-01-dashboard.png): KPI tiles (tokens, sessions, messages, cache hit, MCP servers, context avg 30d), a 7-day token bar chart, an "API Usage (Est.)" panel against a Claude Max 20x plan (today/week/month with % and red overage), and model-usage bars including a non-Claude "Gpt" entry. Tabs include Audit Log, Tools, Plugins, Search and Brain.
- [Live sessions (newer)](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-02-sessions-detail.png): live session list with last hook event (Notification, PreToolUse, PostToolUse), CPU/RAM/tokens per process, a "Waiting Answers" pane, and a detail panel with hook status, PID, runtime, branch, messages, tokens and first prompt.
- [Live sessions (older)](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-02-sessions-live.png): the same idea by OS process (PID list) without hook status.
- [Config](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-03-config.png): Global / Project / Local / Merged (Active) columns, not default/global/project/local as the README text said; shows permissions, hook counts per event, plugins, MCP servers with env counts, CLAUDE.md preview. No editing is visible here.
- [Costs, usage periods](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-06-costs-billing-blocks.png): 5h UTC billing blocks for the last 10 days with tokens, sessions and cost, colour-coded; sub-tabs Overview, By Model, Daily, Top Sessions, Per Project.
- [Analytics, anomalies](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-09-analytics-anomalies.png): thresholds (warn >2σ, crit >3σ, spike 2x/3x), daily cost spikes vs average, and a per-session anomaly table with z-score and deviation; sub-agents appear as own IDs (agent-ac).
- [Analytics, insights](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-09-analytics-insights.png): only two generic hints (peak hours, low forecast confidence) — much thinner than a cost advisor.
- [MCP](https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/tui-08-mcp.png): server list and details (type, command, args, masked env secrets, config file) with copy/edit/reveal actions; status shows "Unknown", no call outcomes.

## Sources

- [GitHub — FlorianBruniaux/ccboard](https://github.com/FlorianBruniaux/ccboard)
- [docs.rs — ccboard latest (0.24.0)](https://docs.rs/crate/ccboard/latest)
- [docs.rs — ccboard 0.12.0 README](https://docs.rs/crate/ccboard/0.12.0/source/README.md)
- [skills.cat — ccboard listing](https://skills.cat/skills/florianbruniaux/claude-code-ultimate-guide/ccboard)
- README TUI screenshots: `https://raw.githubusercontent.com/FlorianBruniaux/ccboard/HEAD/assets/screenshots/tui/` (tui-01-dashboard, tui-02-sessions-detail, tui-02-sessions-live, tui-03-config, tui-06-costs-billing-blocks, tui-08-mcp, tui-09-analytics-anomalies, tui-09-analytics-insights)
