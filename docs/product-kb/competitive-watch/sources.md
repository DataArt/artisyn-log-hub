---
type: "Reference"
title: "Competitive watch — sources"
description: "The competitor sources the morning-check skill watches (GitHub releases, blogs, docs, changelogs, search queries) with the date each was last checked."
tags:
  - competitive-research
timestamp: "2026-11-10T10:00:00+04:00"
---

# Sources

`Last checked` is the date (YYYY-MM-DD) the source was last read by the morning check; `—` means
never. Everything published before **2026-11-01** is covered by the parity study
(`docs/product-kb/competitive-research/`), so the first check of a source only looks at items after that date.

Kinds: `gh-releases` — read `https://api.github.com/repos/<owner>/<repo>/releases` (or the
releases page); `blog` / `docs` / `changelog` — read the page and look for posts or entries newer
than the last check; `search` — a web search query, newest results first.

## Tool sources

| Id | Tool | Kind | URL | Last checked |
|---|---|---|---|---|
| anthropic-analytics | Anthropic built-in analytics | docs | https://code.claude.com/docs/en/analytics | 2026-11-10 |
| anthropic-costs | Anthropic built-in analytics | docs | https://code.claude.com/docs/en/costs | 2026-11-10 |
| ccusage | ccusage | gh-releases | https://github.com/ccusage/ccusage | 2026-11-10 |
| cc-usage-monitor | Claude Code Usage Monitor | gh-releases | https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor | 2026-11-10 |
| ccboard | ccboard | gh-releases | https://github.com/FlorianBruniaux/ccboard | 2026-11-10 |
| claude-hindsight | Claude Hindsight | gh-releases | https://github.com/codestz/claude-hindsight | 2026-11-10 |
| agents-observe | agents-observe | gh-releases | https://github.com/simple10/agents-observe | 2026-11-10 |
| disler-mao | Multi-Agent Observability (disler) | gh-releases | https://github.com/disler/claude-code-hooks-multi-agent-observability | 2026-11-10 |
| claude-code-otel | claude-code-otel | gh-releases | https://github.com/ColeMurray/claude-code-otel | 2026-11-10 |
| grafana-cloud | Grafana Cloud integration | docs | https://grafana.com/docs/grafana-cloud/monitor-infrastructure/integrations/integration-reference/integration-claude-code/ | 2026-11-10 |
| langfuse-plugin | Langfuse + Claude Code plugin | gh-releases | https://github.com/langfuse/Claude-Observability-Plugin | 2026-11-10 |
| langfuse-changelog | Langfuse | changelog | https://langfuse.com/changelog | 2026-11-10 |
| datadog-blog | Datadog Agent Console | blog | https://www.datadoghq.com/blog/claude-code-monitoring/ | 2026-11-10 |
| datadog-docs | Datadog Agent Console | docs | https://docs.datadoghq.com/ai_agents_console | 2026-11-10 |
| dynatrace-blog | Dynatrace Claude Code monitoring | blog | https://www.dynatrace.com/news/blog/dynatrace-expands-ai-coding-agent-monitoring/ | 2026-11-10 |
| coralogix-docs | Coralogix Code Agents | docs | https://coralogix.com/docs/user-guides/ai/code-agents/ | 2026-11-10 |
| jellyfish-blog | Jellyfish AI Impact | blog | https://jellyfish.co/blog/ai-impact-claude-code/ | 2026-11-10 |
| grafana-agento11y | Grafana Cloud AI Observability (agento11y) | docs | https://grafana.com/docs/grafana-cloud/machine-learning/ai-observability/guides/instrument-coding-agents/ | 2026-11-10 |
| newrelic-ai-coding | New Relic AI Coding Observability | blog | https://newrelic.com/press-release/20260608 | 2026-11-10 |
| cc-agent-monitor | Claude Code Agent Monitor (hoangsonww) | gh-releases | https://github.com/hoangsonww/Claude-Code-Agent-Monitor | 2026-11-10 |
| phuryn-claude-usage | claude-usage (phuryn) | gh-releases | https://github.com/phuryn/claude-usage | 2026-11-10 |
| cc-lens | cc-lens | gh-releases | https://github.com/Arindam200/cc-lens | 2026-11-10 |
| anthropic-gateway | Anthropic Claude apps gateway | docs | https://code.claude.com/docs/en/claude-apps-gateway | 2026-11-10 |
| honeyhive-coding | HoneyHive for Coding Agents | blog | https://www.honeyhive.ai/post/honeyhive-for-coding-agents | 2026-11-10 |
| openlit-coding | OpenLIT coding agents | docs | https://docs.openlit.io/latest/openlit/coding-agents/overview | 2026-11-10 |
| revenium-cc | Revenium AI Coding Dashboard | docs | https://docs.revenium.io/claude-code-dashboard | 2026-11-10 |

Note (2026-11-05): `https://langfuse.com/changelog` returns 404 to WebFetch but 200 to `curl`; read
it with `curl -s https://langfuse.com/changelog` and grep the `/changelog/<date>-<slug>` links.

## Search queries

Run each with WebSearch; keep results published after `Last checked` (or after 2026-11-01).

| Id | Query | Last checked |
|---|---|---|
| q-cost-monitoring | Claude Code cost monitoring dashboard | 2026-11-10 |
| q-cost-optimization | reduce Claude Code token cost blog | 2026-11-10 |
| q-otel-observability | Claude Code OpenTelemetry observability | 2026-11-10 |
| q-team-usage | Claude Code team usage analytics tool | 2026-11-10 |
| q-agent-observability | AI coding agent observability new tool | 2026-11-10 |
| q-new-github | github Claude Code usage tracker new | 2026-11-10 |

## Community sources

Noisy by nature. Everything on topic that is not a clear competitor feature goes to the `misc`
relevance ("may be interesting") instead of being dropped. If a site blocks the fetch, fall back
to WebSearch with `site:` (e.g. `site:reddit.com/r/ClaudeAI Claude Code cost`) and say so.

| Id | Where | Kind | How to read | Last checked |
|---|---|---|---|---|
| hn | Hacker News | community | `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=<q>` for each of: `Claude Code cost`, `Claude Code usage`, `Claude Code observability`, `Claude Code telemetry`, `AI coding agent cost` | 2026-11-10 |
| reddit-claudeai | Reddit r/ClaudeAI | community | Reddit blocks anonymous fetches (HTTP 403, checked 2026-11-05), so use WebSearch `site:reddit.com/r/ClaudeAI <q>` for each of: `Claude Code cost`, `usage tracker`, `token usage`, `monitoring`, `dashboard`; try `https://www.reddit.com/r/ClaudeAI/search.json?restrict_sr=1&sort=new&t=week&q=<q>` first only if WebFetch is known to work there | 2026-11-10 |
