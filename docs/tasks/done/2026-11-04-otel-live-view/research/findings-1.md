# Research findings 1 — 2026-11-04

I found everything the plan needs. Two things change the plan's assumptions:

- **The sibling task's changes are now committed.** The working tree is clean. `ffb91b7` ("OTEL cost attribution from new Claude Code telemetry") on `feature/2026-11-03-otel-cost-attribution` holds all the otel client/server/test edits from the snapshot, plus this task's folder. The live view should branch from that commit or after it merges.
- **Some requirements have no data source today.** API errors, the non-call "latest events" and the input/output/cache token split per bucket do not exist in `otel_*`.

## Requirements summary
Add a **Live** item to the top header. It shows a pulsing dot plus a tooltip with the live root-session count. The header polls `GET /api/v1/otel/live/status` every 30 s while the tab is visible. Clicking it opens a modal at 90%×90% of the viewport, deep-linkable by `?live=<nodeKey>` on the current page; Back, ✕ and Esc close it.

- **Left pane: live tree.** Home → team / "No team" → repo → session → agent. Only nodes with OTEL activity in the last 10 min (`computeOtelLiveness`). Placement and access come from the `scopedTreeCtes` / `resolveTeamScope` path. A repo in several teams appears under each. Parent totals count each root once (DISTINCT root).
- **Middle pane: live view.** KPI tiles, a chart carousel from `otel_cost_buckets` (5 min grain, last 2 h), and a breakdown of children with fixed columns. An agent node lists its latest 50 calls instead.
- **Right pane: details panel.** Names and the first prompt come from regular tables; live figures come only from OTEL. An "Open session ↗" link closes the modal and opens the session.
- **Polling.** Every 5 s, with Pause / Resume. A node that stops being live stays greyed and marked "ended" while it is selected. A failed refresh keeps the last data and shows a retry banner.
- **Access.** In a team where the viewer lacks `analyticsAllowed`, they see only their own sessions. `team-no-prompts` masking applies. Each of the two new routes needs a contract-registry row.

## Wireframes
All 8 SVGs in `docs/tasks/todo/2026-11-04-otel-live-view/wireframes/` were reviewed (text extracted).

- **`header-live-entry.svg`:** Live sits between Home and All views. The dot is a red core with a halo, pulsing, and respects `prefers-reduced-motion`. Tooltip: "Live now: 3 sessions · 5 agents · $0.42". So the status route needs agents and cost too, not only the `{live, liveSessions}` in FR-12.
- **`live-modal.svg`:**
  - Header: "Live · ⓘ OTEL only · Updated 2 s ago · 3 live sessions · 5 agents", Pause, ✕. Tree nodes carry costs.
  - The chart is labelled "last 60 min · 2-min buckets", with tabs Cost / Tokens / Calls by model / Tool calls / LLM latency / API errors and "1 / 6". **This conflicts with FR-5** (5-min grain, 2 h); the FR should win.
  - Its breakdown columns (Name, Cost, Tokens in/out, Cache read, Running, Last activity) differ from FR-5's fixed set.
  - The details panel shows Claude Code version, cache read/write, "API calls · errors", LLM p50/p95, TOP TOOLS with "1 failed" and an "mcp: playwright" entry, and LATEST EVENTS including `api_error 529`, `tool_result` and `user_prompt (masked)`.
- **`live-modal-states.svg`:**
  - Empty state: "Nothing is live right now" plus a "How to enable OTEL" link (must point to in-app help, offline-first).
  - Paused: "Paused at 14:33:12", Resume, and "7 updates arrived since pause". That counter implies polling something while paused, which conflicts with FR-8's "stops polling".
  - Failure banner: "Connection lost — showing the last data received at … Retrying in 5 s…".
- **`tree-edge-cases.svg`:**
  - Shared repo under both teams. Example: Home $5.14 < 3.90 + 1.26 + 1.24 = $6.40 (exact sum checked).
  - No team = personal repos. An ended node is greyed with "ended".
  - Restricted member: 🔒 on the team, own sessions only. `team-no-prompts`: "prompt hidden".
  - Node-key table: `home` / `team:<teamId>` / `noteam` / `repo:<repoId>` / `session:<rootId>` / `agent:<rootId>:<agentId>`.
- **`chart-carousel.svg`:** 6 pages.
  1. Cost over time.
  2. Tokens over time, stacked by cache read / cache write / input / output.
  3. Calls and cost by model ("$4.90 · 212").
  4. Cost by structure (main / sub-agents / hidden %).
  5. Skill / MCP server ("if reported").
  6. Latency p50/p95 + API errors, spans only, with an LLM | tools toggle.

  A 2 h window at 5-min grain is exactly 24 buckets.
