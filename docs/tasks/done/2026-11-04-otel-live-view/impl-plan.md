# Implementation plan — 2026-11-04 OTEL Live View

## TL;DR

- New server module set in `server/src/logs/otel/`:
  - `otel-live.types.ts`: shapes;
  - `otel-live.constants.ts`: limits and window;
  - `otel-live-read.sql.ts`: live roots, placement and figures SQL;
  - `otel-live-tree.ts`: the pure `buildOtelLiveTree` / `parseOtelLiveNodeKey` / `formatOtelLiveNodeKey`;
  - `otel-live.reader.ts`: `OtelLiveReader.getStatus` / `getLive`;
  - `otel-live.controller.ts`.
- Two new read routes:
  - `GET /api/v1/otel/live/status` → `{ live, liveSessions, liveAgents, costUsdMicros }`;
  - `GET /api/v1/otel/live?node=&panel=&tz=` → tree, selected-node view and details.

  Both are user-wide: personal plus every team the caller belongs to.
- DB: one migration `0089_otel_live_totals`:
  - an expression index on `otel_session_state (GREATEST(rt_last_at, chunk_last_at))`;
  - two new tables `otel_session_totals` / `otel_agent_totals`, which hold lifetime sums kept up to date by the OTEL writer (DD-22), so a poll never re-sums a multi-day session;
  - time indexes `otel_calls (session_id, event_time)` and `otel_spans (session_id, start_time)` for the window queries.
- Long sessions (DD-23): totals are "since start", charts and details use the 2 h window, the session agent list is capped, a retained key older than 24 h falls back to home, durations show days.
- Node keys get an optional `@<teamId>` / `@noteam` placement suffix. Unqualified FR-12 keys (`repo:<id>`) stay valid and resolve to the first placement.
- **Scope cuts versus the wireframes:**
  - no "API errors" series and no `api_error` / `user_prompt` events (not stored in any `otel_*` table);
  - no "N updates since pause" counter;
  - the chart grain is 5 min / 2 h (FR-5), not 2 min / 60 min.
- Client:
  - DTO mirror `client/src/models/otel-live.ts`, plus `fetchOtelLiveStatus` / `fetchOtelLive` in `api.ts`;
  - Live header entry `components/top-nav/LiveNavItem.tsx`, rendered in `MainNav.tsx`;
  - new folder `client/src/viewer/live/` (modal, tree, view pane, carousel, breakdown, details, URL state);
  - the modal joins the existing `repository-tabs-lazy-group.ts` barrel, so no new lazy chunk;
  - `useOtelLivePoll` gains an additive `refreshAbortsInFlight` option.
- Tests:
  - a new algorithm doc and rows file `otel-live-tree`;
  - three contract rows in `f25-otel.ts` (status, live home, live 400);
  - a new scenario `tests/scenarios/view/s-otel-02.spec.ts` (`@S-OTEL-02`), justified as a genuinely new feature.
- Docs: KB updates, plus a "Live view" section in `user-docs/otel-tab.md` (then `npm run build:help`).

## Reference

Requirements: [requirements.md](requirements.md) · Wireframes: [wireframes/](wireframes/) · Research archive: `research/findings-1.md`.

Branch base: `feature/2026-11-03-otel-cost-attribution` at `ffb91b7`, or `main` once that branch is merged. It already contains every OTEL client/server edit this plan builds on: `skill` / `mcp_server` bucket dimensions and `otel_calls.agent_name`.

## Design Decisions

**DD-1 Liveness.** A root is live when `computeOtelLiveness` (`server/src/logs/otel/otel-facts.reader.ts:349`) says so. In SQL the candidate filter is `GREATEST(s.rt_last_at, s.chunk_last_at) >= now - OTEL_SESSION_ENDED_MS`, read through the new index. `GREATEST` ignores NULLs in Postgres, so it equals the TS rule. `now` is taken once per request in TS and passed as a parameter. This makes the live route the third consumer of the live rule; the KB list gains it.

**DD-2 Agent liveness.** An agent is live when its `otel_agent_totals.last_call_at` (its last `otel_calls.event_time`) is within `OTEL_SESSION_ENDED_MS` of `now` and its root is live.

**DD-3 Node-key grammar.** One parser and one formatter live in `otel-live-tree.ts`. The client never parses or builds keys: it uses the canonical `key` / `type` / ids that the server sends on every node. `client/src/viewer/live/live-node-key.ts` only holds `HOME_LIVE_KEY` and a prefix-based `liveNodeType(key)` for the URL value before the first answer. That is not a computed twin, so no `packages/` module is needed.

| Type | Canonical key (emitted) | Accepted unqualified form |
|---|---|---|
| home | `home` | — |
| team | `team:<teamId>` | — |
| No team | `noteam` | — |
| repo | `repo:<repoId>@<teamId>` or `repo:<repoId>@noteam` | `repo:<repoId>` |
| session | `session:<rootId>@<teamId\|noteam>` | `session:<rootId>` |
| agent | `agent:<rootId>:<agentKey>@<teamId\|noteam>` | `agent:<rootId>:<agentKey>` |

- **Ids.**
  - `rootId` is `sessions.id` (int), the `session_id` of every `otel_*` table.
  - `repoId` under a team is the team repository id `MIN(repositories.id)` per URL (`teamRepoIdsCte`, `otel-facts-read.sql.ts:1337`). Under No team it is the caller's own `repositories.id`.
  - `agentKey` is `otel_calls.agent_id`, or the literal `main` for `agent_id IS NULL AND structure <> 'hidden'`.
- **Parsing.** Split the suffix at the last `@`, and split agent ids at the first two `:`.
- **Resolution.** An unqualified key resolves to its first placement: teams ordered by name, then No team. A malformed key → 400. A well-formed key the caller cannot see, or that has no data → `selected: 'home'`, and the client replaces the URL.

**DD-4 Placement and access (FR-3, FR-6, FR-11).**

- **Teams.** The caller's teams are listed by the new `loadOtelLiveTeams(db, callerId)`: `SELECT t.id, t.name FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.user_id = $caller ORDER BY t.name, t.id`. This is the same membership rule as `isOtelTeamMember` (`otel-facts-read.sql.ts:1416`). For each team the reader calls `RepositoriesService.resolveTeamScope(user, teamId)` (`repositories.service.ts:318`) and builds an `OtelLiveScopeTeam` (DD-20). The effective row filter for that team is:
  - `visibleUserIds` when `analyticsAllowed`;
  - `[user.id]` otherwise, and the team node then carries `restricted: true` (🔒).
- **A root is placed under team T** when its `artisyn` log (`logs.log_type = 'artisyn'`, `sessions.deleted = false`) has a `log_repositories` row whose `repositories.repo_url` is linked to T in `team_repositories`, and `l.user_id` passes T's filter. The repo node id is the `team_repo_id` of that URL. A root linked to two repos of one team is placed under both repo nodes; the team total still counts it once.
- **No team** holds roots whose log links to a `repositories` row owned by the caller (`r.user_id = caller`, `l.user_id = caller`) whose `repo_url` is linked to no team the caller belongs to.
- **Roots with no `log_repositories` link are not placed** (FR-3).
- **One SQL statement does all of this.** The per-team filters are passed in as a `scope_teams(team_id int, user_ids int[] NULL)` VALUES CTE, so nothing runs per team.
- **Multi-team repository ids.** `teamRepoIdsCte` takes a single team, so the live SQL adds its own `live_team_repo_ids(team_id, repo_id, team_repo_id, repo_url)` CTE:
  - the same joins as `otel-facts-read.sql.ts:1337` (`team_repositories` → `team_members` → `repositories` on URL and member);
  - `WHERE tr.team_id IN (SELECT team_id FROM scope_teams)`;
  - `team_repo_id = MIN(r.id) OVER (PARTITION BY tr.team_id, tr.repo_url)`.

