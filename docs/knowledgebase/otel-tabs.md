---
type: "Architecture Guide"
title: "OTEL Tabs (realtime + projected OTEL facts)"
description: "How the repository, session and team OTEL tabs get their data: the two channels (hook realtime batches and the durable claude-otel chunk upload drained by a projection), the five OTEL fact tables, the per-root seq cursor and lock order, call structure (main / subagent / hidden) and queued reclassification, realtime / gap / fill states, the per-session OTEL status (otel-status event, reason panel, partial banner), repository and team coverage with reason chips, the utility-call cost marker, the routes, the attribution stack-bys (skill / MCP server / effort / speed, \"not reported\"), the account latest-wins rule, plan mix and session plan, projection version 2, retention, the hook-by-server and Claude Code compatibility matrix and the measured per-request cost."
tags:
  - otel
  - hooks
  - session-view
  - reports
  - teams
timestamp: "2026-11-04T00:00:00+04:00"
---

# OTEL Tabs

Task `2026-10-30-otel-tabs-traces` (GH-66). Claude Code's OpenTelemetry export (logs, and with
hook `2.29.0`+ traces) is shown on three tabs: **repository → OTEL**, **session → OTEL** (rightmost)
and **team → OTEL**. All amounts are Claude Code's own per-call estimate (`cost_usd`), never the
Log Hub price (`llm-call-math.md`). User help: `user-docs/otel-tab.md` (in-app, offline).

## Two channels, one read model

| Channel | Path | Character |
|---|---|---|
| **Realtime** | the hook's OTEL receiver POSTs at most one batch per session every `max(otelRealtimeIntervalMs, minIntervalMs)` (≥ 5 s) to `POST /api/v2/otel-realtime`; written synchronously | best-effort, memory-only on the hook side ([otel-receiver.md](otel-receiver.md) § "Realtime sender") |
| **Durable** | the unchanged `claude-otel` chunk upload (`logs_otel`, `ingestOtelChunk`, `telemetry_cost`); a background **projection drain** copies every chunk into the same tables | idempotent upserts; fills any realtime gap, and backfills all history after deploy |

Both channels end in the same writer, `applyOtelLines(tx, rootId, userId, lines, source)` in
`server/src/logs/otel/otel-facts-writer.ts`. Realtime and chunk lines are the same objects the
receiver writes, so both produce the same keys (`otelCallKey`: `request_id`, else `rec:` + sha1 of
`{timeUnixNano, attributes}`), and the projection merges instead of duplicating.

Not touched by this feature: `ingestOtelChunk`'s logic and its `telemetry_cost` SUM,
`otel_api_calls`, `utilityCostsCte` and the upload queue. The existing paths only gained additive
hooks: an `otel_reclass_queue` insert after each `replaceSessionRequestIds`, the projection-marker
reset in the `logs_otel` upsert, an `otel_session_state.user_id` fallback in `findSessionOwnerId`,
OTEL-only roots in account deletion and retention, the new tables in `purgeSessionChildData`, a
startup re-mark in `database-init.ts`, and one `HOOK_API_ROUTES` entry.

### Server files (`server/src/logs/otel/`)

| File | Role |
|---|---|
| `otel-facts.constants.ts` | every constant below (`OTEL_*`) |
| `otel-records.ts` | pure: `resolveOtelEventTime`, `otelCallKey`, `extractOtelCalls`, `extractOtelAccount`, `sanitizeOtelBaseUrl`, `extractOtelSpans` (caps, 64 KiB attribute limit), `maxHookVersion` |
| `otel-classify.ts` | pure: `classifyOtelCall`, `bucketStart5m`, `pickOtelInterval` |
| `otel-query-source-dictionary.ts` | `query_source` names, descriptions and `hidden`; `lookupQuerySource` (unknown → `known: false`, a "new" chip in the UI) |
| `otel-span-names.ts` | `claude_code.interaction` / `.llm_request` / `.tool` / `.tool.blocked_on_user` / `.tool.execution` |
| `otel-facts-writer.ts` | `lockOtelState`, `upsertOtelCalls`, `upsertOtelSpans`, `recomputeSpanRollups`, `applyOtelLines`, `rebuildOtelBuckets`, `reclassifyOtelSession`, `enqueueOtelReclass` |
| `otel-realtime.controller.ts` / `.service.ts` | hook route (API key) |
| `otel-projection.service.ts` | the drain (tick every 5 s) |
| `otel-facts-read.sql.ts`, `otel-facts.reader.ts` | UI read SQL and assembly |
| `otel-facts.controller.ts`, `otel-team-facts.controller.ts` | UI routes (session cookie) |
| `otel-facts.types.ts` | every request / response type (client mirror in `client/src/models/repositories.ts`, `teams.ts`) |

