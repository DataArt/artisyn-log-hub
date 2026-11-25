---
type: "Research"
title: "Codebase research for the CloudWatch CAI parity plan"
description: "Research subagent report (2026-11-25) gathered before writing impl-plan.md"
---

**Requirements summary**
The work happens in the existing OTEL **Live view** modal (GH-160). There are three parts.
- **New KPI tiles (FR-2), for home, team, No team, repo and session nodes:**
  - Active users: distinct owners of the node's roots, team-scope filtered, not shown on session nodes.
  - Cache hit %: reuses `OtelCacheRatioTile` with its existing formula over lifetime totals.
  - Active hours: the definition is still an open question.
  - Total tokens: the sum of the four token kinds, lifetime, plus a 2 h sparkline from the 5-min `view.buckets`.
  - No data or a zero denominator shows "—". Agent nodes keep today's tiles.
- **New charts (FR-3), built only from OTEL data the Live view already reads:**
  - Cost and tokens over time by team and by user. This needs additive, optional server fields on `GET /api/v1/otel/live`, the same 2 h / 5-min grain and team-scope filter, and a contract registry row. "By user" is hidden on session nodes.
  - Edits by tool (Edit / Write / NotebookEdit) from OTEL tool spans, showing "not reported" without spans.
  - Lines added/removed, commits, PRs, edit decisions and code by language are "missing — not backed" and left out.
- **Tile mode (FR-4/5):**
  - A Tiles | Carousel toggle. Tiles is the default and the choice is kept in localStorage `artisyn:liveChartMode`.
  - A responsive grid of compact charts with no controls: 4 columns at the default width, fewer when narrower. Share is one tile. The Sankey and breakdown table stay below the grid.
  - Clicking a tile opens today's full carousel page with its Metric / By controls and ‹ › paging. "‹ All charts" goes back to the grid.
  - Switching node keeps the chart if the new node has it, else returns to the grid. A chart that loses its data returns to the grid. An empty grid shows the carousel's empty message.
  - The enlarged tile is not remembered.
- **First, FR-1:** a gap table (CloudWatch card → has / partial / missing → decision) must be written into `requirements.md` before planning.

**Wireframes**
- `wireframes/live-tile-mode.svg`:
  - KPI row 1 (existing): Cost "since start", Tokens by type, Live sessions / agents ("3 sessions · longest 42m"), Cost/min.
  - KPI row 2, marked "new" with dashed borders:
    - Active users, "distinct users under node".
    - Cache hit % "78.4 %", "cache read / all input".
    - Active hours "6.2 h", "sum of session run time". This is the wireframe's suggested definition.
    - Total tokens "128.9 K", "all 4 kinds · last 2 h →", with a sparkline.
  - Header row: "Charts · 12 charts · last 2 h, 5-min buckets · click a tile to enlarge", with a View toggle Tiles | Carousel.
  - The 12 tiles:
    - Existing: Cost over time, Tokens over time, Cost by model, Cost by structure, Cost by skill / MCP server, Latency p50 / p95, Share by team / repository / user (three mini doughnuts).
    - New: Cost over time by team, Cost over time by user, Tokens over time by team / user ("Metric = Tokens"), Edits by tool ("only if backed"), Lines added / removed ("only if backed"). Lines added / removed is out per FR-3.
  - The tiles have a ⤢ hover icon.
  - The Sankey (model → team → user → session) and the breakdown table stay unchanged below the grid.
- `wireframes/live-tile-enlarged.svg`:
  - Top row: "‹ All charts", then ‹ "2 / 12" ›, the title, and "· last 2 h, 5-min buckets", with the View toggle still visible.
  - Metric segmented control: Tokens / Cost / Calls.
  - **By** segmented control: Kind / Team / User. So the wireframe merges by-team and by-user into By variants of existing pages instead of separate pages. The plan has to choose between separate tiles and By variants.
  - Legend click hides a series. Esc also returns to the grid.
  - Carousel mode is "this view without ‹ All charts"; otherwise it is identical to today.
- `screenshots/`: these are AWS reference images, gitignored. Their content is described in the requirements table.

**Knowledgebase**
- `docs/knowledgebase/otel-tabs.md` § "Live view" (lines 392–531) is the main reference:
  - Routes, the response shape, and `useOtelLivePoll` polling every `OTEL_SESSION_POLL_MS`.
  - Totals are lifetime and stored (`otel_session_totals` / `otel_agent_totals`). `runningMs = last_call_at − first_call_at` per session. A parent's `runningMs` = the max over its **live** sessions.
  - Window figures cover 2 h in 24 five-minute buckets.
  - Masking under `team-no-prompts`: `topTools` and tool event labels are null; counts and costs stay unmasked.
  - The Share page and the Sankey are client-only and map `rootId` → team / user / repo through `nodes`. `flows` is optional on the client (the backward-compat pattern to copy).
  - The "Scope cuts" paragraph already says Claude Code metrics (LOC, commits, active time) are not ingested.
  - Update this section and `client-component-map.md` (the `live/` row) when the change lands.
