# UX analysis: making the UI digestible

Date: 2026-11-01. Status: ideas, not yet tasks.

**Question.** Log Hub already has many views, tabs and panels, and more are coming. How do we make the
UI easier to digest **without removing panels**, so that each use case finds what it needs faster?

**Method.** Five independent agents studied the client (`client/src`, `tab-ids.ts`), the KB and
`user-docs/`, each through one lens. Their raw reports are in [`raw/`](raw/):

| Report | Lens |
|---|---|
| [01-personas.md](raw/01-personas.md) | Personas and jobs-to-be-done (run on Fable) |
| [02-information-architecture.md](raw/02-information-architecture.md) | Grouping, naming, nesting of views |
| [03-search-and-wayfinding.md](raw/03-search-and-wayfinding.md) | Search, command palette, cross-links, deep links |
| [04-layout-and-density.md](raw/04-layout-and-density.md) | Layout presets, focus mode, density, saved views |
| [05-industry-patterns.md](raw/05-industry-patterns.md) | Patterns from Datadog, Grafana, Sentry, Langfuse, Linear, VS Code |

**How it all looks together:** [wireframes.md](wireframes.md).

## Where the overload is (all agents agree)

- **Session pane** — the densest place: 14 tabs in one flat row with no groups and no overflow
  (`SessionTabBar.tsx`); Charts has 7 more sub-tabs, Info has 9 sections.
- **Repository** — 7 tabs; Analytics has 13 views, Reports 16 reports, Settings 7 sub-tabs. Admin has 9 tabs.
- **One topic in 2–4 places under different names**: Tools/MCP (session, repo, Analytics, report,
  settings), Change surface, OKF, OTEL. Analytics and Reports largely overlap.
- **The home page `/main` is empty** ("Select an item from the left panel").
- **What already helps**: every tab id lives in one registry (`client/src/viewer/tab-ids.ts`) and tab
  state is kept in the URL, so most ideas below are cheap to build on top of it.

## Selected ideas

| # | Idea | Effort | Impact | Agents that proposed it | Wave |
|---|---|---|---|---|---|
| 1 | [Tab registry with metadata](wave-1/01-tab-registry.md) | S–M | high (enabler) | 2 | 1 |
| 2 | [Grouped session tab bar with overflow](wave-1/02-grouped-session-tab-bar.md) | S–M | high | 4 of 5 | 1 |
| 3 | [Use-case lenses](wave-1/03-use-case-lenses.md) | M | high | 5 of 5 | 1 |
| 4 | [Summary as a hub](wave-1/04-summary-as-hub.md) | M | high | 4 of 5 | 1 |
| 5 | [Command palette (Ctrl+K)](wave-2/05-command-palette.md) | S–M | high | 4 of 5 | 2 |
| 6 | [Home page instead of the placeholder](wave-2/06-home-page.md) | M | high | 5 of 5 | 2 |

**Wave 1** ([`wave-1/`](wave-1/)) is client-only: no backend, no migrations, no new routes. Tab ids
stay the same and new URL params are optional, so old links and the `data-testid`s the scenarios use
keep working. **Wave 2** ([`wave-2/`](wave-2/)) builds on the wave-1 registry and lenses.

## Second tier (cheap, smaller effect)

- **"What is this panel?"** — an ⓘ on every tab with one sentence and a link into the offline help;
  generalise the existing `OtelHelpLink`. S.
- **Group Admin and Settings tabs** — Admin → Directory / Operations / Policy; Settings likewise. S.
- **Analytics view picker** — group the 13 views by question and allow starring favourites. S.
- **Two-way "same thing elsewhere" links** — a tool, file, OKF doc or turn opens in a neighbouring
  view already filtered; plus session ↔ repo jumps. M.
- **Focus mode** (`f` key) — temporarily collapse the left nav and session list. S.

## Deferred

- **Merge Analytics and Reports into one "Insights" tab** — right idea, but a navigation rebuild with
  redirects for old `mtab=` values; do it after lenses.
- **Saved workspaces and team dashboards** — need new API routes, a migration and contract rows.
- **Global full-text search over prompts, files and tools** — strong, but L: FTS index, exact privacy
  filtering, partial data from old hook versions.
- **Langfuse-style trace tree with a side panel** — L, performance risk on large transcripts.

## Cross-cutting notes

- **Backward compatibility**: never rename tab ids or `tab=` / `mtab=` values; new params (`lens=`,
  `focus=`) are optional and unknown params are ignored.
- **Scenarios** address tabs by `data-testid`; a tab moved into an overflow menu must still be
  reachable (open the menu in a scenario helper).
- **Per-viewer UI prefs** are scattered localStorage keys today; a single `useUiPref(key, default)`
  hook (versioned keys, try/catch) would back lenses, collapsed sections and favourites.
- **Offline first**: any help text added for panels lives in `user-docs/`, never online only.
