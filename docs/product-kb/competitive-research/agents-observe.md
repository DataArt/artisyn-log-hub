---
type: "Research"
title: "agents-observe — feature parity with Log Hub"
description: "Local real-time dashboard for Claude Code hook events (SQLite + WebSocket); ahead on live streaming, far behind on analysis, team and harness features."
tags:
  - competitive-research
  - hook-dashboard
timestamp: "2026-11-01T00:00:00+04:00"
---

# agents-observe

- **What it is:** A real-time observability dashboard for Claude Code sessions and multi-agent runs. Hooks stream every event through a small CLI to a local API server (SQLite), and a React dashboard receives them over WebSocket.
- **Vendor / author:** simple10 (individual open-source author)
- **Links:** [GitHub repo](https://github.com/simple10/agents-observe)
- **License / pricing:** MIT, free
- **Maturity:** about 712 stars, 75 forks and 892 commits on `main` (2026-11-01). The README mentions v0.9.7 to 0.9.8. The last-commit date was not visible on the page.
- **Data source:** Claude Code hooks (all hook events) sent through `observe_cli.mjs` to a REST API
- **Deployment:** Local, single user. It installs as a Claude Code plugin that starts the server automatically, or runs standalone from a clone with `just` or Docker. Default port is 4981, and data lives in `data/observe.db`.

## Feature parity

| ID | Capability | agents-observe | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Hook events only | Hooks + JSONL transcripts + OTel | LH ahead |
| C2 | Full content capture | Full hook payloads (tool inputs/outputs, Bash, edits). No transcript, so assistant text is limited | Yes, full transcripts | LH ahead |
| C3 | Sub-agents / multi-agent tree | Agent hierarchy showing which parent spawned which subagent | Sub-agent tree, workflows, root vs tree metrics | Parity |
| C4 | Real-time / live view | Yes, event-by-event WebSocket stream with auto-reconnect | Partial | Competitor ahead |
| C5 | Native OTel ingestion | Not documented | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | Event timeline with expandable payloads, filters, search and replay | Rich renderers | Parity |
| A2 | Tokens & cost | Session Stats tab: requests, input/output, cache-hit %, est. cost; tables by model, by agent and by prompt; per-row cost-breakdown tooltip (input, output, cache read, cache write 5m/1h, rate $/M) | Own pricing, cache, 1M tiers, price sync | Parity |
| A3 | Context-window anatomy | Not documented | Yes | LH ahead |
| A4 | Harness config analysis | Not documented | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | Per-call success tick or spinner, filter chips per tool name (Bash, Edit, Grep, Read...) and per category (MCP, Permissions, Errors). No aggregate outcome or denial analytics | Yes | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Individual edit events only | Yes | LH ahead |
| A8 | Recommendations / advisor | No | Yes | LH ahead |
| A9 | Dashboards / trends | Per-session stats only. Not documented across sessions | Yes | LH ahead |
| A10 | Productivity / ROI | No | Limited | LH ahead |
| A11 | Alerts / budgets | No | No | Parity |
| T1 | Multi-user / teams | No (local, single user) | Yes | LH ahead |
| T2 | Authentication | Not documented (local only) | 4 modes | LH ahead |
| T3 | Self-hosted / offline | Yes, fully local | Yes | Parity |
| T4 | Data retention | Not documented | Yes | LH ahead |
| T5 | Export / import | Not documented | Yes | LH ahead |
| T6 | Install effort | One plugin install that auto-starts the server | Docker server + `npx` per project | Competitor ahead |
| T7 | Other agents | Codex listed in the README intro, but the roadmap still has Codex, OpenClaw and pi-code unchecked | None | Parity |
| T8 | License / pricing | MIT, free | MIT, free | Parity |
| T9 | Query/API access | Local REST events endpoint + WebSocket. No formal docs or auth | REST API with API keys | LH ahead |

## Where it is ahead of Log Hub

- Live event-by-event streaming over WebSocket: you can watch tool calls and subagent spawns as they happen, with auto-reconnect.
- Zero-setup install: one Claude Code plugin install, and the server starts automatically with no Docker or DB needed.
- Session replay of multi-agent runs, plus jump-to-event from timeline icons.
- Per-prompt cost table: every user prompt in a session ranked by cost, duration and tool count.
- Multi-lane activity swimlane (one lane per agent) with time-window zoom.
- Memorable generated session names (for example "twinkly-hugging-dragon") that make sessions easy to tell apart.

## Where Log Hub is ahead

- Full transcripts and native OTel, not only hook payloads.
- Deep analysis: context anatomy, harness usage, KB usage, change surface, cost advisor, trends and reports.
- Accurate pricing with cache and 1M-context tiers.
- Team and server features: multi-user access, auth modes, retention, export/import and an API with keys.

## Ideas worth borrowing

1. A live event stream view: push hook events to the open session page over WebSocket/SSE as they arrive, before the transcript is uploaded.
2. A "light" local mode: the plugin auto-starts a single-user Log Hub on SQLite or embedded Postgres, with no Docker.
3. A session replay control that steps or plays through the timeline, including subagent branches.
4. Human-friendly generated session names shown alongside session IDs.
5. A per-agent swimlane strip above the session log: one lane per sub-agent, icon per event, zoom 1m/5m/10m/60m, click to jump to the event.
6. A "by prompt" cost table in session stats, with a hover tooltip breaking the cost into input/output/cache read/cache write at the applied rates.

## What the UI shows (screenshots)

- [Dashboard demo GIF, first frame](https://raw.githubusercontent.com/simple10/agents-observe/videos/docs/assets/dashboard.gif): left sidebar of projects with sessions grouped by Today/Yesterday, a green live dot and event count per session, and a "Connected" indicator. Main pane: "Agents 4 active" dropdown, category filter chips plus auto-generated per-tool chips, and an **Activity swimlane** with one row per agent (Main, dx-explorer, readme-explorer...) showing icon-coded events on a time axis with 1m/5m/10m/60m zoom. Below it an event list where every row carries the owning sub-agent name, tool, target path, success tick and timestamp.
- [Expanded row](https://raw.githubusercontent.com/simple10/agents-observe/main/docs/assets/dashboard2.png): a SubagentStop event expanded to show agent name and ID, task, full prompt, result markdown and a nested "Conversation thread" of that sub-agent's events. Swimlane bars span a sub-agent's lifetime. Toolbar has export/download, collapse and delete. Events count reads "613 / 1062 raw" (filtered vs raw).
- [Session token usage](https://raw.githubusercontent.com/simple10/agents-observe/main/docs/assets/session-token-usage1.png): session modal with Details / Stats / Labels tabs. Stats shows KPI tiles (requests, total input, total output, cache hit %, est. cost) and tables **by model**, **by agent** (type, duration, tools, requests, tokens, model, cost) and **by prompt** (each user prompt with duration, tool count, tokens, cost), with a cost-breakdown tooltip that splits cache write into 5m and 1h. The README text did not describe the per-prompt cost table or the Labels tab.

## Sources

- [simple10/agents-observe on GitHub (README)](https://github.com/simple10/agents-observe)
- [dashboard.gif](https://raw.githubusercontent.com/simple10/agents-observe/videos/docs/assets/dashboard.gif)
- [dashboard2.png](https://raw.githubusercontent.com/simple10/agents-observe/main/docs/assets/dashboard2.png)
- [session-token-usage1.png](https://raw.githubusercontent.com/simple10/agents-observe/main/docs/assets/session-token-usage1.png)
