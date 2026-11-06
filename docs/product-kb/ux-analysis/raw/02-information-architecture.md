# Raw report 2 — Information architecture

Basis: `client/src/viewer/tab-ids.ts`, tab components, KB. Read-only study, 2026-11-01.

About 60 clickable views over 4 levels: left nav, page tabs, inner tabs and sub-tabs / dropdowns.

## 1. Current structure

| Level | Container | Count |
|---|---|---|
| Left nav | Teams (→ repos), My Repos, API Keys, Installed Hooks, Admin Panel | 5 sections |
| `#/main` | placeholder | 0 |
| Repository | Sessions, Analytics, Reports, Tools/MCP, OKF, OTEL, Settings | 7 tabs |
| → Session pane | Summary, Info, Logs, Bash, Charts, [Advisor], Statistics, Change surface, Harness usage, OKF, Tools/MCP, [Raw Logs], System context anatomy, OTEL | 14 tabs |
| → → Charts | Dashboard, Context Growth, Context Usage, Agent Tree, Timeline, Tool Heatmap, Call Tree | 7 |
| → → Info | Identity, Timeline, Activity, Tokens & Cost, … | 9 sections |
| → Analytics | metric dropdown | 13 views |
| → Reports | tree with 7 categories | 16 reports |
| → Settings | Display … Import/export | 7 |
| Team | Members, Repositories, Invitations, OTEL | 4 |
| Admin | System Info … Model Pricing | 9 |
| Hook state | separate page, only from the left nav | 1 |

**Structural problems**

- Session tab bar: flat row of buttons (`SessionTabBar.tsx`), no grouping, no overflow. Order and labels drift from ids (`usage` is labelled "Statistics").
- Same topic, many homes: Tools/MCP (session tab, repo tab, Analytics view, report, Monitored tools settings); Change surface (session, Analytics, report); Harness (session, report); OKF and OTEL (session and repo; OTEL also on Team); Cache ratio, Productivity counters, Active sessions in both Analytics and Reports.
- Three overlapping overview tabs in a session: Summary, Info, Statistics.
- Repo tab row mixes browsing, analysis and configuration; hook health is not reachable from the repo page.
- No overview-first entry point; Team page is management, not results.
- Jargon labels: OKF, OTEL, Harness, "System context anatomy".
- Admin's 9 tabs mix monitoring, directory and configuration.

## 2. Ideas

- **A. Grouped session tab bar** — Overview (Summary, Info, Statistics, Advisor) / Transcript (Logs, Bash, Raw Logs) / Cost & context (Charts, System context anatomy, Harness usage, OTEL) / Effects (Change surface, Tools/MCP, OKF). Ids and test ids unchanged; remember last sub-tab per group. M / high.
- **B. One tab registry** — extend `tab-ids.ts` into a metadata table (id, label, group, scope, description, synonyms). All tab bars, tooltips and the palette read from it. S–M / high (enabler).
- **C. Same topics at every level, with a scope switch** — one topic list (Activity, Cost & tokens, Context & harness, Tools/MCP, Knowledge (OKF), Code changes, OTEL) with the same names at session, repo and team level, plus "same view, one level up" links. M–L / high.
- **D. Merge Analytics and Reports into "Insights"** — one category tree; each entry has Explore (chart) and Report (printable) modes. Redirect old `mtab=analytics`. M / high.
- **E. Separate configuring from analysing on the repo page** — gear menu with Settings, Hook health (existing `HookStatePage`), Import/export. S / medium.
- **F. Use-case lenses** — "Debug a session", "Cost review", "Tune my harness", "Team lead weekly", "All"; reorders, highlights, picks a landing tab; rest under "More"; `lens=` in URL. M / high.
- **G. Overview-first landing pages** — `#/main` "My overview"; Team page gets an Overview tab; repo opens on Executive Summary. M / medium-high.
- **H. Command palette (Ctrl+K)** over the registry with synonyms, plus recent repos and sessions. M / high.
- **I. Breadcrumb with scope** — Team › Repo › Session › Group › Tab › Sub-tab. S / medium.
- **J. Plain-language labels, hover help, Admin groups** — "System context anatomy" → "Startup context", "Statistics" → "Usage stats", "OKF" → "Knowledge base (OKF)"; one-line tooltip per tab; Admin sub-nav Monitoring / Directory / Configuration. S / medium. Keep ids.

## 3. Top-3

1. **A + B** — fixes the worst crowding; a future tab becomes a row of data.
2. **C + D** — each topic gets one name and one place per level.
3. **F** — per-use-case arrangements without removing anything.

H is the cheap follow-up once B exists.
