# Raw report 3 — Search and wayfinding

Read-only study, 2026-11-01. No global search and no keyboard navigation anywhere in the app; URL
state is good for tabs but weak for anything inside a tab.

## 1. What exists, and the gaps

**Exists**

- Hash routes; left nav with Teams (→ repos), My Repos, API Keys, Installed Hooks, Admin.
- Tabs in the URL: repo (`mtab`), session (`tab`, ids in `client/src/viewer/tab-ids.ts`), settings (`stab`), admin and reports. Also analytics view and layout (`av`, `al`), top-N, users filter, OKF and OTEL filters, selected Bash call (`bashCall`). Opening a session adds a history entry.
- Cross-links: Analytics bars and Active Sessions open the session; repo OTEL opens the session's OTEL tab; Tools/MCP call details open Logs at that call (`tu`); Logs has "View anatomy →" to System context anatomy.
- Local filters: admin tables; Tools tree filter and input/output search; Change surface path filter; session list sections and "Filter by attribute".
- Help: `HelpModal`; only the OTEL panels open it on the right article (`OtelHelpLink`).

**Gaps**

- No global search across sessions, prompts, files, tools or repos.
- No free-text search in the session list and no find in the Logs transcript.
- `/main` is a placeholder; no recent or pinned items, no starting questions.
- ~16 session tabs with no grouping and no "what is this for" text.
- Cross-links mostly go one way, into a session.
- In-panel state (chart sub-tab, selected tree node) is component-only; help articles have no URL.
- Team detail keeps its tab in local state, so it can't be bookmarked.

## 2. Ideas

1. **Command palette (Ctrl/Cmd+K)** — repos and teams, every tab from `tab-ids.ts` with synonyms, help articles from `nav.json`. No backend. S–M / high.
2. **Search in the session list** — first prompt, branch, session id, user email over the loaded list; query in the URL. S / high.
3. **Global content search** — new endpoint over prompt text, touched paths, tool names with exact permission checks; results are deep links. L / high. Needs FTS index and a contract row; old hooks upload less data.
4. **Two-way "same thing elsewhere" links** — tool (session ↔ repo Tools/MCP ↔ Logs), file path (Change surface → Analytics → sessions), OKF doc (session ↔ repo), turn (Charts / Call tree → Logs). M / high.
5. **"What is this panel?" line** — generalise `OtelHelpLink` into `PanelHelpLink`; one-line purpose per tab plus "Learn more" into `user-docs`. S–M / med-high.
6. **Home page: recent, pinned, "What do you want to find?"** — recent (localStorage), pinned (user settings), 5–6 question cards deep-linking with filters preset. M / high.
7. **Group the session tabs and add "jump to tab"** — Read / Cost / Context / Effects / Raw, plus type-to-filter. M / med.
8. **Shareable state everywhere, "Copy link"** — Charts sub-tab, Call tree node, Tools tree selection, Team tab, `?help=`. Replace-style URL updates. M / med.
9. **Breadcrumb** under `MainNav`. S / med.
10. **Find in Logs** — search box over the already-fetched `/logs` payload with next/previous; expands the turn and sets `tu`. M / med-high.

## 3. Top-3

1. **Command palette** — cheapest way to reach every panel by name; grows with each tab.
2. **Home page with recent, pinned and question cards** — the "what's your use case" entry point.
3. **Two-way cross-links** — panels become connected views around one thing.

Sources checked: `client-routing-and-layout.md` (route table partly out of date), `tab-ids.ts`,
`ToolCallDetails.tsx`, `RepoOtelTab.tsx`, `MainPage.tsx`, `OtelHelpLink.tsx`, `user-docs/nav.json`.
