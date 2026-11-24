---
type: "Plan"
title: "Session logs: pre-compressed storage, delivery in parts, bounded memory — implementation plan"
description: "Plan for streaming /logs row by row under a per-worker limit, gzip copies of log bodies, per-part delivery with lazy sub-agent loading, server/hook upload skip, coalesced CPU-governed rebuilds, data-loss fixes and deleted-session tombstones."
---

# Implementation plan — 2026-11-23-session-logs-streaming

## TL;DR

- **DB, one migration `0096` (additive):**
  - New `logs` columns: `body_rev`, `body_sha256`, `ingest_version`, `body_received_at`, `body_gz`, `body_gz_rev`, `edit_records_sha256`, `stats_edit_sha256`.
  - The sequence `logs_body_rev_seq` and the repo's first plpgsql **trigger**, `logs_body_guard`, which bumps the revision and clears the hash on every body write.
  - New `upload_queue` columns `content_sha256` and `failure_delivered`; new `session_stats` columns `workflows` and `workflows_version`; new `deleted_session_log.repository_url`.
  - New table `session_reextract_queue`.
  - Five new indexes: gz pending, workflows pending, and three on `deleted_session_log`.
- **Bounded read path (FR-3):**
  - `logs/streaming/`: the backpressure writer and the per-worker FIFO limiter `LogStreamLimiter` (`SESSION_LOGS_MAX_CONCURRENT_STREAMS`).
  - Legacy `/logs` and `/logs/delta` stream one row at a time, with byte-identical output.
  - Workflows are stored at ingest (`session_stats.workflows`) instead of being parsed per request.
- **New read routes (FR-2):**
  - `GET …/sessions/:sessionId/logs/parts`: the manifest with per-part `rev` and `derivedLagging`.
  - `GET …/logs/parts/:partSessionId/:logType`: the stored gzip body, with 304 on a matching ETag.
  - `subagentStats` gains `cacheWrite5mTokens` / `cacheWrite1hTokens`.
- **Background services:**
  - `common/load-governor/` (CPU sampler, pure `decideRebuildPace`, `RebuildGovernor.admit()`), now in front of every rebuild drain and the upload-queue tick.
  - New drains: `LogBodyGzService`, `WorkflowsBackfillService`, `SessionReextractService`, `DeletedSessionCleanupService`.
- **Ingest:**
  - Server hash skip `decideIngestSkip` with `INGEST_VERSION`.
  - A newer-upload-wins guard on `body_received_at`.
  - Upload-queue coalescing of whole-file types, with `superseded` / `skipped` measurement outcomes.
  - Re-extraction when edit records change.
  - Zip import now re-extracts sub-agent stats.
  - `writeClaudeDerived()` is lifted out of `upsert`.
- **Hook API (additive):** `POST /api/v2/logs` takes the new query params `contentSha256` and `uploadFeedback=1`, and returns `failedUploads` and `sessionDeleted` only to callers that sent `uploadFeedback=1`.
- **Hook 3.1.0 → 3.2.0:** the `.claude-logs.sent.v2` manifest (size, mtime, params hash), a sha256 `tool-calls` fingerprint, a pending-resume sha256, and a 64 KiB response read cap.
- **Deletes (FR-7a):**
  - `SessionTombstoneService` checks every ingest path.
  - Soft delete purges all survivor tables, and the descendant CTE gets a `deleted = false` filter.
  - Account and repository deletion clear their tombstones.
- **Client:** the manifest plus the root parts load first. Sub-agent parts load on demand. "Loading session logs N of M" gates four kinds of tab: Bash, charts, Usage and Harness usage. Sub-agent cost is priced from `subagentStats`.

## Reference

- Requirements: [requirements.md](requirements.md). Evidence is in [notes.md](notes.md); the send/skip rules are in [send-recompute-analysis.md](send-recompute-analysis.md).
- Research:
  - [research/findings-1.md](research/findings-1.md)
  - [research/deleted-sessions.md](research/deleted-sessions.md)
  - [research/client-parts.md](research/client-parts.md)
  - [research/server-ingest-read.md](research/server-ingest-read.md)
  - [research/load-governor.md](research/load-governor.md)
- PoC: [docs/pocs/2026-11-23-1753-logs-body-trigger-gzip/](../../../pocs/2026-11-23-1753-logs-body-trigger-gzip/README.md).
  - The trigger semantics are confirmed: `UPDATE OF body` fires on the upsert's `DO UPDATE` arm; a gz-only update does not fire it; `body_rev` has gaps.
  - gzip level 6 compresses real bodies 3.6–4.3×, at about 12 ms/MB on a dev CPU.

## Design Decisions

Paths: server paths are relative to `server/src/`, client paths to `client/src/viewer/`, and hook paths to `hook/.claude/telemetry_tool/`.

### Read path (FR-1 to FR-4)

**DD-1 — Row by row.** "Row by row" means one `SELECT body::text AS t FROM logs WHERE id = $1` per log row, through the Drizzle pool, after a metadata query that selects no bodies. There is no cursor and no new dependency, and SQL logging keeps working.

**DD-2 — Backpressure writer.** `logs/streaming/response-stream.ts` exports:
- `writeChunk(res, chunk: string | Buffer): Promise<void>`: `res.write`; if it returns false, await `drain` or `close`; throw `StreamAbortedError` once `res.destroyed`.
- `abortStream(res)`: `res.destroy()`, used for any failure after the first byte.

**DD-3 — Per-worker limiter.** `logs/streaming/log-stream-limiter.ts` is the Nest provider `LogStreamLimiter`.
- `acquire(signal: AbortSignal): Promise<() => void>` returns a release function. It is a FIFO semaphore with `SESSION_LOGS_MAX_CONCURRENT_STREAMS` permits.
- A queued request waits without a timeout and leaves the queue when its request closes.
- Legacy `/logs`, part bodies and non-reload `/logs/delta` answers acquire it after the access checks and metadata, before the first byte.

**DD-4 — Legacy `/logs` byte layout.** The output is byte-identical to today's (`repositories.controller.ts:1780-1791, 2002, 2050-2052`):
- `{"main":` followed by the merged main:
  - read the artisyn text: if it is `[]`, skip it; otherwise write it without its trailing `]`;
  - read the claude text, then write:
    - `]` if claude is `[]` and artisyn was written;
    - `,` plus the claude text without its leading `[` if artisyn was written;
    - the claude text otherwise.
- `,"subagents":[` then each non-null sub-agent body, ordered by `sessions.session_id`, in today's template `{"sessionId":…,"parentSessionId":…,"agentDescription":…,"workflowPhase":…,"logs":<body>}`, joined by `,`.
- `],"subagentStats":…,"rootStats":…,"workflows":…,"turnEndAdvisor":…,"sessionAttribution":…,"harnessSnapshot":…}`.
- Errors before the first byte: 404 when there is no root claude row, 422 when the root claude body is NULL.

**DD-5 — Shared tree metadata.** `logs/session-tree-logs-meta.ts` exports `readTreeLogsMeta(db, rootRowId): Promise<TreeLogRowMeta[]>`, with no bodies. Both the legacy streamer and the parts manifest use it.

```ts
interface TreeLogRowMeta {
  logId: number; sessionRowId: number; sessionId: string;
  logType: 'claude' | 'artisyn' | 'claude-subagent';
  isRoot: boolean; bodyIsNull: boolean;
  bodyRev: string | null;            // bigint as text
  updatedAtMicros: string;           // (extract(epoch from updated_at)*1e6)::bigint as text
  gzReady: boolean;                  // DD-9 validity
  parentSessionId: string | null; agentDescription: string | null;
  workflowPhase: string | null; workflowRunId: string | null;
}
```

- Rows: the root `claude` and `artisyn` rows, and the descendants' `claude-subagent` rows, ordered root first (claude, artisyn), then by `sessions.session_id`.
- Descendants come from `getDescendantSessionIds`.

**DD-6 — Stored workflows.**
- `extractClaudeStats` returns `workflows: WorkflowRun[] | null` (null for sub-agent logs). `session-stats-writer.ts` writes `session_stats.workflows` and `workflows_version = WORKFLOWS_VERSION`.
- `logs/stored-workflows.ts` exports `readStoredWorkflows(db, rootRowId): Promise<WorkflowRun[] | null>`; null means not backfilled yet.
- Readers then call `resolveWorkflowAgentLinkage` as today. On null they fall back to today's parse of the root claude body only (one row).

**DD-7 — Delta streaming.**
- `readSlices` (`session-logs-delta.service.ts:364-424`) splits into:
  - `readSliceMeta(requests)`: per row `{sid,t,ut,len,fpPrev,fpLen,exists}`, computed in SQL with no lines;
  - `readSliceText(req): Promise<string | null>`: one row's `jsonb_agg(elem ORDER BY i)::text` for `i > prevN`.
- The stale and growth checks use the meta before the first byte. `reload` answers stay plain JSON.
- Other answers are streamed in today's key order: `reload,rootArtisynLines,rootClaudeLines,subagentAppends,newSubagents,subagentStats,workflows,liveness,serverTime,cursor`.
  - `lines` values are written as raw slice text, never parsed.
  - Entry metadata is written with `JSON.stringify` in today's key order.
- `readWorkflows` uses DD-6.