**DD-5 Candidate roots and retention (FR-7).** Candidates are the live roots (DD-1) plus the roots named by the `node` and `panel` query params (retained). A retained root is placed and figured exactly like a live one, with `live: false`. A named root whose last activity is older than `OTEL_LIVE_RETAIN_MAX_MS` (24 h) is not retained, so an old `?live=session:…` link falls back to home (DD-3), not to a long-dead session (DD-23).

- **Retained ancestors.** For a retained repo, team or No-team key, the node itself plus its ancestors are emitted with `live: false` and zero totals when nothing live remains under it.
- **How keys are retained.**
  - Only session and agent keys contribute root ids, which are added to the candidates.
  - Team, No-team and repo keys go to `buildOtelLiveTree` only as `retainedKeys`.
  - A retained team key is kept only if the team is in the caller's `scopeTeams`.
  - A retained repo key with no placement row gets its label from `loadOtelLiveRepoLabel(db, callerId, teamId | null, repoId)`. That query returns `repo_url` only when the id is a `team_repo_id` of a caller team (team suffix) or a `repositories` row owned by the caller (`@noteam`), and null otherwise. Null → the key is dropped and the DD-3 fallback applies.
- **No client-side retention algorithm.** The server is the single place that decides what stays. A node disappears on the next poll after the user selects something else, because the client stops sending its key.

**DD-6 Totals (FR-3, FR-5).** Every node carries `OtelLiveTotals`.

- **Session.** Its cost, token and call sums are the session lifetime ("since start"), read from `otel_session_totals` (DD-22).
  - `firstEventAt` and `lastActivityAt` are its `first_call_at` / `last_call_at`.
  - `runningMs = last − first`, from calls only, not spans (wall clock, FR-5).
  - `liveAgents` counts its live agents (DD-2).
- **Agent.** The same sums come from its `otel_agent_totals` row; `agentLabel` is `agent_name` if reported, otherwise `agentKey`.
- **Parents** (home, team, No team, repo):
  - sums are over the DISTINCT roots below the node;
  - `runningMs` is the max over the node's live sessions;
  - `liveSessions` / `liveAgents` are counted over DISTINCT live roots and agents;
  - `lastActivityAt` is the max.
- **Hidden calls** (`structure = 'hidden'`) count in session and parent totals but get no agent node.

**DD-7 Charts (FR-5).**

- **Window.** `windowTo = bucketStart5m(now) + OTEL_BUCKET_MS` and `windowFrom = windowTo − OTEL_LIVE_WINDOW_MS`, which gives `OTEL_LIVE_WINDOW_MS / OTEL_BUCKET_MS` = 7 200 000 / 300 000 = 24 five-minute buckets (`OTEL_BUCKET_MS` and `bucketStart5m` are in `otel-classify.ts:71,74`).
- **`tz`.** It is accepted (FR-12), validated and echoed, but does not change any bound: 5-minute buckets are UTC-aligned whatever the zone. The client formats times in the zone it sent.
- **Bucket rows.** `buckets: OtelLiveBucket[]` holds one row per `(bucket_start, structure, model, skill, mcp_server)`, with every sum, over the selected node's DISTINCT roots. They are read from `otel_cost_buckets`, except for an agent node, where they come from `otel_calls` grouped by `date_bin('5 minutes', event_time, TIMESTAMPTZ '1970-01-01Z')` (the buckets have no agent column).
- **Latency rows.** `latency: OtelLiveLatencyBucket[]` holds one row per `(bucket_start, kind)` from `otel_spans` with `end_time IS NOT NULL`, where `kind` is:
  - `llm` = `claude_code.llm_request`;
  - `tool` = `claude_code.tool`.

  Fields: `count`; `p50Ms` / `p95Ms` via `percentile_cont`; `failed` = rows with `attributes->>'success' = 'false'`. An agent node filters `otel_spans.agent_id`.
- **The client derives the carousel pages** (DD-13).

**DD-8 Cost per minute.** `costPerMinUsdMicros` = sum of `otel_calls.cost_usd_micros` with `event_time > now − OTEL_LIVE_COST_RATE_MS` over the node's roots (and the agent filter), floor-divided by `OTEL_LIVE_COST_RATE_MS / 60 000` = 5. It is serialized as a decimal string.

**DD-9 Breakdown (FR-5).**

- **Parent nodes.** `view.breakdown` is the node's direct tree children as `OtelLiveNode[]`.
- **Session nodes.** The breakdown lists its agents that have calls, ended ones with `live: false`, newest last activity first, capped at `OTEL_LIVE_BREAKDOWN_AGENTS` (50); `view.moreAgents` counts the rest ("+N more", DD-23). The tree shows only live agents, plus a retained agent.
- **Agent nodes.** `view.breakdown` is `[]`; `view.calls` holds its latest 50 calls (`OTEL_LIVE_AGENT_CALLS_LIMIT = 50`), newest first. `durationMs` is taken from the `claude_code.llm_request` span with the same `request_id`, else null.
- **Footnote.** `view.distinctFootnote` is true for parent nodes whose total is less than the sum of their children's totals.

**DD-10 Details (FR-9).** `details` is filled only for the `panel` key; it is null without one.