- `docs/knowledgebase/algorithms/otel-live-tree.md` plus rows file `docs/algorithm-examples/otel-live-tree.json` (test `server/src/logs/otel/otel-live-tree.algo.spec.ts`):
  - If Active users or Active hours are computed in `buildOtelLiveTree` / `summarizeOtelLiveNode` / `OtelLiveTotals`, that is an algorithm change: add LT rows there.
  - Rule 9: parents sum over DISTINCT roots; parent `runningMs` = max over live sessions.
- `docs/knowledgebase/ui-principles.md`:
  - Bounded ratios use `CACHE_RATIO_SCOPE_COLORS`, never zone colours.
  - "An undefined value is not zero" is rendered as `n/a`. **This conflicts with the requirement's "—"** (see Open gaps).
  - Every tile in a row has a `hint`. The UI is light-only. Popovers use `ViewportPopover` / `HoverPopover`.
- `docs/knowledgebase/client-routing-and-layout.md` § "Per-user browser storage keys" (lines 259–268): a new key such as `artisyn:liveChartMode` is listed under "Other browser keys", next to `artisyn:leftNavCollapsed`.
- `docs/knowledgebase/test/scenarios.md`, `test/contract-tests.md`: the scenario-step and registry-row conventions.
- `user-docs/otel-tab.md` § "Live view" (line 117, carousel text at line 145): the in-app help must describe tiles and the new KPIs (offline-first; `npm run build:help`).

**Existing patterns**
- **Server: SQL loaders and response shape**
  - `server/src/logs/otel/otel-live-read.sql.ts`:
    - `loadOtelLiveBuckets` aggregates `otel_cost_buckets` over all roots, so per-root information is lost.
    - `loadOtelLiveFlows` is the template for a per-`session_id` `GROUP BY` on the `(session_id, event_time)` index, with a row cap. A per-(bucket, root) series for by-team/user charts would follow this or a variant of the buckets query grouped by `b.session_id`.
    - `loadOtelLiveTopTools` and `loadOtelLiveLatency` are the patterns for `otel_spans` with `s.name = OTEL_SPAN_TOOL`, `attributes->>'tool_name'`, `bin5m(start_time)` and `spanAgentSql`. An edits-by-tool series would be a sibling of these.
  - `server/src/logs/otel/otel-live.reader.ts` `buildView`: loads view figures in one `Promise.all`. The new loaders go here, gated by node type the way flows is (none for agent; "by user" not for session).
  - `server/src/logs/otel/otel-live.types.ts` (`OtelLiveView`) and its client mirror `client/src/models/otel-live.ts`: new fields are optional on the client (`flows?:`, `spark?:` pattern).
  - `server/src/logs/otel/otel-live-tree.ts` `summarizeOtelLiveNode`:
    - Already collects DISTINCT session roots under a node with `userEmail`, but only `liveUsers` (live only) reaches the details panel.
    - Active users (all distinct owners, including recently ended) can come from the same loop or from the client.
- **Server: contract and masking**
  - `server/test/contract/registry/f25-otel.ts` `liveRows` (lines ~1846–1945): `F25-live-home-idle` pins `view` with exact `bodyMatches`. New `view.*` fields must be added there (empty arrays in the idle world), or as a new row.
  - Masking: `maskFirstPrompt` and `scope.visibility === 'team-no-prompts'` in `buildDetails` (`otel-live.reader.ts`) are the current per-root masking points for tool names.
- **Client: chart pages and tiles**
  - `client/src/viewer/live/live-chart-data.ts` `buildLiveChartPages`:
    - Pages with `id`, `metrics` and `variants` (each variant = a By option with its own `stackBy` and buckets).
    - A page is hidden when all its values are zero.
    - `rollUp` / `tokenBuckets` map rows to `OtelBucket`.
    - By-team/user charts fit as extra `variants` (By = Kind / Team / User, as in the wireframe) or as new pages.
  - `client/src/viewer/live/LiveChartCarousel.tsx`:
    - `BucketPage` (Metric / By controls via `OtelSegmented`, legend hide).
    - `LatencyPage`.
    - The Share page is appended when `buildLiveShare(...) !== null`.
    - The page is kept by **id** across polls (`pageId` state). This is the same mechanism needed for "keep the enlarged chart on node change, else grid".
    - Tile mode should reuse this page list.
  - `client/src/viewer/live/live-share-data.ts` `rootsUnder` and `live-flow-data.ts`: map `rootId` → first placement (team / repo / user) from `nodes`. Reuse this for the by-team/user series and for Active users / Active hours on the client.
  - `client/src/viewer/pages/repository/otel/OtelCostChart.tsx`:
    - Has a `height` prop, but always renders the legend and tooltip.
    - There is no compact or "no controls" mode. One must be added, for example a `compact` / `hideLegend` prop.
  - `LiveLatencyChart` and `LiveSharePage` take a `height` / size via `PIE_SIZE`.
  - `client/src/viewer/pages/repository/otel/OtelKpiTile.tsx`:
    - `OtelKpiTile` has a `sparkline?: number[]` prop, rendered by `OtelSparkline`, a 96×22 polyline.
    - `OtelTokensTile` and `OtelCacheRatioTile({ratio})` are also here.
  - `otel-format.ts` `otelCacheReadRatio(input, cacheRead, cacheWrite)` returns `cacheRead / (input + cacheRead + cacheWrite)`, or `null` when the denominator is 0. This is the "existing formula", used in `OtelKpiTiles.tsx:173`.
  - `client/src/viewer/live/LiveKpiTiles.tsx`: node-type branching (agent vs session vs parent), flex-wrap row; `formatLiveDuration` lives in `live-format.ts`.
  - `client/src/viewer/live/LiveViewPane.tsx`: KPI tiles → carousel → Sankey → breakdown. The tile/carousel switch goes here.
