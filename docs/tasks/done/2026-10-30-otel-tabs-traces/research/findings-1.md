# Research findings 1 — 2026-10-30-otel-tabs-traces

I read everything needed for the plan and changed no files. Five findings change the plan; they are first in **Open gaps**:
- The `since=` cursor needs a commit-safe design.
- Bucketing by repository is blocked when OTEL arrives before the repository is known.
- The provisional rule for hidden calls conflicts with the current rule.
- No existing mechanism fits the hook's ~5 s shipping.
- An existing scenario uses `/v1/traces` as its "unknown path" test case.

## Requirements summary
GH-66 adds two "OTEL" tabs, one on the repository view and one on the session view, using only Claude Code's own per-call `cost_usd`:
- **Charts:** a stacked cost-over-time chart (stack by structure, `query_source`, model or Claude Code version; interval auto / 5m / 1h / 1d; absolute or 100 %; cumulative line), KPIs and a cost-structure / hidden-calls section with `query_source` and sessions tables. Each call is placed by its own `event.timestamp`.
- **Session waterfall:** a Jaeger-style view with one trace per `claude_code.interaction`, minimap, collapsible tree, per-span cost joined by `request_id`, rolled-up subtree cost and orphan spans under a provisional "turn in progress" row. It updates live by polling `since=` every 5 s and highlights only what is new.
- **Hook:** three new trace env keys, asked for at install/upgrade with default yes; the receiver accepts `/v1/traces`; OTEL chunks ship every ~5 s.
- **Server:** an `otel_spans` table, new `otel_api_calls` columns (`event_time`, `claude_code_version`, `prompt_id`, `agent_id`) with a backfill, a pre-aggregated 5-minute bucket table, incremental ingest, and repository-facts / session-facts / session-traces routes with a delta shape. Hidden calls are classified provisionally by `query_source` and reclassified when the transcript arrives. A server-side `query_source` dictionary marks unknown sources as "new".
- **Backward compatibility (hard requirement):** all four old/new hook × old/new server combinations must work. Spans travel as `signal:"spans"` lines inside the existing `claude-otel` upload.

## Wireframes
- `wireframes/repo-otel-tab.svg` (1440×1500):
  - Tab order is Sessions | Analytics | Reports | Tools/MCP | OKF | **OTEL** | Settings.
  - Filter row: Period 1d/2d/3d/1w/2w/1m/Custom, Model, Claude Code version, Calls (All / Hidden only / In transcript), and a "Live · updated 4 s ago" label.
  - Chart controls: Metric, Stack by, Interval, View, Cumulative on/off. The tooltip lists the parts, the total and the cumulative value. Clicking a legend item hides it.
  - Six KPI tiles: Total, Per day (+ active days), Per session (+ median), API calls (+ model count), Hidden (+ share and calls), Sessions (+ users).
  - Below: share bars ("other (N)" bucket), hidden-call bars, the `query_source` table (unknown `side_question` shows `hidden` + `new` and "— (not in dictionary)"), and a sessions table with columns started / first prompt / user / CC version / calls / cost / hidden / traces (yes/no) / live / "open ›".
- `wireframes/session-otel-tab.svg`:
  - OTEL is the **rightmost** session tab, after "System Context Anatomy". This conflicts with the `tab-ids.ts` comment that sysctx is "always shown, rightmost".
  - Header: "Cost: Claude Code estimate (cost_usd) · hook 2.29.0 · traces on". This implies the next hook version is 2.29.0.
  - Chart has no 1 d interval. KPI tiles: OTEL cost (= session telemetry total), Hidden, API calls, Turns (running), Sub-agents (cost and share), Waiting for you.
  - Trace navigator "‹ Turn 7 of 7 ›", Expand all / Collapse all, and a header with Start / Duration / Cost / hidden / LLM calls / Depth / Spans / Waiting / Output tokens.
  - Waterfall rows carry Σ rollups, `blocked_on_user` rows, `agent a432dc` labels, hidden `prompt_suggestion` rows in red, and a span-details panel (request_id, query_source, agent_id, model + ttft, tokens, cache, cost source, context, "show all raw (14)").
