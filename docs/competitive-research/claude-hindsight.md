---
type: "Research"
title: "Claude Hindsight — feature parity with Log Hub"
description: "Single-binary local transcript viewer + hook-driven live activity timeline for Claude Code; strong single-user UX (live SSE, TUI, 3D graph), no team/server story."
tags:
  - competitive-research
  - hook-dashboard
timestamp: "2026-11-01T00:00:00+04:00"
---

# Claude Hindsight

- **What it is:** Rust single binary that parses Claude Code JSONL transcripts in `~/.claude/projects/`, indexes them into SQLite and serves a web dashboard (React) plus a terminal UI. `integrate` installs Claude Code hooks for auto-indexing and a live Activity Timeline (SSE).
- **Vendor / author:** codestz (individual GitHub author)
- **Links:** [repo](https://github.com/codestz/claude-hindsight)
- **License / pricing:** MIT, free
- **Maturity:** about 22 stars, 2 forks, 224 commits as of 2026-11-01. The README did not show release dates.
- **Data source:** Local transcript files + hooks (session start/end, tool use, prompt submit, subagent, permission request) + optional OTLP receiver
- **Deployment:** Local CLI/binary (brew, cargo, prebuilt macOS/Linux). It runs offline.

Variants with the same local-viewer shape: Claudescope and claude-trace-replay (harrylettering) are also local Claude Code transcript viewers/replayers. They are single-user, read files from disk and have no server or team layer. These two were not researched in depth.

## Feature parity

| ID | Capability | Claude Hindsight | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Local JSONL + hooks + optional OTLP | Hook + JSONL upload + OTel | Parity |
| C2 | Full content capture | Yes (reads full local transcripts) | Yes | Parity |
| C3 | Sub-agents / multi-agent tree | Subagent nodes, colour-coded, per-model pricing | Sub-agent tree, workflow rows, root vs tree metrics | LH ahead |
| C4 | Real-time / live view | Yes: SSE live dashboard + hook Activity Timeline | Partial (OTel realtime, per-turn upload) | Competitor ahead |
| C5 | Native OTel ingestion | Optional OTLP receiver | Built-in OTLP receiver, OTEL tabs | Parity |
| A1 | Turn-by-turn viewer | Two-panel inspector, diffs, thinking, syntax highlight, 3D execution graph | Rich renderers | Parity |
| A2 | Tokens & cost incl. cache | Per-session/turn, model-aware pricing | Own pricing, live price sync, 1M tiers | LH ahead |
| A3 | Context-window anatomy | Not documented | Yes | LH ahead |
| A4 | Harness config analysis | Not documented | Yes | LH ahead |
| A5 | Tool / MCP monitoring | Top tools, MCP server usage, error filter | Outcomes + permission attribution | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | "Most accessed files" only | Change Surface | LH ahead |
| A8 | Recommendations | Not documented | Cost advisor | LH ahead |
| A9 | Dashboards / trends | Analytics dashboard, scope unclear | Timeline, exec report, export | LH ahead |
| A10 | Productivity / ROI | Not documented | Limited | Parity |
| A11 | Alerts / budgets | Not documented | No | Parity |
| T1 | Multi-user / team | No (single local user) | Yes | LH ahead |
| T2 | Authentication | None (local) | 4 modes incl. Azure OAuth | LH ahead |
| T3 | Self-hosted / offline | Fully local, offline | Fully offline | Parity |
| T4 | Retention controls | Not documented | Yes | LH ahead |
| T5 | Export / import | HTML report export per session | Export/import sessions | LH ahead |
| T6 | Install effort | One binary (brew/cargo), `integrate` command | Docker server + `npx` per project | Competitor ahead |
| T7 | Other agents | Claude Code only | Claude Code only | Parity |
| T8 | License / pricing | MIT, free | MIT, free | Parity |
| T9 | Query/API access | CLI (`search`, `export`). No documented REST API | REST API with keys | LH ahead |

## Where it is ahead of Log Hub

- Live view: the dashboard updates over SSE as Claude works, and an Activity Timeline shows hook events in real time.
- Terminal UI (ratatui) for browsing sessions without a browser.
- 3D execution graph of session nodes (react-force-graph-3d).
- Installs as one binary with zero infrastructure. `integrate` wires up the hooks in one step.
- Indexes existing history: it reads all past `~/.claude/projects/` transcripts, including sessions that ran before install.
- `export <id>` writes a standalone HTML report for a single session.

## Where Log Hub is ahead

- Team/multi-user server with access control, auth modes and retention.
- Context anatomy, harness analysis, KB usage, change surface and cost advisor are all missing from Hindsight.
- Deeper sub-agent/workflow tree metrics, plus permission and outcome attribution for tools.
- Pricing is more complete: live price sync and 1M-context tiers.
- REST API with API keys, plus session import/export between installs.

## Ideas worth borrowing

- Live session view: stream hook events to the web app over SSE so an in-progress session updates without waiting for the per-turn upload.
- Backfill import of a user's existing `~/.claude/projects/` history from the installer/CLI.
- Standalone single-session HTML export, shareable offline.
- A CLI `search` over your own sessions (by tool or by error).

## What the UI shows (screenshots)

- No screenshots found (checked 2026-11-01): the README has only CI/crates/license/rust badges, the repo tree has no PNG/JPG/GIF/WebP files, and the project site (codestz.github.io/claude-hindsight) has no `<img>` screenshots, only text, CSS and an SVG favicon. The verdicts above still rest on the README text alone.

## Sources

- [codestz/claude-hindsight README](https://github.com/codestz/claude-hindsight)
