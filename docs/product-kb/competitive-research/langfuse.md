---
type: "Research"
title: "Langfuse (+ Claude Code Observability Plugin) — feature parity with Log Hub"
description: "Open-source general LLM observability platform fed by a Stop-hook transcript parser for Claude Code; strong on generic trace UI, evals, alerts and API, but has no Claude-Code-specific analysis (harness, context anatomy, KB, change surface)."
tags:
  - competitive-research
  - llm-observability
timestamp: "2026-11-01T00:00:00+04:00"
---

# Langfuse + Claude Code Observability Plugin

- **What it is:** Langfuse is an open-source LLM engineering platform (tracing, evals, prompt management, datasets, dashboards). For Claude Code it offers a hook (plugin `langfuse-observability`, or a hand-installed `langfuse_hook.py` Stop hook) that parses the session transcript after each response and sends one trace per turn to Langfuse.
- **Vendor / author:** Langfuse GmbH (platform); the plugin repo lives under the `langfuse` GitHub org (docs call it a community plugin).
- **Links:** [langfuse.com](https://langfuse.com), [Claude Code integration docs](https://langfuse.com/integrations/other/claude-code), [platform repo](https://github.com/langfuse/langfuse), [plugin repo](https://github.com/langfuse/Claude-Observability-Plugin)
- **License / pricing:** Platform MIT except `ee` folders; plugin MIT. Self-host free (Docker Compose / Kubernetes). Cloud: Hobby free (50k units, 30 days, 2 users), Core $29/mo, Pro $199/mo (+$300 Teams add-on), Enterprise $2,499/mo; overage ~$8 per 100k units.
- **Maturity:** Platform ~36.8k GitHub stars, very active. Plugin: 29 stars, 155 commits, 9 open issues; last commit date not shown (as of 2026-11-01).
- **Data source:** Claude Code Stop hook that reads the JSONL transcript (incremental, per turn); Python (uv or python3 + `langfuse` SDK 4.x). Platform also accepts OTLP traces in general, but that is not the documented Claude Code path.
- **Deployment:** Langfuse Cloud (SaaS) or self-hosted; hook runs locally.

**Similar:** [Respan](https://www.respan.ai/integrations/claude-code) (hosted LLM observability) does the same thing — a Stop hook (now a Node hook installed by `respan integrate claude-code`) parses transcripts into traces with thinking, tool calls and tokens. Same parity profile as below, SaaS-only.

## Feature parity

| ID | Capability | Langfuse | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Stop hook parsing transcript only; no other hook events | Hook (all events) + full transcript + native OTel | LH ahead |
| C2 | Full content capture | Prompts, responses, thinking, tool inputs/outputs, optional images; text truncated at 20k chars by default | Yes, by design | LH ahead |
| C3 | Sub-agents / multi-agent tree | Plugin README lists skills and subagents; nested span tree is generic | Sub-agent tree, workflow rows, root vs tree metrics | LH ahead |
| C4 | Real-time / live view | Traces appear after each response (Stop hook) | Partial (OTel realtime; per-turn upload) | Parity |
| C5 | Native OpenTelemetry ingestion | Platform has an OTLP traces endpoint; not used for Claude Code native OTel metrics/logs | Built-in OTLP receiver, OTEL tabs | LH ahead |
| A1 | Turn-by-turn session viewer | Generic trace/span tree; session page is a chat-style replay (user/assistant bubbles, collapsible reasoning and tool calls) with a per-trace outline sidebar and session totals (traces, duration, cost, tokens); no Claude-Code-specific renderers (Bash, diffs) | Rich Claude Code renderers | LH ahead |
| A2 | Tokens & cost incl. cache | Token usage + cost per generation via Langfuse model price table | Own pricing, live price sync, 1M tiers | Parity |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | No | Yes | LH ahead |
| A5 | Tool / MCP monitoring | Tool spans with I/O and timing; no outcome/permission-denial attribution | Yes, with outcome + permission attribution | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | No | Yes | LH ahead |
| A8 | Recommendations / cost advisor | No (LLM-as-judge evals could be built by user) | Turn-end cost advisor | LH ahead |
| A9 | Dashboards / trends | Custom dashboards (any metric, filters, all plans) | Analytics timeline, exec report, export | Parity |
| A10 | Productivity / ROI metrics | No PR/commit/accept-rate metrics | Limited | Parity |
| A11 | Alerts / budgets | Alerts (2–100 by plan), spend alerts by email | No | Competitor ahead |
| T1 | Team views + access control | Orgs/projects, org RBAC; project RBAC on Pro+Teams/Enterprise | Teams, transparent/restricted, owner-only raw logs | Parity |
| T2 | Authentication options | Email/password, OAuth; enterprise SSO (Okta, Entra), SCIM on Enterprise | none/identify, password, email confirm, Azure OAuth | Competitor ahead |
| T3 | Self-hosted / offline | Self-hostable (Docker/K8s); hook needs uv/PyPI at install; offline not documented | Fully offline incl. docs | LH ahead |
| T4 | Data retention controls | Custom retention on Pro/Enterprise (cloud) | Yes | Parity |
| T5 | Export / import sessions | Export via API/UI; import of sessions not documented | Yes | LH ahead |
| T6 | Install effort | `claude plugin marketplace add` + install + configure keys; needs uv/Python and a Langfuse instance | Docker one-liner + `npx` per project | Parity |
| T7 | Agents besides Claude Code | Any LLM app/framework (SDKs, OTel, many integrations) | None | Competitor ahead |
| T8 | License / pricing | MIT core (`ee` excluded), free self-host, paid cloud tiers | Free, MIT | Parity |
| T9 | Query / API access | Public REST API, MCP server, CLI (all plans) | REST API with keys | Competitor ahead |

## Where it is ahead of Log Hub

- Alerts, including email spend alerts with thresholds (Log Hub has no alerting).
- Custom dashboards: user-defined charts over any trace metric with filters.
- Evaluation tooling: LLM-as-judge, human annotation queues, datasets, experiments — scores attached to traces/sessions.
- MCP server and CLI for querying observability data from an agent; public API on all plans.
- Enterprise identity: Okta/Entra SSO, SSO enforcement, SCIM, audit logs.
- Covers any LLM application, so teams can see Claude Code alongside their own LLM products in one tool.

## Where Log Hub is ahead

- Claude-Code-specific analytics: context anatomy, harness usage/compare, OKF KB usage, change surface, cost advisor.
- Richer capture: all hook events, untruncated content, native OTel metrics/logs; tool outcome and permission-denial attribution.
- Session viewer built for Claude Code (Bash, edits, raw logs) vs a generic span tree.
- Fully offline/air-gapped product including docs; hook installs via `npx` with no Python/uv dependency and works on Windows (Langfuse script skips file locking on Windows).
- No usage-unit metering or paid tiers for team features.

## Ideas worth borrowing

1. Spend/budget alerts: per user/team/repo thresholds with email (Mailpit-compatible) notifications (closes A11).
2. MCP server over Log Hub's REST API so Claude Code can query its own session history and costs.
3. Scores/annotations on sessions and turns (human verdict + optional LLM-as-judge), filterable in analytics.
4. User-defined dashboard widgets (pick metric, group-by, filter) on top of the existing analytics timeline.
5. Session "outline" sidebar: a compact per-turn list (User message / Tool: X / 2x tool / Assistant message) next to the chat replay, with a session header strip of totals (turns, duration, cost, tokens, user) — fast navigation in long Claude Code sessions.

## What the UI shows (screenshots)

No screenshots of a Claude Code session exist: the plugin README has no images and the Langfuse Claude Code docs page only embeds a YouTube video. Generic platform screenshots reviewed (2 informative; 3 README banners skipped):

- [Trace view (platform README)](https://github.com/user-attachments/assets/8f6995b7-285f-441a-b52f-1331d13ceb45) — left: nested span tree with latency, tokens (prompt → completion) and cost per node, plus Timeline toggle, search and download; right: generation detail with chips (latency, env, cost, token counts, model link, sampling params), Preview / Scores / Log View tabs, Formatted/JSON toggle, "Corrected Output (Beta)" field, metadata table, and actions Add to datasets, Annotate, Playground, Add comment.
- [Session view (docs)](https://langfuse.com/images/docs/session.png) — chat-style replay of a multi-trace session: header with traces count, duration, cost, tokens and user; left outline listing each trace's steps (User message, Tool: name, "2x searchLangfuseDocs", Assistant message); right pane with message bubbles, collapsible "Reasoning" and tool-call rows, timestamps, "Show more"; actions Add to, Annotate, Comment. Not described in the README text.

## Sources

- [Langfuse Claude-Observability-Plugin (GitHub)](https://github.com/langfuse/Claude-Observability-Plugin)
- [Langfuse docs: Claude Code integration](https://langfuse.com/integrations/other/claude-code)
- [Langfuse pricing](https://langfuse.com/pricing)
- [Langfuse platform repo](https://github.com/langfuse/langfuse)
- [Screenshot: trace view](https://github.com/user-attachments/assets/8f6995b7-285f-441a-b52f-1331d13ceb45)
- [Screenshot: session view](https://langfuse.com/images/docs/session.png)
- [Respan: Claude Code integration](https://www.respan.ai/integrations/claude-code)
- [Respan docs: Claude Code](https://www.respan.ai/docs/integrations/claude-code)
- [Respan docs: coding agents / Claude Code (v2)](https://respan.ai/docs/integrations-v2/coding-agents/claude-code)