- `wireframes/session-otel-live-update.svg`:
  - Changed KPIs get an amber outline and a delta chip.
  - Only the newest chart bucket grows, with the added segment outlined.
  - Ancestor Σ values flash.
  - New rows get an amber background, a left bar and a NEW tag; rows are keyed by span_id.
  - New rows below the visible area are announced by a "↓ 1 new span below" pill.
  - The highlight fades by about 2 s.
  - Indicator states: Live / Paused · tab hidden / Paused · idle 10 min — resume / Session ended / Slow updates · hook X.
- `wireframes/otel-empty-states.svg`:
  - (A) No OTEL: neutral empty state with "How to enable OTEL" and "Upgrade the hook" buttons opening offline help; the repo `hook_version` appears only as a hint.
  - (B) Logs but no traces: full charts and KPIs, a "Slow updates" banner, and "No traces for this session" in place of the waterfall.
  - (C) Repository with no OTEL in the period: suggests "Show 1 month".

PoC files:
- `docs/pocs/2026-10-30-1407-otel-traces-session-view/template.html` is the prototype UI (525 lines).
- `facts.sql` is a bucket query. Its hidden rule is **not** tree-scoped, so do not copy it.
- `otlp.js` holds the span flattening and the cost join.
- Real span attribute keys (from `node spans.js --keys`):
  - `session.id` is on **every span's attributes**, so the receiver's per-record demux works unchanged.
  - `llm_request` carries `query_source_safe` (not `query_source`), `request_id`, `agent_id`, `llm_request.context`, tokens and `ttft_ms`.
  - The resource carries `service.version`.
  - User identity attributes (`user.email` and others) are present on spans.

## Knowledgebase
- `docs/knowledgebase/otel-receiver.md`:
  - Chunk layout is `<otelDir>/<session>/<epochMs>-<seq>.jsonl`, one line per record, `{signal, receivedAt, resource, scope, record}`.
  - `receivedAt` is never substituted for record timestamps.
  - Uploaded chunks are deleted on upload, with a guard that keeps chunks whose upload failed.
  - The sweep is `SWEEP_INTERVAL_MS` = `SWEEP_QUIET_MS` = 60 s and spawns `send-logs-hook.js --otel-sweep`.
  - The receiver uses Node built-ins only and must not `require` other hook modules.
  - Origin/415/413 defences; stale-receiver restart on register.
- `docs/knowledgebase/hook-api-versioning.md`:
  - Hook-version compatibility matrix (add a ≥2.29.0 row).
  - New hook → old server: unknown params and line types are ignored.
  - Per-route body limits (`HOOK_API_ROUTES`) apply to any new hook POST route.
  - Hook ↔ receiver: a `404` is silent, unknown fields are ignored.
- `docs/knowledgebase/upload-queue.md`: `claude-otel` already goes through the queue. The claim runs every `UPLOAD_QUEUE_INTERVAL_MS` (1 s) with `SKIP LOCKED`, and a burst of small chunks drains in one tick.
- `docs/knowledgebase/llm-call-math.md` § "Utility calls": `utilityCostsCte` classifies by `request_id`, tree-scoped over `descendant_sessions`. It falls back to `query_source` only when the **whole tree** has no `session_request_ids`.
- `docs/knowledgebase/db-tables.md`: `logs_otel`, `otel_api_calls` (unique `(session_id, call_key)`, index `(session_id, request_id)`) and `session_request_ids`. Migration `0071` shows a backfill from `logs_otel.body` with `jsonb_array_elements … WITH ORDINALITY`.
- `docs/knowledgebase/db-schema-code.md`:
  - Hand-write `NNNN_*.sql`, add the `_journal.json` entry, run `npm run migrations:lock`.
  - Never run `drizzle-kit generate`; never use `CONCURRENTLY`.
  - The next migration is **0078** (last is `0077_tool_usage_indexes`).
