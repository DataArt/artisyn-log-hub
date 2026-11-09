---
type: "Research"
title: "Beezi Analytics — feature parity with Log Hub"
description: "SaaS cost and practice analytics for Claude Code, Codex and Copilot via a hook plugin that sends summaries only; leads on budgets, subscription-vs-API value, waiting-time breakdown and multi-agent support, has no session content and no self-hosting."
tags:
  - competitive-research
  - hook-dashboard
  - saas
timestamp: "2026-11-09T00:00:00+04:00"
---

# Beezi Analytics

- **What it is:** "Observability for AI-assisted delivery." A plugin in the coding tool reads local
  session records through hooks, sends a **summary** (no prompts, responses or file contents) to a hosted
  workspace, which shows cost, budget, time and practice analytics. Two advisor "lenses": **AI Coach**
  (developer) and **AI Consultant** (management / FinOps). A separate "Platform" product does Jira /
  Azure DevOps driven task orchestration (plan → code → PR); it is out of Log Hub's scope.
- **Vendor / author:** Beezi, Inc. (privacy policy: Air UA Ltd, DBA Beezi). Commercial.
- **Links:** [site](https://beezi.ai/), [docs](https://docs.beezi.ai/),
  [Claude plugin](https://docs.beezi.ai/coding-tool/beezi-claude-plugin/),
  [Export API](https://docs.beezi.ai/api/analytics-export-api/)
- **License / pricing:** Proprietary. Individual $0 (1 seat, 30-day audit, AI Coach); Team $7.99/user/month
  (RBAC, AI Consultant, "Full report"); Custom (SSO, data residency, custom retention, SDLC orchestration).
- **Maturity:** Early commercial product; no SOC 2 ("Not yet"). Docs and homepage disagree on which agents
  are supported (homepage: Claude Code, Codex, Cursor "coming soon"; docs also have a Copilot plugin).
- **Data source:** Plugin hooks (Claude: SessionStart, UserPromptSubmit, PostToolUse, PermissionRequest,
  PreCompact, SubagentStop, Stop, StopFailure, SessionEnd) plus reading local session files; git remote and
  branch for attribution. No OTel, no proxy. Imports up to 30 days of existing sessions on install.
- **Deployment:** SaaS only (app/api/clerk.beezi.ai). No self-hosted or offline mode documented.

## Feature parity

| ID | Capability | Beezi | Log Hub | Verdict |
|---|---|---|---|---|
| C1 | Data source | Hook plugin + local session files, summaries only | Hook + transcripts + OTel | LH ahead |
| C2 | Full content capture | No by design: prompts/responses/files "never leave the machine" (exceptions: session name from the first prompt, error text up to 1,000 chars) | Yes | LH ahead |
| C3 | Sub-agents / multi-agent tree | Cost by subagent; no tree | Yes | LH ahead |
| C4 | Real-time view | Not documented | Polling, near-live | n/a |
| C5 | Native OTel ingestion | No | Yes | LH ahead |
| A1 | Turn-by-turn log viewer | No; a per-session "receipt" (model, tokens, cache, time, cost, repo, changes, tools) | Yes | LH ahead |
| A2 | Tokens & cost per session/turn | Per session, plus **actual billing vs API-equivalent** per plan and provider; no per-turn | Per session and per turn, API price only | Parity (Beezi ahead on the billing-plan dimension) |
| A3 | Context-window anatomy | No | Yes | LH ahead |
| A4 | Harness config analysis | Only counts changes to CLAUDE.md / AGENTS.md (Copilot plugin) | Yes | LH ahead |
| A5 | Tool / MCP call monitoring | Tool list per session, "MCP usage" in Quick Audit; no outcomes | Yes, with outcomes | LH ahead |
| A6 | KB usage analysis | No | Yes | LH ahead |
| A7 | Code change surface | Files and lines added/removed, files per extension | Yes, per session | Parity |
| A8 | Recommendations / advisor | AI Coach (plan and model fit, idle time), AI Consultant (team: "more work or more expensive habits"), Quick Audit (cost per session, model mix, skills, MCP); `/beezi:analytics` gives up to 3 recommendations, worded by the user's own model | Turn-end cost advisor | **Competitor ahead** (team-level and plan-fit advice) |
| A9 | Dashboards / trends | Template dashboards with widgets, PDF export (homepage claim) | Analytics views, Executive Summary PDF | Parity |
| A10 | Productivity / ROI metrics | Session timeline: working / planning / **waiting for you** (split: plan approval, question, tool approval, next instruction) / idle / break; **blocked time by rate limits**; personal "estimating baseline" | Work time, idle gaps, commit/PR/lines counters | **Competitor ahead** (waiting breakdown, rate-limit time) |
| A11 | Alerts / budgets | Monthly budget, month-end forecast, early overspend flag | No | **Competitor ahead** |
| T1 | Multi-user / team views | Owner / Admin / Supervisor / member, groups; supervisors see only their groups | Teams with roles | Parity |
| T2 | Authentication options | Clerk sign-in; SSO only on Custom tier (protocol not stated) | 4 modes incl. Azure OAuth | Parity |
| T3 | Self-hosted / offline | No (SaaS only) | Yes | LH ahead |
| T4 | Data retention controls | Kept while the account is active; custom retention on Custom tier | Yes | Parity |
| T5 | Export / import | Export API (JSON datasets), no session export/import | Session export/import + REST API | LH ahead |
| T6 | Install effort | `/plugin install beezi@beezi` + `/beezi:login`, no server; "under 2 min" | Docker server + one `npx` line per repo | **Competitor ahead** (no server to run) |
| T7 | Other agents supported | Claude Code, Codex, GitHub Copilot (docs), Claude Desktop Cowork (partial); Cursor announced | Claude Code only | **Competitor ahead** |
| T8 | License / pricing | Free single seat, $7.99/user team, closed | Free MIT, self-hosted | LH ahead |
| T9 | Query/API access | Analytics Export API (11 + 5 datasets, cursor pagination, audited) and an **MCP bridge** for the personal summary | REST API | **Competitor ahead** (MCP) |

Competitor ahead: **6** (A8, A10, A11, T6, T7, T9).

## Beyond the 25 rows

Things Beezi has that the standard rows do not capture:

- **Billing-plan detection.** The plugin records which plan pays (Max, Pro, API key …) and a credential
  fingerprint (first 12 + last 4 chars + length) to tell subscriptions apart. This powers "subscription
  savings vs API" and the plan-fit advice.
- **Tracking modes per workspace:** live, audit-only, off; enforced by the plugin locally.
- **Routing rules:** one machine → several accounts / workspaces, per-repo or per-folder routing, and a
  "Don't track" rule.
- **Claude Desktop Cowork sessions** read from the desktop app's local cache (Windows/macOS, incomplete).
- **"Shadow AI" access view:** which AI tools, MCP servers and integrations touch company data (homepage
  claim only; no feature page found).
- **Platform (SDLC orchestration):** Jira/Azure DevOps tickets → AI plan and code → PR. Not a telemetry
  feature; out of Log Hub's scope.

## Where it is ahead of Log Hub

- Budgets with a month-end forecast and an overspend flag (A11 — the gap already ranked P1 in the
  [gap-closing plan](gap-closing-plan.md)).
- The money view a buyer asks for first: **actual billing vs API-equivalent** per plan, i.e. "how much the
  subscription saves", and advice on whether the plan and model fit.
- A finer time model: *why* a session waited (plan approval, question, tool permission, user's next prompt)
  and how long it was blocked by rate limits.
- Supports Codex and Copilot; Cursor is announced.
- Nothing to host; two-minute install; free single-seat tier; an MCP bridge so the agent can ask about its
  own usage.

## Where Log Hub is ahead

- Everything that needs content: turn log, transcripts, context anatomy, harness and KB analysis, tool
  outcomes, sub-agent tree. Beezi says *how much and where the time went*; Log Hub says *why*.
- Self-hosted and offline; no data leaves the company. Beezi sends hostname, Claude account email and ID,
  org ID, subscription type and limit levels to its SaaS.
- OTel ingestion; session export/import; MIT and free for teams.

## Ideas worth borrowing

- **Waiting-time breakdown** (cheap, data already stored): split idle time in a session by its cause —
  `AskUserQuestion`, `ExitPlanMode` (plan approval), a permission prompt, or simply waiting for the next
  prompt — from the tool-call timestamps Log Hub already parses. Extends the
  [work-time](../../knowledgebase/algorithms/work-time.md) algorithm.
- **Subscription vs API-equivalent cost.** Log Hub already computes API-price cost; what is missing is
  which plan pays. Needs research on where the hook can read the plan type without collecting credentials
  (Beezi's credential fingerprint is a privacy pattern to avoid copying blindly).
- **Rate-limit blocked time** — same as README idea 7 (capture `rate_limits`).
- **Budget with a month-end forecast** — confirms P1; Beezi's minimal version (one monthly number, a
  forecast line, an overspend flag) is a good first increment.
- **Pause / audit-only tracking mode** for a repo, switched from the server, without uninstalling the hook.
- **MCP bridge** for "my usage this month" — confirms P5.

## Sources

- [beezi.ai](https://beezi.ai/) (homepage, pricing, FAQ), read 2026-11-09
- [Privacy policy](https://beezi.ai/privacy-policy)
- [Docs home](https://docs.beezi.ai/)
- [Security policy](https://docs.beezi.ai/security/security-policy/)
- [Claude Code plugin](https://docs.beezi.ai/coding-tool/beezi-claude-plugin/)
- [Codex plugin](https://docs.beezi.ai/coding-tool/beezi-codex-plugin/)
- [Copilot plugin](https://docs.beezi.ai/coding-tool/beezi-copilot-plugin/)
- [Analytics Export API](https://docs.beezi.ai/api/analytics-export-api/)
- [Jira integration](https://docs.beezi.ai/integrations/jira/)

Not checked: screenshots pass, the IDE extension page, Slack / Azure DevOps pages, blog. No account was
created and nothing was installed.