- **team / noteam / repo / home:**
  - From the tree, via the pure `summarizeOtelLiveNode(tree, key)` in `otel-live-tree.ts`:
    - `topUsers` (email, liveSessions, costUsdMicros; top `OTEL_LIVE_TOP_N` by cost, over DISTINCT roots);
    - `liveUsers` (distinct user ids of live roots);
    - `longestRunningMs` (= the node's `runningMs`);
    - for a team node, `topRepos` (its repo children, top `OTEL_LIVE_TOP_N`).
  - From SQL: `topModels` (model, calls, costUsdMicros; top `OTEL_LIVE_TOP_N`, over the node's roots' buckets in the DD-7 window, labelled "last 2 h").
- **session:**
  - `userEmail` and `startedAt` (from `sessions` / `logs.start_time`), plus `claudeVersion` (latest `otel_calls.claude_code_version`);
  - `firstPrompt`, masked per DD-11;
  - `agents`: its agent nodes;
  - `topTools`: name, calls, failed; top 8 from tool spans `attributes->>'tool_name'` that start in the DD-7 window (labelled "last 2 h");
  - `events`: latest 20, merged from calls (`api_request`) and tool spans (`tool`), as `{ time, kind, label, costUsdMicros }`.
- **agent:** `agentId`, `agentLabel`, top `model`, `topTools`, `events`, the same calls as DD-9.

**DD-11 Masking (FR-11).** For a session whose placement team scope is `team-no-prompts` and whose owner is not the caller:

- `firstPrompt` goes through `maskFirstPrompt` (`server/src/logs/team-scope.ts`);
- `topTools` and the tool-span `label`s in `events` become `null`;
- `attributesMasked: true`.

Aggregates (counts, costs) stay unmasked. Under No team the caller owns every session, so nothing is masked there.

- **Where masking happens.** The reader masks each placement row's `firstPrompt` with `maskFirstPrompt(scopeTeam.scope, callerId, row.userId, row.firstPrompt)` before `buildOtelLiveTree`, so tree labels and details are already masked.
- **Details masking** (`attributesMasked`, `topTools`, event labels) uses the `TeamScope` of the panel session's placement team.

**DD-12 Status route (FR-1, FR-12).** It uses the same candidate and placement SQL as the tree, without retention.

- It returns DISTINCT live roots (`liveSessions`), live agents (`liveAgents`) and `costUsdMicros`, the lifetime sum of the live roots (from `otel_session_totals`, DD-22).
- `live = liveSessions > 0`.
- `liveAgents` and `costUsdMicros` go beyond FR-12's minimum; they are additive fields that the wireframe tooltip needs.

**DD-13 Carousel pages (client).** Pages are derived in `client/src/viewer/live/live-chart-data.ts`. A page whose rows are all zero is skipped.

| # | Page | Source / stack key | Notes |
|---|---|---|---|
| 1 | Cost over time | `buckets`, key `''` | always shown |
| 2 | Tokens over time | `buckets`, 4 keys `input` / `output` / `cacheRead` / `cacheWrite` | |
| 3 | Calls and cost by model | key `model` | |
| 4 | Cost by structure | key `structure` | |
| 5 | Cost by skill / MCP server | key `skill`, or `mcpServer` via an `OtelSegmented` toggle | |
| 6 | Latency p50 / p95 | `latency` | LLM \| tools toggle, with a failed-tool count; only when `hasSpans` |

- **Rendering.** Pages 1–5 map rows to `OtelBucket` (`start`, `key`, `calls`, `costUsdMicros`, `tokens`, `changeKind: 'confirm'`) and render with the existing `OtelCostChart` (`client/src/viewer/pages/repository/otel/OtelCostChart.tsx:43`). Shared props: `interval: '5m'`, `view: 'absolute'`, `cumulative: false`, `newBucketKeys: new Set()`, `hiddenKeys` / `onToggleKey` from local state. `OtelMetric` is `'cost' | 'calls' | 'tokens'` (`otel-url-state.ts:26`).

  | Page | `metric` | `stackBy` | How rows map |
  |---|---|---|---|
  | 1 | `cost` | `''` | rows summed per `start`, key `''` |
  | 2 | `tokens` | `tokenKind` | each row yields 4 `OtelBucket`s, keys `input` / `output` / `cacheRead` / `cacheWrite`, with `tokens` = that sum as a string |
  | 3 | `cost` or `calls`, via an `OtelSegmented` toggle | `model` | key = `model` |
  | 4 | `cost` | `structure` | key = `structure` |
  | 5 | `cost` | `skill` / `mcpServer` | key = `skill` or `mcpServer` |
- **Page 6** is a small Recharts line chart.
- **Dropped.** API errors and Claude Code metrics (LOC, commits, active time) are not available and are not shown.

**DD-14 Polling (FR-7, FR-8, FR-13).**

- **Header.** It uses React Query `useQuery(['otel-live-status'], fetchOtelLiveStatus, { refetchInterval: OTEL_REPO_POLL_MS })`. The default `refetchIntervalInBackground: false` gives "visible only", as in `NotificationBell.tsx:28`.
- **Modal.** It uses `useOtelLivePoll` (`client/src/viewer/pages/repository/otel/useOtelLivePoll.ts`):
  - `intervalMs: OTEL_SESSION_POLL_MS`, `resetKey: 'live'`, `isLive: () => true`;
  - the poll step reads `node` / `panel` from refs and returns `{ state, newKeys: EMPTY_OTEL_NEW_KEYS, filled: NO_OTEL_FILLED }`;
  - a selection or panel change calls `refresh()` with the new `refreshAbortsInFlight: true` option;
  - Pause / Resume reuse the hook's own `setPaused`.
- **Idle stop.** The existing `OTEL_IDLE_STOP_MS` idle stop is kept (any input resumes), as on every OTEL tab.
- **Errors.** On error the hook keeps `state`; the modal shows the FR-13 banner using `lastUpdatedAt`.
- **`refreshAbortsInFlight` in `useOtelLivePoll`.**
  - `runPoll` keeps its own `controller`; its catch and finally clean up only when `abortRef.current === controller`.
  - An aborted run never sets `error`, `state` or `isLoading`.
  - With the option on, `refresh()` aborts the active controller, sets `inFlightRef.current = false`, then calls `runPoll()`. With the option off, behaviour is unchanged.

**DD-15 URL state (FR-2).** Only `?live=<nodeKey>` is in the URL; the details-panel key is local state.

- **Opening** copies the search params, sets `live=home` and pushes.
- **Selecting a node** replaces.
- **✕ / Esc** delete `live` and replace; **Back** pops the push.
- **The modal is mounted from `LiveNavItem` inside `MainNav`**, so it works on every page that has the header. It is open iff `searchParams.has('live')`.

**DD-16 Open session (FR-10).** The link target is:

- under a team: `routes.teamRepo(teamId, repoId)`;
- under No team: `routes.repo(repoId)` (`client/src/viewer/hooks/useHashRoute.ts`);

plus `?session=<sessionUuid>` (`useRepositoryViewState.ts:73`). `sessionUuid` = `sessions.session_id`, returned on session nodes. Navigating drops `live`, which closes the modal. The details panel's "OTEL tab" links use the repo page's `mtab` param and the team page's tab param with value `otel` (`TeamDetailPage.tsx:108`).

**DD-17 Lazy loading.** `LiveModal` is exported from `client/src/viewer/pages/repository/repository-tabs-lazy-group.ts`, which already carries Recharts and the OTEL tab code, so no new `import()` target is added. `LiveNavItem` loads it with `lazy()` plus the `helpLoaded` latch pattern of `MainNav.tsx:22-33`.

**DD-18 Empty and ended states.**

- **Nothing live:** only Home, and the middle pane shows "Nothing is live right now" plus `OtelHelpLink` to the `enable-otel-and-traces` help section (offline).
- **Ended nodes:** greyed with an "ended" chip. The details panel of an ended session shows "No OTEL data for N min — figures are final.", with N = `OTEL_LIVE_ENDED_MS / 60 000` (client constant, DD-21).

**DD-21 Client constants** (`client/src/viewer/live/live.constants.ts`):

| Constant | Value | Note |
|---|---|---|
| `OTEL_LIVE_ENDED_MS` | `600_000` | mirror of server `OTEL_SESSION_ENDED_MS` |
| `LIVE_TREE_WIDTH_PX` | `260` | |
| `LIVE_DETAILS_WIDTH_PX` | `320` | |
| `LIVE_STATUS_QUERY_KEY` | `['otel-live-status']` | |

Polling intervals reuse `OTEL_SESSION_POLL_MS` / `OTEL_REPO_POLL_MS` from `pages/repository/otel/otel.constants.ts`.

**DD-20 Server internal shapes (seam between chunks 2, 3 and 4).** These are exported from `otel-live.types.ts`. Money and token sums are decimal strings and times are ISO strings, as in the DTOs. `OTEL_SESSION_ENDED_MS` is imported from `server/src/logs/otel/otel-facts.constants.ts`, and `OTEL_BUCKET_MS` / `bucketStart5m` from `otel-classify.ts`.

```ts
interface ParsedLiveKey {
  type: OtelLiveNodeType; teamId?: number; noteam?: boolean; qualified: boolean;
  repoId?: number; rootId?: number; agentKey?: string;
}
interface OtelLiveWindow { from: Date; to: Date }
interface OtelLiveAgentFilter { rootId: number; agentKey: string }   // agentKey 'main' = agent_id IS NULL AND structure <> 'hidden'
interface OtelLiveNodeSummary {
  topUsers: NonNullable<OtelLiveDetails['topUsers']>; liveUsers: number;
  longestRunningMs: number; topRepos: OtelLiveDetails['topRepos'];   // null unless type = team
}
interface OtelLiveScopeTeam { teamId: number; teamName: string; userIds: number[] | null; restricted: boolean; scope: TeamScope }
interface OtelLiveCandidate { rootId: number; live: boolean }   // live per DD-1
interface OtelLivePlacementRow {
  rootId: number; userId: number; userEmail: string;
  teamId: number | null;            // null = No team
  repoId: number; repoLabel: string; // team_repo_id or own repositories.id; repositories.repo_url
  firstPrompt: string | null;       // logs.first_prompt of the root's artisyn log (masked by the reader, DD-11)
  sessionUuid: string;              // sessions.session_id
  startedAt: string | null;         // logs.start_time
}
interface OtelLiveRootTotalsRow {
  rootId: number; costUsdMicros: string; inputTokens: string; outputTokens: string;
  cacheReadTokens: string; cacheWriteTokens: string; calls: number;
  firstEventAt: string | null; lastActivityAt: string | null;
}
interface OtelLiveAgentRow {
  rootId: number; agentKey: string; agentLabel: string; costUsdMicros: string; inputTokens: string;
  outputTokens: string; cacheReadTokens: string; cacheWriteTokens: string; calls: number;
  firstEventAt: string; lastEventAt: string;
}
interface OtelLiveTreeInput {
  now: Date; scopeTeams: OtelLiveScopeTeam[]; candidates: OtelLiveCandidate[];
  placements: OtelLivePlacementRow[]; rootTotals: OtelLiveRootTotalsRow[]; agents: OtelLiveAgentRow[];
  retainedKeys: ParsedLiveKey[]; retainedRepoLabels: { teamId: number | null; repoId: number; label: string }[];
}
interface OtelLiveTree { nodes: OtelLiveNode[]; resolve(key: string): OtelLiveNode | null; rootIdsOf(key: string): number[] }
```

- **Session-node `label`.** `userEmail · ` plus the first `OTEL_LIVE_PROMPT_EXCERPT_CHARS` (= 80) characters of `firstPrompt`, or `prompt hidden` when masked to null.

**DD-19 Backward compatibility.** Both routes are new, so older clients never call them. Hooks are unchanged, and the old hook's chunk-only sessions are live via `chunk_last_at`. The migration adds indexes and two derived tables and changes no existing row; the totals fill themselves (DD-22), so no backfill is needed. The status DTO may gain fields later; the client must tolerate missing optional fields.

**DD-22 Stored live totals.** A poll must not re-sum every live session's lifetime: a multi-day session has thousands of buckets and far more calls, and the plain approach costs viewers × live sessions × session size every 5 s. The server runs several processes, so the totals live in Postgres, written by the OTEL writer, not by the read path (a GET never writes, per the `security-check` invariant).

- **Tables** (migration 0089, both `ON DELETE CASCADE` to `sessions`):
  - `otel_session_totals (session_id PK, calls int, cost_usd_micros bigint, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens bigint, first_call_at, last_call_at timestamptz, seq bigint)`;
  - `otel_agent_totals (session_id, agent_key varchar(255), agent_name varchar(255) NULL, the same sums, first_call_at, last_call_at, seq, PK (session_id, agent_key))`. `agent_key` is the DD-3 `agentKey` (`agent_id`, or `main`); `hidden` calls have no agent row.
- **Delta path** (`upsertOtelCalls`, `otel-facts-writer.ts:624`). The writer already subtracts each changed call's old contribution and adds its new one for the buckets (`addContribution`, `:409`). The same −old / +new contributions also go into one session delta and per-`agentKey` deltas (old and new key may differ). The new `applyOtelTotalsDeltas` upserts them:
  - sums are added (`ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x`);
  - `first_call_at = LEAST(...)`, `last_call_at = GREATEST(...)`, and `agent_name = COALESCE(EXCLUDED.agent_name, agent_name)`;
  - the session row is stamped with the write's `seq` whenever the write touched `otel_cost_buckets`, even with a zero sum delta.
- **Freshness rule.** The delta path is used only when the session row is current: it exists and `seq >= MAX(otel_cost_buckets.seq)` of the root before this write (one backward step on `idx_otel_cost_buckets_session_seq`). Otherwise the writer runs `rebuildOtelTotals` instead. This one rule covers new sessions, sessions older than the migration, and buckets written by an older server process during an upgrade.
- **Rebuild path.** `rebuildOtelTotals(tx, rootId, seq)` recomputes both tables from `otel_calls` with one `GROUP BY` (agent rows with no calls left are zeroed, like buckets) and sets exact `first_call_at` / `last_call_at`. It is called by the freshness rule and by `reclassifyOtelSession` after `rebuildOtelBuckets` (`:1370`), because a reclass can move calls into or out of `hidden`.
- **Times.** On the delta path an `update` that moves a call's `event_time` can leave `first_call_at` / `last_call_at` slightly wide until the next rebuild. This is acceptable for a running-time display.
- **Locks.** Everything runs inside the writer's transaction that already holds the `otel_session_state FOR UPDATE` lock (DD-2 lock order), so there is no new lock and no race between processes.
- **Purge.** `purgeSessionChildData` (`sessions.service.ts:185`) and the deleted-session cleanup (`otel-projection.service.ts:~503`) delete both tables next to `otel_cost_buckets`.
- **Read path.** The reader takes rows by primary key for the live roots. If a root's session row is missing or `seq < MAX(otel_cost_buckets.seq)` (same index step), the reader computes that root's totals inline with the rebuild `GROUP BY`, read-only, and the next write repairs the row.
- **Load** (estimated; measured by `npm run perf` in chunk 1):
  - per OTEL write: +1 PK read, +1 index step, +1 session upsert and +k agent upserts (k = agents in the batch, usually 1–2);
  - per poll: R PK reads per table plus R index steps (R = live roots), independent of session age and of how many people watch.

**DD-23 Long-running sessions (several days).**

- **Totals** are the session lifetime. The tiles and breakdown header say "since start"; Cost/min, the charts, `topModels` and `topTools` are window figures labelled "last 2 h" / "last 5 min".
- **Running time** is wall clock (FR-5), so a session paused overnight shows its full span. The client formats it with `formatLiveDuration(ms)`: `45s`, `12m`, `3h 12m`, `2d 4h`. The existing `formatDuration` (`client/src/viewer/lib/format.ts:8`) stops at minutes and is not reused.
- **Times shown** ("Paused at", "showing data from", Last activity) use `formatLiveClock(iso, now)`: `hh:mm:ss` today, otherwise `MMM d, hh:mm`.
- **Bounded lists:** session agents in the breakdown (DD-9, 50 + "+N more"), agent calls (50), events (20), top lists (5 / 8).
- **Window queries** use indexes: `otel_cost_buckets` by its primary key prefix `(session_id, bucket_start)`; `otel_calls` and `otel_spans` by the new time indexes.
- **Old deep links** fall back to home after 24 h (DD-5).
- **A tab hidden for days, or a long pause:** the next poll returns the current snapshot; nothing is replayed.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0089_otel_live_totals.sql` | activity index, two totals tables, two time indexes | + `meta/_journal.json` entry idx 89 |
| `server/src/database/schema/index.ts` | declare the activity index next to `idx_otel_session_state_created_at` (`:674`), the time indexes on `otelCalls` / `otelSpans`, and `otelSessionTotals` / `otelAgentTotals` after `otelSessionState` | drizzle `index().on(sql\`GREATEST(...)\`)` |
| `docs/knowledgebase/db_state.sql` | regenerated | `db-state-update` skill |
| `server/src/logs/otel/otel-facts-writer.ts` | session / agent deltas in `upsertOtelCalls`, `applyOtelTotalsDeltas`, `rebuildOtelTotals`, freshness rule, call from `reclassifyOtelSession` | DD-22 |
| `server/src/sessions/sessions.service.ts` | `purgeSessionChildData` deletes both totals tables | DD-22 |
| `server/src/logs/otel/otel-projection.service.ts` | deleted-session cleanup deletes both totals tables | DD-22 |
| `client/src/viewer/live/live-format.ts` | `formatLiveDuration`, `formatLiveClock` | DD-23 |
| `server/src/logs/otel/otel-live.types.ts` | DTOs | API changes section |
| `server/src/logs/otel/otel-live.constants.ts` | `OTEL_LIVE_WINDOW_MS = 7_200_000`, `OTEL_LIVE_COST_RATE_MS = 300_000`, `OTEL_LIVE_AGENT_CALLS_LIMIT = 50`, `OTEL_LIVE_EVENTS_LIMIT = 20`, `OTEL_LIVE_TOP_N = 5`, `OTEL_LIVE_TOP_TOOLS = 8`, `OTEL_LIVE_PROMPT_EXCERPT_CHARS = 80`, `OTEL_LIVE_BREAKDOWN_AGENTS = 50`, `OTEL_LIVE_RETAIN_MAX_MS = 86_400_000` | |
| `server/src/logs/otel/otel-live-tree.ts` | pure key parse / format + `buildOtelLiveTree` | algorithm doc |
| `server/src/logs/otel/otel-live-read.sql.ts` | candidate, placement, figures, buckets, latency, calls, details SQL | |
| `server/src/logs/otel/otel-live.reader.ts` | `OtelLiveReader` | |
| `server/src/logs/otel/otel-live.controller.ts` | two routes | |
| `server/src/logs/logs.module.ts` | register controller + reader (`controllers` / `providers` arrays) | |
| `client/src/models/otel-live.ts` | client mirror of the DTOs | |
| `client/src/viewer/api.ts` | `fetchOtelLiveStatus`, `fetchOtelLive` (style of `:880-920`) | |
| `client/src/viewer/pages/repository/otel/useOtelLivePoll.ts` | additive `refreshAbortsInFlight` option | |
| `client/src/viewer/components/top-nav/LiveNavItem.tsx` | header entry, dot, tooltip, lazy modal mount | |
| `client/src/viewer/pages/main/MainNav.tsx` | render `LiveNavItem` between Home and All views | |
| `client/src/viewer/app.css` | `prefers-reduced-motion` guard if a custom keyframe is used | |
| `client/src/viewer/live/live-node-key.ts` | client key helpers | DD-3 |
| `client/src/viewer/live/live.constants.ts` | client constants | DD-21 |
| `client/src/viewer/live/useLiveUrlState.ts` | `?live=` read / open / select / close | DD-15 |
| `client/src/viewer/live/LiveModal.tsx` | modal shell, header bar, polling, banners | |
| `client/src/viewer/live/LiveTree.tsx` | left pane | |
| `client/src/viewer/live/LiveViewPane.tsx` | middle pane: breadcrumb, tiles, carousel, breakdown / calls | |
| `client/src/viewer/live/LiveKpiTiles.tsx` | tiles per node type | reuse `OtelKpiTile` |
| `client/src/viewer/live/live-chart-data.ts` | page derivation | DD-13 |
| `client/src/viewer/live/LiveChartCarousel.tsx` | carousel | |
| `client/src/viewer/live/LiveBreakdownTable.tsx` | breakdown + agent calls table | |
| `client/src/viewer/live/LiveDetailsPanel.tsx` | right panel per type | |
| `client/src/viewer/pages/repository/repository-tabs-lazy-group.ts` | `export { LiveModal }` | DD-17 |
| `docs/knowledgebase/algorithms/otel-live-tree.md` + `docs/algorithm-examples/otel-live-tree.json` + `server/src/logs/otel/otel-live-tree.algo.spec.ts` | algorithm test | |
| `server/test/contract/registry/f25-otel.ts` | three rows | |
| `tests/scenarios/view/s-otel-02.spec.ts` | scenario `@S-OTEL-02` | |
| `docs/knowledgebase/otel-tabs.md`, `server-endpoint-map.md`, `client-component-map.md`, `client-routing-and-layout.md`, `algorithms/README.md`, `index.md` | KB | |
| `user-docs/otel-tab.md` | "Live view" help section | offline-first |
| `client/public/help/*.md` | regenerated by `npm run build:help` | generated, not hand-edited |

## API changes

Both routes sit in `@Controller('api/v1/otel/live')` with `@UseGuards(SessionAuthGuard)`. The literal `status` route is declared first.

### `GET /api/v1/otel/live/status`

- **No params.**
- **Response `OtelLiveStatusResponse`:**

```ts
{ live: boolean; liveSessions: number; liveAgents: number; costUsdMicros: string }
```

### `GET /api/v1/otel/live`

- **`node`:** optional, default `home`; grammar per DD-3. A malformed value → 400.
- **`panel`:** optional node key. Same grammar.
- **`tz`:** optional IANA zone; validate with the `tzParam` helper of `otel-facts.controller.ts:135`; 400 on an unknown zone; echoed back.
- **Response `OtelLiveResponse`:**

```ts
type OtelLiveNodeType = 'home' | 'team' | 'noteam' | 'repo' | 'session' | 'agent';

interface OtelLiveTotals {
  costUsdMicros: string; inputTokens: string; outputTokens: string;
  cacheReadTokens: string; cacheWriteTokens: string; calls: number;
  liveSessions: number; liveAgents: number; runningMs: number;
  firstEventAt: string | null; lastActivityAt: string | null;
}

interface OtelLiveNode {
  key: string;               // canonical, DD-3
  type: OtelLiveNodeType;
  parentKey: string | null;  // null for home
  label: string;             // team name / repo URL / user email · first-prompt excerpt (masked) / agent label
  live: boolean;
  inTree: boolean;           // false = ended agent shown only in a session breakdown (DD-9)
  restricted: boolean;       // team node filtered to own sessions (DD-4)
  teamId: number | null; repoId: number | null; rootId: number | null;
  sessionUuid: string | null; agentKey: string | null; userEmail: string | null;
  totals: OtelLiveTotals;
}

interface OtelLiveBucket {
  start: string; structure: 'main' | 'subagent' | 'hidden';
  model: string; skill: string; mcpServer: string;   // '' = not reported
  calls: number; costUsdMicros: string; inputTokens: string; outputTokens: string;
  cacheReadTokens: string; cacheWriteTokens: string;
}

interface OtelLiveLatencyBucket {
  start: string; kind: 'llm' | 'tool'; count: number; p50Ms: number; p95Ms: number; failed: number;
}

interface OtelLiveCallRow {
  callKey: string; eventTime: string; model: string | null; agentKey: string; agentLabel: string;
  structure: 'main' | 'subagent' | 'hidden'; costUsdMicros: string | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  durationMs: number | null;
}

interface OtelLiveView {
  costPerMinUsdMicros: string;
  buckets: OtelLiveBucket[]; latency: OtelLiveLatencyBucket[]; hasSpans: boolean;
  breakdown: OtelLiveNode[]; moreAgents: number;   // agents beyond the DD-9 cap, 0 otherwise
  calls: OtelLiveCallRow[] | null; distinctFootnote: boolean;
}

interface OtelLiveEvent {
  time: string; kind: 'api_request' | 'tool'; label: string | null; costUsdMicros: string | null;
}

interface OtelLiveDetails {
  key: string; type: OtelLiveNodeType; live: boolean;
  liveUsers: number | null; longestRunningMs: number | null;
  topUsers: { email: string; liveSessions: number; costUsdMicros: string }[] | null;
  topModels: { model: string; calls: number; costUsdMicros: string }[] | null;
  topRepos: { repoId: number; label: string; costUsdMicros: string }[] | null;
  userEmail: string | null; startedAt: string | null; claudeVersion: string | null;
  firstPrompt: string | null; attributesMasked: boolean;
  agents: OtelLiveNode[] | null; model: string | null;
  topTools: { name: string; calls: number; failed: number }[] | null;
  events: OtelLiveEvent[] | null; calls: OtelLiveCallRow[] | null;
}

interface OtelLiveResponse {
  generatedAt: string; tz: string; windowFrom: string; windowTo: string;
  selected: string;          // canonical key actually shown (DD-3 fallback → 'home')
  nodes: OtelLiveNode[];     // tree nodes (inTree) in display order: teams by name, No team last, children by cost desc
  view: OtelLiveView;
  details: OtelLiveDetails | null;
}
```

## Database changes

One migration, `server/drizzle/migrations/0089_otel_live_totals.sql`:

- **Activity index:** `CREATE INDEX IF NOT EXISTS idx_otel_session_state_last_at ON otel_session_state ((GREATEST(rt_last_at, chunk_last_at)));`
- **Totals tables:** `otel_session_totals` and `otel_agent_totals`, with the columns of DD-22, `session_id` FK `REFERENCES sessions(id) ON DELETE CASCADE`, and all sums `NOT NULL DEFAULT 0`. The primary keys are `(session_id)` and `(session_id, agent_key)`; no other index is needed.
- **Time indexes:** `idx_otel_calls_session_event_time ON otel_calls (session_id, event_time)` and `idx_otel_spans_session_start_time ON otel_spans (session_id, start_time)`.
- **Comments:** `COMMENT ON` for each new table, column and index.
- **Registration:** a journal entry, idx 89; the same objects are declared in `server/src/database/schema/index.ts`.
- **Apply:** apply to the local dev DB, then run the `db-state-update` skill and the `migrations-data-integrity` checklist.
- **Data:** no existing row changes and there is no backfill; the totals fill themselves by the DD-22 freshness rule.
- **Index build:** plain synchronous `CREATE INDEX` inside the migration, with no `CONCURRENTLY` (a decision of the owner).

## Test coverage plan

Per the CLAUDE.md test policy, only these three kinds:

- **Algorithm.** A new doc `docs/knowledgebase/algorithms/otel-live-tree.md`, a rows file `docs/algorithm-examples/otel-live-tree.json`, and a table test `server/src/logs/otel/otel-live-tree.algo.spec.ts`, loaded via `loadExamples`, as in `otel-facts.algo.spec.ts:6`. The rows cover:
  - key parse and format, including unqualified resolution and malformed keys;
  - a repo in two teams counted once at home;
  - a No-team placement;
  - a restricted team;
  - a retained ended session, and a retained repo with nothing live;
  - parent `runningMs` = max;
  - hidden calls counted in session totals with no agent node;
  - `distinctFootnote`.
- **API contract.** Three rows in `server/test/contract/registry/f25-otel.ts`:
  - `GET /api/v1/otel/live/status` expects `{ live: false, liveSessions: 0, liveAgents: 0, costUsdMicros: '0' }`. World OTEL state is fixed to Jan 2026, so nothing is live (AC-12).
  - `GET /api/v1/otel/live?node=home` expects only the home node, empty view arrays and `selected: 'home'`.
  - `GET /api/v1/otel/live?node=bogus` expects 400.

  The world fixture is not changed, which leaves the F25 counts untouched.
- **Scenario.** A new `tests/scenarios/view/s-otel-02.spec.ts` (`@S-OTEL-02 @mode-a`): Live is a feature no existing scenario covers. It reuses `tests/scenarios/helpers/otel.ts` (`uploadOtelChunk`, `sendRealtime`, `waitForOtelProjected`) and the restricted-team setup pattern of `s-otel-01.spec.ts:1065`. The steps cover AC-1 to AC-11a and AC-13 (Chunk 11 lists them); AC-12 is covered by the contract rows. The stored totals (DD-22) are checked there too: after a realtime update, a session's Live cost equals the cost on its session OTEL tab, which is summed from `otel_calls`.

## Visual/UX notes

- **Header.** The `Live` item is a ghost button with a `Radio` lucide icon and the label "Live", placed between Home and All views.
  - The dot is a red core (`bg-red-500`, 8 px) plus a halo (`animate-ping`, `bg-red-400/60`) with `motion-reduce:animate-none`.
  - The tooltip uses the project `Tooltip`: "Live now: N sessions · M agents · $x.xx" via `formatMicrosUsd`. With nothing live it says "Nothing live right now".
- **Modal.**
  - **Size and frame:** `DialogContent className="w-[90vw] h-[90vh] max-w-none p-0 flex flex-col"`, overriding the `max-w-lg` of `ui/dialog.tsx:61`.
  - **Header bar:** "Live · ⓘ OTEL only · Updated N s ago · X live sessions · Y agents", Pause / Resume, ✕.
  - **Panes:** tree 260 px, view flex-1, details panel 320 px (only while open). Each pane scrolls on its own.
- **States** (per `wireframes/live-modal-states.svg`):
  - **Paused:** an amber badge "Paused at hh:mm:ss" and a Resume button.
  - **Error:** an amber banner "Connection lost — showing data from hh:mm:ss, retrying".
  - **Empty:** "Nothing is live right now" plus the help link.
  - **Ended:** the node row at `opacity-60` with an "ended" chip.
- **Tree rows:** chevron, type icon, label (truncated, full text in `title`), a cost on the right, a 🔒 on restricted teams, and an ⓘ that appears on hover and opens the details panel.
- **Breakdown:**
  - **Columns:** Name, Cost, In, Out, Cache R, Cache W, Calls, Running, Last activity. Session rows add an "Open session ↗" link.
  - **Footnote** when `distinctFootnote`: "Parents count each session once; a session in several repos or teams appears under each."
  - **Agent node:** the call table Time, Model, Source, Cost, In/Out, Cache R, Duration.
- **Colours and popups:** light-only status colours and popups that never leave the viewport, per `docs/knowledgebase/ui-principles.md`. Follow the `ui-components` skill.

## Wireframes

No wireframe changes. The plan deviates from them in four places, all stated in DD-7 / DD-13 / DD-14:

- the grain is 5 min / 2 h, not 2 min / 60 min;
- there is no API-errors series and no `api_error` / `user_prompt` events;
- there is no "updates since pause" counter;
- the breakdown columns are FR-5's fixed set.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | DB migration + stored totals writer | 8 | none |
| 2 | Server types, constants, tree algorithm | 6 | pure TS, no DB |
| 3 | Server live SQL | 8 | uses the chunk 2 types (DD-20) |
| 4 | Server reader + controller | 7 | uses chunks 2–3 |
| 5 | Client models, API, poll hook option | 4 | mirrors the API changes section |
| 6 | Client header entry + URL state + modal shell | 7 | uses chunk 5 |
| 7 | Client tree, view pane, tiles, carousel | 6 | inside the chunk 6 shell |
| 8 | Client breakdown + details panel | 5 | inside the chunk 7 pane |
| 9 | KB + user docs | 4 | after the code is settled |
| 10 | Algorithm doc + rows + contract tests | 6 | |
| 11 | Scenario S-OTEL-02 | 8 | last |

### Chunk 1 — DB migration + stored totals writer
- [ ] Add `server/drizzle/migrations/0089_otel_live_totals.sql` with every object in Database changes (activity index, both totals tables, both time indexes, comments); indexes are built synchronously; follow the `migrations-data-integrity` skill.
- [ ] Add journal entry idx 89 / tag `0089_otel_live_totals` to `meta/_journal.json` (`when` greater than idx 88's) and run `npm run migrations:lock`. Declare the same objects in `server/src/database/schema/index.ts`.
- [ ] In `otel-facts-writer.ts`, add `otelAgentKeyOf(agentId, structure): string | null` (DD-3; null for `hidden`). In `upsertOtelCalls`, collect a session delta and per-agent deltas from the same −old / +new contributions as `addContribution`, plus event times and `agent_name`.
- [ ] Add `applyOtelTotalsDeltas(tx, rootId, sessionDelta, agentDeltas, seq)` per DD-22 (additive upsert, `LEAST` / `GREATEST`, `COALESCE` name, session row stamped whenever buckets were written). Call it after `applyBucketDeltas`, guarded by the freshness rule.
- [ ] Add `rebuildOtelTotals(tx, rootId, seq)` (one `GROUP BY` over `otel_calls`, zeroing agent rows with no calls left). Use it when the freshness rule fails, and call it in `reclassifyOtelSession` right after `rebuildOtelBuckets` (`:1370`).
- [ ] Delete both totals tables in `purgeSessionChildData` (`sessions.service.ts:185`, next to `otelCostBuckets`) and in the deleted-session cleanup of `otel-projection.service.ts` (`~:512`).
- [ ] Apply the migration to the local dev DB, then run the `db-state-update` skill to regenerate `docs/knowledgebase/db_state.sql`.
- [ ] Run the server fast set (lint, typecheck, algorithm tests), then `npm run perf` from `server/` in the background. The ingest metrics must not degrade by more than 20 %; stop and ask the user if they do.

### Chunk 2 — Server types, constants, tree algorithm
- [ ] Create `server/src/logs/otel/otel-live.types.ts` exporting every type of the API changes section, plus the DD-20 internal shapes and `ParsedLiveKey`.
- [ ] Create `server/src/logs/otel/otel-live.constants.ts` with every constant in the Files to create/modify row for it, including `OTEL_LIVE_PROMPT_EXCERPT_CHARS = 80`.
- [ ] In new `server/src/logs/otel/otel-live-tree.ts`, implement `parseOtelLiveNodeKey(key): ParsedLiveKey | null` and `formatOtelLiveNodeKey(parsed): string` per DD-3 (`ParsedLiveKey` in DD-20).
- [ ] In `otel-live-tree.ts`, implement pure `buildOtelLiveTree(input: OtelLiveTreeInput): OtelLiveTree` (shapes per DD-20), applying DD-4 placement, DD-5 retention, DD-6 totals, DD-2 agent liveness and DD-9 `inTree`; session labels per DD-20.
- [ ] Inside `buildOtelLiveTree`, implement `resolve` with unqualified-key resolution (DD-3), `rootIdsOf` (DISTINCT roots below a key), the `distinctFootnote` flag (DD-9), and ordering: teams by name, No team last, children by cost desc.
- [ ] In `otel-live-tree.ts`, implement pure `summarizeOtelLiveNode(tree, key): OtelLiveNodeSummary` (DD-20) per DD-10.

### Chunk 3 — Server live SQL
- [ ] Create `server/src/logs/otel/otel-live-read.sql.ts`; add `loadOtelLiveCandidateRoots(db, now, retainedRootIds): OtelLiveCandidate[]` using the DD-1 `GREATEST(...)` filter (hits the chunk-1 index), unioned with the retained ids whose last activity is within `OTEL_LIVE_RETAIN_MAX_MS` (DD-5).
- [ ] Add `loadOtelLiveTeams(db, callerId): {teamId, teamName}[]` (SQL in DD-4) and `loadOtelLiveRepoLabel(db, callerId, teamId | null, repoId): string | null` (access rule in DD-5).
- [ ] Add `loadOtelLivePlacements(db, callerId, scopeTeams: OtelLiveScopeTeam[], rootIds): OtelLivePlacementRow[]` per DD-4: one statement with the `scope_teams` VALUES CTE and the `live_team_repo_ids` CTE, plus the No-team branch; columns per DD-20.
- [ ] Add `loadOtelLiveRootTotals(db, rootIds): OtelLiveRootTotalsRow[]`: `otel_session_totals` rows by primary key, per DD-6. A root that is missing or stale by the DD-22 read-path check gets its totals from the inline read-only `GROUP BY` over `otel_calls`.
- [ ] Add `loadOtelLiveAgents(db, rootIds): OtelLiveAgentRow[]` from `otel_agent_totals` (`calls > 0`; `agent_name`, else `agentKey`, as `agentLabel`), with the same stale-root fallback grouped by `otelAgentKeyOf`, per DD-3 / DD-6 / DD-22.
- [ ] Add `loadOtelLiveBuckets(db, rootIds, window: OtelLiveWindow, agent?: OtelLiveAgentFilter): OtelLiveBucket[]` per DD-7 (cost buckets, or `otel_calls` `date_bin` for an agent), and `loadOtelLiveLatency(db, rootIds, window, agent?): OtelLiveLatencyBucket[]` from `otel_spans`.
- [ ] Add `loadOtelLiveCostRate(db, rootIds, now, agent?): string` per DD-8, and `loadOtelLiveCalls(db, agent: OtelLiveAgentFilter, limit): OtelLiveCallRow[]` per DD-9 with the `durationMs` span join.
- [ ] Add details loaders per DD-10, typed as the matching `OtelLiveDetails` fields:
  - `loadOtelLiveTopModels(db, rootIds, agent?)`;
  - `loadOtelLiveTopTools(db, rootId, agent?)`;
  - `loadOtelLiveEvents(db, rootId, agent?)`;
  - `loadOtelLiveClaudeVersion(db, rootId)`.

  Every list is capped by the chunk-2 constants.

### Chunk 4 — Server reader + controller
- [ ] Create `server/src/logs/otel/otel-live.reader.ts`, an `@Injectable() OtelLiveReader` (deps: db, `RepositoriesService`), with `resolveScopeTeams(user): OtelLiveScopeTeam[]`: `loadOtelLiveTeams`, then `resolveTeamScope` per team, mapped per DD-4 / DD-20.
- [ ] `OtelLiveReader.getStatus(user): OtelLiveStatusResponse` per DD-12:
  1. `resolveScopeTeams`, then candidates (none retained), then placements.
  2. `loadOtelLiveRootTotals` and `loadOtelLiveAgents` for the placed roots.
  3. `buildOtelLiveTree` with no retained keys.
  4. Answer from the home node's `totals` (`liveSessions`, `liveAgents`, `costUsdMicros`).
- [ ] `OtelLiveReader.getLive(user, {node, panel, tz})`:
  1. Parse the keys (`BadRequestException` if malformed).
  2. Take the retained root ids from session and agent keys, and the retained repo labels per DD-5.
  3. Load candidates, then placements (masked per DD-11), then totals and agents.
  4. Run `buildOtelLiveTree` and pick `selected` (DD-3 fallback).
- [ ] In `getLive`, build `view` for `selected` per DD-7 / DD-8 / DD-9, and `details` for `panel` per DD-10 (`summarizeOtelLiveNode` plus the SQL loaders), with the details masking of DD-11. Run independent loaders in `Promise.all`.
- [ ] Create `server/src/logs/otel/otel-live.controller.ts`: `@Controller('api/v1/otel/live')`, `@UseGuards(SessionAuthGuard)`; `@Get('status')` declared before `@Get()`; `tz` validated with the `tzParam` helper (`otel-facts.controller.ts:135`).
- [ ] Register `OtelLiveController` and `OtelLiveReader` in the `controllers:` / `providers:` arrays of `server/src/logs/logs.module.ts` (`~:75` / `~:93`).
- [ ] Run the server lint, typecheck and algorithm tests (fast set); fix findings.

### Chunk 5 — Client models, API, poll hook option
- [ ] Create `client/src/models/otel-live.ts` mirroring every type of the API changes section (the client copy of `otel-live.types.ts`); status fields beyond `live` / `liveSessions` are optional, per DD-19.
- [ ] Add `fetchOtelLiveStatus(signal?)` and `fetchOtelLive({node, panel, tz}, signal)` to `client/src/viewer/api.ts`, in the style of `fetchTeamOtelFacts` (`:880-920`).
- [ ] Add an optional `refreshAbortsInFlight?: boolean` (default false) to `UseOtelLivePollOptions` in `useOtelLivePoll.ts`, with the exact behaviour in DD-14 (`refreshAbortsInFlight` bullet); existing callers are unchanged.
- [ ] Create `client/src/viewer/live/live-node-key.ts`: `liveNodeType(key)` and `HOME_LIVE_KEY = 'home'`, per DD-3; and `client/src/viewer/live/live.constants.ts` per DD-21.

### Chunk 6 — Client header entry + URL state + modal shell
- [ ] Create `client/src/viewer/live/useLiveUrlState.ts`: returns `{ liveKey: string | null, open(), select(key), close() }` per DD-15 (push on open, replace otherwise, params copied first).
- [ ] Create `client/src/viewer/components/top-nav/LiveNavItem.tsx`: status `useQuery` per DD-14, the button with dot and tooltip per Visual/UX notes, `open()` on click, and a lazy `LiveModal` per DD-17, rendered while `liveKey !== null`.
- [ ] Render `<LiveNavItem />` in `client/src/viewer/pages/main/MainNav.tsx` between the Home and All-views buttons. If the dot uses a custom keyframe instead of `animate-ping`, add its `prefers-reduced-motion` guard to `client/src/viewer/app.css` (pattern at `:259-290`).
- [ ] Export `LiveModal` from `client/src/viewer/pages/repository/repository-tabs-lazy-group.ts` (DD-17).
- [ ] Create `client/src/viewer/live/LiveModal.tsx`: a `Dialog` sized per Visual/UX notes; ✕ / Esc → `close()`; three-pane layout; holds `panelKey` state; polls via `useOtelLivePoll` per DD-14 using `fetchOtelLive`.
- [ ] In `LiveModal`, the header bar ("Updated N s ago" from `lastUpdatedAt`, counts from the home node), Pause / Resume with the "Paused at" badge, and the FR-13 error banner shown when `error` is set and `state` exists.
- [ ] In `LiveModal`, when `state.selected !== liveKey`, call `select(state.selected)` (replace) so the URL shows the canonical key.

### Chunk 7 — Client tree, view pane, tiles, carousel
- [ ] Create `client/src/viewer/live/LiveTree.tsx`: render `state.nodes` (`inTree`) nested by `parentKey`, all expanded; the row layout and ended / restricted styling per Visual/UX notes; a click calls `select(key)`, ⓘ sets `panelKey`.
- [ ] Create `client/src/viewer/live/live-chart-data.ts`: `buildLiveChartPages(view): LiveChartPage[]` per DD-13 (map to `OtelBucket`, skip all-zero pages, latency page only when `hasSpans`).
- [ ] Create `client/src/viewer/live/LiveChartCarousel.tsx`: ‹ › arrows, "n / N", page title, `OtelCostChart` for pages 1–5 (`interval '5m'`), a skill / MCP `OtelSegmented` toggle, and a Recharts line chart with an LLM | tools toggle for latency.
- [ ] Create `client/src/viewer/live/LiveKpiTiles.tsx` with `OtelKpiTile` / `OtelTokensTile`. The tokens tile gets `{ input, output, cacheRead, cacheWrite }` as `Number(...)` of the `OtelLiveTotals` strings (`OtelTokenTotals`, `OtelKpiTile.tsx:129`). Tiles: Cost, Tokens in/out, Live sessions / agents, Cost/min. Session nodes show Agents live; agent nodes show Cost, Calls, Model, Running.
- [ ] Create `client/src/viewer/live/LiveViewPane.tsx`: a breadcrumb from the `parentKey` chain, tiles, carousel, then the breakdown slot; the empty state per DD-18 when the only node is home and nothing is live. Create `client/src/viewer/live/live-format.ts` (`formatLiveDuration`, `formatLiveClock`, DD-23) and use it for running time, Last activity and the Paused / error times; label totals "since start" and window figures "last 2 h".
- [ ] Run the client lint and typecheck (fast set); keep each component under the size threshold of the `post-impl-check-client-component-size` check.

### Chunk 8 — Client breakdown + details panel
- [ ] Create `client/src/viewer/live/LiveBreakdownTable.tsx`: rows from `view.breakdown` with the FR-5 columns, or `view.calls` with the agent columns, per Visual/UX notes; ended rows greyed; the footnote when `distinctFootnote`; a "+N more agents" row when `view.moreAgents > 0`; a row click sets `panelKey`.
- [ ] In `LiveBreakdownTable`, add the "Open session ↗" link on session rows: `navigate` to the DD-16 target, built from `teamId` / `repoId` / `sessionUuid`, dropping `live`.
- [ ] Create `client/src/viewer/live/LiveDetailsPanel.tsx`: render `state.details` per DD-10 for each node type, per `wireframes/details-panel-variants.svg`. Masked fields show "prompt hidden" / "masked"; ended sessions show the DD-18 note; ✕ clears `panelKey`.
- [ ] In `LiveDetailsPanel`: the session "Open session ↗" (DD-16), and the repo / team "Open OTEL tab" links (DD-16 `mtab` / tab param `otel`); no link on agent panels.
- [ ] Wire `LiveViewPane` → `LiveBreakdownTable`, and `LiveModal` → `LiveDetailsPanel`, passing `panelKey` to the poll so `details` refreshes.

### Chunk 9 — KB + user docs
- [ ] `docs/knowledgebase/otel-tabs.md`: add a "Live view" section covering the routes table rows, node keys (DD-3), placement (DD-4), retention (DD-5), totals (DD-6), the stored totals tables and their writer rules (DD-22), long-session behaviour (DD-23), the live route as the third liveness consumer, and the scope cuts.
- [ ] `docs/knowledgebase/server-endpoint-map.md`: add both routes and `OtelLiveController` to the controller index (`~:210`); note that the live route row-filters and never 403s.
- [ ] `docs/knowledgebase/client-component-map.md`: add `viewer/live/` and `components/top-nav/LiveNavItem.tsx`; `client-routing-and-layout.md`: add the `?live=` param and `LiveModal` in the repository-tabs barrel.
- [ ] `user-docs/otel-tab.md`: add a "Live view" section (opening, tree, Pause, ended, access, what is not shown); then run `npm run build:help`.

### Chunk 10 — Algorithm + contract tests
- [ ] Write `docs/knowledgebase/algorithms/otel-live-tree.md` (inputs, outputs, rules from DD-3 / DD-4 / DD-5 / DD-6 / DD-9, pointing to its rows file); add it to `docs/knowledgebase/index.md` and to the algorithm list in `docs/knowledgebase/algorithms/README.md`.
- [ ] Create `docs/algorithm-examples/otel-live-tree.json` with the rows listed in the Test coverage plan (Algorithm bullet).
- [ ] Create `server/src/logs/otel/otel-live-tree.algo.spec.ts`: a table test over those rows with `loadExamples`, as in `otel-facts.algo.spec.ts:6`; run `npm run test` from `server/`.
- [ ] In `server/test/contract/registry/f25-otel.ts`, add a row for `GET /api/v1/otel/live/status` expecting `{ live:false, liveSessions:0, liveAgents:0, costUsdMicros:'0' }` for a world user.
- [ ] In `f25-otel.ts`, add a row for `GET /api/v1/otel/live?node=home` expecting the home-only tree, empty view arrays, `selected:'home'` and `details:null`; plus a 400 row for `node=bogus`.
- [ ] Run `npm run test:contract` from `server/` in the background (app group, not alongside builds or e2e).

### Chunk 11 — Scenario S-OTEL-02
- [ ] Create `tests/scenarios/view/s-otel-02.spec.ts` (`@S-OTEL-02 @mode-a`) with the restricted team (owner, manager, member) and transparent-team setup of `s-otel-01.spec.ts:1065`, plus a personal no-team repo; sessions uploaded through `uploadOtelChunk` so they are live (chunk time = now).
- [ ] Step "header + open" (AC-1, AC-2, AC-4). Load the page after the uploads (the first status fetch happens on load), then check that:
  - the header dot is visible within 30 s;
  - a click opens a dialog of about 90 % viewport width and height, with `live=home` in the URL and Home selected;
  - `?live=repo:<id>` survives a reload on that repo;
  - Back removes `live` and closes the modal.
- [ ] Step "tree placement" (AC-3, AC-3a, AC-3b). Check that:
  - a session in a repo linked to both teams sits under both teams;
  - the home cost equals that session's cost counted once;
  - a personal-repo session sits under No team;
  - only live nodes are listed.
- [ ] Step "node view" (AC-5, AC-6). Check that:
  - the tiles, the FR-5 breakdown columns and the cost and tokens carousel pages render for a selected repo;
  - after a `sendRealtime` update, a session's Live cost equals the cost on its session OTEL tab (stored totals, DD-22);
  - a session that has only OTEL data plus the `artisyn` log (no transcript upload) is listed.
- [ ] Step "live updates + ended + pause" (AC-7, AC-8): `sendRealtime` changes a value within 5 s; Pause freezes it (request counting as in `s-otel-01.spec.ts:850`) while the dot updates; Resume shows the latest. Age the selected session with `UPDATE otel_session_state SET rt_last_at = rt_last_at - interval '30 minutes', chunk_last_at = chunk_last_at - interval '30 minutes'` (as `s-otel-01.spec.ts:1043`); it shows "ended".
- [ ] Step "details + open session" (AC-9, AC-10): a row click opens the panel; "Open session ↗" closes the modal and lands on `?session=`.
- [ ] Step "access + masking" (AC-11, AC-11a): the plain member sees only own sessions under the 🔒 team with matching totals; the manager sees others' prompts masked.
- [ ] Step "refresh failure" (AC-13): route-abort `/api/v1/otel/live` via Playwright, assert the banner and the kept data; then run `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-OTEL-02"`.
