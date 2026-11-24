---
type: "Research"
title: "Session parts disk cache — research findings 1"
description: "Codebase research report for the session-parts disk cache plan (audit archive)."
---

## Findings: session parts disk cache (GH-171)

All lookups were done with grep and reads. I did not refresh or use the `ce` graph. The delete-path list under FR-9 below comes from grepping `delete(logs)`, `schema.logs` and `DELETE FROM logs`, so the plan should confirm it with `ce` before relying on it.

### Requirements summary
Today `streamPart` reads `logs.body_gz` (bytea) from Postgres on every first read of a part. The task adds a disposable file cache on disk so those bodies are served from files instead, all inside Node (no nginx):
- **Location:** `SESSION_PART_CACHE_DIR`, default `<resolved UPLOAD_QUEUE_DIR>/part-cache/`. Files are `<logId>/<body_rev>.json.gz` and are never changed after writing.
- **Hit:** after the existing auth, tree and 304 checks, the server reads only the revision columns and streams the file. It sends gzip as-is when the client accepts it, otherwise it decompresses on the fly. Headers and ETag stay byte-identical to today.
- **Miss:** served from the DB as today, then written to the cache via a temp file and atomic rename. Only rows with a valid gzip copy are cached, and nothing is pre-warmed. Writing a new revision removes the older revision files of that `logId`.
- **Last read:** recorded as the file's mtime (`utimes`), at most about once an hour per file.
- **Sweep:** a timer deletes files not read for `SESSION_PART_CACHE_TTL_DAYS` (default 14), stale temp files and empty folders. A size cap `SESSION_PART_CACHE_MAX_MB` (default 1024) evicts the least recently read files first. A write that pushes the estimated total over the cap starts an eviction pass at once, and a part bigger than the cap is never cached.
- **Deletes:** every path that deletes `logs` rows also removes the matching `<logId>/` folders, best effort.
- **Failures and switch:** any cache error falls back to the DB (fail open). `SESSION_PART_CACHE_ENABLED=false` gives exactly today's behaviour.
- **Admin view:** a new additive `partCache` field on `GET /api/v1/admin/system`, shown on the Admin System tab. The last sweep result is kept in a state file inside the cache folder so every worker shows the same one.
- **Docs and tests:** env examples, KB and user docs; steps added to `@S-SESS-03` and `@S-ADM-01`; contract row `F01-admin-system`.

Computed defaults:
- 1024 MB = 1,073,741,824 bytes
- 14 days = 1,209,600,000 ms
- 1 h throttle = 3,600,000 ms

### Wireframes
None are referenced, and the task folder holds only `requirements.md`.

### Knowledgebase
- `docs/knowledgebase/session-log-view.md` §"The parts API" (lines 134–178): the part body contract (headers, 304 without a stream permit, gzip / identity / `body::text`, the ETag is the revision of the bytes actually read). Add the cache here.
- `docs/knowledgebase/server-endpoint-map.md:304-313`: the parts route notes. Mention the cache and the new `partCache` field of admin/system.
- `docs/knowledgebase/db-tables.md:220-245`: `body_rev` comes from `logs_body_rev_seq` on every body write (trigger `logs_body_guard`); `body_gz` is valid only while `body_rev IS NOT NULL AND body_gz_rev = body_rev`; never `SELECT` whole `logs` rows.
- `docs/knowledgebase/upload-queue.md:38-39` (staging dir, resolved from CWD and created on demand) and `:310-317` (`LogBodyGzService` drain, which must not fill the cache).
- `docs/knowledgebase/system-info-and-cluster.md:197-215`: the list of CWD-relative resolvers and the release volume mounts. Add the new resolver to that list.
- `docs/knowledgebase/twins-and-cross-cutting-rules.md:101-117`:
  - Every new env var gets a commented line in `release-template/.env.example`.
  - The "new background job" rule (a `SKIP LOCKED` queue table) does not fit a file sweep. The closer precedent is the idempotent sweep that every worker runs (see Existing patterns).
