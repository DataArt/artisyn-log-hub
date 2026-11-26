# Implementation plan — Live View: CloudWatch-Style Metrics and a Tile Mode

## TL;DR

- **External surface:** `GET /api/v1/otel/live` gets two new additive fields, `view.rootSeries`
  (per root × 5-min bucket cost/tokens/calls) and `view.editsByTool` (per tool × 5-min bucket span
  counts). There is no DB change, no new route and no hook change. Older clients ignore the fields,
  and the new client treats them as optional.
- **No new mechanism on the server.** Two SQL loaders, siblings of `loadOtelLiveFlows` and
  `loadOtelLiveTopTools`, are added to the existing `buildView` `Promise.all`. The tree
  (`otel-live-tree.ts`) and its algorithm are unchanged.
- **The new KPIs are client-only, computed from data the client already has:**
  - Active users and Active hours come from `nodes`, the DISTINCT session roots under the selected
    node, as the Share page already does. Active hours is the sum of `runningMs` (user decision).
  - Cache hit % comes from node totals.
  - Total tokens comes from node totals, with the sparkline from `view.buckets` zero-filled to 24
    points.
  - *Rejected:* computing them in the server tree. It would mean a new algorithm and new contract
    fields for figures the client can derive exactly.
- **By-team / by-user over time are two separate pages / tiles** (user decision). The server sends
  per-root rows and the client folds roots into team / user by first placement, reusing the
  Share / Sankey mapping.
  - *Rejected:* the server grouping by team / user. Placement (first placement, multi-team roots)
    already lives on the client, and a second copy on the server would drift.
