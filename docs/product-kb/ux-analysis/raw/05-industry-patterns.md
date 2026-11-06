# Raw report 5 — Patterns from observability and LLM-ops products

Basis: competitor KB and study (`docs/product-kb/competitive-research/`), `client-routing-and-layout.md`,
`tab-ids.ts`. Read-only study, 2026-11-01.

**What users face today:** session pane 14 tabs (Charts has 7 sub-tabs); repository 7 tabs, Analytics
~12 views; Admin 9, repo Settings 7, Team 4. `MainPage` is empty. No command palette, no saved views.
Every tab id is in one registry and in the URL.

## Patterns

1. **Use-case lenses** (Datadog / Grafana per-persona dashboards, Sentry perspectives, Kibana Spaces) — "What happened" (Summary, Logs, Bash, Charts→Timeline, Raw Logs), "Cost & context" (Info, Charts→Context growth/usage, System context, OTEL, Usage, Advisor), "Harness health" (Harness usage, OKF, Tools/MCP, Change surface), "All". `lens` URL param; old links open with "All". M / high.
2. **Command palette (Ctrl+K)** (VS Code, Linear, GitHub, Datadog) — entries from `tab-ids.ts` plus route helpers. S–M / high.
3. **Overview first, details one click away** (Sentry issue page, Langfuse trace overview, Honeycomb home) — Summary as a map of ~6 cards, each opens its tab. M / high.
4. **Saved and pinned views** (Datadog Saved Views, Linear Views, PostHog insights, Grafana starred) — stored in `user_settings`; pins in left nav or home. M / med-high. Needs a backward-compatible route.
5. **Grouped navigation** (VS Code activity bar, Datadog nav groups, GitHub repo tabs) — repo: Explore / Analyze / Configure (+ Hook state); Admin: Operations / Directory / Policy. S / medium.
6. **Home page** (GitHub dashboard, Sentry "For review", PostHog home) — recent sessions, hooks with problems, most expensive sessions, advisor results, task-shaped entry points opening the right lens. Use `session_stats`. M / high.
7. **Badges and hiding empty tabs** (Sentry tab counts, GitHub "Issues 12", Langfuse) — counts / health dots; empty tabs dimmed and moved to "More" (Advisor already works this way). S / medium.
8. **Trace tree with a side panel** (Langfuse, LangSmith, Phoenix, Honeycomb) — one session tree, context panel by selection; Bash, Tools/MCP, OKF, Harness as filters on it; tabs stay as alternative views. L / high. Later step.
9. **Pivot links between views** (Datadog metric→logs→traces, Honeycomb BubbleUp, PostHog insight→persons) — Analytics bar → filtered session list; session Tools → repo Tools filtered. M / medium.
10. **"What is this?" note on every panel** (Grafana panel descriptions, PostHog / Datadog info tooltips) — ⓘ with one sentence and a link to `HelpModal` `<slug>.md#anchor`; offline. S / medium.

## Top-3

1. **Use-case lenses** — 14 visible tabs → ~4, nothing removed, old URLs keep working.
2. **Command palette** — cheap thanks to the registry, scales with new panels.
3. **Overview-first Summary** — the default tab becomes the guide to all the others.

Next step after these: the home page with task-shaped entry points that open the right lens.
