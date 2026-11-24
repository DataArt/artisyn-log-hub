---
type: "Research"
title: "Session logs streaming — codebase research for the plan (pass 1)"
description: "Audit archive of the plan-deep research subagent report, 2026-11-23."
---

# Research findings — pass 1 (2026-11-23)

Three things the plan has to settle first:
- **Workflows on the client.** `extractWorkflows` exists only on the server, so the client needs `workflows` sent with the root part or a client port of the extractor.
- **CPU load signal on Windows.** `os.loadavg()` always returns 0 on Windows, and nothing in the server reads container CPU limits yet.
- **Answer for a deleted session.** The hook needs to learn "deleted, don't retry" from the upload response, without changing the status old hooks expect.

## Requirements summary
Opening a large session must not OOM a worker; that ships first (FR-3). Every read of whole session bodies streams row by row with backpressure, a per-worker env-set limit queues large responses, all access checks run before the first byte, and the per-request `JSON.parse` for `extractWorkflows` goes away.

On top of that:
- **FR-1:** store a gzip `bytea` copy of each `artisyn` / `claude` / `claude-subagent` body, written async by the rebuild path. Staleness marker, background backfill, `jsonb` path as fallback.
- **FR-2:** serve the session in parts, one request per part, as stored gzip with `Content-Encoding: gzip`. Root part first; a subagent's part loads lazily, with "Loading session logs N of M" when a view needs all of them. The old `/logs` keeps working.
- **FR-4:** a live session refetches only the parts that changed, reusing the `/logs/delta` version idea.
- **FR-5:** server skips ingest when a body is unchanged. Skip key = raw-body hash, `INGEST_VERSION`, uploader and, for transcripts, the tree's `artisyn` revision. A DB trigger clears the hash when `body` changes without it; `artisyn` is never skipped.
- **FR-6:** rebuilds coalesced per session and slowed as CPU rises. Defaults: slowdown from ~60 %, hard cap at 99 % for 5 min, all env vars. Nothing dropped; idle instance behaves as today.
- **FR-7:** hook gets `.claude-logs.sent.v2` manifest (size, mtime, params hash), keeps `.claude-logs.sent`, adds a content hash to `.claude-logs.pending`. No verify route, no history re-send.
- **FR-7a:** soft-deleted / purged / retention-purged session stays deleted on every ingest path. Answer is success-class "don't retry"; leftover child data never shown.
- **FR-8:** close data-loss gaps: failure after 2xx, same-length chunk splice, out-of-order overwrite, `artisyn` edit records changing, `tool-calls` fingerprint, late `.meta.json`, zip import of subagent stats.

## Wireframes
None referenced. UI parts: progress indicator and "derived data may lag a couple of minutes" notice. Related parse-indicator task (`docs/tasks/todo/2026-06-21-session-parse-indicator`) is todo, no component built. Nearest UI: "Loading updated session…" banner, `SessionDetailPane.tsx:268-273` (`Loader2` on indigo bar).