- `docs/knowledgebase/algorithms/log-retention.md` plus `server/src/log-retention/log-retention-plan.ts`: the nearest algorithm (age plus size cap, oldest first). The requirements explicitly treat cache eviction as "not an algorithm", so there are no rows to add.
- `docs/knowledgebase/server-conventions.md` (pino logging, DB query patterns) and `docs/knowledgebase/test/index.md` / `test/scenarios.md:72` (the stand's working dir holds `UPLOAD_QUEUE_DIR`).

### Existing patterns

**Read path**
- `server/src/logs/session-log-parts.service.ts:167-217` `streamPart`: the single query, the headers (lines 189-193), the gzip branch (195-201) and the gunzip branch (203-212). `acceptsGzip` is at 46-57. The hit / miss branch goes here.
- `server/src/logs/repositories.controller.ts:1840-1884` `getSessionLogPart`: access, then `readTreeLogsMeta`, 404, 304, then `runLimited(...streamPart)`. The cache plugs in behind `streamPart`.
- `server/src/logs/session-tree-logs-meta.ts:13-34`: `TreeLogRowMeta` already carries `logId`, `bodyRev` and `gzReady`, so a hit candidate is known before any body query. The requirements still ask for one re-read of the revision columns, to avoid a stale ETag.
- `server/src/logs/session-logs-stream.service.ts:46-73` `runLimited`: a failure after the first byte calls `abortStream`. FR-10's mid-stream file error reuses this.
- `server/src/logs/streaming/response-stream.ts`: `writeChunk` (backpressure-aware), `StreamAbortedError`, `abortStream`. Stream a hit with `fs.createReadStream` and `writeChunk`.
- `server/src/logs/streaming/log-stream-limiter.ts:31`: the per-worker FIFO limiter.

**Directories and config**
- `server/src/logs/upload-queue.service.ts:132-136` `resolveStagingDir()`: `path.resolve(process.env.UPLOAD_QUEUE_DIR || 'upload-queue')` plus `mkdirSync({recursive:true})`. The default cache dir is derived from this.
- `server/src/logs/export-import-zip.ts:31`: the same resolver pattern for `EXPORT_IMPORT_DIR`.
- `server/src/common/env-int.ts` `readPositiveIntEnv`; `log-retention-plan.ts` `parseRetentionEnv` accepts 0. For the enable flag, the house style is `process.env.X_ENABLED !== 'false'`, e.g. `server/src/logs/budgets/budget-threshold.scheduler.ts:20`.

**Staging scanners (FR-2): all already safe**
- `upload-queue.service.ts:316` and `:724` match only `^<uploadId>\.chunk\d+$`.
- `:590`, `:655` and `upload-queue-admin.service.ts:145-156` unlink only named rows' files.
- `upload-queue-scheduler.service.ts:744` `diagnoseMissingFile` matches entries by `startsWith(upload_id ?? session_id)`. A UUID or session id never starts with `part-cache`, so the subfolder is not picked up.
- `system-info.service.ts:184` `getDiskUsage` sizes only `logs/`, so it does not count the cache.

**Sweeper**
- `server/src/log-retention/log-retention.service.ts`: `SchedulerRegistry` plus `setInterval`, a first tick at bootstrap, an `isTickRunning` guard, ENOENT treated as success, and it runs in every worker. Copy this for the TTL/cap sweep.
- `server/src/logs/export-import-job-cleanup.scheduler.ts:43-80, 160-200`: the same pattern, plus an mtime cutoff and an `inFlightTick` await in `onModuleDestroy`.
- `server/src/common/repeated-failure-log.ts`: keeps sweep error logging from flooding.

**FR-9 delete paths**
- `server/src/sessions/sessions.service.ts:286` `purgeSessionChildData`. It deletes logs at :378 with no `RETURNING id`. Its callers are :148 (user delete), :438 `hardDeleteSessionsInTx`, :666 `hardPurgeExpiredSessions`, and `deleted-session-cleanup.service.ts:167,195`. Precedent: step f (`deleteQueueRowsForSessionIds`, `upload-queue.service.ts:637-690`) already unlinks files best effort inside the transaction.
- `server/src/admin/admin.service.ts:614-689` `removeRepo`: `logIds` are already collected (:637) and deleted at :652, then `hardDeleteSessionsInTx`.
- `server/src/teams/teams.service.ts:583-683`: `logIds` collected (:626) and deleted at :644.
- `server/src/users/account-deletion.service.ts:106-230` `hardDeleteUser`: logs go by the `users` FK cascade at :208, so the user's log ids must be selected first. Session ids are already read at :136.

**Admin view (FR-11a)**
- `server/src/system-info/system-info.service.ts:39-75` `getSystemInfo` and `system-info.types.ts` `SystemInfoResponse`: add `partCache`.
- `server/src/system-info/system-info.module.ts`: no imports; it only gets `PG_POOL`.
- `server/src/admin/admin-panel.controller.ts:60-63`: the route, guarded by `SessionAuthGuard` and `AdminGuard`.
- Client side:
  - `client/src/models/admin.ts:210`: the independent `SystemInfo` type, which needs a matching `partCache`.
  - `client/src/viewer/pages/admin/tabs/AdminSystemTab.tsx`: 14,335 bytes, already over the 10 KB guideline. Put the new card in its own component file. The local `Card` (:60) and `SecondaryTile` (:71), `formatBytes` and `DateTime` can be reused, and the DB Space card (:346-361) is the nearest layout to copy.

**Tests**
- Contract: `server/test/contract/registry/f01-infra.ts:79-84` (`F01-admin-system`, `expect: {status: 200}`, `noDb`); add `partCache` via `bodyMatches`. `:86-90` is the 403 member row.
- `tests/scenarios/view/s-sess-03.spec.ts:1055-1200`, steps 12–15 (`@mode-a @mode-c`): parts helpers `partUrl` and `fetchPart`, the poll for `content-encoding: gzip` after the gzip drain (:1097), and the re-upload pattern for a new `body_rev` (step 14).
- `tests/scenarios/repos/s-repo-11.spec.ts:590,613`: reads files under `stand.runDir` (`tests/scenarios/fixtures/index.ts:37`), which is how a scenario can inspect or backdate cache files.
- `tests/scenarios/modes.ts:133-170` `standEnv`: stand env vars (`UPLOAD_QUEUE_DIR` = `<runDir>/upload-queue`). `scripts/__tests__/scenarios-stand.test.js:88` asserts that env.
- `tests/scenarios/auth/s-adm-01.spec.ts:135-150`: step 2 already checks admin/system → 403 / 401; the UI System tab check is step 4 (:172).

**Docs to touch**
- `release-template/.env.example:121-140`: next to `SESSION_LOGS_MAX_CONCURRENT_STREAMS` and `LOG_BODY_GZ_INTERVAL_MS`.
- `server/.env.example:26`.
- `server/README.md:145`.
- `user-docs/server-configuration.md:21-23`: the env table, shaped like the `LOG_RETENTION_*` rows.
- `user-docs/component-reference.md:84` (volume table) and `:108` (admin panel).
- `release-template/INSTALL.md:264`: the backup note. Say the cache folder is not needed in backups.

### Open gaps (the plan must decide)
1. **No file-serving precedent.** `server/src` has no `fs.createReadStream`, `rename` or `utimes` use, so the temp-file naming (it must be a pattern the sweep recognises as stale), the atomic rename and the hit streaming are all new. Windows rename over an open file also needs a decision.
2. **Limiter on hits.** Should a hit still take a `LogStreamLimiter` permit (today every 200 does)? Also, should the hit check use `meta.bodyRev`/`gzReady` from the metadata read, or re-read the revision columns? The requirements imply a re-read.
3. **Writing the miss into the cache:** after `res.end()` or in parallel, sync or detached. Also how big the miss Buffer may be against the cap check (cap in bytes = MB × 1,048,576).
4. **Module placement.** The cache service is needed by `SessionsService`, `AdminService`, `TeamsService`, `AccountDeletionService`, `SystemInfoService` and `SessionLogPartsService`. `SystemInfoModule` has no imports, and LogsModule ↔ SessionsModule already need a `forwardRef`. A small standalone module with no DB dependency, or plain functions, avoids new cycles.
5. **FR-9 mechanics.** `purgeSessionChildData` does not return log ids: add `RETURNING id`, or select ids first. Decide whether deletion happens in the transaction (as the staging unlink does) or after commit (as the requirements say), which means threading ids out through every caller. Account deletion needs a new pre-cascade select of `logs.id WHERE user_id`.
6. **Sweep interval default.** The requirements say only "a few hours" (for example 3 h = 10,800,000 ms). The format of the state file, and whether it is skipped by name, is unspecified.
7. **Per-process size estimate** for the write-triggered eviction: how it is seeded at bootstrap, given a full disk scan on start.
8. **Scenario isolation.** Stand env is set per mode for all scenarios, so a small `SESSION_PART_CACHE_MAX_MB` or TTL on the stand affects every parallel scenario in mode A/C and could make the `@S-SESS-03` cache-file assertions flaky. Steps may need to trigger a sweep on demand (no admin trigger route exists) or rely on a short `SESSION_PART_CACHE_SWEEP_INTERVAL_MS` plus backdated mtimes. A stand-env change also needs `scripts/__tests__/scenarios-stand.test.js` checked.
9. **Proof of "not read from Postgres" (FR-4 acceptance).** No scenario helper exists to show a hit skipped `body_gz`. One option: corrupt or NULL `body_gz` through `db` while the file is cached, then compare bytes.
10. **Admin card.** No wireframe exists, so the layout and test ids are undecided. The `ui-components` skill applies.