- `docs/knowledgebase/okf-usage.md` and `docs/knowledgebase/tool-monitoring.md`: the most recent session+repo tab pair to copy for the route/scope pattern, URL params dropped by `setMainTab`, the update-hook banner and a backward-compatibility table.
- `docs/knowledgebase/session-metrics-scope.md`: additive metrics sum over the session tree. OTEL rows already sit on the root session.
- `docs/knowledgebase/hook-installation.md`: per-key ownership of the env block in `.claude/settings.local.json`, today **nine** keys (they become twelve).
- `docs/knowledgebase/ui-principles.md`: light-only colours, zone/scope colour rules, tooltips kept inside the viewport, stat-tile hint uniformity.
- `docs/knowledgebase/test/scenarios.md`:
  - Every new tab needs a `tests/scenarios/tours/screen-registry.ts` row; the `tour-10-registry` meta-test fails otherwise.
  - Each row's `docRef` must point to an existing help heading.
- `docs/knowledgebase/test/contract-tests.md`: registry rows, world-v1 fixture, router meta-test.
- `docs/knowledgebase/algorithms/README.md`:
  - Algorithm docs are a doc plus an examples block plus a table test.
  - `algorithms/otel-cost-selection.md` already exists, with `server/src/logs/otel-cost.sql.algo.spec.ts`.
  - Candidates for new docs: structure/hidden classification, interval auto-pick and timezone bucketing, span tree assembly with standalone attachment and rollup.
- `docs/knowledgebase/data-retention.md` and `docs/knowledgebase/session-export-import.md`: export is synthesised from `logs.body` and carries no OTEL today.

## Existing patterns
**Server ingest**
- `server/src/logs/otel-chunk.ts:142`, `summarizeOtelChunk`:
  - It has `if (entry?.signal !== 'logs') continue;`, so old servers ignore `signal:"spans"` lines (FR-20 holds).
  - `attributesOf`, `stringAttrOf` (255 cap) and `costMicrosOf` are reusable.
  - `call_key = request_id ?? chunkKey:lineIdx(1-based)`.
- `server/src/logs/logs.service.ts`:
  - `:367` is the `claude-otel` branch.
  - `:1177` `ingestOtelChunk` takes `FOR UPDATE` on the session row, upserts `logs_otel`, calls `upsertOtelApiCalls` (`:1273`, batch of 500), then **re-SUMs all chunks** (`:1224`). FR-15 replaces that re-SUM with an incremental add.
  - `chunk_key` is a content hash (`computeChunkKey`), so an identical re-upload is an update. An incremental add must subtract the old value on conflict.
- `server/src/logs/session-stats-writer.ts:196`: `upsertSessionTelemetryCost`.
- `replaceSessionRequestIds` call sites are the triggers for FR-6a reclassification: `logs.service.ts:432`, `:1084` and `repositories.service.ts:1438`. A sub-agent upload has to reclassify its **root's** aggregates.

**Server classification and storage**
- `server/src/logs/otel-cost.sql.ts`:
  - `:162` `TRANSCRIPT_QUERY_SOURCES` and `TRANSCRIPT_QUERY_SOURCE_PREFIX`.
  - `:226` `utilityCostsCte`, the hidden rule that AC-3 must match.
- `server/src/database/schema/index.ts`: `logsOtel` at `:341`, `otelApiCalls` at `:386`, `sessionRequestIds` at `:441`, `repositories.hookVersion` at `:258`.
- `server/src/sessions/sessions.service.ts:175`, `purgeSessionChildData`: new tables must be purged here, because a soft delete keeps the `sessions` row. Note that `logs_otel` and `otel_api_calls` are not purged here today.

**Server routes and scope**
- `server/src/logs/tool-monitoring/tool-monitoring.controller.ts:178-210`: `@Controller('api/v1/repositories')` + `SessionAuthGuard`; `resolveReadScope` = `assertRepoAccess` + `resolveTeamScope` + `resolveRepoIds`. This is the template for the new routes, registered in `logs.module.ts:78`.
- `server/src/logs/tool-monitoring/tool-usage-read.sql.ts:1-60`: a root session is in scope via its `artisyn` log → `log_repositories`, plus `scopedUserFilterSql` and `descendantSessionsCte` / `topAncestorIdsSql`.
- `server/src/logs/repositories.controller.ts:1513`: session-tab route where a session outside the scope gets an empty response, not 404.