## Knowledgebase
- `docs/knowledgebase/session-log-view.md` §"The `/logs` payload contract" (l.77-112): hand-spliced JSON string; client types `SessionLogsData` / `SubagentStats` in `client/src/viewer/api.ts`; `agent-` prefix rules; `workflows` from root `claude` body only; `harnessSnapshot` loaded by owner; new field goes into the string plus `SessionLogsData`, optional on client; error states (l.575): 403 / 422 / other.
- `docs/knowledgebase/session-map.md`: Map tab uses `/logs/delta`. §"Watermark suspension" (l.110) describes the `useRepositoryData` watermark refetch FR-4 replaces.
- `docs/knowledgebase/algorithms/session-logs-delta.md`: cursor `{sid,t,ut,n,fp}`, `ut` = `updated_at` µs; `classifyDeltaRows` / `checkGrowth`. Rows `docs/algorithm-examples/session-logs-delta.json` (SLD-01..23); test `server/src/logs/session-logs-delta.algo.spec.ts`.
- `docs/knowledgebase/server-endpoint-map.md`: `/logs` and `/logs/delta` share `resolveSessionLogsAccess`; error body shape; no GET mutates; literal segments before `:param`; hook-route compatibility (l.162-176): additive only, invalid optional params ignored, 413 / `400 Malformed gzip request body` stay.
- `docs/knowledgebase/hook-api-versioning.md`: URL is the version signal; new response fields additive and gated on a param only new hooks send (`unknownSnapshotId`, l.399-423); foreign session: success status + warning once (l.130-154); matrix row (l.64-77) and behaviour-history row (l.844-872) per hook version. Current hook 3.1.0.
- `docs/knowledgebase/upload-queue.md`: background-job pattern (`SKIP LOCKED`, lease, transient retry); chunk assembly; `received_at`; `{warnings}`; §"Hook-side skip of unchanged files".
- `docs/knowledgebase/twins-and-cross-cutting-rules.md` l.101-127: env var → commented line in `release-template/.env.example`; background job copies upload-queue pattern; list/analytics never read `logs.body`; hook change → version bump + `npm run build:hooks-installer`.
- `docs/knowledgebase/server-conventions.md` §Gotchas: never bind JS array as Drizzle param (`textList()`); startup steps in `initializeDatabase()`; perf `-heavy` scenarios incl. `repos:session-logs-heavy`; new read routes into `sessionReadScenarios()` in `server/perf-tests/scenarios.ts`, p95 regression ≤ 20 %.
- `docs/knowledgebase/db-tables.md`: §sessions / soft delete (l.102-110) — what `purgeSessionChildData` removes and what survives (`session_tool_stats`, `session_harness_usage`, `session_changed_paths`, `session_cause_stats`, `session_request_ids`, `logs_otel`, `otel_api_calls`, attribution); §`deleted_session_log` (l.118) unique `session_pk`; §logs (l.154) hook replaces body, zip keeps longer; §derived data delete-then-insert.
- `docs/knowledgebase/data-retention.md` §"Purge mechanics" (l.81-98).
- `docs/knowledgebase/static-asset-serving.md` l.99-121: `Content-Encoding` / `Vary: Accept-Encoding` in `server/src/common/precompressed-static.ts`; set `Vary` even on identity.
- `docs/knowledgebase/hook-system-overview.md` §Upload pipeline (l.186-290): Stop order, manifest rules, `.upload.lock`, `.claude-logs.pending` v2 slice replay.
- `docs/knowledgebase/system-info-and-cluster.md`: `node:cluster` primary + N workers; every worker runs every scheduler.
- `.claude/rules/db-migration.md` + `migrations-data-integrity` / `db-state-update`: no rewriting defaults, no `CONCURRENTLY`, `COMMENT ON` every new column, then `npm run db:state` and `npm run migrations:lock`.
- `.claude/rules/hook.md`: bump `hook/.claude/telemetry_tool/version.json` (3.1.0 → 3.2.0), `npm run build:hooks-installer`, refresh `.artisyn/marketplace/plugins/log-hub-hooks/`, run `update-install-instructions`.

## Existing patterns
**Read path (FR-1..FR-4)**
- `server/src/logs/repositories.controller.ts:1728-2053` `getSessionLogs`: `@Res()`; access 1737-1745; harness snapshot 1749; root `body::text` 1758-1769, 404/422 at 1774-1776; `getDescendantSessionIds` 1798; parallel queries 1803-1848 (subagent rows, `selectSubagentStats`, `rootStats`); `JSON.parse` + `extractWorkflows` + `resolveWorkflowAgentLinkage` 1861-1871; advisor 1881-1924; attribution 1933-1989; one `res.end(string)` 1998-2052.
- `server/src/logs/session-logs-access.ts:36-145` `resolveSessionLogsAccess`.
- `server/src/logs/session-tree.sql.ts:101-130` `getDescendantSessionIds`; `:148` `lockSessionTreeForIngest`.
- `server/src/logs/session-logs-delta.service.ts`: `selectSubagentStats` 38-103; `readTreeMeta` 315-356; `readSlices` 364-424; `readWorkflows` 430-460 (`body::text` + `JSON.parse`); route `repositories.controller.ts:1703-1726`; DTO `server/src/logs/dto/session-logs-delta.dto.ts:65`.
- `server/src/logs/workflow-extractor.ts:126` `extractWorkflows`; other callers `session-list-flags.ts:19`, `database/backfill-session-list-flags.ts:16`.
- `server/src/database/database.module.ts:20-72`: `PG_POOL` node-postgres `Pool` (`DB_POOL_MAX` 20), `DRIZZLE` over it; checked-out client bypasses SQL logging; `pool.connect()` precedent `health/health.controller.ts:36`, `system-info/system-info.service.ts:109,126`; no `pg-cursor` / `pg-query-stream` (`pg ^8.21.0`).
- `server/src/common/precompressed-static.ts:211-244`: headers to mirror.
- `server/src/logs/gzip-sniff.middleware.ts`: inbound gzip only; no `compression()` in `main.ts:66-69`.
- Single-flight `inFlightTick`: `server/src/ai-tool-versions/ai-tool-versions.scheduler.ts:33-62`. No semaphore / p-limit.
- Schema `logs`: `server/src/database/schema/index.ts:329-364`; DDL `docs/knowledgebase/db_state.sql:355-384`.