**DD-8 — Revision trigger.** The migration contains the trigger verified in the PoC:
- Sequence `logs_body_rev_seq`.
- Function `logs_body_guard()`: `NEW.body_rev := nextval('logs_body_rev_seq')`; on UPDATE, `IF NEW.body_sha256 IS NOT DISTINCT FROM OLD.body_sha256 AND NEW.body_received_at IS NOT DISTINCT FROM OLD.body_received_at THEN NEW.body_sha256 := NULL`.
  - A writer that touches neither column (zip import, an older server build) gets the hash cleared.
  - The upsert re-writing the same hash with a new `body_received_at` (the "process" path after an `INGEST_VERSION` or edit-sha change) keeps it.
  - This extends the PoC rule, which tested the hash condition only.
- Trigger `logs_body_guard BEFORE INSERT OR UPDATE OF body ON logs FOR EACH ROW EXECUTE FUNCTION logs_body_guard()`.

Rules for `body_rev`:
- It is compared only for equality or order, because it has gaps.
- Legacy rows keep NULL until DD-10 assigns a value.
- Part `rev` = `bodyRev` when set, else `'u' + updatedAtMicros`.

**DD-9 — Compressed copy.**
- `body_gz` is the gzip (level 6) of the UTF-8 `body::text`.
- It is valid (`gzReady`) when `body_rev IS NOT NULL AND body_gz_rev = body_rev`.
- It is kept only for `artisyn`, `claude` and `claude-subagent`.

**DD-10 — gzip builder.** `logs/log-body-gz.service.ts` is `LogBodyGzService`, following the `tool-usage-rebuild.service.ts` pattern: `notify()` coalescing, a tick every `LOG_BODY_GZ_INTERVAL_MS`, and `RebuildGovernor.admit()` per row.

Per row:
1. Claim one id matching the `idx_logs_body_gz_pending` predicate (`body_rev IS NULL OR body_gz_rev IS DISTINCT FROM body_rev`, so legacy rows with both NULL are included) with `FOR UPDATE SKIP LOCKED`.
2. Read `body::text` and `body_rev`.
3. `zlib.gzip` at level 6.
4. `UPDATE logs SET body_rev = r.rev, body_gz = $gz, body_gz_rev = r.rev FROM (SELECT COALESCE(body_rev, nextval('logs_body_rev_seq')) AS rev FROM logs WHERE id = $id) r WHERE logs.id = $id AND logs.body_rev IS NOT DISTINCT FROM $readRev`.

**DD-11 — Parts.**
- A part is one `logs` row of `TreeLogRowMeta` with `bodyIsNull = false`.
- The UI's root part is the manifest plus the root claude and artisyn parts, loaded in parallel. That gives one request per stored blob and no multi-member gzip.
- The client merges artisyn lines first, then claude lines (DD-4).

**DD-12 — Part body response.**
- Headers: `Content-Type: application/json; charset=utf-8`, `Vary: Accept-Encoding`, `ETag: "<rev>"`, `Cache-Control: private, no-cache`.
- `If-None-Match` equal to the current ETag → `304` with no body. No body is read and no limiter permit is taken.
- Otherwise `200`:
  - copy valid and `Accept-Encoding` contains `gzip` → the stored `body_gz` with `Content-Encoding: gzip`;
  - copy valid, gzip not accepted → the copy piped through `zlib.createGunzip()`;
  - copy not valid → stream `body::text`.
- `?rev=` is a cache-buster only.
- A part outside the tree, or a `logType` that does not match its node, gives 404 `Session log part not found`. A `logType` outside the three types gives 400.

**DD-13 — Live refetch (FR-4).**
- The manifest keeps the query key `['session-logs', repoId, sessionId, teamId]`, so today's watermark and invalidators refetch only the manifest.
- Part keys are `['session-log-part', repoId, sessionId, partSessionId, logType, rev]` with `staleTime: Infinity`.
- A changed rev refetches only parts that are already loaded. This is the `/logs/delta` idea: a per-row version from metadata.

**DD-14 — Derived-lag flag.**
- Manifest `derivedLagging` is true when either of these exists:
  - an `upload_queue` row with status `pending` or `processing` for the tree's session ids (`textList()`) and `received_at < now() - DERIVED_LAG_MS`;
  - a `session_reextract_queue` row for the root with `requested_at` older than that.

### Rebuilds under load (FR-6)

**DD-14a — Drain start-up.**
- Every new drain service (`LogBodyGzService`, `WorkflowsBackfillService`, `SessionReextractService`, `DeletedSessionCleanupService`) starts the way `tool-usage-rebuild.service.ts:56` does: `onModuleInit` runs a first tick and registers its `setInterval`.
- `initializeDatabase()` runs before the Nest context exists, so it is never used to start them.
- "Startup kick" in this plan means this first tick.

**DD-15 — Rebuild governor.**
- `common/load-governor/cpu-load-sampler.ts` reports system busy % from `os.cpus()` time deltas. When `/sys/fs/cgroup/cpu.max` holds a quota, it takes the max with the cgroup v2 share (Δ`usage_usec` from `cpu.stat`). It samples every `REBUILD_LOAD_SAMPLE_MS` and reports the mean of the last `CPU_LOAD_SAMPLE_WINDOW` samples.
- `common/load-governor/rebuild-pace.ts` exports the pure `decideRebuildPace(input: {loadPct, nowMs, pausedSinceMs: number|null, slowdownPct, pausePct, hardCapMs, maxDelayMs}): {action: 'run'|'wait'|'pause', waitMs: number, pausedSinceMs: number|null}`, following the table in `research/load-governor.md`.
- `common/load-governor/rebuild-governor.ts` is the Nest provider `RebuildGovernor`, exported from the global `LoadGovernorModule`:
  - `admit(): Promise<void>` resolves when the decision is `run` (after `waitMs`), and re-checks after one sample while paused;
  - `reportIdle()` resets drain mode.

**DD-16 — Coalescing.** This applies to `claude`, `claude-subagent` and `tool-calls`.
- After `claimNextPendingRow` picks such a row, it claims instead the newest `pending` row with the same `(user_id, session_id, log_type)` (`FOR UPDATE SKIP LOCKED`), if there is one. The first pick goes back to `pending` untouched.
- After the newest row succeeds, `deleteSupersededRows` deletes the older `pending` rows of that key with an earlier `received_at`, unlinks their files, and records one measurement per row with outcome `superseded`.
- If the newest row fails, the older rows are processed normally.
- `artisyn` and `claude-otel` are never coalesced.

**DD-17 — Measurement outcomes.**
- `UploadQueueMeasurementOutcome` (`logs/upload-queue-stats.constants.ts:44`) becomes `'success' | 'failure' | 'skipped' | 'superseded'`.
- The `upload_queue_measurements.outcome` column is already `varchar(20)`; the migration only updates its comment.
- The admin stats (`admin/upload-queue-stats.service.ts:136-152`) already filter on `'success'` / `'failure'`, so the new outcomes are excluded from throughput and failure figures and stay unchanged.

### Ingest skip and data-loss fixes (FR-5 and FR-8)

**DD-18 — `upsert` interface.**
- `LogsService.upsert` gets a new optional last argument `ingest?: UpsertIngestMeta`, where `UpsertIngestMeta = {bodySha256: string; receivedAt: Date}`, exported from `logs/ingest-version.ts`.
- Its result union gains `'superseded'`.
- When `ingest` is absent, the hash and `body_received_at` are NULL, so the guard always lets the write through.

**DD-19 — Newer upload wins.**
- The `DO UPDATE` adds `WHERE logs.body_received_at IS NULL OR excluded.body_received_at IS NULL OR excluded.body_received_at >= logs.body_received_at`.
- `body_received_at` = `ingest.receivedAt`, which is `upload_queue.received_at` (first-insert / chunk-0 time). Zip import writes `now()`.
- An empty `RETURNING` sets a local `superseded` flag:
  - `claude`, `claude-subagent` and `tool-calls` skip extraction and stale marks and return `'superseded'`;
  - `artisyn` skips the hook-status column update but still runs harness/OKF store and bind, code-inventory and `otel-status`.
- `claude-otel` is unaffected.

**DD-20 — Server hash skip.**
- `logs/ingest-version.ts` exports `INGEST_VERSION = 1`. Bump it on any change to the parser, null stripping, `extractClaudeStats` or `writeClaudeDerived`.
- `logs/ingest-skip.ts` exports the pure `decideIngestSkip(stored: {bodySha256: string|null, ingestVersion: number|null, userId: number, statsEditSha256: string|null} | null, incoming: {logType: string, bodySha256: string, userId: number, treeEditSha256: string}): 'skip'|'process'`.
  - The answer is `skip` only when all of these hold:
    - `logType` is `claude`, `claude-subagent` or `tool-calls`;
    - a stored row exists;
    - the hash, `INGEST_VERSION` and user all match;
    - for transcripts, `statsEditSha256 === treeEditSha256`.