**Server queue and contracts**
- `server/src/logs/upload-queue-scheduler.service.ts:105`: `UPLOAD_QUEUE_INTERVAL_MS`, default 1000 ms.
- `server/test/contract/registry/f24-tool-monitoring.ts`: registry-row format. The new routes need rows; F15 covers ingest.

**Hook and installer**
- `hook/.claude/telemetry_tool/otel-receiver.js`:
  - `:101-105` path constants and `KNOWN_PATHS` (add `/v1/traces`).
  - `:328` `walkLogs` is the shape for a `walkSpans` (`resourceSpans/scopeSpans/spans`).
  - `:870` `handleOtlp`.
  - `:688-732` sweep spawn and timer; `runtime.lastRequestAt`.
- `hook/.claude/telemetry_tool/send-logs-hook.js`:
  - `:429` `listOtelChunks`.
  - `:606` `uploadOtelChunkNoManifest`, which goes chunked above `CHUNK_SIZE_BYTES`.
  - `:663` `runOtelSweep`, using the upload lock with `LOCK_WAIT_STOP_MS` = 2000.
- `hook/.claude/telemetry_tool/env-context.js`:
  - `:381-382` logs/metrics endpoint regexes (add traces).
  - `:441` `resolveOtelPort`.
  - `:84` `CONFIG_DEFAULTS` (`otelEnabled`), the place for any new config key.
- `hook/.claude/telemetry_tool/otel-endpoint-check.js:36-42, :127`: `ENDPOINT_KEYS` and the missing/mismatch warning. The traces key must be optional, since "no" is a valid answer.
- `artisyn-hooks-installer/src/otel-env.ts:22,38`: `OTEL_ENV_KEYS(port)` and `OTEL_ENDPOINT_KEYS`. They are also imported at runtime by `docker-dev/provision.mjs:98`.
- `artisyn-hooks-installer/src/install.ts`:
  - `:1559` `OTEL_LOOPBACK_ENDPOINT_RE` only matches `/v1/(logs|metrics)`; it must add traces or ownership checks fail.
  - `:1592` `isArtisynOwnedOtelValue`; `:2043` `mergeOtelEnv` (rules a–d); `:2132` `stripOwnedOtelEnvKeys`.
  - `:1136` `prompt()` and the TTY-only `[Y/n]` pattern at `:841` / `:885`.
- `artisyn-hooks-installer/src/index.ts`: manual argv flags, and `upgrade` rejects flags.
- `hook/.claude/telemetry_tool/version.json`: currently 2.28.0.

**Client**
- `client/src/viewer/tab-ids.ts`: `SESSION_TABS` / `REPO_MAIN_TABS` need an `'otel'` id.
- `client/src/viewer/pages/repository/SessionTabBar.tsx:44-100`: tab entries.
- `client/src/viewer/pages/repository/useRepositoryViewState.ts:126-150`: `setMainTab`, which drops `okf*` / tools params.
- `client/src/viewer/pages/repository/RepositoryView.tsx:43,62,433,472`: lazy tab plus `canSeeTeamWideTabs`.
- `client/src/viewer/pages/repository/SessionDetailPane.tsx:418`: tab switch.
- `client/src/viewer/pages/repository/session-log/okf/SessionOkfTab.tsx:58`: update-hook banner that navigates to `routes.apiKeys`.
- Polling: `client/src/viewer/pages/repository/useNewSessionPoll.ts:74` (react-query `refetchInterval` + `SESSION_POLL_INTERVAL_MS`, `client/src/viewer/lib/settings.ts`) and `client/src/viewer/pages/repository/tools/RepoToolsTab.tsx:172` (function `refetchInterval`).
- Charts: Recharts 3.8 and d3 7.9 are already dependencies (`client/src/viewer/pages/repository/reports/CostByGroupChart.tsx`, `client/src/viewer/pages/repository/analytics/CostBarChart.tsx`, `client/src/viewer/components/ChartResponsiveContainer.tsx`).
- `client/src/viewer/components/CostReconciliation.tsx:189`: the current single "Utility calls" figure.

