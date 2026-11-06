---
type: "Research"
title: "Claude Code Usage Monitor — feature parity with Log Hub"
description: "Local Python terminal monitor of Claude Code token usage with burn-rate and plan-limit predictions; ahead of Log Hub only on limits/burn-rate alerting, far behind on depth, content and team features."
tags:
  - competitive-research
  - local-cli
timestamp: "2026-11-01T00:00:00+04:00"
---

# Claude Code Usage Monitor

- **What it is:** A real-time terminal UI (Python, `claude-monitor` / `ccm`) that reads Claude Code's local usage data and shows token/cost consumption against subscription-plan limits, with burn rate, session-reset predictions and warnings.
- **Vendor / author:** Maciek (GitHub `Maciek-roboblog`), independent open-source project.
- **Links:** [GitHub repo / README](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor); PyPI package `claude-monitor`. No separate docs site found.
- **License / pricing:** MIT, free.
- **Maturity:** ~8.8k stars, 463 forks (as of 2026-11-01); README headlines v4.0.0; exact last release date not documented on the captured page.
- **Data source:** Local Claude Code usage files (`~/.claude` JSONL usage), official `rate_limits` via a statusline hook (`--statusline`), optional experimental Anthropic OAuth usage API (`--api`).
- **Deployment:** Local CLI (Python 3.9+, install via `uv tool` / `pip` / `pipx`).

## Feature parity

| ID | Capability | Claude Code Usage Monitor | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Local usage files + statusline rate_limits + optional OAuth usage API | Hook + full transcript upload + native OTel | LH ahead |
| C2 | Full content capture | No (token/usage counts only) | Yes | LH ahead |
| C3 | Sub-agents / multi-agent tree | Not documented | Yes | LH ahead |
| C4 | Real-time / live view | Yes: live-refreshing terminal dashboard (default realtime view) | Partial | Competitor ahead |
| C5 | Native OTel ingestion | No | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | No (an "entries" usage view only) | Yes | LH ahead |
| A2 | Tokens & cost incl. cache | Yes, per session/day/month (aggregate level); live view shows cost, tokens and message count vs. limit plus a Sonnet/Opus model-split bar | Yes, per session/turn with tiers | LH ahead |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | No | Yes | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | No | Yes | LH ahead |
| A8 | Recommendations / cost advisor | Pace labels only ("reset-aware pace") | Yes | LH ahead |
| A9 | Dashboards / trends | Daily / monthly / sessions / burn-rate views; opt-in local warehouse for history | Yes | LH ahead |
| A10 | Productivity / ROI metrics | No | Limited | LH ahead |
| A11 | Alerts / budgets / burn-rate prediction | Yes: burn rate (tokens/min, last hour) and cost rate ($/min), session-expiry/limit-hit prediction, plan limits (Pro/Max5/Max20/Custom P90), warnings, `--once` exit codes 10/11 | No | Competitor ahead |
| T1 | Multi-user / team views | No (single user) | Yes | LH ahead |
| T2 | Authentication options | n/a (local tool) | Several modes | n/a |
| T3 | Self-hosted / offline | Yes, local, works offline (except opt-in `--api`) | Yes | Parity |
| T4 | Data retention controls | Not documented | Yes | LH ahead |
| T5 | Export / import sessions | JSON/CSV usage output; no session import | Yes | LH ahead |
| T6 | Install effort | One `uv tool install`, no server | Docker server + `npx` per project | Competitor ahead |
| T7 | Other agents | None (Claude Code only) | None | Parity |
| T8 | License / pricing | Free, MIT | Free, MIT | Parity |
| T9 | Query/API access | Machine-readable JSON/CSV and state files for status bars; no API | REST API with keys | LH ahead |

## Where it is ahead of Log Hub

- Burn-rate calculation (tokens/min over the last hour) and prediction of when the 5-hour session window / plan limit will be hit.
- Plan-aware limits (Pro, Max5, Max20, Custom = P90 of own past usage) with warnings.
- Uses official `rate_limits` captured from the Claude Code statusline, falling back to labelled estimates.
- Scriptable alerting: `--once` mode with exit codes (10 near-limit, 11 limit hit), terminal-title updates, state files for status bars.
- Truly live terminal view and zero-infrastructure install.

## Where Log Hub is ahead

- Full content capture and turn-by-turn transcript viewer; sub-agent/workflow tree.
- Explains *why* sessions cost what they do: context anatomy, harness usage, tool/MCP outcomes, KB usage, change surface, cost advisor.
- Native OTel ingestion, team views with access control, auth modes, retention, export/import, REST API.

## Ideas worth borrowing

1. Burn-rate and limit forecast per user: tokens/min over the last hour and a predicted "limit hit at HH:MM" for the current 5-hour window, with plan presets and a P90-of-history custom limit.
2. Capture official `rate_limits` through the hook's statusline integration and show remaining quota vs. estimate in the UI.
3. Budget/limit alerts (per user/team), plus a small CLI or endpoint returning near-limit status codes for scripting.
4. A stacked "limit gauges" panel: one progress bar per budget dimension (cost, tokens, messages, time to reset) with a green/yellow status dot each, plus a one-line model-mix bar — a compact header for a user/team usage page.
5. A compact "pace" indicator (on-track / ahead of reset) on the session list or OTel realtime tab.

## What the UI shows (screenshots)

- [Current live view (scnew.png)](https://raw.githubusercontent.com/Maciek-roboblog/Claude-Code-Usage-Monitor/main/doc/scnew.png): header with plan and timezone (`custom | europe/warsaw`); "Session-Based Dynamic Limits — based on your historical usage patterns when hitting limits (P90)"; four progress bars with status dots — Cost Usage ($44.49 / $164.32), Token Usage (353,830 / 853,171), Messages Usage (1033 / 2,745), Time to Reset (2h 21m); a Model Distribution bar (Sonnet 96.6% / Opus 3.4%); Burn Rate (tokens/min) and Cost Rate ($/min); Predictions ("Tokens will run out: 09:45", "Limit resets at: 05:00"); footer clock and "Active session" status. The message-count limit, cost rate and model-split bar are not spelled out in the README text.
- [Older v1-style view (sc.png)](https://raw.githubusercontent.com/Maciek-roboblog/Claude-Code-Usage-Monitor/main/doc/sc.png): "Claude Token Monitor" with only Token Usage and Time to Reset bars, tokens used / limit / left, burn rate, Predicted End and Token Reset times, and a status line ("Smooth sailing..."). Shows the tool grew from tokens-only to cost/messages/model views.
- No screenshots of the daily/monthly/sessions table views were found; those remain verified only from README text.

## Sources

- [Claude-Code-Usage-Monitor GitHub README](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)
- [Screenshot scnew.png](https://raw.githubusercontent.com/Maciek-roboblog/Claude-Code-Usage-Monitor/main/doc/scnew.png)
- [Screenshot sc.png](https://raw.githubusercontent.com/Maciek-roboblog/Claude-Code-Usage-Monitor/main/doc/sc.png)