- `bodySha256` = sha256 hex of the staged raw body string as UTF-8, computed before parsing.
- `LogsService.checkUnchanged(params, bodySha256): Promise<'skip'|'process'|'deleted'|'foreign'>` runs, in its own transaction:
  1. the tombstone check, ownership, the tree lock, and the `sessions` upsert of the upload params (today's Steps 0–1);
  2. reads the stored row and `readTreeEditSha`;
  3. calls `decideIngestSkip`.

**DD-21 — The tree's edit revision.**
- FR-5's "revision of the tree's `artisyn` log" is implemented as the hash of its edit records, because they are the only `artisyn` input to transcript stats. Roots, links and OKF heal from the `artisyn` side (send-recompute-analysis §2 S13).
- An `artisyn` row's `edit_records_sha256` = sha256 of `JSON.stringify(extractEditResultRecords(lines))`, written in the body statement.
- `readTreeEditSha(tx, sessionRowId): Promise<string>` returns the value of the nearest ancestor-or-self with an `artisyn` log, using the walk of `loadSessionTreeEditRecords` (`logs.service.ts:473-483`). It returns `''` when there is none or the value is NULL.
- A transcript row's `stats_edit_sha256` is the `readTreeEditSha` value read before Step 2, written in the body statement.

**DD-22 — Re-extract on edit-record change (FR-8 / S12).**
- In the `artisyn` path of `upsert`, read the previous `edit_records_sha256` of the row after the tree lock and before Step 2. When the new value differs, `INSERT … ON CONFLICT (session_pk) DO UPDATE SET requested_at = now()` the tree root into `session_reextract_queue`.
- `logs/session-reextract.service.ts` (`SessionReextractService`: `notify()`, a tick every `SESSION_REEXTRACT_INTERVAL_MS`, governed) claims one queue row with `SKIP LOCKED`. Under `lockSessionTreeForIngest`, for each `claude` / `claude-subagent` row of the tree it reads one body at a time, parses it, calls `writeClaudeDerived`, and sets `stats_edit_sha256`. Then it calls `markTreeStale` and deletes the queue row.

**DD-23 — Extraction function.** `logs/claude-derived-writer.ts` exports `writeClaudeDerived(tx, input: {sessionRowId: number; sessionId: string; logType: 'claude'|'claude-subagent'; lines: object[]; userId: number}): Promise<void>`, which is today's block `logs.service.ts:465-544` moved unchanged. Callers are `upsert`, `writeImportedLog` (both types) and `SessionReextractService`.

**DD-24 — Content integrity (FR-8 / S6).**
- New query param `contentSha256` (64 lowercase hex; anything else is ignored) on a single upload or chunk 0, stored in `upload_queue.content_sha256`.
  - It reaches the row through a new optional trailing parameter `contentSha256?: string | null` on `UploadQueueService.saveRawUpload` and `saveChunk` (used on chunk 0 only).
- When the staged raw body's sha256 differs, `processRow` marks the row `failed` with `error_kind='server'` and `error_message='content-hash-mismatch'`.

**DD-25 — Upload feedback.** When the request carries `uploadFeedback=1`, the single-upload and chunk-complete 201 responses (and the tombstone answer, DD-27) additively carry:
- `failedUploads: {sessionId: string; type: string}[]`: at most `FAILED_UPLOADS_MAX` of the caller's `failed` rows with `error_kind='server'` and `failure_delivered = false`, flagged delivered in the same `UPDATE … RETURNING`;
- `sessionDeleted: true` when the tombstone check rejected the upload.

Old hooks never send the param.

### Hook manifest and pending file (FR-7)

**DD-26 — Hook manifest v2, skip rule and scoped paths.**
- `.claude-logs.sent.v2` is JSON `{"version":2,"entries":{"<manifestKey>":{"size":n,"mtimeMs":n,"paramsSha256":"hex","fp":"hex"?}}}`. It is written with tmp + rename under `.upload.lock`, in the same flush as the unchanged `.claude-logs.sent`.
- `paramsSha256` = sha256 of `JSON.stringify([type, sessionId, parentSessionId||'', workflowRunId||'', agentDescription||'', workflowPhase||''])`.
- `size` is the byte length read; `mtimeMs` is the stat value taken before the read.
- `tool-calls`: `fp` = sha256 of the sorted `relativeName\tsize\tmtimeMs` lines of its source files; the old manifest keeps Σ(size+1).
  - For `tool-calls`, `oldSize` and `statSize` in `decideUploadSkip` are the Σ(size+1) numbers, and `fp` is the sha256.
  - Adoption records `size` = Σ, `mtimeMs` = 0 (ignored for this type) and the current `fp`.
- Manifest keys, unchanged from today (`send-logs-hook.js:1507, 1688, 1726, 1782, 2182`):
  - `claude/<sessionId>.jsonl`
  - `claude-subagent/<rootSessionDir>/<file>` or `claude-subagent/<rootSessionDir>/workflows/<wf>/<file>`
  - `artisyn/<sessionId>.jsonl`
  - `tool-calls/<sessionId>`
- A `failedUploads` entry `{sessionId, type}` maps to every key whose namespace equals `type` and whose last segment, without `.jsonl`, equals `sessionId`; for `tool-calls`, the key `tool-calls/<sessionId>`.
- The pure `decideUploadSkip(input: {isCurrentArtisyn, oldSize: number|undefined, v2: Entry|undefined, statSize, statMtimeMs, paramsSha256, fp?}): {skip: boolean, adopt: boolean}`:
  - current `artisyn` → send;
  - v2 missing and `oldSize === statSize` → skip and adopt (record the v2 entry);
  - v2 present → skip only if `oldSize === v2.size === statSize`, the mtime is equal, `paramsSha256` is equal, and `fp` is equal when given;
  - anything else → send.
- `canResumePending(entry, totalSize, sha256): boolean` is true only when `entry.sha256 === sha256`, `totalSize` is equal, and `nextChunkIndex < totalChunks`.
- **Scoped paths** (`prompt-upload-hook.js` and the SessionEnd flush), after a 201 for the current session's `claude` transcript only:
  - record the entry (key `claude/<sessionId>.jsonl` as the full scan builds it, read size, pre-read mtime, `paramsSha256` of `['claude', sessionId, '', '', '', '']`) in both manifests;
  - do this only when `sanitizeNdjson` dropped no line. The SessionEnd flush runs it only to detect drops and still sends the raw body.
  - Never record `artisyn` from these paths.

### Deleted sessions (FR-7a)

**DD-27 — Tombstone check.**
- `sessions/session-tombstone.service.ts` (`SessionTombstoneService`) exports `isTombstoned(db | tx, sessionId: string, parentSessionId?: string | null): Promise<boolean>`.
- It walks at most `TOMBSTONE_MAX_DEPTH` levels upward. The next id is `sessions.parent_session_id`; the given `parentSessionId` is used when the current id has no `sessions` row.
- It returns true at the first id with `sessions.deleted = true` or a `deleted_session_log` row with that `session_id`.
- Callers:
  - the request-time check in `logs-v2.controller.ts` (single upload and chunk 0), which on a hit answers like the foreign-session path, 201 `complete:true` with nothing staged;
  - `processRow` before parsing (the row is dropped with result `deleted`);
  - inside `upsert`, `checkUnchanged` and `ingestOtelChunk` after the tree lock (authoritative), replacing `logs.service.ts:297-308`;
  - `importSession`;
  - `otel-realtime.service.ts`, which answers its existing `{ignored:'deleted'}`;
  - `turn-end-cost-advisor.service.ts` `recordRun`, which skips the insert.
- `deleteSession` takes `lockSessionTreeForIngest` for the root before marking anything deleted.

**DD-28 — Delete helpers, survivors, cleanup.**
- `sessions.service.ts` gets `markSessionTreeDeleted(tx, rootPk: number, deletedByUserId: number | null): Promise<number[]>`, extracted from `deleteSession` (`:128-163`).
  - It marks the root and its live descendants `deleted`, writes their `deleted_session_log` rows (with `owner_user_id` and `repository_url`, DD-29), and returns the pks.
  - `deleteSession` and the cleanup both use it with `purgeSessionChildData`.
- `purgeSessionChildData` also deletes the rows of the given pks from `logs_otel`, `otel_api_calls`, `session_request_ids`, `session_tool_stats`, `session_harness_usage`, `session_changed_paths`, `session_cause_stats`, `session_attribution`, `session_attribution_runs` and `session_prompt_watermark`, plus `turn_end_advisor_runs` by `session_id` text. `upload_queue_measurements` is kept.
- `findSessionOwnerId` with `includeDeleted` falls back to `deleted_session_log.owner_user_id`.
- `descendantSessionsCte` (`logs/session-tree.sql.ts:36-46`) filters descendants on `deleted = false`.
- `sessions/deleted-session-cleanup.service.ts` (`DeletedSessionCleanupService`, governed; started per DD-14a with `DELETED_SESSION_CLEANUP_INTERVAL_MS`, `DELETED_SESSION_CLEANUP_BATCH` rows per pass):
  1. calls `markSessionTreeDeleted(tx, pk, null)` for every live session where `isTombstoned(parent_session_id)` is true;
  2. calls `purgeSessionChildData` for `deleted = true` sessions that still own survivor rows.

**DD-29 — Fresh start.**
- `deleted_session_log.repository_url` is the root's repo URL: `artisyn` log → `log_repositories` → `repositories.repo_url`, taking the lowest `repo_id`. It is copied to descendant rows.
- Retention purge writes `owner_user_id` (from `logs`, before the purge) and `repository_url`.
- Account deletion:
  1. selects `session_pk` from `deleted_session_log WHERE owner_user_id = $user`;
  2. hard-deletes `sessions WHERE deleted AND id = ANY(those)`;
  3. deletes those `deleted_session_log` rows.
- Admin `removeRepo` and team `removeTeamRepository` do the same keyed by `repository_url = repoUrl`.
- Rows written before the migration cannot be cleared by a repository deletion. This is accepted.

### Client (FR-2 and FR-4)

**DD-30 — Client assembly.** `pages/repository/session-parts/assemble-session-logs.ts` builds a `SessionLogsData` from the manifest plus the loaded parts:
- `main` = artisyn lines followed by claude lines;
- `subagents` = loaded parts only, in manifest order.

Existing props keep their types. `fetchSessionLogs` has exactly two callers, `useRepositoryData.ts:161` and `session-export-runner.ts:82`, so it is removed.

**DD-30a — Hook and context shapes.**
- `useSessionLogParts` returns `subagentLogsMap`, `agentParentMap` and `subagentMeta` with the same types as today's values in `useRepositoryData.ts:324-346`. It also returns `knownAgentIds: Set<string>` and `manifestQuery: UseQueryResult<SessionLogPartsManifest>`.
- Part loading reaches views through a new React context `SessionPartsContext` (`session-parts/SessionPartsContext.tsx`), not through props:
  - its value is `{requestAgent(id: string, withDescendants: boolean): Promise<void>; requestAll(): Promise<void>; loaded: number; total: number; allLoaded: boolean}`;
  - it is read with `useSessionParts()`;
  - `SessionDetailPane.tsx` provides it around the tab content;
  - `AgentActivationItem`, `ToolViewContext`, `SessionLogView` and `AllSessionPartsGate` consume it.

**DD-31 — Stable root totals.** `parseSessionLogs` gets the option `knownSubagentIds?: ReadonlySet<string>` (bare agent ids from the manifest). `isAgentUsagePricedElsewhere` (`session-log/log-parser.ts:317-324`) checks it before `subagentLogs`.

**DD-32 — Pricing from stats.**
- `statsToTokenBreakdown(entry)` in `log-parser.ts` replaces the three inline folds (`:977`, `:1268-1285`, `:2100`): `cacheWrite5m = entry.cacheWrite5mTokens ?? entry.cacheWriteTokens`, `cacheWrite1h = entry.cacheWrite1hTokens ?? 0`.
- `computeTurnDirectAgentCost` and `computeWorkflowCostPerToken` (both in `session-log/log-parser.ts:1606-1698`) take `subagentStats` and price an unloaded id with the helper.

**DD-33 — Views that wait for all parts.**
- `AllSessionPartsGate` wraps the tab ids `bash`, `dashboard`, `context-growth`, `context-usage`, `agent-tree`, `timeline`, `tool-heatmap`, `call-tree`, `usage` and `harness-usage`.
- The header's `bashCount` and `toolsFailure` appear only when `allLoaded`.
- Session export loads every part.
- `WorkflowAgentModal.tsx` is unchanged: `openSubAgent` awaits the parts before opening it.

### Releases and compatibility

**DD-34 — Compatibility.**
- All hook API changes are additive.
- `.claude-logs.sent` keeps its format.
- The old `/logs` route and its shape stay.
- New hook against an old server: the new params are ignored and the new fields are absent. This is matrix row 3.2.0.

### Constants and env vars

| Name | Kind | Default | Where read |
|---|---|---|---|
| `SESSION_LOGS_MAX_CONCURRENT_STREAMS` | env | 2 | `logs/streaming/log-stream-limiter.ts` |
| `REBUILD_SLOWDOWN_CPU_PERCENT` | env | 60 | `common/load-governor/rebuild-governor.ts` |
| `REBUILD_PAUSE_CPU_PERCENT` | env | 99 | same |
| `REBUILD_HARD_CAP_MS` | env | 300000 | same |
| `REBUILD_MAX_DELAY_MS` | env | 10000 | same |
| `REBUILD_LOAD_SAMPLE_MS` | env | 2000 | `common/load-governor/cpu-load-sampler.ts` |
| `CPU_LOAD_SAMPLE_WINDOW` | const | 3 | `common/load-governor/cpu-load-sampler.ts` |
| `LOG_BODY_GZ_INTERVAL_MS` | env | 15000 | `logs/log-body-gz.service.ts` |
| `WORKFLOWS_BACKFILL_INTERVAL_MS` | env | 15000 | `logs/workflows-backfill.service.ts` |
| `SESSION_REEXTRACT_INTERVAL_MS` | env | 15000 | `logs/session-reextract.service.ts` |
| `DELETED_SESSION_CLEANUP_INTERVAL_MS` | env | 60000 | `sessions/deleted-session-cleanup.service.ts` |
| `DELETED_SESSION_CLEANUP_BATCH` | const | 200 | same |
| `TOMBSTONE_MAX_DEPTH` | const | 64 | `sessions/session-tombstone.service.ts` |
| `INGEST_VERSION` | const | 1 | `logs/ingest-version.ts` |
| `WORKFLOWS_VERSION` | const | 1 | `logs/workflow-extractor.ts` |
| `FAILED_UPLOADS_MAX` | const | 20 | `logs/upload-queue.service.ts` |
| `DERIVED_LAG_MS` | const | 30000 | `logs/session-log-parts.service.ts` |
| `LOG_BODY_GZIP_LEVEL` | const | 6 | `logs/log-body-gz.service.ts` |
| `PART_LOAD_CONCURRENCY` | const (client) | 3 | `session-parts/useSessionLogParts.ts` |
| `UPLOAD_RESPONSE_READ_CAP` | const (hook) | 65536 | `upload-logs.js` |

All env vars are read with `readPositiveIntEnv` from the new `common/env-int.ts`. Percent values are clamped to 1–100.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0096_logs_streaming_skip_tombstones.sql` | Schema per Database changes | New |
| `server/drizzle/migrations/meta/_journal.json`, `meta/migrations.lock.json` | Journal entry; lock regenerated by `npm run migrations:lock` | Modify (lock: generated) |
| `server/src/database/schema/index.ts` | Drizzle columns and tables | Modify |
| `docs/knowledgebase/db_state.sql` | Regenerated by `npm run db:state` | Modify (generated) |
| `server/src/common/env-int.ts` | `readPositiveIntEnv` export | New; `tool-usage.constants.ts` imports it |
| `server/src/logs/streaming/response-stream.ts`, `log-stream-limiter.ts` | DD-2, DD-3 | New |
| `server/src/common/load-governor/{cpu-load-sampler,rebuild-pace,rebuild-governor,load-governor.module}.ts`, `rebuild-pace.algo.spec.ts` | DD-15 | New |
| `server/src/app.module.ts` | Import `LoadGovernorModule` | Modify |
| `server/src/logs/stored-workflows.ts`, `workflows-backfill.service.ts` | DD-6 | New |
| `server/src/logs/claude-extractor.ts`, `session-stats-writer.ts`, `workflow-extractor.ts` | Workflows at ingest | Modify |
| `server/src/logs/claude-derived-writer.ts` | DD-23 | New |
| `server/src/logs/session-tree-logs-meta.ts` | DD-5 | New |
| `server/src/logs/session-logs-stream.service.ts` | DD-4 legacy streamer | New |
| `server/src/logs/repositories.controller.ts` | Streaming `/logs` and delta, parts routes | Modify |
| `server/src/logs/session-logs-delta.service.ts` | DD-7, stats keys | Modify |
| `server/src/logs/log-body-gz.service.ts` | DD-10 | New |
| `server/src/logs/session-log-parts.service.ts`, `dto/session-log-parts.dto.ts` | DD-11/12/14 | New |
| `server/src/logs/ingest-version.ts`, `ingest-skip.ts`, `ingest-skip.algo.spec.ts` | DD-18/20 | New |
| `server/src/logs/logs.service.ts` | upsert, checkUnchanged, readTreeEditSha, zip import, tombstone | Modify |
| `server/src/logs/session-reextract.service.ts` | DD-22 | New |
| `server/src/logs/upload-queue.service.ts`, `upload-queue-scheduler.service.ts`, `upload-queue-stats.constants.ts`, `logs-v2.controller.ts` | DD-16/17/24/25/27 | Modify |
| `server/src/logs/logs.module.ts` | Register new providers | Modify |
| `server/src/logs/tool-monitoring/tool-usage-rebuild.service.ts`, `logs/otel/otel-projection.service.ts`, `logs/session-cost/session-cost-recompute.service.ts`, `okf/shell-figures-backfill.service.ts` | Governor admit | Modify |
| `server/src/sessions/session-tombstone.service.ts`, `deleted-session-cleanup.service.ts` | DD-27/28 | New |
| `server/src/sessions/sessions.service.ts`, `sessions.module.ts` | Lock, helper, purge, repo url, retention owner | Modify |
| `server/src/logs/session-tree.sql.ts` | Descendant filter | Modify |
| `server/src/logs/otel/otel-realtime.service.ts`, `logs/turn-end-cost-advisor/turn-end-cost-advisor.service.ts` | Tombstone checks | Modify |
| `server/src/users/account-deletion.service.ts`, `admin/admin.service.ts`, `teams/teams.service.ts` | DD-29 | Modify |
| `server/.env.example`, `release-template/.env.example` | Env docs | Modify |
| `server/perf-tests/scenarios.ts` | New read routes in `sessionReadScenarios()` | Modify |
| `client/src/viewer/api.ts` | Manifest/part types and fetchers, stats fields, remove `fetchSessionLogs` | Modify |
| `client/src/viewer/pages/repository/session-parts/{useSessionLogParts.ts,assemble-session-logs.ts,SessionPartsContext.tsx,AllSessionPartsGate.tsx}` | DD-13/30/30a/33 | New |
| `client/src/viewer/pages/repository/useRepositoryData.ts`, `session-export-runner.ts` | Use parts | Modify |
| `client/src/viewer/pages/repository/session-log/log-parser.ts` | DD-31/32 | Modify |
| `client/src/viewer/pages/repository/SessionDetailPane.tsx`, `SessionLoadBanners.tsx` | Header figures, banners | Modify / New |
| `client/src/viewer/pages/repository/SessionTabContent.tsx` | Gate wrapping | Modify |
| `client/src/viewer/pages/repository/session-log/{AgentActivationItem.tsx,SessionLogView.tsx,PromptTurnItem.tsx}`, `session-log/tool-call-view/ToolViewContext.tsx`, `summary/session-summary-derive.ts` | On-demand parts, stats pricing | Modify |
| `hook/.claude/telemetry_tool/upload-skip.js`, `__tests__/upload-skip.algo.test.js` | DD-26 | New |
| `hook/.claude/telemetry_tool/{send-logs-hook.js,upload-logs.js,tool-wrap-records.js,prompt-upload-hook.js,version.json}` | Hook changes | Modify |
| `.artisyn/marketplace/plugins/log-hub-hooks/**` | Dogfooded install refresh | Modify (generated) |
| `docs/knowledgebase/algorithms/{rebuild-load-governor,ingest-hash-skip,hook-upload-skip}.md`, `docs/algorithm-examples/{rebuild-load-governor,ingest-hash-skip,hook-upload-skip}.json` | Algorithm docs and rows | New |
| `docs/knowledgebase/{session-log-view,session-map,server-endpoint-map,db-tables,upload-queue,hook-api-versioning,hook-system-overview,data-retention}.md`, `index.md`, `algorithms/README.md` | KB updates | Modify |
| `server/test/contract/registry/{f17-sessions,f15-ingest,f18-session-delete-retention}.ts` | Contract rows | Modify |
| `tests/scenarios/**` (listed in Test coverage plan) | Scenario steps | Modify |

## API changes

**`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts?teamId=`** (new)
- Access and errors are the same as for `/logs`: `resolveSessionLogsAccess`, then 403/404, and 422 when the root claude body is NULL.
- 200 response:

```ts
interface SessionLogPart {
  sessionId: string;                 // root session id or 'agent-<id>'
  logType: 'claude' | 'artisyn' | 'claude-subagent';
  rev: string;                       // DD-8
  parentSessionId: string | null;
  agentDescription: string | null;
  workflowPhase: string | null;
  workflowRunId: string | null;
}
interface SessionLogPartsManifest {
  parts: SessionLogPart[];           // DD-5 order, bodyIsNull rows omitted
  subagentStats: Record<string, SubagentStats>;   // as /logs, incl. cacheWrite5mTokens/cacheWrite1hTokens
  rootStats: SessionRootStats | null;
  workflows: WorkflowRun[];
  turnEndAdvisor: TurnEndAdvisor | null;          // same object as /logs
  sessionAttribution: SessionAttribution;         // same object as /logs
  harnessSnapshot: HarnessSnapshot | null;
  derivedLagging: boolean;           // DD-14
}
```

**`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts/:partSessionId/:logType?teamId=&rev=`** (new)
- 200: a JSON array of log lines (DD-12). 304 when `If-None-Match` matches.
- Errors: 403/404 as for `/logs`; 404 `Session log part not found`; 400 for an invalid `logType`.

**`GET …/logs`** (changed)
- The bytes stay identical, except that every `subagentStats` entry ends with `cacheWrite5mTokens`, `cacheWrite1hTokens`.
- The response is streamed. A failure after the first byte destroys the socket.

**`GET …/logs/delta`** (changed)
- The shape is unchanged. Non-reload answers are streamed, and `subagentStats` entries get the two keys.

**`POST /api/v2/logs`** (changed, additive)
- New optional query params: `contentSha256` (DD-24) and `uploadFeedback=1` (DD-25).
- New optional response fields `failedUploads` and `sessionDeleted`, only when `uploadFeedback=1` was sent.
- A tombstoned session gets 201 `{complete:true, …}` with nothing staged.

**`POST /api/v2/otel-realtime`, `POST /api/v2/turn-end-cost-advisor`**: unchanged shapes. A tombstoned session is ignored (DD-27).

## Database changes

Migration `0096_logs_streaming_skip_tombstones.sql`:
- It has no `--> statement-breakpoint`. The file runs as one multi-statement query in one transaction, like the existing files with `DO $$ … $$` blocks (e.g. `0072`), so the plpgsql `$$` body is safe.
- It is additive: new columns are nullable without a default (except `failure_delivered`), there is no rewrite, and there is no `CONCURRENTLY`.
- It adds `COMMENT ON` for every new table, column, function and trigger.

| Table | Change |
|---|---|
| `logs` | `body_rev bigint`, `body_sha256 varchar(64)`, `ingest_version smallint`, `body_received_at timestamptz`, `body_gz bytea` + `ALTER COLUMN body_gz SET STORAGE EXTERNAL`, `body_gz_rev bigint`, `edit_records_sha256 varchar(64)`, `stats_edit_sha256 varchar(64)` |
| `logs` | `CREATE SEQUENCE logs_body_rev_seq`; function and trigger per DD-8 |
| `logs` | `CREATE INDEX idx_logs_body_gz_pending ON logs (id) WHERE log_type IN ('artisyn','claude','claude-subagent') AND body IS NOT NULL AND (body_rev IS NULL OR body_gz_rev IS DISTINCT FROM body_rev)` |
| `upload_queue` | `content_sha256 varchar(64)`, `failure_delivered boolean NOT NULL DEFAULT false` (constant default: no rewrite) |
| `upload_queue_measurements` | comment on `outcome` updated to `success | failure | skipped | superseded` (no type change) |
| `session_stats` | `workflows jsonb`, `workflows_version smallint`; `CREATE INDEX idx_session_stats_workflows_pending ON session_stats (session_id) WHERE workflows_version IS NULL` |
| `deleted_session_log` | `repository_url varchar(2048)`; indexes `idx_deleted_session_log_session_id (session_id)`, `idx_deleted_session_log_owner (owner_user_id)`, `idx_deleted_session_log_repo_url (repository_url)` |
| new `session_reextract_queue` | `session_pk integer PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE`, `requested_at timestamptz NOT NULL DEFAULT now()` |

Steps:
1. Apply the migration to the dev DB.
2. Run `npm run db:state`, then `npm run migrations:lock` (from `server/`).
3. `db_state.sql` dumps neither functions nor triggers, so document the trigger in `docs/knowledgebase/db-tables.md`.

There is no SQL data backfill: workflows, gzip copies, legacy revisions and survivor cleanup converge through DD-6, DD-10 and DD-28.

## Test coverage plan

Per CLAUDE.md, only the three allowed kinds are used.

**Algorithm** (each is a new doc + rows file + table test):
- `rebuild-load-governor`: `docs/knowledgebase/algorithms/rebuild-load-governor.md`, `docs/algorithm-examples/rebuild-load-governor.json`, `server/src/common/load-governor/rebuild-pace.algo.spec.ts`. Rows cover every `decideRebuildPace` branch: below slowdown, slope midpoint and edge, pause start, pause within cap, drain after cap, return below slowdown.
- `ingest-hash-skip`: `…/ingest-hash-skip.md`, `…/ingest-hash-skip.json`, `server/src/logs/ingest-skip.algo.spec.ts`. Rows: all equal → skip; each mismatching field → process; no stored row → process; `artisyn` / `claude-otel` → process; `tool-calls` ignores the edit sha.
- `hook-upload-skip`: `…/hook-upload-skip.md`, `…/hook-upload-skip.json`, `hook/.claude/telemetry_tool/__tests__/upload-skip.algo.test.js`. Rows cover `decideUploadSkip` (adopt, mtime change, params change, size disagreement, `fp` change, current artisyn) and `canResumePending` (equal, sha differs, legacy entry without sha).

**API contract:**
- `server/test/contract/registry/f17-sessions.ts`:
  - parts manifest: owner 200 with parts order, foreign 403;
  - part body: root claude 200 equals `body::text`, 304 on a matching `If-None-Match`, outside the tree 404, bad `logType` 400;
  - the `/logs` and delta rows updated for the two `subagentStats` keys.
- `f15-ingest.ts`: a tombstoned session with `uploadFeedback=1` → 201 `sessionDeleted:true`, nothing staged; a valid `contentSha256` accepted.
- `f18-session-delete-retention.ts`: after delete, the DD-28 survivor tables hold no rows of the session.

**Scenario** (steps in existing scenarios):
- `view/s-sess-03.spec.ts`:
  - open requests only the manifest and the root parts;
  - a part answers gzip after the builder ran;
  - a foreign repo gives 4xx;
  - legacy `/logs` is unchanged;
  - the delta full snapshot equals `/logs` lines;
  - FR-4: only the changed part refetches;
  - `derivedLagging` and the notice appear for an aged `session_reextract_queue` row, then clear after the drain.
- `view/s-sess-04.spec.ts`: a nested agent part loads on expand; Bash shows "Loading session logs" and then content.
- `ingest/s-ingest-02.spec.ts`:
  - an identical re-upload keeps `updated_at` and `session_stats`, also on the upload right after a re-processed identical body, so the trigger kept the hash;
  - an older row does not overwrite a newer one;
  - a burst is coalesced with `superseded` measurements;
  - an `artisyn` upload with new edit records re-extracts transcript line counts;
  - nulling `workflows_version` / `body_gz` is repaired by the backfill and gzip drains.
- `ingest/s-ingest-04.spec.ts`: a same-length changed body with a stale `contentSha256` becomes `content-hash-mismatch`; the next upload with `uploadFeedback=1` returns it in `failedUploads` once.
- `hook/s-hook-01.spec.ts`: v2 manifest written; mtime change → sent; late `.meta.json` → sent; `failedUploads` from the fake Log Hub → re-send.
- `hook/s-hook-09.spec.ts`: unchanged → not sent; current artisyn always sent; a SessionEnd-recorded transcript is not re-sent on the next Stop.
- `hook/s-compat-01.spec.ts`: the frozen old hook against the new server is unchanged.
- `sessions/s-slife-07.spec.ts`:
  - after a tree delete, a late sub-agent, an OTEL chunk, realtime OTEL, `tool-calls` and the advisor succeed and write nothing; no survivor rows remain;
  - a seeded live child of a deleted root is soft-deleted by the cleanup drain;
  - fresh start after account deletion, after admin repo removal and after team repo removal.
- `sessions/s-slife-08.spec.ts`: a retention-purged session's re-upload is not re-created.
- `repos/s-repo-11.spec.ts`: zip import re-extracts sub-agent stats and leaves `body_sha256` NULL.
- `repos/s-repo-17.spec.ts`: a same-size `tool-calls` change is re-sent.
- Perf: the new routes are added to `sessionReadScenarios()` (p95 regression ≤ 20 %).

## Visual/UX notes

- **Loading indicator.** "Loading session logs {n} of {m}" uses the progress markup of `SessionExportProgressModal.tsx:37-46` (`N / M` text, `h-2 bg-muted` track, `bg-primary` bar), centred in the tab area with `max-w-md`.
- **Root load.** While the root parts load, the existing pane skeleton shows. An agent expanded in the Logs tab shows "Loading agent log…" with `Loader2` until its part arrives.
- **Derived-lag notice.** When `derivedLagging` is true, a muted amber one-line notice sits under the header: "Some figures may lag behind the latest upload — the server is busy; this can take a couple of minutes." It is not dismissible.
- **Badges.** The Bash tab count badge and the MCP failure marker are hidden until all parts are loaded.
- **Pane size.** The banners move to the new `SessionLoadBanners.tsx`, so `SessionDetailPane.tsx` (already 12.4 KB) does not grow.

## Post-implementation verification (not a chunk)

The `adlc-lh:workcycle` final step runs this on the Pi stand named in the requirements. It is a check against fixed pass criteria, not discovery.

Open session `c0d1de05` (repo 77) on the build before and after the change, and record the numbers in `notes.md`. Pass criteria:
- no worker is OOM-killed;
- the worker's RSS growth during the open is ≤ 3 × the largest single log row text plus 64 MB;
- the time to a rendered Logs tab is ≤ 10 s;
- the bytes for all parts together are ≤ 12 MB;
- under load, five uploads in a row produce one processed row plus `superseded` measurements, and the derived data converges within `REBUILD_HARD_CAP_MS` plus one rebuild.

## Implementation Chunks

Server chunks are ordered by dependency with FR-3 (chunk 4) as early as possible, per the requirement that FR-3 lands first. The parts API (chunk 6) precedes the ingest chunks (7–10) because it depends only on chunks 1–5.

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Schema migration | 5 | First |
| 2 | Server primitives: streaming, limiter, governor | 6 | Independent of 1 at runtime |
| 3 | Stored workflows and extraction refactor | 5 | Needs 1, 2 |
| 4 | FR-3 streaming of `/logs` and `/logs/delta` | 6 | Needs 2, 3 |
| 5 | Governed background drains and gzip builder | 5 | Needs 1, 2 |
| 6 | Parts API | 5 | Needs 4, 5 |
| 7 | Ingest hash skip, ordering guard, edit sha | 8 | Needs 1, 3 |
| 8 | Upload queue: coalescing, content hash, feedback, re-extract | 6 | Needs 7 |
| 9 | Tombstone on every ingest path (services) | 5 | Needs 7 |
| 10 | Hook ingest API (`logs-v2.controller.ts`) | 4 | Needs 8, 9 |
| 11 | Delete helpers, purge, cleanup, fresh start | 7 | Needs 9 |
| 12 | Client parts loader | 6 | Needs 6 |
| 13 | Client views on parts | 8 | Needs 12 |
| 14 | Hook manifest v2, skip rule, scoped paths | 6 | Server-independent; after frontend only by convention |
| 15 | Hook upload integrity, feedback, release | 7 | Needs 14; server 8–10 |
| 16 | Tests: contract and perf | 6 | Needs 1–11 |
| 17 | Tests: read-path and ingest scenarios | 7 | Needs 1–13 |
| 18 | Tests: hook and delete scenarios, full run | 7 | Needs all |

### Chunk 1 — Schema migration
- [ ] Create `server/drizzle/migrations/0096_logs_streaming_skip_tombstones.sql` with no statement breakpoints, containing the `logs` columns, `SET STORAGE EXTERNAL`, the sequence, the `logs_body_guard()` function and trigger (DD-8), and `idx_logs_body_gz_pending`, per Database changes.
- [ ] In the same file add the `upload_queue`, `upload_queue_measurements` comment, `session_stats` and `deleted_session_log` changes, the `session_reextract_queue` table, and `COMMENT ON` for everything new, per Database changes.
- [ ] Add the journal entry in `meta/_journal.json`; mirror every new column, index and the `sessionReextractQueue` table in `server/src/database/schema/index.ts`.
- [ ] Apply it to the dev DB, then run `npm run db:state` and `npm run migrations:lock` from `server/` (skills `db-state-update`, `migrations-data-integrity`).
- [ ] Update `docs/knowledgebase/db-tables.md`: document the new `logs` columns, the `logs_body_guard` trigger and sequence, `session_reextract_queue`, the `deleted_session_log` column and indexes, and the new measurement outcomes.

### Chunk 2 — Server primitives: streaming, limiter, governor
- [ ] Create `server/src/common/env-int.ts` exporting `readPositiveIntEnv(name, fallback)`, moved from `logs/tool-monitoring/tool-usage.constants.ts:23-26`, which then imports it.
- [ ] Create `server/src/logs/streaming/response-stream.ts` and `log-stream-limiter.ts` per DD-2 and DD-3; provide `LogStreamLimiter` in `logs.module.ts`.
- [ ] Create `server/src/common/load-governor/cpu-load-sampler.ts` and the pure `rebuild-pace.ts` per DD-15 and the `research/load-governor.md` table.
- [ ] Create `rebuild-governor.ts` and the global `load-governor.module.ts` per DD-15; import the module in `server/src/app.module.ts`; read the env vars per the Constants table.
- [ ] Write `docs/knowledgebase/algorithms/rebuild-load-governor.md` (OKF `type: "Algorithm"`), `docs/algorithm-examples/rebuild-load-governor.json` (rows per Test coverage plan) and `rebuild-pace.algo.spec.ts` using `loadExamples`.
- [ ] Document the env vars from the Constants table in `server/.env.example` and `release-template/.env.example` in each file's format; list the new algorithm doc in `docs/knowledgebase/algorithms/README.md` and `docs/knowledgebase/index.md`.

### Chunk 3 — Stored workflows and extraction refactor
- [ ] Add `WORKFLOWS_VERSION` to `logs/workflow-extractor.ts`; make `extractClaudeStats` return `workflows` per DD-6; make `session-stats-writer.ts` write `workflows` and `workflows_version`.
- [ ] Create `server/src/logs/stored-workflows.ts` with `readStoredWorkflows` per DD-6.
- [ ] Create `server/src/logs/claude-derived-writer.ts` with `writeClaudeDerived` (DD-23) by moving `logs.service.ts:465-544` unchanged; `upsert` calls it.
- [ ] In `writeImportedLog` (`logs.service.ts:1088-1249`), call `writeClaudeDerived` for `claude` and `claude-subagent` whenever the body was written, and set `body_received_at = now()`.
- [ ] Create `server/src/logs/workflows-backfill.service.ts`: it claims `session_stats` with `workflows_version IS NULL` whose session has a root `claude` log (`SKIP LOCKED`, one at a time, `RebuildGovernor.admit()`), reads one body, extracts and writes the workflows, and starts per DD-14a with `WORKFLOWS_BACKFILL_INTERVAL_MS`. Register it in `logs.module.ts`.

### Chunk 4 — FR-3 streaming of `/logs` and `/logs/delta`
- [ ] Create `server/src/logs/session-tree-logs-meta.ts` with `readTreeLogsMeta` and the `TreeLogRowMeta` type exactly per DD-5.
- [ ] Create `server/src/logs/session-logs-stream.service.ts` with `writeLegacyLogs(res, rows: TreeLogRowMeta[], tailJson: string)`, which streams per DD-1, DD-2 and DD-4.
- [ ] Rewrite `getSessionLogs` (`repositories.controller.ts:1728-2053`): access and metadata (`readTreeLogsMeta`, stats, `readStoredWorkflows` with the DD-6 fallback, advisor, attribution, harness); 404/422 before any byte; `LogStreamLimiter.acquire`; `writeLegacyLogs`; `abortStream` on a later failure.
- [ ] Append `cacheWrite5mTokens` and `cacheWrite1hTokens` from `session_stats` as the last keys of `selectSubagentStats` (`session-logs-delta.service.ts:38-103`) and of the `/logs` `subagentStats` mapping.
- [ ] In `session-logs-delta.service.ts`, split `readSlices` into `readSliceMeta` and `readSliceText`, and switch `readWorkflows` to `readStoredWorkflows`, per DD-7.
- [ ] Change `getSessionLogsDelta` (`repositories.controller.ts:1703-1726`) to `@Res()` streaming per DD-7 with the limiter; update `docs/knowledgebase/session-log-view.md` and `session-map.md` for streaming and the stats keys.

### Chunk 5 — Governed background drains and gzip builder
- [ ] Create `server/src/logs/log-body-gz.service.ts` (`LogBodyGzService`) per DD-10 with `LOG_BODY_GZIP_LEVEL` and `LOG_BODY_GZ_INTERVAL_MS`; register it in `logs.module.ts`.
- [ ] Call `LogBodyGzService.notify()` after the `upsert` commit and after the `importSession` commit; start the service per DD-14a.
- [ ] Call `RebuildGovernor.admit()` before each unit of work in `ToolUsageRebuildService`, `OtelProjectionService`, `SessionCostRecomputeService` and `ShellFiguresBackfillService`.
- [ ] In the upload-queue tick (`upload-queue-scheduler.service.ts:290-321`), call `admit()` before each claim and `reportIdle()` when nothing was claimed.
- [ ] Add a "Background rebuilds under load" section to `docs/knowledgebase/upload-queue.md` covering the governor, its env vars, and the drains it covers.

### Chunk 6 — Parts API
- [ ] Create `server/src/logs/dto/session-log-parts.dto.ts` with `SessionLogPart` and `SessionLogPartsManifest` exactly as in API changes.
- [ ] Create `server/src/logs/session-log-parts.service.ts` with `buildManifest(rootRowId, meta: TreeLogRowMeta[], extras: Omit<SessionLogPartsManifest, 'parts' | 'derivedLagging'>)` (parts per DD-11, rev per DD-8, `derivedLagging` per DD-14) and `streamPart(req, res, meta: TreeLogRowMeta)` per DD-12.
- [ ] Add `GET :repoId/sessions/:sessionId/logs/parts` to `repositories.controller.ts`; reuse the chunk 4 metadata gathering (stats, workflows, advisor, attribution, harness) through a shared private method.
- [ ] Add `GET :repoId/sessions/:sessionId/logs/parts/:partSessionId/:logType`: `resolveSessionLogsAccess`, the `logType` 400 check, the row lookup in `readTreeLogsMeta` (404), then the 304 check, the limiter, and `streamPart`. Mirror the headers of `common/precompressed-static.ts:211-244`.
- [ ] Update `docs/knowledgebase/server-endpoint-map.md` (two routes) and `session-log-view.md` (parts contract, rev, gzip and identity fallback, 304, `derivedLagging`).

### Chunk 7 — Ingest hash skip, ordering guard, edit sha
- [ ] Create `server/src/logs/ingest-version.ts` (`INGEST_VERSION`, `UpsertIngestMeta`) and the pure `ingest-skip.ts` (`decideIngestSkip`) per DD-18 and DD-20.
- [ ] Write `docs/knowledgebase/algorithms/ingest-hash-skip.md`, `docs/algorithm-examples/ingest-hash-skip.json` and `server/src/logs/ingest-skip.algo.spec.ts`; list the doc in the algorithms README and the KB index.
- [ ] Add `readTreeEditSha(tx, sessionRowId)` per DD-21 to `logs.service.ts`, next to `loadSessionTreeEditRecords`.
- [ ] Add `LogsService.checkUnchanged` per DD-20, reusing today's deleted check (chunk 9 swaps it for the tombstone).
- [ ] Add the `ingest?: UpsertIngestMeta` argument and the `'superseded'` result to `upsert` (DD-18). In Step 2 (`logs.service.ts:430-463`), write `body_sha256`, `ingest_version`, `body_received_at` and `stats_edit_sha256` (`artisyn`: also `edit_records_sha256`) in the body statement, with the DD-19 guard.
- [ ] Implement the DD-19 superseded branches in `upsert`; for `artisyn`, read the previous `edit_records_sha256` before Step 2 and upsert `session_reextract_queue` when it changed (DD-22).
- [ ] Widen `UploadQueueMeasurementOutcome` (`upload-queue-stats.constants.ts:44`) per DD-17.
- [ ] In `processRow` (`upload-queue-scheduler.service.ts:350-513`), compute `bodySha256`, call `checkUnchanged` (`skip` → delete the row, measurement `skipped`), otherwise parse and pass `{bodySha256, receivedAt: row.receivedAt}` to `upsert`.

### Chunk 8 — Upload queue: coalescing, content hash, feedback, re-extract
- [ ] Change `claimNextPendingRow` (`upload-queue-scheduler.service.ts:329-348`) to coalesce per DD-16; add `deleteSupersededRows(row)` to `upload-queue.service.ts`, called after a whole-file row succeeds.
- [ ] Add the optional `contentSha256` parameter to `saveRawUpload` and `saveChunk` (chunk 0) per DD-24, writing `upload_queue.content_sha256`; in `processRow`, fail the row with `content-hash-mismatch` before `checkUnchanged`.
- [ ] Add `FAILED_UPLOADS_MAX` and `takeFailedUploadsForFeedback(userId): Promise<{sessionId: string; type: string}[]>` per DD-25 to `upload-queue.service.ts`.
- [ ] Create `server/src/logs/session-reextract.service.ts` per DD-22, started per DD-14a with `SESSION_REEXTRACT_INTERVAL_MS`; register it in `logs.module.ts`.
- [ ] Call `SessionReextractService.notify()` from `upsert` after commit when the `artisyn` path enqueued.
- [ ] Update `docs/knowledgebase/upload-queue.md`: hash skip, ordering guard, coalescing, `skipped` / `superseded`, content hash, failure feedback, re-extract.

### Chunk 9 — Tombstone on every ingest path (services)
- [ ] Create `server/src/sessions/session-tombstone.service.ts` with `isTombstoned` per DD-27 and `TOMBSTONE_MAX_DEPTH`; export it from `sessions.module.ts` and import that module in `logs.module.ts`.
- [ ] In `processRow`, check the tombstone before parsing. In `upsert` and `checkUnchanged`, replace the check at `logs.service.ts:297-308` with `isTombstoned` inside the transaction after the tree lock.
- [ ] Add the tombstone check inside the `ingestOtelChunk` transaction and in `importSession` (`logs.service.ts:967-1081`), skipping the write on a hit.
- [ ] Add the tombstone check in `otel-realtime.service.ts` (existing `{ignored:'deleted'}` answer) and in `turn-end-cost-advisor.service.ts` `recordRun` (skip the insert).
- [ ] In `deleteSession` (`sessions.service.ts:85-171`), take `lockSessionTreeForIngest` for the root before marking deleted.

### Chunk 10 — Hook ingest API (`logs-v2.controller.ts`)
- [ ] Read `contentSha256` on single upload and chunk 0 (64 lowercase hex, otherwise ignored) and pass it to `saveRawUpload` / `saveChunk` (DD-24).
- [ ] Check `SessionTombstoneService.isTombstoned(sessionId, parentSessionId)` on single upload and chunk 0. On a hit, answer like the foreign-session path (`:132-145`, `:235-240`), 201 `complete:true`, nothing staged.
- [ ] When the query has `uploadFeedback=1`, add `failedUploads` (`takeFailedUploadsForFeedback`) to the single-upload, chunk-complete and tombstone answers, and `sessionDeleted: true` to the tombstone answer (DD-25).
- [ ] Update `docs/knowledgebase/server-endpoint-map.md` hook-route compatibility for the two params and fields.

### Chunk 11 — Delete helpers, purge, cleanup, fresh start
- [ ] Extract `markSessionTreeDeleted` per DD-28 from `deleteSession` (`sessions.service.ts:128-163`), writing `repository_url` per DD-29; `deleteSession` uses it.
- [ ] Extend `purgeSessionChildData` (`sessions.service.ts:189-295`) with the DD-28 survivor tables; make `findSessionOwnerId` with `includeDeleted` (`logs.service.ts:124-156`) fall back to `deleted_session_log.owner_user_id`.
- [ ] Add the descendant `deleted = false` filter to `descendantSessionsCte` (`logs/session-tree.sql.ts:36-46`).
- [ ] In `hardPurgeExpiredSessions` (`sessions.service.ts:388-534`), write `owner_user_id` and `repository_url` per DD-29.
- [ ] Apply DD-29 clearing in `users/account-deletion.service.ts` (by owner) and in `admin/admin.service.ts` `removeRepo` and `teams/teams.service.ts` `removeTeamRepository` (by `repository_url`).
- [ ] Create `server/src/sessions/deleted-session-cleanup.service.ts` per DD-28 with `DELETED_SESSION_CLEANUP_INTERVAL_MS` and `DELETED_SESSION_CLEANUP_BATCH`; register it in `sessions.module.ts`.
- [ ] Update `docs/knowledgebase/db-tables.md` §soft delete and `data-retention.md` §purge: survivors are purged, the tombstone rule, fresh start, and the pre-migration rows limitation.

### Chunk 12 — Client parts loader
- [ ] In `client/src/viewer/api.ts` add the `SessionLogPart` and `SessionLogPartsManifest` types (API changes), `fetchSessionLogParts(repoId, sessionId, teamId?)`, `fetchSessionLogPart(repoId, sessionId, part, teamId?)`, and `cacheWrite5mTokens?` / `cacheWrite1hTokens?` on `SubagentStats`.
- [ ] Create `pages/repository/session-parts/assemble-session-logs.ts` per DD-30.
- [ ] Create `pages/repository/session-parts/SessionPartsContext.tsx` (context, provider and `useSessionParts()`) with the value shape of DD-30a.
- [ ] Create `pages/repository/session-parts/useSessionLogParts.ts` per DD-13 and DD-30a, with `PART_LOAD_CONCURRENCY`. It returns `{manifestQuery, logsData, subagentLogsMap, agentParentMap, subagentMeta, knownAgentIds, requestAgent(id, withDescendants): Promise<void>, requestAll(): Promise<void>, loaded, total, allLoaded}`.
- [ ] In `useRepositoryData.ts`, replace the query (159-163) and the map building (324-358) with `useSessionLogParts`; return `manifestQuery` as `logsQuery` so the watermark logic (170-268) keeps working; pass `knownAgentIds` into `parseSessionLogs`; also return `requestAgent`, `requestAll` and the progress fields.
- [ ] Rewrite `session-export-runner.ts:82-128` to load the manifest and all parts with the new fetchers and `assemble-session-logs`; delete `fetchSessionLogs` from `api.ts`.

### Chunk 13 — Client views on parts
- [ ] In `session-log/log-parser.ts`, add the `knownSubagentIds` option (DD-31) and `statsToTokenBreakdown` replacing the three folds (DD-32).
- [ ] Give `computeTurnDirectAgentCost` and `computeWorkflowCostPerToken` a `subagentStats` parameter per DD-32; pass it from `PromptTurnItem.tsx`, `SessionLogView.tsx:166-176` and `summary/session-summary-derive.ts`.
- [ ] Create `session-parts/AllSessionPartsGate.tsx` (`requestAll()` on mount, progress per Visual/UX notes, children once `allLoaded`); wrap the DD-33 tab ids in `SessionTabContent.tsx:126-286`.
- [ ] In `AgentActivationItem.tsx:51-55`, parse only when open, and call `requestAgent(agentId, true)` on open with the "Loading agent log…" placeholder.
- [ ] In `ToolViewContext.tsx:76-96`, `openSubAgent` awaits `requestAgent(id, true)`; in `SessionLogView.tsx:113-128`, the `tu` deep link awaits `requestAll()` first.
- [ ] Create `SessionLoadBanners.tsx` with the root-loading banner moved from `SessionDetailPane.tsx:268-273` and the `derivedLagging` notice per Visual/UX notes; render it in `SessionDetailPane.tsx`, which also wraps the tab content in the `SessionPartsContext` provider (DD-30a).
- [ ] In `SessionDetailPane.tsx:134-160`, compute `usage` from `main` only, and compute `bashCount` and `toolsFailure` only when `allLoaded` (DD-33).
- [ ] Update `docs/knowledgebase/session-log-view.md` client section: parts hook, gate, on-demand agents, pricing from stats.

### Chunk 14 — Hook manifest v2, skip rule, scoped paths
- [ ] Create `hook/.claude/telemetry_tool/upload-skip.js` exporting `decideUploadSkip`, `canResumePending`, `paramsSha256(params)`, `readManifestV2` and `writeManifestV2` (tmp + rename) per DD-26.
- [ ] Write `docs/knowledgebase/algorithms/hook-upload-skip.md`, `docs/algorithm-examples/hook-upload-skip.json` and `__tests__/upload-skip.algo.test.js` (`loadExamples`); list the doc in the algorithms README and the KB index.
- [ ] In `tool-wrap-records.js` add `toolCallsFingerprint()` per DD-26, keeping `toolCallsSourceSize` (`:426-449`) for the old manifest.
- [ ] In `send-logs-hook.js`:
  - read the v2 manifest next to the old one (`:1565`);
  - replace the skip test (`:2188-2209`) with `decideUploadSkip`;
  - record the read size and pre-read mtime;
  - write both manifests in the same flush (`:2315-2353`, `:2452-2464`), pruning v2 like v1.
- [ ] Apply the DD-26 scoped-path recording in `prompt-upload-hook.js` and `runSessionEndFlush` (`send-logs-hook.js:1495-1545`).
- [ ] Update `docs/knowledgebase/hook-system-overview.md` §Upload pipeline: v2 manifest, skip rule, scoped-path recording.

### Chunk 15 — Hook upload integrity, feedback, release
- [ ] In `upload-logs.js` add `sha256` to each `.claude-logs.pending` entry (`:704-800`); resume only via `canResumePending` (`:885-891`), else restart with a new `uploadId`.
- [ ] In `uploadFile` (`upload-logs.js:466-503`), send `contentSha256` (sha256 of the uncompressed body) on single uploads and chunk 0, and `uploadFeedback=1` on every request.
- [ ] Raise the response read cap in `uploadFile` (`:552-589`) to `UPLOAD_RESPONSE_READ_CAP`; parse `failedUploads` and `sessionDeleted` fail-open; surface them from the chunked final response (`:973-990`).
- [ ] In `send-logs-hook.js`, delete each `failedUploads` entry's manifest key (built from `type` and `sessionId` as the scan builds keys) from both manifests, and write `sessionDeleted` to `hook.log` without retrying.
- [ ] Bump `version.json` to `3.2.0`; add the matrix row (l.64-77), the behaviour-history row (l.844-872) and the `uploadFeedback` / `contentSha256` sections to `docs/knowledgebase/hook-api-versioning.md`.
- [ ] Run `npm run build:hooks-installer` and refresh `.artisyn/marketplace/plugins/log-hub-hooks/` per `.claude/rules/hook.md`.
- [ ] Run the `update-install-instructions` skill.

### Chunk 16 — Tests: contract and perf
- [ ] Add the `F17-session-log-parts` rows to `server/test/contract/registry/f17-sessions.ts`: owner 200 with the manifest shape and parts order, foreign actor 403, and 422 for a root claude log with a NULL body (same fixture as the existing `/logs` 422 row).
- [ ] Add the `F17-session-log-part-body` rows: root claude 200 equal to `body::text`, 304 with a matching `If-None-Match`, outside the tree 404, bad `logType` 400.
- [ ] Update the existing `/logs` and `F17-session-logs-delta` rows for the two new `subagentStats` keys.
- [ ] Add `f15-ingest.ts` rows (tombstoned upload with `uploadFeedback=1` → `sessionDeleted:true`, nothing staged; valid `contentSha256` accepted) and an `f18-session-delete-retention.ts` row (no survivor rows after delete).
- [ ] Add the manifest and part-body routes to `sessionReadScenarios()` in `server/perf-tests/scenarios.ts`.
- [ ] Run `npm run perf` (from `server/`, per `.claude/rules/server.md`) before and after the change; p95 of `repos:session-logs-heavy` and the new routes must not regress more than 20 %. Record the numbers in `notes.md`.

### Chunk 17 — Tests: read-path and ingest scenarios
- [ ] `tests/scenarios/view/s-sess-03.spec.ts`: on open only the manifest and root parts are requested (`page.on('request')`); a part answers `content-encoding: gzip`; a foreign repo gives 4xx; legacy `/logs` is unchanged; the delta full snapshot lines equal the `/logs` lines.
- [ ] Same scenario: the FR-4 step (one upload of a loaded sub-agent refetches only that part) and the `derivedLagging` step (insert an aged `session_reextract_queue` row; the notice shows, then clears after the drain).
- [ ] `tests/scenarios/view/s-sess-04.spec.ts`: expanding a nested agent requests its part; the Bash tab shows "Loading session logs" and then the calls.
- [ ] `tests/scenarios/ingest/s-ingest-02.spec.ts`: an identical re-upload keeps `logs.updated_at` and `session_stats`; an older queued row does not overwrite a newer body; three quick uploads yield one processed row plus `superseded` measurements.
- [ ] Same scenario: an `artisyn` upload adding `edit_result` records updates the transcript's line counts through the re-extract drain.
- [ ] Same scenario: after SQL sets `session_stats.workflows_version`, `logs.body_gz`, `body_gz_rev` and `body_rev` to NULL (legacy shape), the backfill and gzip drains restore the workflows, a `body_rev` and a valid gzip copy within their intervals.
- [ ] `tests/scenarios/ingest/s-ingest-04.spec.ts`: a same-length changed body with a stale `contentSha256` ends `content-hash-mismatch`, and the next upload with `uploadFeedback=1` returns it in `failedUploads` exactly once.

### Chunk 18 — Tests: hook and delete scenarios, full run
- [ ] `tests/scenarios/hook/s-hook-01.spec.ts`: the v2 manifest is written; an mtime change → sent; a `.meta.json` added later → sent; `failedUploads` from `startFakeLogHub` drops the entry and causes a re-send.
- [ ] `tests/scenarios/hook/s-hook-09.spec.ts`: an unchanged transcript is not re-sent; the current artisyn is always sent; a SessionEnd-recorded transcript is not re-sent on the next Stop. `s-compat-01.spec.ts`: the frozen old hook works unchanged.
- [ ] `tests/scenarios/sessions/s-slife-07.spec.ts`: after a tree delete, a late sub-agent, an OTEL chunk, realtime OTEL, `tool-calls` and an advisor post succeed and write nothing, and no survivor rows remain.
- [ ] Same scenario: a seeded live child of a deleted root is soft-deleted by the cleanup drain; after account deletion, after admin repo removal and after team repo removal, the same session id is accepted again.
- [ ] `tests/scenarios/sessions/s-slife-08.spec.ts`: a retention-purged session's re-upload does not re-create it.
- [ ] `tests/scenarios/repos/s-repo-11.spec.ts`: zip import re-extracts sub-agent stats with `body_sha256` NULL. `s-repo-17.spec.ts`: a same-size `tool-calls` change is re-sent.
- [ ] Run the full set with `adlc-lh:check-health` `finalRun: true` (fast set plus `contract`, `scenarios-a..d`, `e2e-fast`, `e2e-full`) and fix any failures.