- **Edits by tool** counts only a fixed whitelist of built-in tool names (Edit, MultiEdit, Write,
  NotebookEdit). It keeps the existing DD-11 masking: roots that DD-11 masks for the caller
  (another member's session under `team-no-prompts`) are left out at every node level.
  - *Rejected:* a whitelist exception to DD-11. It would show tool names that the details panel
    hides on the same node, and the requirements say charts keep the masking rules.
- **Tile mode reuses the carousel's page list.** A grid of compact charts goes into the existing
  pane, with the mode in localStorage `artisyn:liveChartMode` (try/catch, as in `chart-tab.ts`).
  No new chart library or grid library is added. The responsive grid uses Tailwind container
  queries, which the project already uses.

## Reference

Requirements: [requirements.md](requirements.md). The FR-1 gap table and the answered open
question are in that file. Research trail: `research/findings-1.md`.

## Architecture decisions

**Reuse and placement**

- **Per-root series query.** It reads `otel_cost_buckets` grouped by `(session_id, bucket_start)`
  over the node's `rootIds` and the 2 h window, the same source and filter as `view.buckets`. It
  is sent for every non-agent node and is `[]` for agent nodes, like `flows`.
- **Edits-by-tool query.** It reads `otel_spans` with `name = OTEL_SPAN_TOOL` and a whitelisted
  `tool_name`, binned with `bin5m(start_time)`, and filtered with `spanAgentSql` on an agent node.
  So it is sent for every node type, agent included.
- **Row cap.** `rootSeries` is capped at a new constant `OTEL_LIVE_ROOT_SERIES_ROWS`: 1200 rows,
  which is 50 roots × 24 buckets.
  - A row is about 108 bytes of JSON, so the cap costs at most 129,600 bytes per poll before
    compression.
  - Usual nodes hold far fewer roots, since only live roots and roots that ended within 2 h count.
  - When the cap is hit, the roots with the highest 2 h cost are kept whole.
  The client draws whatever the listed roots do not cover as an "Other" series: the bucket total
  from `view.buckets` minus the sum of the listed roots. That way a stack never under-reports.
- **Team / user mapping.** The client maps `rootId` to team / user through the existing first
  placement mapping in `live-share-data.ts` (`rootsUnder`) and does not add a new one.
  - Roots that are not in `nodes` fall into "Other".
  - "Over time by user" is hidden on session nodes.
  - "Over time by team" is shown on every non-agent node.
  - Both use the same hide-when-all-zero rule as the existing pages.
- **"Edits by tool" page.**
  - It is shown when `view.hasSpans` is true and the data has a non-zero value.
  - When `hasSpans` is false it shows a "not reported" state instead of zeros. In tile mode that
    is a tile with a "not reported" note; in the carousel it is the page note.
  - When spans exist but there are no edits, the page is hidden like any all-zero page. That
    includes the case where every root is masked.
  - `hasSpans` means "any span in the 2 h window", the same as on the latency page. So a node
    with a current hook but no spans in the last 2 h also reads "not reported". The help text
    says "no traces in the last 2 h" and does not blame the hook version.
- **KPI row.**
  - The four new tiles render on home / team / No team / repo / session nodes. Active users is
    left out on session nodes, and agent nodes are unchanged.
  - Every new tile has a `hint`.
  - Undefined values render `n/a` (ui-principles; user decision).
  - Cache hit % reuses `OtelCacheRatioTile` and `otelCacheReadRatio` unchanged.
  - Total tokens is new optional props on `OtelTokensTile` (a total line and `sparkline`). The OTEL
    tabs that do not pass them render as today.
- **Compact charts.**
  - `OtelCostChart`, `LiveLatencyChart` and `LiveSharePage` get an optional compact mode: a small
    height and no legend or controls. Each existing call site keeps today's look by default.
  - The grid and the enlarged view are rendered by the carousel module, which owns the page list,
    so pages are built once.
- **Enlarged view.**
  - It is today's carousel page plus a "‹ All charts" button. The page is kept by `id` across polls
    and node changes, the existing `pageId` mechanism.
  - If the id is no longer in the page list, the view returns to the grid.
  - Esc returns to the grid while a tile is enlarged and must not close the Radix modal, which
    stays closable with Esc from the grid.
- **Mode storage.**
  - The key `artisyn:liveChartMode` holds `'tiles' | 'carousel'`. An unknown or unreadable value
    means `'tiles'`.
  - The enlarged state is component state only and is never stored.
  - The key is global, not per-user, as the splitter widths are.

**Internal contracts**

- `buildLiveChartPages(...)` returns the full ordered page list for both modes. The two new page
  ids are `team-time` and `user-time`, and the edits page id is `edits-by-tool`. Tile and carousel
  rendering both consume this list.
- Client helpers (pure, in `client/src/viewer/live/`):
  - `liveActiveUsers(nodes, selectedKey): number | null`
  - `liveActiveHoursMs(nodes, selectedKey): number | null`
  - `liveTokenSpark(view, windowFrom, windowTo): number[]`, which returns 24 points.
  - The first two return null when there are no session roots under the node.

## External surface

**API**

`GET /api/v1/otel/live`: same params, auth (session guard, team-scope row filter, never 403) and
grain. `OtelLiveView` gets two fields:

- `rootSeries: OtelLiveRootSeriesRow[]`
  - Row fields:
    - `rootId: number`
    - `start: string` (ISO, UTC 5-min bucket start)
    - `calls: number`
    - `costUsdMicros: string`
    - `tokens: string` (input + output + cache read + cache write)
  - `rootId` = `sessions.id`, the same id as a session node's `rootId` in `nodes`.
  - The row set is the selected node's root set (`rootIdsOf(selected)`) before the cap.
  - Ordered by `rootId`, then `start`. Only buckets with `calls <> 0`.
  - At most `OTEL_LIVE_ROOT_SERIES_ROWS` rows, keeping whole roots in order of their 2 h cost.
  - `[]` for an agent node and when the node has no roots.
- `editsByTool: OtelLiveEditsRow[]`
  - Row fields:
    - `start: string` (ISO, 5-min bucket start)
    - `tool: 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit'`
    - `count: number`
  - Ordered by `start`, then `tool`.
  - Every node type. On an agent node it is filtered to that agent.
  - DD-11 masking: a root is excluded when DD-11 masks it under **any** of the caller's
    placements of that root. That is another member's session in a `team-no-prompts` team,
    and it applies even when the same root is visible through a transparent team.
    - It is excluded on every node: home, team, No team, repo, session and agent.
    - So a masked session or agent node gets `[]`.
    - *Rejected:* judging masking per placement under the selected node. It is safe-side
      simpler, and the counts from one root cannot differ by the node they are viewed from.
  - Tools outside the whitelist never appear.

Backward compatible: both fields are additive.

- Older clients ignore them.
- The client mirror declares them optional (`rootSeries?`, `editsByTool?`), and missing means
  "no data": the pages are hidden, and Edits by tool falls back to the `hasSpans` rule.
- `GET /api/v1/otel/live/status` is unchanged.

**DB**

None. The new reads use the existing `otel_cost_buckets (session_id, bucket_start)` access path
and the `otel_spans (session_id, start_time)` index from migration `0089`.

**Other**

- **New browser storage key** `artisyn:liveChartMode` (`'tiles' | 'carousel'`) in localStorage.
  A missing or invalid value means tiles. It is new, so there is nothing to migrate.
- **New server constant** `OTEL_LIVE_ROOT_SERIES_ROWS` (code constant, not config).
- **Hook / OTEL ingest:** unchanged. Edits by tool needs hook ≥ `OTEL_LIVE_HOOK_MIN_VERSION`
  with traces on; without spans the page says "not reported".
- **In-app help** (`user-docs/otel-tab.md`, built by `npm run build:help`): it describes tile mode
  and the new KPIs and pages, and ships offline.

## Test coverage plan

- **API contract:**
  - Extend `F25-live-home-idle` in `server/test/contract/registry/f25-otel.ts` with
    `rootSeries: []` and `editsByTool: []` in its exact `view` match.
  - Every other live row that pins `view` gets the same fields.
  - No populated live row is added, and world-v1 is untouched. The live rows are golden and
    `noDb` by design: the world's OTEL data is January 2026, so nothing is live. Populated
    behaviour is pinned by the scenario below, which already ingests fresh live data.
  - The route is unchanged otherwise, so the router meta-test stays satisfied.
- **Scenario:** extend `tests/scenarios/view/s-otel-02.spec.ts` (`@S-OTEL-02`, mode a).
  - The default view is tiles: the grid is visible and shows the new KPI testids.
  - Clicking a tile enlarges it with Metric controls, and "‹ All charts" returns to the grid.
  - Switching to Carousel survives closing and reopening the modal. The existing carousel steps
    run after this switch.
  - The "Over time by team" and "Over time by user" pages show on home.
  - The fixture gains Edit / Write tool spans and one `Read` span (`spanLine`) on the session in
    S, which sits under both the restricted team R and the transparent team T.
    - "Edits by tool" shows Edit / Write but never Read.
    - A session with no spans shows "not reported".
  - In the existing AC-11 masking step, the manager does not see that session's edits, at any
    node level, per the any-placement rule in External surface.
- **Algorithm:** none. No algorithm doc is touched: the tree is unchanged, and the new client
  helpers have no algorithm doc and are covered by the scenario.

## Visual/UX notes

- The KPI row follows `wireframes/live-tile-mode.svg`: the existing row first, then Active users,
  Cache hit %, Active hours and Total tokens with a sparkline. The tiles wrap in the existing flex
  row.
- Header row over the charts: "Charts · N charts · last 2 h, 5-min buckets · click a tile to
  enlarge", with an `OtelSegmented` "Tiles | Carousel" toggle on the right.
- The grid uses `@container` with 1 / 2 / 3 / 4 columns as the pane width grows. It reaches
  4 columns at the default pane width on a 1440 px viewport, where the pane is 1036 px before
  padding.
- Each tile shows the title, a compact chart and a ⤢ icon on hover. The whole tile is a button
  with a focus ring.
- Share is one tile with its three doughnuts shrunk.
- The enlarged view follows `wireframes/live-tile-enlarged.svg`: "‹ All charts", ‹ n / N ›, the
  title, then the page's own Metric / By controls. Carousel mode is the same view without
  "‹ All charts".
- The Sankey and the breakdown table stay below, unchanged.
- An empty grid shows the carousel's existing empty-state text.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Server: new live view fields | 5 | server only; defines the API the client chunks consume |
| 2 | Client: new KPI tiles | 4 | needs only existing data; independent of chunk 1 |
| 3 | Client: new chart pages | 5 | consumes the chunk 1 fields (per External surface) |
| 4 | Client: tile mode | 6 | builds on the page list from chunk 3 |
| 5 | Scenario, docs and help | 5 | last; covers chunks 1–4 |

### Chunk 1 — Server: new live view fields
`GET /api/v1/otel/live` returns `view.rootSeries` and `view.editsByTool`.
Where: `server/src/logs/otel/` (live SQL loaders, live reader `buildView`, live types, live
constants) and `server/test/contract/registry/f25-otel.ts`
- [ ] `OtelLiveView` carries `rootSeries` and `editsByTool` with the shapes, ordering, gating
      by node type and row cap in External surface.
- [ ] Both loaders run inside the existing `buildView` `Promise.all` over the node's `rootIds`
      and the 2 h window, under the same team-scope row filter. They add no per-root round trip.
- [ ] `editsByTool` counts only the four whitelisted tool names and is filtered to the agent on
      an agent node. It leaves out every root that DD-11 masks under any of the caller's
      placements, per External surface.
- [ ] Live contract rows that pin `view` include the two new fields, and
      `npm run test:contract` passes.
- [ ] Server lint, typecheck and algorithm tests pass. `npm run perf` (`.claude/rules/server.md`)
      shows no metric worse by more than 20 %.

### Chunk 2 — Client: new KPI tiles
The Live view shows Active users, Cache hit %, Active hours and Total tokens with a sparkline.
Where: `client/src/viewer/live/` (KPI tiles, pure helpers), plus the shared
`client/src/viewer/pages/repository/otel/OtelKpiTile.tsx`, which the OTEL tabs also use
- [ ] The helpers `liveActiveUsers`, `liveActiveHoursMs` and `liveTokenSpark` exist with the
      signatures in Architecture decisions. They count DISTINCT session roots under the selected
      node through the existing `rootsUnder` mapping.
- [ ] The four tiles render per the node-type rules in Architecture decisions (no Active users on
      session nodes, agent nodes unchanged), each with a `hint`, and show `n/a`, never 0, when
      undefined.
- [ ] `OtelTokensTile` takes the optional total and sparkline props, and the OTEL tabs that do
      not pass them look unchanged.
- [ ] The tiles update on the existing poll and carry stable `data-testid`s
      (`live-kpi-active-users`, `live-kpi-cache-hit`, `live-kpi-active-hours`, plus the total on
      the tokens tile).

### Chunk 3 — Client: new chart pages
The carousel has the "Over time by team", "Over time by user" and "Edits by tool" pages.
Where: `client/src/viewer/live/` (chart page builder, carousel pages) and
`client/src/models/otel-live.ts`
- [ ] The client model mirrors the two new fields as optional, per External surface.
- [ ] `team-time` and `user-time` pages fold `rootSeries` into team / user by first placement,
      with an "Other" series for the remainder against `view.buckets`. Each has Metric =
      Cost / Tokens / Calls.
- [ ] `user-time` is hidden on session nodes, both pages are absent on agent nodes, and both
      follow the all-zero hide rule.
- [ ] The `edits-by-tool` page shows per-tool counts over time when spans exist, shows
      "not reported" when `hasSpans` is false, and is hidden when spans exist but there are no
      edits.
- [ ] Client lint, typecheck and algorithm tests pass.

### Chunk 4 — Client: tile mode
The Live view opens in a responsive tile grid. A tile enlarges to the full page, and the mode is
remembered.
Where: `client/src/viewer/live/` (view pane, carousel, chart components) and the shared chart
components `OtelCostChart`, `LiveLatencyChart` and `LiveSharePage`
- [ ] The Tiles | Carousel toggle switches modes. The mode is stored in `artisyn:liveChartMode`
      with try/catch and defaults to tiles. The enlarged tile is never stored.
- [ ] In tile mode every page from `buildLiveChartPages` (Share included) is a compact tile with
      no controls, in a container-query grid that reaches 4 columns at the default pane width. The
      Sankey and the breakdown table stay below.
- [ ] Clicking a tile enlarges it with its controls and ‹ › paging, and "‹ All charts" or Esc
      returns to the grid. Esc does not close the modal while a tile is enlarged.
- [ ] On a node change the enlarged page stays if its id exists on the new node, else the view
      goes back to the grid. The same happens when a poll removes the page. An empty grid shows
      the existing empty message.
- [ ] Compact mode is opt-in on the shared chart components, and their other call sites are
      visually unchanged.
- [ ] A visual check of the grid, an enlarged tile and the carousel at a 1440 px and a 1920 px
      viewport matches the wireframes.

### Chunk 5 — Scenario, docs and help
Tests and documentation cover the new behaviour.
Where: `tests/scenarios/view/s-otel-02.spec.ts`, `tests/scenarios/fixtures/otel/`, the
`docs/knowledgebase/` articles `otel-tabs.md`, `client-component-map.md` and
`client-routing-and-layout.md`, and `user-docs/otel-tab.md`
- [ ] `@S-OTEL-02` covers the steps in the Test coverage plan, and
      `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-OTEL-02"` passes.
- [ ] `otel-tabs.md` § Live view describes the two new view fields, the new KPIs (Active hours =
      sum of `runningMs`), the new pages and tile mode. `client-component-map.md` (the `live/`
      row) is updated.
- [ ] `artisyn:liveChartMode` is listed under "Other browser keys" in
      `client-routing-and-layout.md`.
- [ ] `user-docs/otel-tab.md` § Live view explains tile mode, the new KPIs and the new pages, and
      `npm run build:help` regenerates the help.
- [ ] The full health set (`adlc-lh:check-health`, `finalRun: true`) passes.