**Client**
- `client/src/viewer/api.ts`: `SessionLogsData` 1625-1696, `fetchSessionLogs` 1698-1709, delta 1739-1788.
- `client/src/viewer/pages/repository/useRepositoryData.ts`: key `['session-logs', repoId, sessionId, teamId]` 159-163; watermark poll 170-187; `seenEndTimeRef` 191; invalidate 201-230; reload 232-268; `subagentLogsMap` / `agentParentMap` / `subagentMeta` / `parseSessionLogs` 324-358.
- Invalidators: `SessionDetailPane.tsx:108-117`, `session-map/useSessionMapData.ts:100-105`.
- All-subagent consumers: `session-export-runner.ts:82-128`; `SessionDetailPane.tsx:135,158`; `harness-usage/SessionHarnessUsageTab.tsx:36,69-93`; `bash-tab/SessionBashTab.tsx:15,42`, `collect-bash-calls.ts:73-76`; `CallTreeView.tsx:72`; `charts/chart-data.ts`, `charts/subagent-sessions.ts`; `summary/session-summary-derive.ts:199-345`; `usage/session-usage-derive.ts:747-770`; `otel/session-otel-kpis.ts`; workflow views.
- One-at-a-time consumers: `SessionLogView.tsx:60-218`, `AgentActivationItem.tsx:51-53`, `tool-call-view/ToolViewContext.tsx`, `log-parser.ts:1291` (`parseSessionLogs` 1735).
- Tab bar `SessionTabContent.tsx:47-282`; lazy chunk via barrel `session-tabs-lazy-group.ts`.

**Ingest (FR-5..FR-8)**
- `server/src/logs/logs.service.ts` `upsert` (284-886): soft-delete check 297-308 outside tx (races `deleteSession`); tx 311; owner lock / foreign 316-326; tree lock 331-336; sessions upsert 338-378; logs upsert 430-463 (`updated_at` 448, `RETURNING (xmax=0)` 462); claude extraction 465-544; `markTreeStale` 548-554; artisyn 559-881 (`renormaliseSessionChangedPaths` 822, heal 832-845); `toolUsageRebuild.notify()` 884. Gets parsed `lines` + `bodyBytes` only.
- Zip import: `importSession` 967-1081 (deleted check in tx 979-991); `writeImportedLog` 1088-1249 (longer body 1108-1155, claude re-extract only 1167).
- Raw body: `logs-v2.controller.ts:61`; staged `upload-queue.service.ts:100-137`; read `upload-queue-scheduler.service.ts:359-390`; parsed 391.
- `upload-queue.service.ts`: `saveChunk` 148-237 (`received_at` chunk 0); `reassembleChunks` 304-369 (size mismatch warning only 320-324, `attempts` reset 334-347); `getPendingWarnings` 418-454; `deleteQueueRowsForSessionIds` 473-517.
- `upload-queue-scheduler.service.ts`: claim 329-348; `processRow` 350-513; `'deleted'` = success, hook told nothing; transient retry 468-480; `DEFAULT_MAX_ATTEMPTS=5` 57-59.
- `logs-v2.controller.ts:43-307`: foreign answer 132-145 / 235-240; additive fields 177-181 / 301-306; no request-time deleted check.
- Rebuild models: `tool-monitoring/tool-usage-rebuild.service.ts` (`notify()` 78-102, claim `tool_usage_version IS NULL … SKIP LOCKED` 134-171, advisory lock 111-118); `markTreeStale` `tool-usage-writer.ts:64`; env readers `tool-usage.constants.ts:30-49`; `otel-projection.service.ts:107-119,366-430`; `session-cost/session-cost-recompute.service.ts:19-25,54`; `okf/shell-figures-backfill.service.ts:55-99`; `teams/team-repo-recompute.service.ts:67`; startup re-queues `database/database-init.ts:155-190`.
- CPU signal: display only, `system-info/system-info.service.ts:24,46,54`.
- Env vars read inline via `readPositiveIntEnv`-style helper; documented in `server/.env.example`, `release-template/.env.example`.