- **`session-agent-view.svg`:**
  - Session pane: breadcrumb, "Open session ↗", tiles Cost / Tokens / Agents live / Cost/min (last 5 min). Agent rows: Agent, Cost, In, Out, Cache R, Cache W, Calls, Running, Last. Hidden calls count in the session total but get no agent row.
  - Agent pane: tiles Cost / Calls / Model / Running. Call rows: Time, Model, Source (`agent:Explore`), Cost, In/Out, Cache R, Duration.
- **`details-panel-variants.svg`:**
  - Repo / team: live sessions, live users, cost, longest running, top users, top models (team adds "Top repos"), plus a link to the repo's / team's OTEL tab.
  - Session: user, started, last activity, cost/tokens, first prompt, agents, top tools (spans), latest OTEL events.
  - Agent: `agent_id`, type, model, calls, cost/tokens, running, top tools, latest calls; no Open-session button.
  - Ended session: "No OTEL data for 10 min — figures are final."
- **`click-flow.svg`:**
  - A tree click selects the node with a `replace` URL update.
  - A row click or ⓘ opens the details panel and leaves the selection unchanged.
  - ↗ closes the modal and navigates, keeping the team context.
  - ✕ / Esc / Back remove `?live=` and leave the page underneath unchanged.

## Knowledgebase
- **`docs/knowledgebase/otel-tabs.md`** (main article):
  - Root session is the key; sub-agents are told apart by `agent_id` (DD-1).
  - "Live rule, two consumers": `computeOtelLiveness` / `isRecent` in `otel-facts.reader.ts`; a new route would be a third consumer, so add it to that list.
  - Scope and access (DD-6, DD-29); team DISTINCT roots; masking (DD-22).
  - Buckets are the 5-min UTC grain with no repository and no agent column.
  - Client polling (DD-20): `OTEL_SESSION_POLL_MS` 5 s, `OTEL_REPO_POLL_MS` 30 s, Pause / Resume.
  - Shapes live in `otel-facts.types.ts`, mirrored in `client/src/models/repositories.ts` / `teams.ts`.
  - Routes table and compatibility matrix; contract rows in `f25-otel.ts`; scenario `s-otel-01`.
  - Update this article for the new routes and the third liveness consumer.
- **`docs/knowledgebase/server-endpoint-map.md`:**
  - Lines 70-90: the team access-mode gate. List routes row-filter; analytics routes 403 when `!analyticsAllowed`; masking is a projection, never a `WHERE`.
  - Line 210: controller index (add the new controller).
  - Literal segments go before parametric siblings: `/otel/live/status` before any `:param`.
- **`docs/knowledgebase/client-routing-and-layout.md`:**
  - Code splitting: 9 `import()` targets today, budget about 8, hard cap 10. A new page or tab joins an existing barrel.
  - The `HelpModal` pattern: a lazy import in `MainNav` with `helpOpen` / `helpLoaded` flags and `Suspense fallback={null}`.
  - URL state: copy the params, then `setSearchParams`. Opening pushes; every other change uses `replace: true`.
  - The `session` URL param is the only source of the selected session.
- **`docs/knowledgebase/twins-and-cross-cutting-rules.md:87`:** a new lazy UI joins an existing barrel; never add a new `import()`.
- **`docs/knowledgebase/ui-principles.md`:** light-only colours, status colours, popups never leave the viewport, one hint/tooltip style.
- **`docs/knowledgebase/client-component-map.md`:** the top bar is `pages/main/MainNav.tsx`; `components/top-nav/` holds the bar's widgets. Update the map if a new folder (for example `viewer/live/`) is added.
- **`docs/knowledgebase/db_state.sql:370-528`:** the `otel_calls` / `otel_cost_buckets` / `otel_session_state` / `otel_spans` DDL and indexes. Details are under Open gaps.
- **`docs/knowledgebase/algorithms/README.md`:** a new pure algorithm (tree assembly or ended-node retention) needs a doc plus `docs/algorithm-examples/<name>.json`. Existing related docs: `otel-delta-merge.md` (client), `otel-facts.md` (server).
- **`docs/knowledgebase/test/index.md`:** links `scenarios.md` and `contract-tests.md`.
- **`server/test/contract/README.md`:** oracle SQL is hand-written and differs from the app's; world data only via `world-v1.sql.ts`; new ids below 1000.
- **`docs/knowledgebase/user-docs-and-site.md`:** the help article would go in `user-docs/otel-tab.md` (offline-first). The empty state's "How to enable OTEL" should point to an in-app help anchor (`enable-otel-and-traces` exists).