- **Client: storage and layout**
  - localStorage with try/catch for one non-user key: `client/src/viewer/pages/repository/session-log/charts/chart-tab.ts` (`CHART_TAB_STORAGE_KEY`, read/remember with a fallback default). `useDraggableWidth` (`artisyn:liveTreeWidth`) does **not** wrap storage in try/catch, so don't copy it for this.
  - Responsive grid by pane width: Tailwind v4 container queries are already used (`@container` + `@[56rem]:grid-cols-2` in `client/src/viewer/pages/repository/okf/view/OkfUsageView.tsx`). Use these, since the pane width depends on the splitters, not the viewport.
- **Modal width:** `w-[90vw]` (`LiveModal.tsx:178`), default tree pane 260 px, view pane min 360 px. Width left for the view pane (90 % of the viewport minus the tree, before splitter and padding):
  - 1920 px viewport: 1728 − 260 = 1468 px.
  - 1440 px: 1296 − 260 = 1036 px.
  - 1280 px: 1152 − 260 = 892 px.
- **Scenario:** `tests/scenarios/view/s-otel-02.spec.ts` (`@S-OTEL-02`, mode a) is the step to extend.
  - It currently drives the carousel (`live-chart-prev` / `-next`, `data-page`, lines 364–399) and checks the `live-kpi-*` / `otel-kpi-tokens` testids.
  - **With tiles as the default, these steps break** unless they switch to Carousel first or are rewritten for the grid.
  - The fixture sessions send only `apiRequestLine`, no spans. Edits-by-tool coverage needs `spanLine` from `tests/scenarios/fixtures/otel/otel-lines.ts:148`.
- **Span names:** `server/src/logs/otel/otel-span-names.ts` (`OTEL_SPAN_TOOL = 'claude_code.tool'`).

**Open gaps**
- **Active hours definition** is unresolved: sum of each session's `runningMs` over the node's DISTINCT roots (what the wireframe suggests), or the sum of span time from `otel_spans`. Lifetime or 2 h? The tree's `runningMs` today is the max over **live** sessions, not a sum, so a sum needs a new computation, either in the tree (algorithm rows) or on the client from `nodes`. It also has to be told apart from the "Running" / "longest" figures.
- **"—" vs `n/a`:** `OtelCacheRatioTile` and ui-principles render the undefined ratio as `n/a`; the requirement says "—". The plan must choose: a prop on the tile, or ask.
- **Total tokens:** the requirement says lifetime total with a 2 h sparkline, but the wireframe secondary says "last 2 h". `view.buckets` drops empty buckets (`calls <> 0`), so the sparkline needs zero-fill to 24 points from `windowFrom` / `windowTo`. `OtelTokensTile` is shared with the repo/team/session OTEL tabs, so extend it through optional props.
- **Active users scope:** `summarizeOtelLiveNode` counts only live users and only for the details panel. Decide whether ended-but-in-tree roots count, and whether to compute it in the server tree or the client.
- **By-team/user series:** no per-root time series exists. A new optional `view.*` field is needed, e.g. `(bucket_start, root_id)` rows with cost / tokens / calls. The client maps roots to team / user via `nodes` (first placement, as in Share). Decide on a row cap (R roots × 24 buckets) and whether these are By variants of existing pages (wireframe) or separate tiles.
- **Edits by tool:**
  - Needs a new span query (tool names Edit / Write / NotebookEdit; is MultiEdit included?).
  - The `team-no-prompts` rule nulls tool names on another member's session. Decide whether these three fixed built-in names are exempt, or whether masked roots are excluded or counted as "masked".
  - "Not reported" when `hasSpans` is false. A Code Mode session has no spans.
- **Compact chart mode:** there is no compact or no-controls variant of `OtelCostChart`, `LiveLatencyChart` or `LiveSharePage`, and no existing tile-grid / enlarge component. Both are built from scratch; Esc-to-grid inside the Radix dialog must not close the modal.
- **No localStorage helper for global keys:** `user-storage.ts` is per-user only, and the requirement says per viewer, not per user id. Copy the `chart-tab.ts` try/catch pattern.
- **No algorithm doc for the client chart data** (`live-chart-data.ts`): client logic is covered only by scenario steps, unless something moves into `otel-live-tree`.
- **FR-1 gap table** is not yet written into `requirements.md`. It is a prerequisite for planning.