**Deletes (FR-7a)**
- `server/src/sessions/sessions.service.ts`: `deleteSession` 85-171 (`deleted_session_log` 152-163); `purgeSessionChildData` 189-295; `hardPurgeExpiredSessions` 388-534 (477).
- Other hard deletes: `admin/admin.service.ts:613,663`; `users/account-deletion.service.ts:105-220`.
- `deleted_session_log` (`db_state.sql:195-213`) never read on ingest, no `session_id` index.
- Ingest paths: `POST /api/v2/logs` (`logs-v2.controller.ts:43`); `POST /api/v2/otel-realtime` (`otel/otel-realtime.controller.ts:76`, service `otel-realtime.service.ts:79-102`, `{ignored:'deleted'}` precedent); `ingestOtelChunk` `logs.service.ts:1264`, `OtelSessionDeletedError` `otel-facts-writer.ts:217-221`; `POST /api/v2/session-attribution` (`session-attribution.controller.ts:32`); `POST /api/v2/turn-end-cost-advisor` (`turn-end-cost-advisor.controller.ts:29` → `recordRun` `turn-end-cost-advisor.service.ts:518`, no deleted check); zip import `repository-export-import.controller.ts:93,147,353,417`.

**Hook (`hook/.claude/telemetry_tool/`)**
- `send-logs-hook.js`: `readManifest` / `writeManifest` 192-247; manifest path 1565; skip 2188-2209; write after 2xx 2315-2353; prune/flush 2452-2464; artisyn guard 2343; deferred artisyn 2382-2388; `isRetryableUploadFailure` 1454-1460; `tool-calls` 1765-1800; `hook-status` with `hookVersion` 2472-2480.
- `tool-wrap-records.js:426-449` `toolCallsSourceSize` Σ(size+1).
- `upload-logs.js`: `uploadFile` 462-625 (params 466-503, headers 529-537, only 201 = success, parse 563-588); pending 704-800; resume `totalSize ===` 885-886; chunk failures 920-950; completion 973-990.
- `hook-log.js:12-20` `getHookVersion()`.
- 13 hook `__tests__/*.algo.test.js` using `loadExamples`; none covers manifest skip / pending resume.

**Tests**
- Contract: `server/test/contract/registry/f17-sessions.ts` (`/logs` 610-720, `F17-session-logs-delta` 719-740, `FR6_LOGS_ROWS` :137); `f15-ingest.ts`; `f18-session-delete-retention.ts`; `f23-export-import.ts`; meta-test `server/test/contract/routes.contract-spec.ts`.
- Scenarios: `view/s-sess-03.spec.ts`; `view/s-otel-01.spec.ts`; `view/s-sess-04.spec.ts`; `hook/s-hook-01.spec.ts` (:277-356); `hook/s-hook-09.spec.ts`; `hook/s-compat-01.spec.ts`; `ingest/s-ingest-04.spec.ts`; `ingest/s-ingest-02.spec.ts`; `sessions/s-slife-06/07/08.spec.ts`; `repos/s-repo-11.spec.ts`; `repos/s-repo-17.spec.ts`.
- Helpers: `helpers/hook-process.ts` (`runHook`, `readManifest` :394, `startFakeLogHub` :491); `helpers/ingest.ts`; `helpers/queue.ts`; `helpers/session-view.ts`.
- Algorithm rows: `session-logs-delta.json`, `upload-job-queue.json`, `upload-error-classify.json`.

## Open gaps
1. No streaming/cursor in server; no response gzip.
2. No per-worker semaphore.
3. Workflows source: ingest-time stored result vs client port.
4. "Large-log response" definition for the limiter.
5. No CPU-load signal (`loadavg` 0 on Windows; no cgroup).
6. No rebuild queue for FR-6; whether FR-1 gzip build rides on it.
7. No part version / hash / gzip columns; route shapes undecided.
8. First DB trigger / plpgsql in repo — check Drizzle migrate and db:state.
9. Deleted-session lookup: no `session_id` index; descendants; account/repo delete = fresh start; upsert race; advisor route unchecked.
10. No upload-response field for "deleted, don't retry".
11. Ordering timestamp for newer-upload-wins.
12. Failure-after-2xx feedback to hook.
13. Header figures on open need server metadata or all parts.
14. Stale KB line in `docs/knowledgebase/test/overview.md:103` (13 hook algo test files, not 3).