## Existing patterns
**Server**
- **Controller and query parsing.** `server/src/logs/otel/otel-facts.controller.ts:156-195`: `parseRepoOtelFactsQuery`, `tzParam` (IANA check, 400), `single` / `enumParam` / `repeatable`, `RawQuery`.
- **Team controller.** `otel-team-facts.controller.ts:86-113`: `@Controller('api/v1/teams')` with `SessionAuthGuard`, `isTeamMember`, `resolveTeamScope`, and a 403 when `!analyticsAllowed`. Live must **not** 403 here: FR-11 row-filters instead.
- **Registration.** `server/src/logs/logs.module.ts:35,91`: where the OTEL controllers are registered.
- **Scope SQL.**
  - `server/src/logs/tool-monitoring/tool-usage-read.sql.ts:147-163`: `scopedTreeCtes`, i.e. the artisyn log joined through `log_repositories`, `deleted = false`, `scopedUserFilterSql(teamScope,'l')`.
  - `otel-facts-read.sql.ts:122`: `otelScopedRootsCtes`.
  - `otel-facts-read.sql.ts:1337-1394`: `teamRepoIdsCte` (`team_repo_id = MIN(r.id)` per URL), `otelTeamRootsCtes` (`root_repos`, `root_primary_repo`, `scoped_roots` DISTINCT). This is the template for DISTINCT-root parent totals.
- **Bucket reads.**
  - `otel-facts-read.sql.ts:202-226`: `repoBucketSource(roots, window, filters, extra)`, the `fb` CTE over `scoped_roots`.
  - `:287`: `loadRolledBuckets` with `stackKeySql` (`:138`: structure / model / skill / mcpServer…).
  - `:379`: `loadKpiSums`, which already returns input / output / cache read / cache write totals.
  - `:1495`, `:1576`: `loadOtelTeamPeople`, `loadOtelTeamRepositories` (per-person and per-repo rows with live flags).
  - `:801`: `loadRealtimeCounts`.
- **Per-session reads.** `otel-facts-read.sql.ts:1079` `readOtelStateRow`, `:1190` `loadSessionCalls`, `:1271` `loadSessionSpans`, `:1020` `resolveOtelRoot`, `:1044` `loadScopedRootOwner`.
- **Reader helpers.** `otel-facts.reader.ts`:
  - `:329-371`: `isRecent` and `computeOtelLiveness`, the one liveness definition.
  - `:439`: `masksOtelAttributes`.
  - `:154` / `:450`: `deriveRepoKpis` / `deriveTeamKpis`.
  - `:667-822`: `getTeamOtelFacts`, i.e. the `Promise.all` of loaders over one `fb` source.
- **Scope and masking.**
  - `server/src/logs/repositories.service.ts:318-411`: `resolveTeamScope`, with its role → visibility / `analyticsAllowed` matrix. Personal (`teamId` undefined) means own-only with `analyticsAllowed: true`.
  - `repositories.service.ts:152-198`: `assertRepoAccess`. The personal view admits only the `repositories` row owner.
  - `server/src/logs/team-scope.ts`: `TeamScope`, `maskFirstPrompt`.
- **Constants and span names.** `otel-facts.constants.ts:10` `OTEL_SESSION_ENDED_MS = 600_000`; `otel-classify.ts:71` `OTEL_BUCKET_MS`, `:74` `bucketStart5m`; `otel-span-names.ts`.

**Client**
- **Header.** `client/src/viewer/pages/main/MainNav.tsx:22-24,93-127`: Help's lazy modal with the `helpOpen` / `helpLoaded` pattern. The Live entry goes after Home (`:59-69`) per the wireframe.
- **Modal sizing.** `client/src/viewer/help/HelpModal.tsx:119`: `DialogContent className="w-[90vw] max-w-[1100px] h-[85vh] p-0 …"`. For Live use `w-[90vw] h-[90vh] max-w-none`; the base `DialogContent` in `client/src/viewer/ui/dialog.tsx:61` has `max-w-lg`, which must be overridden.
- **Polling engine.** `client/src/viewer/pages/repository/otel/useOtelLivePoll.ts`:
  - Already provides visibility pause, Pause / Resume with one catch-up poll, `lastUpdatedAt`, and keeping `state` on error (that covers FR-13).
  - It also has an idle stop after `OTEL_IDLE_STOP_MS` (10 min), which FR-7 does not mention.
  - It stops polling when `isLive(state)` is false. For Live this must return true (the empty state still polls).
