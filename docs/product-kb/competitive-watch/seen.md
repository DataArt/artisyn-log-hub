---
type: "Reference"
title: "Competitive watch — seen log"
description: "Every competitor item (release, blog post, docs change, new tool) the morning check has already seen, newest first, with its relevance and verdict for Log Hub."
tags:
  - competitive-research
timestamp: "2026-11-06T10:00:00+04:00"
---

# Seen log

Newest first. One row per item; the URL is the identity. `Relevance`: `high` (a feature Log Hub
lacks or a direct positioning threat), `medium` (worth knowing, maybe borrow), `misc` (on topic
but not a competitor feature — community posts, user complaints, tips, home-made tools; "may be
interesting"), `low` (noise, kept so it is not reported again). `Verdict`: what to do — `none`, `idea: <short>`, `task: <task id>`, or
`study: <file in docs/product-kb/competitive-research/ updated>`.

Baseline: everything published before 2026-11-01 is in the parity study and is not repeated here.

| Seen | Source id | Published | Item | URL | Relevance | Verdict |
|---|---|---|---|---|---|---|
| 2026-11-06 | hn | 2026-11-06 | Ask HN: Engineers Focus Using AI — HN 1 / 0 | https://news.ycombinator.com/item?id=50390444 | low | none |
| 2026-11-06 | hn | 2026-11-05 | Show HN: KeepPlain – trace code to the agent session and open the matching dialogue segment; records Claude Code/Codex/Cursor/Pi/Antigravity sessions to a SaaS (searchable past work, rules carried into new sessions, token counts per model, usage-limit-based hand-off to another agent; per-seat team plan) — HN 2 / 0 | https://github.com/keepplain/keepplain-plugin | misc | idea: reverse lookup from a file/line (or commit) to the session and transcript segment that wrote it — Log Hub stores Edit/Write tool calls per session but has no such lookup |
| 2026-11-06 | hn | 2026-11-05 | Ask HN: Are you building an AI company brain? — HN 5 / 3 | https://news.ycombinator.com/item?id=50379710 | low | none |
| 2026-11-06 | hn | 2026-11-05 | Show HN: Ski – voice-first multilingual coding harness — HN 2 / 0 | https://justski.it/ | low | none |
| 2026-11-06 | hn | 2026-11-05 | Show HN: Penthera – offline rule-based pentest scanner — HN 1 / 0 | https://github.com/danoszz/penthera | low | none |
| 2026-11-06 | grafana-cloud | 2026-11 | Grafana Cloud Claude Code integration 1.0.2: updated mixin dependencies only (dashboards unchanged: Claude Code, stats, usage breakdown, productivity) | https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-claude-code/ (1.0.2) | low | none |
| 2026-11-05 | langfuse-changelog | 2026-11-04 | Langfuse AI Gateway public beta: proxy for Claude Code / Codex / Copilot CLI / OpenCode with per-member keys, per-user/key/model cost analytics, model allowlists, key metadata (team, cost center) on every generation; self-hostable | https://langfuse.com/changelog/2026-11-04-ai-gateway-public-beta | medium | idea: optional team / cost-center tag per hook install so cost can be grouped by it; gateway capture itself is a different model (no transcript/harness), positioning only |
| 2026-11-05 | hn | 2026-11-04 | Ravenry: local board for every Claude Code/Codex session (needs-you grouping, context fill, hand-off at half context, rule suggestions from repeated corrections) — HN 2 pts / 0 comments | https://github.com/patoles/ravenry | misc | idea: "corrections you keep typing" mined from transcripts as CLAUDE.md rule suggestions; not a cost competitor |
| 2026-11-05 | hn | 2026-11-04 | Background subagents in Claude Code now use less of your usage limit (ClaudeDevs) — HN 2 / 0 | https://twitter.com/ClaudeDevs/status/2118063143167693011 | misc | none (cc news sub-check owns Claude Code changes; may affect subagent cost share) |
| 2026-11-05 | hn | 2026-11-04 | Running 17 Claude Code bots in a real company for $100/month — HN 13 / 5 | https://botsinproduction.com/blog/what-10-claude-code-bots-cost-per-month/ | misc | none |
| 2026-11-05 | hn | 2026-11-04 | Ask HN: What's your current AI agentic setup? — HN 329 / 345 | https://news.ycombinator.com/item?id=50366117 | low | none |
| 2026-11-05 | hn | 2026-11-04 | Tell HN: Claude Code queries raw GitHub token on startup — HN 4 / 2 | https://news.ycombinator.com/item?id=50365442 | low | none |
| 2026-11-05 | hn | 2026-11-04 | Avoiding Being a Meat Proxy with Claude Code Mods — HN 4 / 0 | https://www.jvt.me/posts/2026/11/03/honest-claude-meatproxy/ | low | none |
| 2026-11-05 | hn | 2026-11-04 | Accenture contractor linked personal Claude agent to Pentagon system — HN 8 / 1 | https://www.ibtimes.co.uk/claude-code-agent-pentagon-niprnet-access-allegations-1829425 | low | none |
| 2026-11-05 | hn | 2026-11-04 | Show HN: Gauge – CLI to recursively improve your docs — HN 31 / 4 | https://github.com/gauge-sh/gauge-cli | low | none |
| 2026-11-05 | langfuse-changelog | 2026-11-03 | Langfuse skill management (beta): versioned skills, skill tracing (loaded version, files read), per-skill Usage tab | https://langfuse.com/changelog/2026-11-03-skill-management | medium | idea: cross-session per-skill usage view (loads, files read, linked calls, cost); Log Hub records skill loads per session (harness snapshot, tool-call sections) — check whether an org-wide per-skill view exists |
| 2026-11-05 | langfuse-changelog | 2026-11-03 | Observations API continuation | https://langfuse.com/changelog/2026-11-03-observations-api-continuation | low | none |
| 2026-11-05 | hn | 2026-11-03 | Show HN: Agent Trace – let agents query Codex and CC chat histories (MCP) — HN 1 / 0 | https://github.com/wcook04/agent-trace-mechanism | misc | none (transcript-as-context, not monitoring) |
| 2026-11-05 | hn | 2026-11-03 | Show HN: Recursive Human Intelligence – feedback on you from your AI coding chats — HN 2 / 0 | https://github.com/andrearitossa/recursive-human-intelligence | misc | none (similar to /insights; transcript analysis for the human) |
| 2026-11-05 | hn | 2026-11-03 | Show HN: Mallard – Git for the age of AI agents — HN 3 / 2 | https://mallard-ai.com/home | low | none |
| 2026-11-05 | hn | 2026-11-03 | OpenAI seems to be silently re-enabling model training on Codex chats — HN 519 / 155 | https://news.ycombinator.com/item?id=50352757 | low | none |
| 2026-11-05 | hn | 2026-11-03 | Show HN: usage tracker / site blocker for Linux (glocker) — HN 1 / 0 | https://github.com/glocker-app/glocker | low | none |
| 2026-11-05 | ccusage | 2026-11-02 | ccusage v20.0.48 (no significant changes) | https://github.com/ccusage/ccusage/releases/tag/v20.0.48 | low | none |
| 2026-11-05 | hn | 2026-11-02 | Ask HN: What is your backup plan when AI companies rug pull their prices? — HN 5 / 15 | https://news.ycombinator.com/item?id=50336034 | misc | none |
| 2026-11-05 | hn | 2026-11-02 | Show HN: Nomos – Go harness that stops coding agents cheating on tests — HN 4 / 0 | https://github.com/mgantlett/nomos | low | none |
| 2026-11-05 | langfuse-changelog | 2026-11-02 | Langfuse PagerDuty integration | https://langfuse.com/changelog/2026-11-02-pagerduty-integration | low | none |
| 2026-11-05 | ccusage | 2026-11-01 | ccusage v20.0.47: bug fixes (OpenCode Claude Agent turns counted once, --until day, config sections) | https://github.com/ccusage/ccusage/releases/tag/v20.0.47 | low | none |
| 2026-11-05 | coralogix-docs | 2026-11-04 | Coralogix Code Agents docs "last updated 2026-11-04": Claude Code / Cowork data scopes "Forthcoming", ChatGPT and claude.ai "Coming soon", Cursor budget view — matches the parity study | https://coralogix.com/docs/user-guides/ai/code-agents/ (2026-11-04 revision) | low | none |
| 2026-11-05 | q-agent-observability | 2026-06 | Grafana Cloud AI Observability for coding agents (`agento11y` launcher for Claude Code/Codex/Copilot/OpenCode/Pi): auto tags user/repo/branch with cost break-down, content capture modes, synchronous Guards that block failing tool calls; not in the parity study | https://grafana.com/docs/grafana-cloud/machine-learning/ai-observability/guides/instrument-coding-agents/ | high | study: grafana-cloud.md should cover agento11y (proposed); idea: cost break-down by branch |
| 2026-11-05 | q-agent-observability | 2026-06-08 | New Relic AI Coding Observability (open source, OTel + MCP): Claude Code/Cursor/Copilot/Windsurf/Amazon Q, cost vs budgets with threshold alerts, local-only mode; not in the parity study | https://newrelic.com/press-release/20260608 | high | idea: budgets with threshold alerts (Log Hub has none — A11 gap); study: new file proposed |
| 2026-11-05 | q-cost-monitoring | 2026-11-05 | Claude Code Agent Monitor (hoangsonww, 1.1k stars, active): real-time dashboard for Claude Code & Codex, sessions, tool usage, subagent orchestration, Kanban board, native apps; not in the parity study | https://github.com/hoangsonww/Claude-Code-Agent-Monitor | medium | none (local single-user; Log Hub covers subagent tree) — study: new file proposed |
| 2026-11-05 | q-new-github | 2026-07-10 | phuryn/claude-usage (2.3k stars): local dashboard of token usage, costs, session history, plan progress bar; not in the parity study | https://github.com/phuryn/claude-usage | medium | none (ccusage-class local tool) |
| 2026-11-05 | q-cost-monitoring | 2026-06-27 | cc-lens (600 stars): local analytics dashboard for Claude Code, no cloud; not in the parity study | https://github.com/Arindam200/cc-lens | medium | none |
| 2026-11-05 | q-cost-monitoring | — | SigNoz Claude Code dashboard template (OTel: tokens, cost, success rate, engagement) | https://signoz.io/docs/dashboards/dashboard-templates/claude-code-dashboard/ | low | none (another OTel backend dashboard) |
| 2026-11-05 | q-cost-monitoring | 2026-11-04 | cceye: Claude Code cost from local logs with threshold alerts (6 stars, pushed 2026-11-04) | https://github.com/ydah/cceye | low | none |
