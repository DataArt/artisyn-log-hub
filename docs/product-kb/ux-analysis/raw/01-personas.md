# Raw report 1 — Personas and use cases (agent on Fable)

Basis: `tab-ids.ts`, `report-catalog.ts`, `analytics-state.ts`, routes. Read-only study, 2026-11-01.

## 1. Inventory

**Left nav:** Teams → repos; My Repos; API Keys; Installed Hooks (→ Hook state page); Admin (admin
only). Top bar: Help modal (5 sections, 22 articles), notifications, user menu.

| Page | Tabs / panels |
|---|---|
| **Main** (`/main`) | placeholder "Select an item from the left panel" |
| **Repository** | 7 main tabs: Sessions, Analytics, Reports, Tools/MCP, OKF, OTEL, Settings (the last five gated by `canSeeTeamWideTabs`) |
| ↳ Sessions | session list (4 view modes: branch/date/user/plain, attribute filter, OTEL-reason chip, other-users notice) + session detail pane with 14 tabs: Summary, Logs, Bash, Info, Charts, [Advisor], Statistics, Change surface, Harness usage, OKF, Tools/MCP, [Raw logs], System context anatomy, OTEL |
| ↳ Charts sub-tabs | Dashboard, Context growth, Context usage, Agent tree, Timeline, Tool heatmap, Call tree (7) |
| ↳ Summary | executive band (7 tiles), Detected issues (8 detectors), 5 extended blocks, prompt-cost table |
| ↳ Analytics | 13 views × group-by (none/branch/user/attr) × vertical/horizontal |
| ↳ Reports | tree of 7 groups / 16 reports + PDF export |
| ↳ Tools/MCP | 3 panes (tree / calls table / call details) + filter strip |
| ↳ OKF, OTEL | each: filter strip, verdict/coverage, KPI tiles, tree/chart, tables |
| ↳ Settings | 7 sub-tabs: Display, File Categories, Analysis, Monitored Tools, Session Attributes, Maintenance, Import/Export |
| **Team detail** | Members, Repositories, Invitations, OTEL |
| **Hook state** | status card, recommendations, non-uploadable logs, errors, log tail |
| **API Keys** | Install, Keys (+ upgrade-hooks card) |
| **Admin** | 9 tabs: System Info, Repos, Teams, Users, Error Logs, Upload Queue, Data Retention, Auth, Model Pricing |

Roughly 80 distinct surfaces; a session alone exposes 14 + 7 tabs.

**Personas / jobs-to-be-done:**

- **P1 Developer, own session** — what did it do, what did it cost, why slow: Summary, Logs, Bash, Charts, Advisor, Change surface.
- **P2 Investigator of a failed tool/MCP call** — Tools/MCP, Logs (`tu` deep link), Bash, OTEL traces.
- **P3 Team lead / manager** — cost, adoption, productivity: Reports (Executive, Cost by user, Productivity), Analytics, Team OTEL, Attributes.
- **P4 Harness / plugin engineer** — System context anatomy, Harness usage, OKF, Info › CLAUDE.md context, Claude Version report, Context growth.
- **P5 Hook operator** ("is my data arriving?") — Hook state, API Keys › Install, OTEL coverage banner, Admin › Upload Queue.
- **P6 Repo/team owner** — Settings 7 sub-tabs, Team detail.
- **P7 Platform admin** — Admin 9 tabs.

## 2. Ideas

- **A. Lenses (persona presets for the session tab bar).** Developer (Summary, Logs, Bash, Charts, Advisor, Change surface), Cost (Summary, Statistics, Charts›Context growth/Call tree, Advisor, OTEL), Harness (Summary, System context anatomy, Harness usage, OKF, Info), Tools (Tools/MCP, Bash, Logs, OTEL), All. A lens is only an ordering+visibility list over existing ids; hidden tabs stay in "More ▾"; `tab=` deep links always win. Persist in localStorage + `lens=`. M / high. Risk: users not noticing "More"; scenarios address tabs by `data-testid`.
- **B. Two-tier session tab bar.** Keep Summary, Logs, Charts flat; fold the rest into 4 dropdown groups (Cost & context, Harness, Tools, Data). Ids unchanged. S–M / med-high. Risk: one extra click; count badges must surface on the group trigger.
- **C. Real landing page.** My recent sessions, Needs attention (hook issues, advisor advice, OTEL gaps, failed tool calls), This week's cost, Get started. M–L / high. Risk: visibility rules, polling cost.
- **D. Repository "Insights" workspace.** Sessions | Insights | Settings; Insights reuses the Reports tree with sections Reports, Analytics views, Tools/MCP, OKF, OTEL; old `mtab=` map 1:1. M / med.
- **E. Summary "Explore" row.** Debug a tool call, Why this cost, Harness & context, Code changes. S / med.
- **F. Unified "focused call" strip.** One `call=` param resolved by Tools/MCP, Logs, Bash, OTEL; sticky strip with "view in …" buttons; old params kept as aliases. M / med (high for P2).
- **G. Team dashboard tab.** Executive KPIs, cost by user, active sessions across team repos. L / high for P3. Needs a cross-repo endpoint.
- **H. "Collection health" page.** Hook state + OTEL coverage + upload-queue lag for every repo. M / med.
- **I. Group Admin and Settings tabs.** Admin → Directory / Operations / Policy; Settings → What is collected / Display / Data ops. S / low-med.

## 3. Top-3

1. **A — Lenses**: directly answers "each kind of user finds what they need faster"; scales as tabs grow.
2. **C — Landing page**: the first screen is empty today; deep-link cards teach the UI.
3. **B — Grouped tab bar**: cheapest lens-independent reduction of the 14-tab bar.