- **Pulsing dot and live indicator.** `OtelLiveIndicator.tsx:68`: `bg-emerald-500 animate-pulse` plus labels. `client/src/viewer/ui/notification-dot.tsx`: the absolute red dot. `client/src/viewer/app.css:259-290`: `@media (prefers-reduced-motion: reduce)` override pattern for custom keyframes.
- **Header poll.** `components/top-nav/NotificationBell.tsx:28-32`: `useQuery` with `refetchInterval`. React Query's default `refetchIntervalInBackground: false` gives "only while visible".
- **Charts and tiles.**
  - `OtelCostChart.tsx`: Recharts stacked bars over `OtelBucket[]` with `stackBy`.
  - `otel-chart-data.ts`: `buildOtelSeries`, `buildOtelChartRows`, `OTEL_SERIES_PALETTE`, `OTEL_NOT_REPORTED_*`.
  - `OtelKpiTile.tsx`: `OtelKpiTile`, `OtelTokensTile`.
  - `otel-format.ts`: `formatMicrosUsd`, `formatTokenCount`, `formatClock`.
  - `OtelChartControls.tsx:24`: `OtelSegmented`.
  - `OtelHelpLink.tsx`, `OtelEmptyState.tsx`.
- **Session-tab parts for the agent / session panels.** `session-log/otel/otel-span-format.ts:89-120`: `otelSpanDetail` (`tool_name`, `success` attributes), `otelSpanDurationMs`. Also `session-otel-kpis.ts`.
- **Team tab.** `pages/teams/otel/TeamOtelTab.tsx`, `OtelPeopleTable.tsx`, `OtelRepositoriesTable.tsx`: tables of people and repos with costs.
- **API and routes.**
  - `client/src/viewer/api.ts:880-920`: the `fetchRepoOtelFacts` / `fetchTeamOtelFacts` style, URLSearchParams with `signal`.
  - `client/src/viewer/hooks/useHashRoute.ts:4-30`: `routes.repo(id)`, `routes.teamRepo(teamId, repoId)`. The session opens with the `?session=<session_id>` search param (`useRepositoryViewState.ts:73`).

**Tests**
- **Contract registry.** `server/test/contract/registry/f25-otel.ts` (hand-written oracle SQL; `PERSONAL_ROOTS`, `teamRoots(acknowledgedOnly)`, `bucketsOf`), `registry/index.ts`. World: `server/test/contract/fixtures/world-v1.sql.ts:2950+` `otelStatements()`.
  - All OTEL state timestamps are fixed to January 2026, so nothing is live in the contract world. A status row naturally gives `{live:false, liveSessions:0}` (AC-12).
  - A positive row needs `now()`-relative state rows, precedent at `world-v1.sql.ts:2801-2806`. Add a **new** session rather than moving existing ones: F25 `realtime` counts depend on `rt_last_at`.
- **Scenarios.**
  - `tests/scenarios/view/s-otel-01.spec.ts`:
    - `:755` "live session tab" test: realtime batches via `sendRealtime`, Pause / Resume request counting at `:850`, an aged-state step at `:1043`. Hosts AC-7 / AC-8 / AC-13.
    - `:1065` "team OTEL tab" test: restricted team with owner / manager / member / trainer, a session linked to repos A+B, sessions uploaded just before. Hosts AC-3a / AC-11 / AC-11a.
    - `:582` hosts the no-OTEL / empty-state step.
  - Helpers: `tests/scenarios/helpers/otel.ts` (`uploadOtelChunk`, `postRealtime`, `sendRealtime`, `waitForOtelProjected`, `teamFacts`). Note that `chunk_last_at` is the **upload time**, so freshly uploaded scenario sessions are live for 10 min.
  - Live view is a genuinely new feature, so a new `s-otel-02` file is allowed by policy; extending `s-otel-01` is the alternative.
- **Algorithm rows.** `docs/algorithm-examples/otel-delta-merge.json` and `client/.../otel/otel-merge.algo.test.ts` are the vitest table-test pattern for a new client algorithm, such as tree merge with ended-node retention.

