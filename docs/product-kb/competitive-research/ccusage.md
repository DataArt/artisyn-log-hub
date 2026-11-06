---
type: "Research"
title: "ccusage — feature parity with Log Hub"
description: "Popular MIT local CLI that reports token/cost usage from local agent JSONL files; strong at quick cost reports, 5-hour block burn-rate and multi-agent coverage, but no content, harness or team analysis"
tags:
  - competitive-research
  - local-cli
timestamp: "2026-11-01T00:00:00+04:00"
---

# ccusage

- **What it is:** A command-line tool (`npx ccusage`) that reads the local JSONL session files of Claude Code and other coding-agent CLIs and prints daily, weekly, monthly, session and 5-hour billing-block reports of tokens and USD cost. It also has a beta `statusline` command for the Claude Code status bar.
- **Vendor / author:** ryoppippi and community contributors. The repo now lives under the `ccusage/ccusage` org.
- **Links:** [site/docs](https://ccusage.com/guide/), [repo](https://github.com/ryoppippi/ccusage), [npm](https://www.npmjs.com/package/ccusage)
- **License / pricing:** MIT, free.
- **Maturity:** About 19.3k stars, 904 forks and about 2,885 commits as of 2026-11-01. The last release date could not be confirmed from the repo page. v18.0.0 removed `blocks --live`.
- **Data source:** Local transcript files (`~/.claude/projects/**/*.jsonl` and the equivalents for other agents) plus a LiteLLM-based pricing table that can be cached for `--offline` use.
- **Deployment:** Local CLI only. No server.
- **Forks/extensions:** [ccusage-live](https://www.npmjs.com/package/ccusage-live) and [ccusage-team](https://cdn.jsdelivr.net/npm/ccusage-team@1.0.27/README.en.md) are third-party forks. Their commands, under the `ccul` alias, are `team create`, `team join` and `team sync`, which upload usage to a shared team database, plus a live blocks view. They are small projects and their maintenance status is unknown.

## Feature parity

| ID | Capability | ccusage | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Local JSONL files only, read on demand | Hook + full transcript upload + native OTel | LH ahead |
| C2 | Full content capture | No. Reads only usage/token fields and shows no content | Yes | LH ahead |
| C3 | Sub-agents / multi-agent tree | Not documented. Usage is summed per session/project | Sub-agent tree, workflow rows | LH ahead |
| C4 | Real-time / live view | Statusline (beta). `blocks --live` was removed in v18 (forks still offer it) | Partial (OTel realtime tab) | Parity |
| C5 | Native OTel ingestion | No | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | No | Yes | LH ahead |
| A2 | Tokens & cost incl. cache | Yes (screenshots: Input/Output/Cache Create/Cache Read/Reasoning/Total/Cost columns): per day/week/month/session/block, cache tokens, `--breakdown` per model, cost modes, custom pricing | Yes, per session/turn, 1M tiers | Parity |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | No | Yes | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | No | Yes | LH ahead |
| A8 | Recommendations / cost advisor | No | Yes | LH ahead |
| A9 | Dashboards / trends | Text tables by day/week/month, JSON output | Web timeline, executive report, export | LH ahead |
| A10 | Productivity / ROI | No | Limited | LH ahead |
| A11 | Alerts / budgets / burn rate | Yes: 5-hour blocks with `--token-limit`, warning bars, burn rate (tokens/min, cost/h) and end-of-block projections | No | Competitor ahead |
| T1 | Multi-user / team | No in core. Only the third-party `ccusage-live`/`-team` forks | Yes | LH ahead |
| T2 | Authentication | n/a (local tool) | 4 modes | n/a |
| T3 | Offline | Yes (`--offline` cached pricing) | Yes | Parity |
| T4 | Retention controls | n/a (depends on Claude Code's local file cleanup) | Yes | LH ahead |
| T5 | Export / import | JSON export only | Export + import | LH ahead |
| T6 | Install effort | `npx ccusage`, zero config | Docker server + `npx` hook per project | Competitor ahead |
| T7 | Other agents | Many: Codex, OpenCode, Amp, Gemini CLI, Copilot CLI, Goose, Qwen, Kimi and others | None | Competitor ahead |
| T8 | License / pricing | MIT, free | MIT, free | Parity |
| T9 | Query / API access | JSON output from the CLI. No API documented | REST API with keys | LH ahead |

## Where it is ahead of Log Hub

- 5-hour billing-block view with a token limit (`-t max` = the highest previous block), color-coded progress, burn rate and projected end-of-block tokens and cost.
- Zero-setup install: one `npx` command reads history that already exists, including sessions recorded before installation.
- Covers many coding agents in one combined report.
- Claude Code `statusline` integration shows cost in the terminal while you work.
- Calendar rollups (daily/weekly/monthly) with a per-model `--breakdown`, plus timezone and `--since`/`--until` filters.

## Where Log Hub is ahead

- Full content capture and a turn-by-turn viewer. ccusage shows numbers only.
- Explains *why* a session costs what it does: context anatomy, harness, tools/MCP, KB usage, change surface and the cost advisor.
- Sub-agent tree, OTel ingestion, team views with access control, a REST API and retention controls.

## Ideas worth borrowing

1. **5-hour block / burn-rate view:** group usage into Claude's 5-hour windows, with burn rate, a projected block cost and a limit bar where `max` means the highest previous block. This would close part of A11.
2. **Backfill from existing local JSONL:** on hook install, offer to upload past sessions from `~/.claude/projects`, so the first dashboard isn't empty.
3. **Statusline command in the hook:** show the cost of the current session and today from Log Hub data in the Claude Code status bar.
4. **Calendar rollup report with per-model breakdown**, exportable as JSON or CSV.
5. **Grouped rollup rows (from the screenshots):** one "All" row per day with indented per-agent (or per-model/per-repo) sub-rows, the model list in its own column and a Total footer. This is a compact way to show a day's cost split without a chart.

## What the UI shows (screenshots)

All four images in the repo's `docs/public/` are terminal screenshots. There is no web UI and no chart.

- [Combined daily report](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/screenshot.png): a "Coding Agent Usage Report - Daily" header that lists the detected agents (Amp, Claude, Codex, OpenCode, pi-agent). Each date has an "All" row plus indented per-agent sub-rows (Claude/opus-4-7, Codex/gpt-5.5, OpenCode). The columns are Input, Output, Cache Create, Cache Read, Total Tokens and Cost (USD), with a Total row at the bottom. The README text does not describe this cross-agent per-day split.
- [`blocks-live.png`](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/blocks-live.png): despite the file name, this shows a Codex daily report with "(Timezone: Europe/London)" in the title, a "Reasoning" token column, a "gpt-5 (fallback)" pricing label and a log line saying "Loaded pricing for 1525 models" from LiteLLM. It is not a live blocks view.
- [Codex daily report](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/codex-cli.jpeg): `codex -s 20260507` (a since-date filter) gives a daily table that lists several models per day and has a Reasoning column.
- [Codex monthly report](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/codex-cli-monthly.jpeg): one row per month from 2025-09 to 2026-05, with that month's models and token/cost totals.
- None of the images shows the 5-hour blocks view, the burn-rate bars or the statusline. The A11 and C4 verdicts rest on the docs text only.

## Sources

- [GitHub: ryoppippi/ccusage](https://github.com/ryoppippi/ccusage)
- [ccusage guide](https://ccusage.com/guide/)
- [ccusage blocks reports](https://ccusage.com/guide/blocks-reports)
- [npm: ccusage-live](https://npmjs.com/package/ccusage-live)
- [ccusage-live README (unpkg)](https://app.unpkg.com/ccusage-live@1.0.7/files/README.md)
- [ccusage-team README (jsDelivr)](https://cdn.jsdelivr.net/npm/ccusage-team@1.0.27/README.en.md)
- [Screenshot: combined daily report](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/screenshot.png)
- [Screenshot: blocks-live.png (Codex daily report)](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/blocks-live.png)
- [Screenshot: Codex daily report](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/codex-cli.jpeg)
- [Screenshot: Codex monthly report](https://cdn.jsdelivr.net/gh/ccusage/ccusage@main/docs/public/codex-cli-monthly.jpeg)