Client: `client/src/viewer/pages/repository/otel/` (repository tab and shared parts),
`.../session-log/otel/` (session tab, trace waterfall), `client/src/viewer/pages/teams/otel/` (team
tab) — see [client-component-map.md](client-component-map.md).

## Tables (migration `0078`)

`otel_calls`, `otel_spans`, `otel_cost_buckets` (5-minute UTC rollups, no repository column),
`otel_session_state` (per-root state and lock row), `otel_reclass_queue`, plus
`logs_otel.otel_projection_version`. Columns: [db-tables.md](db-tables.md) § "OTEL tab tables".
**Root session is the key** (DD-1): the OTEL `session.id` is always the root, so sub-agent calls
and spans attach to the root and are told apart by `agent_id`.

## Cursor, lock order and isolation (DD-2)

- `otel_session_state.seq` is a per-root counter. Every write does `seq = seq + 1` and stamps that
  value on every row it inserts or changes (`seq` column), with a `change_kind`.
- **Lock order**, the same for every OTEL writer (realtime, projection, reclassification,
  cleanup):
  1. (realtime only) the advisory lock `session-owner:<sessionId>`;
  2. `otel_session_state` `FOR UPDATE` (`lockOtelState(tx, rootId, { create })` creates the row
     with `INSERT … ON CONFLICT DO NOTHING` only for realtime and projection);
  3. a plain read of `sessions.deleted` — `true` rolls the transaction back.

  OTEL writers never lock `sessions` or `logs_otel` rows. The realtime path's only `sessions`
  write is an insert-if-missing after the advisory lock (the same order as the upload path). The
  upload path (advisory lock → `sessions FOR UPDATE` → `logs_otel`) never touches the state row,
  so no cycle exists. `purgeSessionChildData` deletes the state row first, so it waits for a
  running writer and a later writer sees `deleted`.
- Writers of one session are serialised, so commit order = seq order.
- **Reader rule:** the session route runs one `REPEATABLE READ READ ONLY` transaction: read
  `state.seq` = S first, then rows with `since < seq <= S`, return `cursor = v1.S`. An unknown
  cursor version or a value above S gets a snapshot (`full: true`). `since == S` is the
  empty-delta fast path (one primary-key read).

### Change kinds (DD-3)

