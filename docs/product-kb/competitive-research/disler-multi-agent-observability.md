---
type: "Research"
title: "Multi-Agent Observability (disler) — feature parity with Log Hub"
description: "Local hook-event stream (Bun/SQLite/Vue) with a live multi-agent timeline; far ahead on real-time, far behind on cost, transcripts, harness and team features."
tags:
  - competitive-research
  - hook-dashboard
timestamp: "2026-11-01T00:00:00+04:00"
---

# Multi-Agent Observability (claude-code-hooks-multi-agent-observability)

- **What it is:** A reference/demo project: Python (uv) hook scripts POST every Claude Code hook event to a Bun server that stores them in SQLite and broadcasts over WebSocket to a Vue 3 dashboard with a live event timeline and pulse chart. Aimed at watching parallel agent swarms (Agent Teams) in real time.
- **Vendor / author:** IndyDevDan (GitHub `disler`), individual; tied to his paid "Tactical Agentic Coding" course.
- **Links:** [repo](https://github.com/disler/claude-code-hooks-multi-agent-observability), [README](https://github.com/disler/claude-code-hooks-multi-agent-observability/blob/main/README.md)
- **License / pricing:** Free; no LICENSE file detected by GitHub API (license unknown).
- **Maturity:** ~1.56k stars; last push 2026-02-08 (as of 2026-11-01). No releases; demo-grade.
- **Data source:** Hook events (12 types) via `send_event.py`; optional chat transcript attached on Stop (`--add-chat`).
- **Deployment:** Local (bun dev server + Vite client on localhost:5173); copy `.claude/` into each project.

## Feature parity

| ID | Capability | Multi-Agent Observability | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Hook events only (+ optional chat on Stop) | Hook + full transcript + OTel | LH ahead |
| C2 | Full content capture | Partial: hook payloads, chat on Stop | Yes, by design | LH ahead |
| C3 | Sub-agents / multi-agent | SubagentStart/Stop events, agent "swim lane" filter, Agent Teams task events | Sub-agent tree, workflow rows, root vs tree metrics | LH ahead |
| C4 | Real-time / live view | Yes: WebSocket push, live pulse chart, auto-scroll | Partial | Competitor ahead |
| C5 | Native OTel ingestion | No | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | Event timeline + chat transcript modal | Rich renderers | LH ahead |
| A2 | Tokens & cost | No | Yes | LH ahead |
| A3 | Context-window anatomy | No (status line script shows context usage only) | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP monitoring | Pre/PostToolUse, PostToolUseFailure, PermissionRequest events, MCP server detection; no aggregation | Yes, with outcome/permission attribution | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | No | Yes | LH ahead |
| A8 | Recommendations | No (only optional LLM per-event summaries) | Cost advisor | LH ahead |
| A9 | Dashboards / trends | Live 1/3/5-minute activity chart only | Timeline, reports, export | LH ahead |
| A10 | Productivity / ROI | No | Limited | LH ahead |
| A11 | Alerts / budgets | No (TTS voice notifications on events, not alerts) | No | Parity |
| T1 | Multi-user / access control | No (single local user) | Yes | LH ahead |
| T2 | Authentication | None | Several modes | LH ahead |
| T3 | Self-hosted / offline | Local; summaries/TTS need external APIs (optional) | Fully offline | LH ahead |
| T4 | Retention controls | No (`just db-reset` only) | Yes | LH ahead |
| T5 | Export / import | No | Yes | LH ahead |
| T6 | Install effort | Clone repo, install uv + bun, copy `.claude/`, edit `source-app` per project | Docker + `npx` | LH ahead |
| T7 | Other agents | Not documented (Claude Code hooks only) | None | Parity |
| T8 | License / pricing | Free; license unknown | Free, MIT | LH ahead |
| T9 | Query / API access | Unauthenticated REST (`/events/recent`, filter-options) + WS stream | REST API with keys | LH ahead |

## Where it is ahead of Log Hub

- True live push of every hook event (WebSocket) with a pulse chart of activity per session over the last 1/3/5 minutes; good for watching many parallel agents.
- Swim-lane/session colouring across several projects (`source-app`) in a single merged stream.
- Optional per-event one-line LLM summaries of tool calls.
- Agent Teams events (TaskCreate/TaskUpdate/SendMessage) shown as they flow between agents.
- Bundles guard hooks (blocks dangerous `rm -rf`) and TTS notifications. These are hook utilities, not observability features.

## Where Log Hub is ahead

- Cost/tokens, context anatomy, harness, KB and change-surface analysis; it has none of them.
- Full transcripts plus OTel instead of event fragments.
- Teams, auth, retention, export, offline docs, one-line install and a defined license.
- Persistent history and analytics; it only offers a live tail.

## Ideas worth borrowing

1. Live cross-session activity feed: push hook events over WebSocket/SSE as they arrive, merged across all of a user's active sessions.
2. Activity pulse chart (events/minute per session or agent) for the last few minutes, on the dashboard or realtime tab.
3. Per-agent swim-lane view of a multi-agent session (each sub-agent or team member in its own lane on a time axis).
4. Optional short summaries of tool calls in the event list (local or opt-in, so offline mode keeps working).
5. Icon-based pulse strip: each event drawn as a small tool/outcome glyph on the time axis, with consecutive identical events collapsed into an `xN` badge and a hover tooltip; denser and more readable than a bar chart.
6. Colour-coded left border per project/session in a merged event list, plus a "Connected" live indicator and running event count in the header.

## What the UI shows (screenshots)

- [app.png](https://raw.githubusercontent.com/disler/claude-code-hooks-multi-agent-observability/HEAD/images/app.png): single dark page, header "Multi-Agent Observability" with a green "Connected" indicator, event counter ("97 events") and theme toggle. Three dropdown filters (Source App, Session ID, Event Type). "Live Activity Pulse" strip with 1m/3m/5m toggles where each event is a tool/check icon on the time axis, repeated events collapsed to "x2"/"x3" badges, hover tooltip ("1 events (PreToolUse: 1)"). Below, an "Agent Event Stream": cards with project chip, short session id, event-type pill (PreToolUse, PostToolUse, Notification), tool + target (e.g. "Write index.html", "TodoWrite"), timestamp, and an AI one-line summary on the right; each card has a coloured left border per source app. No token, cost, duration or tree view is visible — confirms the table.
- [AgentDataFlowV2.gif](https://raw.githubusercontent.com/disler/claude-code-hooks-multi-agent-observability/HEAD/images/AgentDataFlowV2.gif) (first frame only): a near-blank dark title frame of an animated data-flow diagram; nothing informative.
- [claude-code-multi-agent-orchestration.png](https://raw.githubusercontent.com/disler/claude-code-hooks-multi-agent-observability/HEAD/images/claude-code-multi-agent-orchestration.png): "OPUS TEAMS" video thumbnail with eight coloured robot icons; marketing art, no product UI.

## Sources

- [GitHub repo](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- [README](https://github.com/disler/claude-code-hooks-multi-agent-observability/blob/main/README.md)
- GitHub API repo metadata (stars, last push, license), fetched 2026-11-01
- Screenshots: [app.png](https://raw.githubusercontent.com/disler/claude-code-hooks-multi-agent-observability/HEAD/images/app.png), [AgentDataFlowV2.gif](https://raw.githubusercontent.com/disler/claude-code-hooks-multi-agent-observability/HEAD/images/AgentDataFlowV2.gif), [claude-code-multi-agent-orchestration.png](https://raw.githubusercontent.com/disler/claude-code-hooks-multi-agent-observability/HEAD/images/claude-code-multi-agent-orchestration.png)