## Open gaps
1. **No API-error data.** `extractOtelCalls` (`otel-records.ts:24,183`) stores only `claude_code.api_request`. `api_error`, `tool_result` and `user_prompt` events are not in any `otel_*` table. This blocks the "API errors" chart, "API calls · errors" and most of the "latest OTEL events" list. Options: derive from spans (span status / attributes, if present), add an extraction plus a projection-version bump (history re-projects), or drop it from scope.
2. **No token split per bucket.** `OtelBucket` / `loadRolledBuckets` return only the summed `tokens`. The stacked "tokens over time" chart needs a new rolled-bucket shape with 4 token sums. The `otel_cost_buckets` columns already exist.
3. **No agent dimension in buckets.** `otel_cost_buckets` has only `structure`. Agent-node charts, per-agent tiles and agent rows must come from `otel_calls` (`agent_id`, `agent_name`, `event_time`; index `idx_otel_calls_session_agent`), bucketed in SQL. Undecided:
   - the key for the main agent (`agent_id` NULL; something like `agent:<root>:main`);
   - whether hidden calls are excluded from agent rows;
   - the agent label source (`otel_calls.agent_name` from 0088, or workflow `.meta.json` labels).
4. **Status route is not cheap yet.** There is no index on `otel_session_state.rt_last_at` / `chunk_last_at`; only `created_at` and `user_id` are indexed. FR-12 needs a migration (an expression index on `GREATEST(rt_last_at, chunk_last_at)` or two indexes), plus the `db-state-update` and `migrations-data-integrity` skills. The status payload probably also needs agents and cost for the tooltip (wireframe vs FR-12).
5. **No user-wide tree scope exists.** Every current route is scoped to one repo or one team. The plan must decide:
   - how "No team" is defined: the user's own `repositories` rows whose URL is linked to no team the user belongs to? Or also personal rows of team-linked URLs (the personal view `assertRepoAccess` admits those too)? This affects double placement;
   - the `repo:<id>` identity. A team node uses `team_repo_id = MIN(r.id)` per URL across members, which can differ per team, while the personal view uses the user's own row id. `repo:<id>` alone is ambiguous for deep links and team context; the key may need to be `team:<t>/repo:<id>`, or the team inferred;
   - whether `session:<rootId>` means `sessions.id` (int) or `session_id` (string).
6. **Who counts as lacking analytics access.** FR-11 says "lacks `analyticsAllowed`" means own sessions only. That also catches an ADLC-trainer-only member, who has `team-with-prompts` visibility but `analyticsAllowed: false`. Confirm that is intended, or filter on `visibleUserIds` instead. Unlike the team OTEL route, Live must row-filter, never 403.
7. **Session link path.** FR-10 says `/repositories/:repoId/sessions/:sessionId`, but that is the API path. The client route is `routes.repo(id)` / `routes.teamRepo(t, r)` plus `?session=<session_id>` (and probably `tab`).
8. **Lazy chunk budget.** 9 of at most 10 `import()` targets are used. The Live modal (Recharts plus tree) must join an existing barrel (Workspace or repository-tabs) or take the 10th and last slot.
9. **`?live=` on every page.** This param is new. Existing page setters copy the params, so it should survive, but the modal must push on open (so Back closes) and `replace` on node change. There is no shared AppShell-level URL-modal precedent; `MainNav` holds Help in local state only.
10. **Polling engine fit.** `useOtelLivePoll` has the idle stop and an `isLive` gate that FR-7 / FR-3 do not want (it must keep polling an empty tree). Either add options, or build a thin hook. Ended-node retention (keep the selected or panel node greyed) is new client logic and a candidate algorithm doc plus rows.
11. **Paused counter.** The wireframe shows "7 updates arrived since pause", which needs some request while paused; FR-8 says polling stops. Drop the counter, or let the cheap status route feed it.
12. **Masking of tool names.** For masked sessions the span `attributes` are dropped, so `tool_name` is unavailable. Decide whether "top tools" (aggregate counts computed server-side) count as masked; the precedent is that aggregates stay unmasked.
13. **Small derived values.**
    - Running time: decide the event set. Calls only (`otel_calls.event_time`), or also spans (`start_time` / `end_time`).
    - Cost/min over the last 5 min: buckets are 5-min floors, so that window spans a partly filled bucket. Read `otel_calls.event_time >= now − 5 min` instead.
14. **No live data in the contract world.** No contract-world session is live. A positive row for `GET /api/v1/otel/live` needs new `now()`-relative world rows (a new session id below 1000), and every F25 count must be re-checked.