| Kind | Meaning |
|---|---|
| `new` | first insert by realtime, or by a chunk while the session has no realtime data |
| `update` | a value changed: cost, end time or rollup |
| `confirm` | a chunk confirmed a realtime row; only `source_mask` changed |
| `fill` | first insert by a chunk while the session already has realtime data (a filled gap) |
| `reclass` | changed only by reclassification (a `fill` call keeps `fill`, so a gap filled in the same tick as the transcript's reclassification still feeds the "Filled" notice) |

The client (`mergeOtelDelta`, algorithm doc `algorithms/otel-delta-merge.md`) highlights unseen
`new` / `update` / `confirm` keys and known keys with `update`; `fill` rows only feed the
"Filled N calls / M spans" notice; `confirm` / `reclass` / `fill` on known keys update silently.
The repository and team tabs re-read a snapshot every 30 s and highlight a bucket only when its
value grew **and** its newest underlying row is `new` / `update`.

## Call structure and reclassification (DD-4, DD-5)

`classifyOtelCall` (pure TS, algorithm doc `algorithms/otel-facts.md`) puts each call into
`main`, `subagent` or `hidden`:

1. `request_id` is in the tree's `session_request_ids` → `subagent` when it is in a sub-agent
   transcript or `query_source` starts with `agent:`, else `main`;
2. else, when the tree has no request ids at all **or** the call is **provisional** (its
   `first_seq` > `otel_session_state.transcript_seq`, or no transcript yet): the
   `utilityCostsCte` fallback — `TRANSCRIPT_QUERY_SOURCES` or an `agent:` prefix is visible (with
   step 1's split), anything else `hidden`;
3. else `hidden`.

Provisional is decided by `first_seq`, so a later `confirm` / `update` never makes a call
provisional again. **At rest** (no provisional call left) the hidden set equals what
`utilityCostsCte` classifies as utility, matched by `request_id` — AC-3 compares their OTEL
`cost_usd` sums, never the Log Hub price.

**Reclassification is queued, not inline.** Transcript ingest only inserts the root into
`otel_reclass_queue` (`enqueueOtelReclass`, `ON CONFLICT DO NOTHING`, no other lock) after each
`replaceSessionRequestIds` (`logs.service.ts` ×2, `repositories.service.ts`). The projection
tick claims one row per transaction (`DELETE … WHERE session_id = (SELECT … FOR UPDATE SKIP
LOCKED) RETURNING`), resolves the root, takes the state lock **without** creating a row (no state
row = no OTEL data → just commit the dequeue), recomputes `structure` / `provisional` in TS,
updates changed rows (`reclass`), rebuilds the buckets, and sets `transcript_seq = seq` and
`has_provisional`. Each tick also enqueues idle roots that are still provisional
(`GREATEST(rt_last_at, chunk_last_at) < now() − OTEL_SESSION_ENDED_MS` and the tree has request
ids), so backfilled history never stays provisional.

## Spans, cost and rollups (DD-10, DD-11)

- `extractOtelSpans` reads `signal === 'spans'` lines; ids over their caps skip the span
  (counted), names etc. are cut to 255, `context` to 32, attributes over
  `OTEL_SPAN_ATTRIBUTES_MAX_BYTES` (64 KiB) become `{ _truncated, _bytes }`. Unknown names or
  attributes never fail ingest.
- An `llm_request` span takes `cost_usd_micros` from `otel_calls` by `request_id`, in either
  arrival order.
- After each batch one recursive CTE recomputes `rollup = own + Σ child rollups` over the
  touched traces; only changed rows get a seq bump. An orphan is rolled up as a root until its
  parent arrives.
- The client assembles turns (`assembleOtelTraces`, algorithm doc
  `algorithms/otel-trace-assembly.md`): orphans under a provisional "turn in progress" row,
  standalone root `llm_request` traces (e.g. `prompt_suggestion`) attached to the containing (or
  last earlier) interaction, the turn header, the waiting → model → tool time split and the
  Start / Cost / Slowest order.

## Buckets and intervals (DD-7, DD-18, DD-19)

- Grain `(session_id, bucket_start, structure, query_source, model, cc_version, skill,
  mcp_server, effort, speed)` (the four attribution columns since migration `0088`, task
  `2026-11-03-otel-cost-attribution`, also the columns of `otel_cost_buckets_pk`), `bucket_start`
  = 5-minute UTC floor. `CallContribution` takes the attribution parts from `otel_calls.skill_name`,
  `mcp_server_name`, `effort`, `speed` with `?? ''`; `bucketKey` joins all 9 grain parts (session
  aside). A call upsert subtracts the old contribution and adds the new one (identical values → no
  seq bump), so a call whose attribution changed moves between keys; a rebuild
  (`rebuildOtelBuckets`) groups by and FULL JOINs on all grain columns, upserts only changed keys
  and zeroes vanished ones (reads ignore zero rows).
- `''` in an attribution column = **not reported** (the attribute was absent: older Claude Code,
  default value, or no `OTEL_LOG_TOOL_DETAILS=1` for skill / MCP names). Rows written before `0088`
  read as `''` through the column default.
- The routes return **server-rolled** buckets: `interval=auto` → repository ≤ 24 h `5m`, ≤ 14 d
  `1h`, else `1d`; session ≤ 24 h `5m`, else `1h`. `tz` is an IANA name (validated with
  `Intl.DateTimeFormat`, 400 otherwise); SQL rolls up with `date_trunc(unit, bucket_start, tz)`.
- A session delta maps 5-minute rows with `seq > since` to their rolled starts and returns the
  full values of only those buckets.

## Scope and access (DD-6, DD-29)

- Repository and session routes: a private `resolveReadScope` (copy of the tools controller's:
  `assertRepoAccess`, `resolveRepoIds`, `resolveTeamScope`), roots via the exported
  `scopedTreeCtes` (`tool-usage-read.sql.ts`), which needs the root's `artisyn` log linked to the
  repository — the hook uploads it on every prompt, so a new session appears seconds after its
  first prompt. Deleted sessions are excluded.
- Optional `teamId` = team context. The repository facts route with `teamId` answers **403** when
  `teamScope.analyticsAllowed` is false (the usage-analytics gate: in a `restricted` team only the
  owner and managers). The session route has no analytics gate. The client hides the tab with
  `canSeeTeamWideTabs` (same rule as OKF).
- Team route: the team's repositories, each through `scopedTreeCtes` with the caller's team
  scope, then `DISTINCT` roots — totals, KPIs, buckets, people and flows count a session once;
  only the `repositories` rows count it per repository. 403 for non-members and when
  `analyticsAllowed` is false.
- Masking (DD-22): for a `team-no-prompts` caller viewing another member's session, span
  `attributes` are dropped (`attributesMasked: true`) and `firstPrompt` is masked
  (`maskFirstPrompt`).

## Realtime states (DD-14, DD-15)

State fields (server clock): `rt_last_at` (last realtime batch), `chunk_last_at`
(`logs_otel.created_at` of the newest projected chunk — upload time, so backfill is never "live"),
`rt_receiver_id` / `rt_batch_seq`, `rt_gap_at`. `source_mask` bit 1 = realtime, bit 2 = chunk.

| State | Rule | Notice |
|---|---|---|
| unconfirmed | rows without the chunk bit | "Includes N calls received in realtime and not yet confirmed …" |
| `chunkDelayed` | `rt_last_at − chunk_last_at > OTEL_CHUNK_DELAY_MS` (10 min), or no chunk and realtime older than that | "The regular upload is delayed …" |
| `gap` | a batch with `batchSeq > rt_batch_seq + 1` for the same receiver, or `droppedLines > 0` (a lower / equal `batchSeq` is a replay: no gap) | "Some realtime data was missed …" |
| filled | a session delta carrying `fill` rows | "Filled N calls / M spans from the regular upload." (session tab only) |

The projection clears `rt_gap_at` once the session has no pending `logs_otel` rows and
`chunk_last_at >= rt_gap_at` (best-effort: chunks still on the user's disk are invisible). A
receiver restart starts a new `receiverId`, which the gap rule cannot see; the chunks fill it.

**Live rule, two consumers.** `computeOtelLiveness(state, now)` (`otel-facts.reader.ts`, with the
exported `isRecent`) is the one definition of "live": `rt_last_at` or `chunk_last_at` within
`OTEL_SESSION_ENDED_MS` (10 min); `lastActivityAt` = the later of the two; no state row →
`hasOtel: false`, `live: false`. It feeds `buildOtelSessionStatus` (the OTEL tab's `live`) and the
`liveness` field of `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta`, which the
Session Map tab polls ([`session-map.md`](session-map.md)). The delta returns only
`{hasOtel, live, lastActivityAt}`, no OTEL figures.

**Slow updates.** `otel_hook_version` = highest `hookVersion` seen. A session with OTEL data but no
`rt_last_at` is slow: `old-hook` when that version is NULL or below `OTEL_LIVE_HOOK_MIN_VERSION`
(`2.29.0`), else `realtime-off`. A repository / team is slow when the highest
`repositories.hook_version` in scope is below 2.29.0.

## Projection drain (DD-16)

`OtelProjectionService`, every `OTEL_PROJECTION_INTERVAL_MS` (5 s):

1. **Claim** (own committed transaction): stamp up to `OTEL_PROJECTION_BATCH` (50) pending
   `logs_otel` rows with `otel_projection_version = OTEL_PROJECTION_VERSION` (`FOR UPDATE SKIP
   LOCKED`, partial index on `IS NULL`). Stamping before work means a failing chunk, or one of a
   deleted session, never blocks the queue.
2. **Per session** (own transaction): state lock (create) + deleted check, `applyOtelLines(…,
   'chunk')` over the claimed bodies, `chunk_last_at`, the gap-close rule. On failure the claimed
   rows get `-1`; the startup re-mark in `initializeDatabase()` (`< current` → NULL) retries them.
3. **Reclassification queue**, up to `OTEL_RECLASS_BATCH` (50) roots.
4. **Idle-root finalising** (above).
5. **Deleted-session cleanup**: OTEL rows of up to `OTEL_CLEANUP_BATCH` (50) roots with
   `sessions.deleted = true` (sessions soft-deleted while an old server build ran).

One summary log line per tick with work (chunks, sessions, fills, failures, duration). The
`ingestOtelChunk` upsert resets `otel_projection_version` to NULL on a re-upload, and every
`logs_otel` row that existed before `0078` starts NULL — that is the backfill.

**Projection version.** `OTEL_PROJECTION_VERSION` is `2` since task
`2026-11-03-otel-cost-attribution` (v1 had no attribution / account fields). The startup re-mark
(`database-init.ts`, `< current` → NULL) requeues every v1 chunk, and the normal drain re-projects
all history: the new `otel_calls` columns, the attribution bucket grain and the account fields fill
in without an extra startup wait. Bump it again whenever extraction gains fields history should get.

## Account fields (latest wins, task `2026-11-03-otel-cost-attribution`)

`applyOtelLines` calls `extractOtelAccount(lines)` (`otel-records.ts`, algorithm
[otel-facts](algorithms/otel-facts.md)) and writes `otel_session_state.plan`, `seat_type`,
`provider`, `custom_base_url` and `account_event_at`:

- sources: `anthropic.plan`, `anthropic.seat_type`, `anthropic.provider`,
  `anthropic.custom_base_url` on `logs` `claude_code.api_request` records and `traces` spans —
  record / span attributes first, then `entry.resource`; the base URL is sanitised
  (`sanitizeOtelBaseUrl`: scheme + host:port + path only);
- inside a batch each field takes the non-null value with the greatest event time
  (`resolveOtelEventTime`; ties → later line); `eventAt` = greatest event time of any record that
  carried a field;
- in SQL a non-null value overwrites when `stored IS NULL OR $eventAt >= account_event_at`, then
  `account_event_at = GREATEST(account_event_at, $eventAt)`; **null never overwrites**, so a
  re-projected old chunk cannot erase a newer plan;
- any changed stored value counts as a change (bumps `seq`, so a `since=` delta carries the new
  `plan`).

## Realtime ingest (DD-17)

`OtelRealtimeService.ingest`, one transaction: advisory lock + `findSessionOwnerId` (a different
owner → 409; `findSessionOwnerId` now falls back to `otel_session_state.user_id`, so the upload
path also rejects a second user writing into a realtime-only session) → insert the `sessions` row
if missing → resolve the root, state lock (create, with `user_id`) + deleted check (deleted →
`200 { ignored: 'deleted' }`) → gap / replay rule → `applyOtelLines(…, 'realtime')` and `rt_*` →
`{ accepted, cursor, minIntervalMs }`. `minIntervalMs` = env `OTEL_REALTIME_MIN_INTERVAL_MS`
(default 5000; lower values count as 5000) — the server's lever to slow every hook down. Body ≤
`HOOK_API_BODY_LIMIT` (1 MiB), ≤ `OTEL_REALTIME_MAX_LINES` (5000) lines.

## OTEL coverage and status (task `2026-10-30-otel-shared-receiver`)

Not every session has OTEL: Claude Code `2.1.282`+ ignores project-scope telemetry keys, an admin
can pin or disable OTEL through managed settings, a receiver can be down. Since hook `2.30.0` the
hook says **why** per session, and the tabs show it instead of a silent empty chart.

**Per-session status (DD-28).** At `Stop` and `SessionEnd` the hook asks its receiver
`session-status` and appends an `otel-status` line to the artisyn log
([hook-api-versioning.md](hook-api-versioning.md) § "The `otel-status` event"; state, reason and
write rule: algorithm [otel-status-reason](algorithms/otel-status-reason.md)). The artisyn ingest
(`extractOtelStatus` in `artisyn-extractor.ts`, `upsertSessionOtelStatus` in
`session-stats-writer.ts`, called from `logs.service.ts` beside step 5c) stores it in
`session_stats.otel_state`, `otel_reason`, `otel_status` (migration `0079`,
[db-tables.md](db-tables.md#session_stats)). The latest event `timestamp` wins; an unknown
`state` / `reason` becomes `unknown`; `NULL` = never reported, read as `no-status`.

| Reason | Meaning | Chip | Help anchor (`user-docs/otel-tab.md`) |
|---|---|---|---|
| `managed-endpoint` | a managed setting pins the endpoint of at least one enabled signal | red | `admin-managed-otel` |
| `managed-disabled` | managed settings disable telemetry (or that signal's exporter), nothing pinned | red | `admin-managed-otel` |
| `project-only` | Artisyn keys only in project scope on Claude Code `≥ 2.1.282` (or unknown) | amber | `claude-code-21282-change` |
| `not-configured` | no effective Artisyn endpoint | amber | `enable-otel-and-traces` |
| `receiver-down` | receiver unreachable, or `detail:'port-conflict'` | amber | `troubleshooting-otel-tab-is-empty` |
| `unknown` | none of the above (or a receiver without `session-status`) | grey | `troubleshooting-otel-tab-is-empty` |
| `no-status` | no hook ever reported (`NULL`, hooks `< 2.30.0`) | grey | `otel-tab-is-empty` |

Titles and bodies: `OTEL_REASON_MESSAGES` in `client/src/viewer/pages/repository/otel/otel.constants.ts`
(from the task wireframes); server key lists: `OTEL_REASON_KEYS`, `OTEL_STATES`,
`OTEL_REASON_FILTER_KEYS` in `server/src/logs/otel/otel-facts.constants.ts` (client mirror in
`otel.constants.ts`).

**Session tab (reason UI).** `GET …/sessions/:sessionId/otel` returns `status.otelStatus`
(`OtelStatusDto | null`) and `status.costExcludesUtilityCalls`. With state `none` or `NULL` and no
OTEL data, `SessionOtelTab` renders `OtelReasonPanel` in the empty-state area: a status line
(`OTEL status: <state> · reason <key> · hook <v> · Claude Code <v> · forward <f>`, omitted for
`NULL`), title, body, "Still works / Not available" boxes, the help link and the receiver counts
line. With state `partial`, the normal chart gets a slim amber `OtelPartialBanner` naming the
missing signals.

**Repository and team coverage (DD-29).** `GET …/otel/facts` (repository and team) returns
`coverage: {otelSessions, totalSessions, otelUsers, reasons[]}` over the same root-session scope
and filters as the facts (`loadOtelCoverage` in `otel-facts-read.sql.ts`, `toOtelCoverage` in
`otel-facts.reader.ts`): `otelSessions` = roots with OTEL data (`hasOtel`) or state `ok` /
`partial`; `reasons` = the other roots by `COALESCE(otel_reason, 'no-status')`, count descending.
The UI shows:

- `OtelCoverageBanner` under the chart header when N < M: "OTEL for N of M sessions — totals and
  averages below cover these N sessions only…", plus reason chips. On the repository tab a chip
  click sets the sessions list `otelReason=` filter (URL param `otelReason`, kept when leaving the
  OTEL tab) and switches to the Sessions tab, where `RepositorySessionsPanel` shows a removable
  `OTEL: <reason> ×` chip. On the team tab the chips only label (a team has no single sessions
  list to filter).
- A "Sessions with OTEL" tile in `OtelKpiTiles`: `N / M`, `<pct> % coverage · <users> users`.
- N = 0: `OtelEmptyState` variant `reason` (dominant reason's body, "Show 1 month", help).

**Utility-call cost marker (DD-30).** Utility calls (title generation, summaries, …) are priced only
from OTEL. `costExcludesUtilityCalls` (`costExcludesUtilityCallsSql` in `otel-cost.sql.ts`) is true
when the root session has no OTEL call rows and `otel_state IS DISTINCT FROM 'ok'`; it is on the
session OTEL route and on each sessions-list `costBreakdown`. `UtilityCallsMarker` ("excl. utility
calls (no OTEL)" with a tooltip from `cost-hints.ts`) shows next to the cost in
`SessionDetailHeader` and on the Summary cost tile.

## Routes

| Route | Auth | Notes |
|---|---|---|
| `POST /api/v2/otel-realtime` | API key | hook `2.29.0`+; [hook-api-versioning.md](hook-api-versioning.md) |
| `GET /api/v1/repositories/:repoId/otel/facts` | session | `from`/`to` ≤ 93 days, filters, `interval`, `stackBy` (+ `skill\|mcpServer\|effort\|speed`), `tz`, `teamId`; + `coverage`, `planMix` |
| `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel` | session | snapshot or `since=` delta, `stackBy` (+ the same 4); + `status.otelStatus`, `status.costExcludesUtilityCalls`, `plan` |
| `GET /api/v1/teams/:teamId/otel/facts` | session | + `repoId[]`, `userId[]`, `stackBy=person\|repository\|…\|skill\|mcpServer\|effort\|speed`; + `coverage`, `planMix` |
| `GET /api/v1/repositories/:repoId/sessions` | session | (existing list) + `costBreakdown.costExcludesUtilityCalls` and `costBreakdown.subagentCostFromOtel` per item and the `otelReason=<key>` filter (root sessions without OTEL data whose `COALESCE(otel_reason,'no-status')` equals it; unknown or repeated value → `400`) |
| `GET …/sessions/:sessionId/logs`, `…/logs/delta` | session | (existing) + `subagentStats[*].otelCostUsd` |

Shapes: `server/src/logs/otel/otel-facts.types.ts`. Controllers and access rules:
[server-endpoint-map.md](server-endpoint-map.md). No existing route, upload kind or chunk line
type changed incompatibly: the `coverage` / `otelStatus` / `costExcludesUtilityCalls` /
`planMix` / `plan` / `subagentCostFromOtel` / `otelCostUsd` fields and the `otelReason` param and
new `stackBy` values are additive, and `otel-status` is a new artisyn line type.

**Attribution and plan fields (task `2026-11-03-otel-cost-attribution`).**

- `stackBy=skill|mcpServer|effort|speed` maps to `fb.skill`, `fb.mcp_server`, `fb.effort`,
  `fb.speed` (`stackKeySql`, `teamStackKeySql`); `''` is the "not reported" key, shown by the
  client as a grey **not reported** series with an ⓘ hint (`OTEL_NOT_REPORTED_HINT`,
  `otel-chart-data.ts`). Defaults are unchanged; unknown values → 400.
- `planMix: OtelPlanMixRow[]` (`{ plan, sessions, costUsdMicros }`) — `loadPlanMix(db, source)`
  over the same `fb` source and filters as the Total KPI, `LEFT JOIN otel_session_state` grouped by
  `NULLIF(plan,'')`, cost descending, NULL last. Rendered by `OtelPlanMix.tsx` on the Total tile
  only when some row has a non-null plan.
- `plan: OtelSessionPlan | null` (`{ plan, seatType, provider, customBaseUrl }`) — from
  `readOtelStateRow` on every response including the empty-delta fast path; `null` when all four
  are null. `customBaseUrl` is forced to `null` when `attributesMasked` — the only new masked
  value; attribution keys and plan-mix values are aggregates and stay unmasked on every route.
  Client: `SessionOtelAccount.tsx` (Account row + plan note, help anchor `plan-and-notional-cost`)
  and the `plan:` chip on the session OTEL cost tile; `mergeOtelDelta` keeps the previous `plan`
  when a delta (old server) has none.
- Sub-agent OTEL cost (FR-6): see [llm-call-math.md](llm-call-math.md) and
  [otel-cost-selection](algorithms/otel-cost-selection.md) rule for sub-agents.

Client polling (DD-20, `client/src/viewer/pages/repository/otel/otel.constants.ts`): session tab
every `OTEL_SESSION_POLL_MS` (5 s) with `since=` while the page is visible, there was input within
`OTEL_IDLE_STOP_MS` (10 min) and `status.live`; repository and team tabs every `OTEL_REPO_POLL_MS`
(30 s) snapshot while the period end ≥ now. The user's Pause stops every tab; Resume and the
return from a hidden tab send one catch-up request.

## Retention and lifecycle (DD-25)

- All five tables cascade on a hard delete of `sessions`; `purgeSessionChildData` (soft delete,
  hard delete, admin family delete, retention) deletes them explicitly, state row first.
- Retention also purges **OTEL-only roots** (no `logs` rows) by `otel_session_state.created_at`;
  `getRetentionStats` reports them as `otelOnlySessions` (admin Data Retention tab). Account
  deletion also collects the user's OTEL-only roots. Details:
  [data-retention.md](data-retention.md).
- A realtime-only session has no repository link, so repository removal needs no change; it ages
  out by retention or account deletion.
- Export / import carries no OTEL: imported sessions show the "no OTEL" empty state.
- Hook side: only the chunk files (pruned by `otelRetentionDays`); the realtime buffer is memory.
- **Data volume:** `summarizeOtelChunk` counts every line in `record_count`, so span lines raise
  `logs_otel.record_count` and the chunk volume on old and new servers. Accepted.

## Compatibility matrix (DD-27)

| Hook × Server | Code path | Scenario step |
|---|---|---|
| old, no OTEL × new | no state row → `hasOtel=false` → empty state A | `s-otel-01` "no-OTEL session"; `s-compat-01` 1.6.2 session |
| old, OTEL logs × new | chunk upload unchanged → projection drain → charts; no spans; `rt_last_at` NULL → slow `old-hook` banner + no-traces state B | `s-compat-01` frozen 2.28.0 hook session |
| new × old | realtime POST → 404 → disabled for 1 h; chunks as today, span lines and `hookVersion` ignored by `summarizeOtelChunk` | `s-hook-01` fake old hub |
| new × old → upgrade | spans are in `logs_otel.body`; the new column is NULL → the projection extracts them | `s-otel-01` "logs_otel rows with span lines, as stored by an old server" |
| new × new, server unreachable for a while | realtime backoff + queue cap; chunks stay on disk; later upload → projection `fill` → notice | `s-otel-01` "gap then fill" |
| new × new | full path | `s-otel-01` live steps; `s-hook-07` `/v1/traces` + realtime |
| hook `≤ 2.28.0` (per-project receiver) × new | no `otel-status` → `otel_*` NULL → `no-status` chip / generic panel; OTEL data as before while Claude Code `< 2.1.282` honours the project endpoint; side by side with a shared receiver of other repos | `s-compat-01` frozen 2.28.0 next to a shared receiver |
| hook `2.30.0` × server without `0079` | `otel-status` lines stored inert with the artisyn log; tabs as before | `s-hook-01` fake old hub |
| hook `2.30.0` × new | status, reason panel, coverage, cost marker | `s-otel-01`, `s-cost-01`, `s-hook-01` |

**Claude Code version** (the exporter side, independent of the hook):

| Claude Code | Where OTEL keys must be | With hook `≤ 2.29.0` | With hook `2.30.0` |
|---|---|---|---|
| `< 2.1.282` | any scope (project, local, user, managed) | per-project endpoint in `.claude/settings.local.json` works | user-scope keys + local mirror (same shared port), both work |
| `≥ 2.1.282` | user or managed only | project keys ignored → no OTEL (reason not reported: `no-status`) | user-scope keys work; project-only keys → `project-only` reason and a SessionStart `warn` |
| unknown version | treated as `≥ 2.1.282` | — | as `≥ 2.1.282` |
| any, managed endpoint / disabled | managed wins per key | no OTEL to Log Hub for pinned signals | `managed-endpoint` / `managed-disabled`; the installer writes no user keys |

**Claude Code version × cost attribution** (task `2026-11-03-otel-cost-attribution`; server-side
only, any hook that sends OTEL):

| Claude Code | Effect | Scenario step |
|---|---|---|
| `< 2.1.300` | no `cache_creation_5m_tokens` / `_1h_tokens` → `cache_write_5m_tokens` / `cache_write_1h_tokens` NULL (the cache-write total is unchanged) | algorithm row (pre-2.1.300 `calls`) |
| no attribution attributes (old CC, default values, no `OTEL_LOG_TOOL_DETAILS`) | every attribution `stackBy` returns one `''` "not reported" group equal to the total | `s-compat-01` frozen 2.28.0 OTEL |
| `< 2.1.307` | sub-agent transcripts can miss API calls → sub-agent cost = `GREATEST(transcript, OTEL)` (FR-6), `subagentCostFromOtel`, "from OTEL" | `s-cost-01` GS-02 old-CC sub-agent |
| `< 2.1.317` | no `anthropic.plan` / account attributes → `plan: null`, no Account row, no chip, counted as "not reported" in `planMix` | `s-compat-01` frozen 2.28.0 OTEL |

The trace keys are opt-in at install (`--otel-traces`, stored `otelTraces`), see
[hook-installation.md](hook-installation.md).

## Measured per-request cost

`npm run perf` (`server/perf-tests/scenarios.ts`, 500 requests per case, 10 parallel, dev
machine, dev database with little OTEL data) on 2026-10-30:

| Case | Mean | p95 |
|---|---|---|
| `otel:realtime-50` — `POST /api/v2/otel-realtime`, one batch of 50 `api_request` lines (synchronous ingest) | 43.4 ms | 45.6 ms |
| `otel:repo-facts-week` — `GET …/otel/facts`, 1-week repository snapshot | 13.5 ms | 18.9 ms |

For scale, `logs:v2-small` (a small regular upload) measured 13.3 ms mean / 21.7 ms p95 in the
same run — but that route only enqueues (the upload queue writes later), while the realtime route
writes synchronously, hence about 3× the latency. With the default 5 s interval a running session
sends about one realtime POST per 5 s. The session snapshot and empty-delta cases (`otel:session-snapshot`,
`otel:session-empty-delta`) need the perf seed session and did not run in this measurement;
re-run `npm run perf` against a seeded database to fill them in.

## Tests

- Algorithm docs: `algorithms/otel-facts.md` (server), `otel-trace-assembly.md`,
  `otel-delta-merge.md` (client), `otel-realtime-backoff.md`, `otel-shared-routing.md`,
  `otel-status-reason.md` (hook).
- Contract rows: `server/test/contract/registry/f25-otel.ts`.
- Scenario: `tests/scenarios/view/s-otel-01.spec.ts`, plus steps in `s-compat-01`, `s-hook-01`,
  `s-hook-07`, `s-inst-01`, `s-inst-04`, `s-slife-08`.