**Tests**
- `tests/scenarios/hook/s-hook-07.spec.ts:277`: **asserts `POST /v1/traces` → 404** as the "unknown path". Must change.
- `tests/scenarios/hook/s-hook-01.spec.ts:189`: new hook → old server is tested with a fake hub that answers `{warnings: []}`. Reuse for AC-13 old-server half.
- `tests/scenarios/hook/s-compat-01.spec.ts`: frozen hooks in `tests/fixtures/legacy-hooks/{1.6.2,2.6.1}`, made by `scripts/scenarios/freeze-legacy-hook.mjs`. 2.28.0 is the "previous released hook" for AC-10 and is not frozen yet.
- `tests/scenarios/installer/s-inst-01.spec.ts:209,252` and `tests/scenarios/installer/s-inst-04.spec.ts:125,184`: assert "nine OTEL env keys"; extend for AC-15.
- `tests/scenarios/view/s-cost-01.spec.ts:286-306`: inserts `otel_api_calls` rows directly; pattern for AC-3/AC-4.

## Open gaps
1. **`since=` cursor safety.** A plain Postgres sequence is not commit-ordered, so a transaction holding a lower value can commit after a reader has passed it, and that row is never delivered. No existing pattern covers this. The plan must choose a safe watermark (e.g. `pg_snapshot_xmin`, a lag window, or a per-session counter bumped under the session `FOR UPDATE` lock that ingest already takes).
2. **Repository unknown at OTEL ingest.** Sessions reach a repository only via the root's `artisyn` log → `log_repositories`, and OTEL chunks can arrive before it. Denormalising `repo_id` into the bucket table needs a backfill or update when the artisyn log links the session (or the repository read joins through sessions). The team filter also needs a user column.
3. **FR-6a conflicts with `utilityCostsCte`.** The current fallback is tree-level (only when the whole tree has no request ids). "Provisional per call until its transcript arrives" has no definition yet: how does the server know a transcript covers a given call? AC-18 depends on this.
4. **5 s shipping has no fitting mechanism.**
   - The receiver must not `require` hook modules and has no `serverUrl`/`apiKey`.
   - Spawning `--otel-sweep` every 5 s means one Node process every 5 s, competing for the upload lock with `LOCK_WAIT_STOP_MS`.
   - Backoff state, the trigger condition (traffic flowing) and the interaction with `Stop` all need design.
   - An older receiver still running returns 404 on `/v1/traces` until the stale-receiver restart.
5. **Saving the trace opt-in answer.** No config key stores a "no", so upgrade would ask again every time. Non-TTY runs need a default; `upgrade` accepts no flags, so non-interactive "no" has no flag.
6. **No stacked Recharts chart exists** (`stackId` is not used anywhere), and nothing does dual-axis/cumulative charts or in-place highlight animation. These are new UI work.
7. **No `tz` parameter pattern on the server.** Validation of IANA names must be decided. Current offsets are whole multiples of 15 min, so 5-minute UTC buckets always roll up cleanly into local 1 h / 1 d buckets.
8. **Test fixtures.** No golden session carries OTEL logs or spans, and the PoC `out/` holds real data and is gitignored, so a synthetic OTEL+traces fixture is needed. No frozen "previous released server" exists for AC-13; only the fake-hub pattern does.
9. **Backfill cost.** Backfilling `event_time` / `prompt_id` / `agent_id` / `claude_code_version` and extracting spans from historic `logs_otel.body` could be done in-migration (like `0071`) or by a background drain (like `tool_usage_version` in `0076`). The plan must pick one given the data size.
10. **Lifecycle.** Export/import, retention purge (`purgeSessionChildData`) and account deletion have no OTEL tables. Decide whether `otel_spans` and the bucket table get purged or exported.
11. **Privacy.** Spans carry `user.email`, `user.account_uuid` and `organization.id`. The plan should state whether raw attributes are stored as-is (per `product-purpose-and-data-capture.md`) and whether they are masked in team views.
12. **`query_source` dictionary storage** (table vs code constant) and the placement of the session tab (rightmost vs the sysctx "rightmost" rule) are undecided.
13. **Docs to update:** `INSTALL_HOOK.md` via the `update-install-instructions` skill, `hook-installation.md` (nine → twelve keys), `otel-receiver.md`, `hook-api-versioning.md` (a ≥2.29.0 row), `db-tables.md`, and the user-docs help pages that the new tour `docRef` will point to.
