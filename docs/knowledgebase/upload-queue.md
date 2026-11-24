---
type: "Architecture Guide"
title: "Upload Queue (async log ingest, chunked upload, worker stats)"
description: "How POST /api/v2/logs stages uploads and a cluster-safe scheduler ingests them: queue lifecycle and statuses, chunked upload and reassembly, malformed-line tolerance, coalescing, hash skip, ordering guard, content hash, failure feedback and transcript re-extraction, append rows (POST /api/v2/logs/append, start_line, upload-full), the admin Upload Queue tab and its worker statistics, and the hook-side upload order and unchanged-file skip."
tags:
  - server
  - hooks
  - upload
generated: { by: "claude-code", at: "2026-11-24T20:00:00+04:00" }
---

# Upload Queue

This is also the house pattern for **any** background job: a queue table every cluster worker
claims with `FOR UPDATE SKIP LOCKED`, a lease that returns lapsed `processing` rows to `pending`,
and transient-error retry (steps 3, 5 and 6 below) — copy it instead of inventing a new scheduler.

Every log upload from the hook goes through one asynchronous pipeline: `POST /api/v2/logs` stages
the raw body and answers at once, and a background scheduler parses and ingests it later. Nothing is
parsed on the request path. Column-level detail lives in
[db-tables.md](db-tables.md#upload_queue) and
[db-tables.md](db-tables.md#upload_queue_measurements); the hook ↔ route compatibility contract is in
[hook-api-versioning.md](hook-api-versioning.md).

| Piece | File |
|---|---|
| Route | `server/src/logs/logs-v2.controller.ts` |
| Staging and chunk assembly | `server/src/logs/upload-queue.service.ts` (`UploadQueueService`) |
| Worker | `server/src/logs/upload-queue-scheduler.service.ts` (`UploadQueueSchedulerService`) |
| Tolerant NDJSON parse | `server/src/logs/ndjson-parser.ts` (`parseNdjsonLinesTolerant`) |
| Stats config | `server/src/logs/upload-queue-stats.constants.ts` |
| Admin API | `server/src/admin/admin-panel.controller.ts` (`upload-queue*` routes), `server/src/admin/upload-queue-stats.service.ts` |
| Admin UI | `client/src/viewer/pages/admin/tabs/AdminUploadQueueTab.tsx`, `UploadQueueStatsPanel.tsx` |
| Hook uploader | `hook/.claude/telemetry_tool/upload-logs.js`, `hook/.claude/telemetry_tool/send-logs-hook.js` |

**`part-cache/` is not staging.** By default the session-log part cache lives in
`<UPLOAD_QUEUE_DIR>/part-cache/` ([session-part-cache.md](session-part-cache.md)). No staging
scanner touches it: every one matches `<uploadId>.chunk*` or a session / upload id prefix, or
unlinks named files, and the admin disk-usage figure sizes only `logs/`. A new scanner over
`UPLOAD_QUEUE_DIR` must skip that folder too.

## Queue lifecycle

1. **Stage.** `saveRawUpload()` writes the body to `<UPLOAD_QUEUE_DIR>/<epochMs>-<uuid>.raw`
   (`UPLOAD_QUEUE_DIR` defaults to `upload-queue`, resolved against the process CWD and created
   lazily) and inserts a `pending` `upload_queue` row. The epoch prefix keeps files in received
   order; the UUID keeps them unique within one millisecond. A staging write failure is logged and
   answered with `500`, and no row is inserted.
2. **Answer.** The `201` response carries `{ warnings: string[] }` — one message per `failed` row of
   the calling user, plus each `rejected_foreign_session` row exactly once
   (`getPendingWarnings`). The hook turns a non-empty list into its `broken-upload-file`
   recommendation.
3. **Claim.** Every `UPLOAD_QUEUE_INTERVAL_MS` (default 1s) each cluster worker runs `tick()`. It
   claims the oldest `pending` row with `SELECT … FOR UPDATE SKIP LOCKED` and an `UPDATE` in one
   transaction, which is cluster-safe without any instance-index gating (whole-file types claim
   the newest row of the same key instead — see "Skip, ordering, coalescing and integrity"; an
   append row waits for the older rows of its key — see "Append rows"). A tick keeps claiming rows until the
   queue is empty or `UPLOAD_QUEUE_TICK_BUDGET_MS` (default 500ms, `0` allowed) has passed, and
   always processes at least one row, so a burst of small `claude-otel` chunks drains in one tick.
   An in-process flag stops two ticks of the same process from overlapping.
4. **Ingest.** The staged file is parsed and passed to `LogsService.upsert()`. On success the row is
   deleted first, then a measurement is recorded and the file is unlinked (best effort — the row is
   the source of truth). The ingest transaction takes two advisory xact locks first, always in this
   order: the session-owner lock, then the per-tree lock of `lockSessionTreeForIngest`
   (`session-tree.sql.ts`, keyed by the tree's top-ancestor `session_id`). The tree lock serialises
   uploads of one session tree across cluster workers: an `artisyn` upload re-normalises the
   changed paths of every node while a sub-agent upload writes the same node's rows, and without
   the lock the two deadlocked (`40P01`).
5. **Fail or retry.** A read, parse or DB error is classified by `classifyUploadError`
   (`upload-error.ts`, rules in
   [algorithms/upload-error-classify.md](algorithms/upload-error-classify.md)). A **transient** DB
   error (deadlock, serialization failure, lock not available, lost connection) sends the row back
   to `pending` with `attempts + 1`; the claim skips it for `attempts × 2` s, and after
   `UPLOAD_QUEUE_MAX_ATTEMPTS` (default 5) it fails. Any other error fails the row at once. A failed
   row gets `status = 'failed'`, a short one-line `error_message` (never Drizzle's raw SQL and
   parameters) and `error_kind` = `server` (Log Hub could not process a good file) or `file` (the
   body is broken). The log line (`Logger.error`, which is how it reaches the admin Error Logs tab)
   carries the attempt number, the kind and the Postgres `code` / `detail` / `constraint` / `table`.
   The hook sees the row as a warning on its next upload: `Hook uploaded broken file: …` for a
   `file` row, `Log Hub could not process upload … (server-side error, not a hook problem; …)` for a
   `server` row (and for a pre-0083 row whose message is a raw `Failed query:`). An upload into a
   session owned by another user is marked `rejected_foreign_session` instead, and its file is
   deleted.
6. **Recover.** A `processing` row whose `updated_at` is older than
   `UPLOAD_QUEUE_LEASE_TIMEOUT_MS` (default 3 min) goes back to `pending`. This runs at bootstrap and
   at the start of every tick, and only touches lapsed leases, so a row another worker is still
   processing is never disturbed.

A tick-level DB error is logged and swallowed, and the next tick retries. On shutdown the
scheduler stops the interval and awaits the in-flight tick before the DB pool closes.

Admins manage failed rows from the Upload Queue tab: `DELETE /api/v1/admin/upload-queue/failed`
clears them, `POST /api/v1/admin/upload-queue/reprocess-failed` re-queues them (with `attempts` reset to 0), and
`GET /api/v1/admin/upload-queue/:id/file` downloads the staged file behind one row. That staged
file is debugging data and sits outside the privacy boundary of the access model (the admin role
otherwise grants no session-data access — see
[authorization-and-authentificaiton.md](authorization-and-authentificaiton.md)); the Data Collection
Notice discloses it.

## Chunked upload

A body larger than `CHUNK_SIZE_BYTES` (900 KB, in `upload-logs.js`) is sent as several requests to
the same route with query params `uploadId` (a hook-generated UUID), `chunkIndex`, `totalChunks`
and, on chunk 0, `totalSize`. The chunk size sits under the common 1 MB default request cap of
reverse proxies, which the hook cannot detect — see [hook-api-versioning.md](hook-api-versioning.md)
§ "Known limitation: a reverse proxy's own body-size cap is invisible to this app".

- Each chunk is staged as its own file, `<uploadId>.chunk<N>`, so a retried chunk simply overwrites
  its file. A retry of chunk 0 refreshes the existing row instead of inserting a second one.
- Received counts (`chunks_received`, bytes) are derived by scanning the staging directory, not by
  incrementing a counter, so retries cannot double-count.
- The row stays `partially_uploaded` until the last chunk arrives. Then the chunks are reassembled
  into `<uploadId>.raw`, the row points at it and flips to `pending`. A single-chunk upload starts
  as `pending`.
- A chunk with `chunkIndex > 0` for an unknown `uploadId` is rejected with `400`.
- `partially_uploaded` rows not touched by any chunk for `UPLOAD_QUEUE_PARTIAL_UPLOAD_TTL_MS`
  (default 24h) are deleted with their part-files, at most once per
  `UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS` (default 10 min) per process.
- If a row still names a `.chunkN` file that reassembly already removed, the worker reads
  `<uploadId>.raw` instead. A missing file on a failed row gets a diagnostic listing of related
  staging files appended to `error_message`.

The hook can also gzip a request body (`uploadFileMaybeCompressed`); the server's gzip sniffer
decompresses it before staging.

## Harness snapshot known-check

`POST /api/v2/logs` also accepts two optional query params that are orthogonal to staging and
unrelated to the chunk-reassembly params above: `snapshotId` (64-char hex, the hook's harness
snapshot id — see `docs/knowledgebase/algorithms/harness-snapshot.md`) and `snapshotFull` (`'1'`
when the uploaded body's `artisyn` file carries the full `harness-snapshot` line, not just a
`harness-snapshot-ref`).

- `harnessSnapshotId` is threaded into the `upload_queue` insert (both the single-upload path and
  chunk 0 of a chunked upload) **only** when `snapshotFull === '1'` and the id passes
  `SNAPSHOT_ID_RE`; a ref-only upload leaves the column `NULL`.
- On the `201` response of a single upload, or the chunk-complete response of a chunked one (never
  on an intermediate `{ complete: false }` chunk, and never on a foreign-session response), the
  controller computes `unknownSnapshotId` via `isHarnessSnapshotKnown(db, userId, snapshotId)`
  (`server/src/logs/harness-snapshot.ts`) and adds it to the JSON body when the id is unknown. The
  field is additive — an old hook that sends no `snapshotId` never gets it.
- An id counts as **known** when either holds: a `harness_snapshots` row already exists for
  (`userId`, id), or an `upload_queue` row for that user already names that
  `harness_snapshot_id` with status `pending`, `processing` or `partially_uploaded` — i.e. another
  upload is already carrying the full snapshot through the pipeline, so asking for it again would
  be redundant.
- An invalid `snapshotId` (wrong shape) is silently ignored, never a `400`, and is treated the same
  as no `snapshotId` at all.
- The hook reacts to `unknownSnapshotId` by forgetting the id from its local known-state file and
  resending the full snapshot on its next upload — see
  `docs/knowledgebase/hook-system-overview.md`.

## Sub-agent meta columns

Hook `2.31.0`+ sends the optional query params `agentDescription` / `workflowPhase` on
`claude-subagent` uploads (from the agent's `.meta.json`; see
[hook-api-versioning.md](hook-api-versioning.md)). The controller sanitises both with
`sanitizeAgentMeta` (`server/src/logs/agent-meta-param.ts`) and drops them for any other `type`.
They are staged on the `upload_queue` row as `agent_description` / `workflow_phase`
(`varchar(255)`, nullable) — on the plain-upload insert and on the insert that creates a chunked
upload's row (later chunks only update the counters). The scheduler reads them from the claimed
row (`UploadQueueRawRow`) and passes `{ agentDescription, workflowPhase }` as the trailing
`agentMeta` argument of `LogsService.upsert`, which copies only non-null values onto `sessions`
(never clearing a stored value). An invalid or empty value is stored as `NULL`, never a `400`.

## Malformed lines

Concurrent hook appends to one session `.jsonl` can tear a few lines on filesystems where
cross-process `O_APPEND` is not atomic (for example WSL with the repository on a Windows drive).
The worker therefore uses `parseNdjsonLinesTolerant()`: up to `MAX_DROPPED_LINE_RATIO` (10%) of the
non-blank lines may be malformed. Those lines are dropped and logged as one `warn` line with the
first few line numbers, and the rest of the session is ingested. Above that ratio the body is
treated as garbage and the row fails with the strict parser's error. Null characters are stripped
from decoded values after parsing, because JSONB cannot store U+0000.

Session export/import parsing (`server/src/logs/export-import-zip.ts`) stays strict — see
[session-export-import.md](session-export-import.md).

## Worker statistics

A successfully processed row is deleted, and each cluster worker has its own memory, so neither the
queue table nor in-process counters can report throughput. Every processing attempt — success and
failure — therefore writes one `upload_queue_measurements` row (`recordMeasurement()`), with the
active duration and the queue latency (`finished_at − received_at`). Recording a measurement never
delays or fails an upload.

`GET /api/v1/admin/upload-queue/stats` (`UploadQueueStatsService.getStats()`) returns:

- the backlog per status (files and bytes, every status zero-filled in a fixed order) and the number
  of rows `processing` now;
- worker utilisation, files/s and bytes/s, and success/failure counts over a rolling
  `UPLOAD_QUEUE_STATS_WINDOW_MS` window (default 15 min);
- a 7-day average speed (the retention window);
- latency avg / p95 / min / max and a drain ETA.

A measurement's `outcome` is `success`, `failure`, `skipped` (hash skip), `superseded`
(coalesced away, or older than the stored body) — see the next section — or `upload-full` (an
append row whose delta did not fit the stored log, see "Append rows"). Only `success` rows feed
throughput; failures count toward utilisation; `skipped`, `superseded` and `upload-full` rows feed
neither. Measurements older than
`UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS` (default 7 days) are pruned at most once per
`UPLOAD_QUEUE_MEASUREMENT_PRUNE_INTERVAL_MS` (default 5 min) per process. All three values are
read from `process.env` on every call, so e2e overrides apply after bootstrap. The Upload Queue tab
polls the stats while it is open.

## Skip, ordering, coalescing and integrity

Whole-file uploads (`claude`, `claude-subagent`, `tool-calls`) are re-sent whenever the file grew,
so the queue sees many copies of one file. These rules (impl-plan
`docs/tasks/todo/2026-11-23-session-logs-streaming`, DD-16 to DD-25) keep that cheap and correct.
`artisyn` and `claude-otel` are never coalesced or hash-skipped.

**Coalescing (DD-16).** When the claim picks a row of a coalesced type (`COALESCED_LOG_TYPES` in
`upload-queue.service.ts`), it claims instead the newest eligible `pending` row of the same
`(user_id, session_id, log_type)` — in one transaction, both `FOR UPDATE SKIP LOCKED`; the first
pick stays `pending`, untouched. After that newest row completes (processed, skipped or
superseded), `deleteSupersededRows()` deletes the older `pending` rows of the key, unlinks their
files and records one `superseded` measurement per row. If the newest row fails, the older rows
are processed normally.

**Content integrity (DD-24).** A new hook sends `contentSha256` (64 lowercase hex, anything else
is ignored) on a single upload or chunk 0; it is stored in `upload_queue.content_sha256`. The worker
computes the sha256 of the staged body first: on a mismatch the row fails at once (no retry) with
`error_kind = 'server'` and `error_message = 'content-hash-mismatch'`.

**Hash skip (DD-20).** Before parsing, `LogsService.checkUnchanged()` takes the owner and tree
locks, upserts the `sessions` row and compares the stored `logs` row with the upload using the
pure `decideIngestSkip` ([algorithms/ingest-hash-skip.md](algorithms/ingest-hash-skip.md)): same
`body_sha256`, same `INGEST_VERSION`, same user and — for transcripts — the same tree edit
revision (`stats_edit_sha256` vs the nearest `artisyn` `edit_records_sha256`). Then the row is
deleted without parsing, with a `skipped` measurement.

**Ordering guard (DD-19).** `upsert` writes the body only when the upload is not older than the
stored one (`body_received_at` = `upload_queue.received_at`, chunk-0 time). A transcript or
`tool-calls` upload that loses writes nothing and completes as `superseded`; an `artisyn` one
keeps the stored body and hook status but still runs the idempotent repo-link, harness / OKF,
code-inventory and OTEL-status steps.

**Failure feedback (DD-25).** With `uploadFeedback=1`, the upload answer carries `failedUploads`:
`takeFailedUploadsForFeedback()` returns up to `FAILED_UPLOADS_MAX` (20) of the caller's `failed`
rows with `error_kind = 'server'` not reported yet, as `{sessionId, type}`, and flags them
`failure_delivered` in the same `UPDATE … RETURNING`, so each is reported once. The hook re-sends
those files. The `warnings` list is unchanged.

**Re-extract on edit-record change (DD-22).** Transcript stats depend on the tree's `artisyn`
edit records. When an `artisyn` upload changes them (`edit_records_sha256`), `upsert` queues the
tree root in `session_reextract_queue` and nudges `SessionReextractService`
(`session-reextract.service.ts`) after the commit. The drain (first pass on module init, then every
`SESSION_REEXTRACT_INTERVAL_MS`, default 15000; governed, one tree per unit) takes the tree's
ingest lock before locking the queue row (ingest upserts that row under the tree lock, so the
reverse order could deadlock), re-runs `writeClaudeDerived` for each `claude` / `claude-subagent`
row of the tree one body at a time, sets its `stats_edit_sha256`, marks the tree stale for the
Tools/MCP rebuild and deletes the queue row. A queued row older than 30 s makes the parts manifest
report `derivedLagging`.

## Append rows

Hook `3.3.0`+ sends only the new complete lines of a `claude` / `claude-subagent` transcript to
`POST /api/v2/logs/append` (`postLogsAppend` in `logs-v2.controller.ts`; contract and fallbacks in
[hook-api-versioning.md](hook-api-versioning.md) § "`POST /api/v2/logs/append`"). Task
`docs/tasks/todo/2026-11-24-traffic-optimization` (DD-1 to DD-9).

- **Staging.** The route shares the non-chunked branch of `postLogs` (`stageSingleUpload`:
  foreign / deleted session answers, then `saveRawUpload(rawBody, meta, contentSha256,
  startLine)`), so the row is a normal single `pending` row plus `upload_queue.start_line` — the
  0-based record index the delta starts at. `start_line IS NULL` marks a full upload; every
  pre-append row and old hook stays NULL. `contentSha256` covers the delta.
- **Claim rule.** An append row is claimed only when no older row of the same
  `(user_id, session_id, log_type)` is still `pending` or `processing` (`NOT EXISTS` on
  `(received_at, id)`, served by `idx_upload_queue_session_id_received_at`), so the deltas of one
  key are applied in order, one at a time. Full rows ignore append rows: for the queue F1, A1, F2
  the coalescing jump claims F2, and A1, processed later, is discarded as stale.
- **No coalescing, no superseding.** The coalescing jump runs only when the first pick is a full
  row, and lands only on a full row (`AND start_line IS NULL`). `deleteSupersededRows` deletes only
  full rows (`AND start_line IS NULL`), so an append row is never dropped unprocessed and never
  gets a `superseded` measurement that way.
- **Worker branch.** The staged-file read, the `content_sha256` check and the tombstone pre-check
  run as for a full row; `checkUnchanged` (hash skip) is skipped. The body is parsed with
  `parseNdjsonLinesTolerant` and passed to `upsert` with `{ bodySha256: null, receivedAt,
  appendStartLine: start_line }`. Inside the ingest transaction `decideIngestAppend`
  ([algorithms/ingest-append.md](algorithms/ingest-append.md)) compares the row with the stored
  `logs` row (`body_received_at`, `jsonb_array_length(body)`):
  - `append` — the stored body ends exactly at `start_line`: `upsert` stores body + delta and the
    rest of the ingest (derived rows, `markTreeStale`) runs on the full body. `body_sha256` is
    written NULL, so the next full upload of the file is processed, not hash-skipped; the
    `logs_body_guard` trigger advances `body_rev`.
  - `stale` — the row is older than the stored body: `superseded`, completed with a `superseded`
    measurement, nothing written.
  - `upload-full` — no stored log, a NULL record count or a different one: the transaction rolls
    back and the worker calls `failUploadFull`.
- **`upload-full` lifecycle.** `failUploadFull` unlinks the staged delta and sets the row
  `status = 'failed'`, `error_kind = 'server'`, `error_message = 'upload-full'`
  (`UPLOAD_FULL_REASON` in `upload-queue.service.ts`), `failure_delivered = false` — no retry. Then:
  - `getPendingWarnings` skips it (`error_message IS DISTINCT FROM 'upload-full'`), so the hook
    gets no `warnings` entry and no `broken-upload-file` recommendation;
  - `takeFailedUploadsForFeedback` returns it once as a `failedUploads` entry (only to callers that
    send `uploadFeedback=1`, which every `3.3.0` hook does) and **deletes** it in the same call; the
    hook then re-sends the whole file;
  - the admin `reprocess-failed` skips it (its delta no longer fits); `clear failed` still deletes
    it.
- **Measurement.** `failUploadFull` records one measurement with outcome `upload-full`
  (`UploadQueueMeasurementOutcome`). Like `skipped` and `superseded` it feeds neither throughput
  nor the failure count of the admin statistics.

## Upload priority

On `Stop`, `send-logs-hook.js` uploads files in this order:

1. the current session's `claude` and `claude-subagent` transcripts (`priorityEntries`), so the
   server knows the turn that just ended — the post-turn analysis depends on it (see
   [turn-end-cost-advisor.md](turn-end-cost-advisor.md));
2. everything else (`remainder`), with `claude-otel` chunks kept in their lexicographic write order;
3. the current session's own `artisyn` file last, so the hook-status event it carries can report
   this run's upload failures.

## Hook-side skip of unchanged files

The `.claude-logs.sent` manifest in the telemetry directory maps each file key
(`<namespace>/<file>`) to the size at its last successful upload. A file whose size equals the
recorded size is skipped; only the current session's `artisyn` file is never skipped.

- Only the full `Stop` scan reads and writes the manifest. The detached prompt-submit upload
  (`prompt-upload-hook.js`) never touches it.
- The manifest is rewritten on a bounded schedule — every `MANIFEST_FLUSH_EVERY` (25) new entries
  or `MANIFEST_FLUSH_INTERVAL_MS` (1s) — so a killed run keeps credit for what it already shipped.
- Entries whose file no longer exists are pruned, per namespace that resolved in this run.
- Uploaded `claude-otel` chunks are deleted rather than fingerprinted (see
  [otel-receiver.md](otel-receiver.md)).

For `claude` / `claude-subagent` files that did change, hook `3.3.0`+ usually sends only the new
lines ("Append rows" above).

More on the manifest and namespaces: [hook-system-overview.md](hook-system-overview.md).

## Background rebuilds under load

Ingest and every background rebuild share one per-worker pacer, `RebuildGovernor`
(`server/src/common/load-governor/rebuild-governor.ts`, global `LoadGovernorModule`). A drain
calls `admit()` before each unit of work and `reportIdle()` when it found nothing to do. Work is
never dropped: a paused caller simply has not run yet. The pacing rules are the pure
`decideRebuildPace` (algorithm doc
[rebuild-load-governor.md](algorithms/rebuild-load-governor.md)); the load is the system CPU busy %
from `CpuLoadSampler` (the max with the cgroup v2 quota share inside a limited container), averaged
over the last 3 samples.

- Below `REBUILD_SLOWDOWN_CPU_PERCENT` (default 60) `admit()` resolves at once, so an idle
  instance ingests and rebuilds right after an upload.
- Between that and `REBUILD_PAUSE_CPU_PERCENT` (default 99) it waits, up to
  `REBUILD_MAX_DELAY_MS` (default 10000) just below the pause threshold.
- At the pause threshold and above it pauses, re-checking after every load sample
  (`REBUILD_LOAD_SAMPLE_MS`, default 2000), until `REBUILD_HARD_CAP_MS` (default 300000) has
  passed. After that work runs anyway (drain mode) until a drain reports idle, so deferred work
  always converges.

Drains it covers and their unit of work:

| Drain | Unit of work (admit before it) |
|---|---|
| Upload-queue tick (`UploadQueueSchedulerService`) | each row claim; `reportIdle()` when nothing is pending. The wait counts against `UPLOAD_QUEUE_TICK_BUDGET_MS` |
| `ToolUsageRebuildService` | each claimed batch of stale trees |
| `OtelProjectionService` | the chunk claim, each reclassification-queue claim, the idle-root finalising, each deleted-root cleanup |
| `SessionCostRecomputeService` | each stale-cost batch claim (not under `SESSION_COST_RECOMPUTE_INLINE=true`, where a pricing write awaits the drain) |
| `ShellFiguresBackfillService` | each pass (one claimed batch) |
| `WorkflowsBackfillService` | each `session_stats` row |
| `LogBodyGzService` | each `logs` row whose gzip copy is missing or stale |
| `SessionReextractService` | each queued tree in `session_reextract_queue` |

Admission always happens before a claim, never between a claim and its work, so a paused drain
never holds rows it has already stamped as done.

`LogBodyGzService` (`server/src/logs/log-body-gz.service.ts`) builds `logs.body_gz`, the gzip
(level `LOG_BODY_GZIP_LEVEL` = 6) of `body::text` for `artisyn`, `claude` and `claude-subagent`
rows. It runs a first pass on module init, then every `LOG_BODY_GZ_INTERVAL_MS` (default 15000),
and `LogsService.upsert` / `importSession` nudge it after their commit. Per row, in one
transaction: claim one row of the `idx_logs_body_gz_pending` predicate (newest first,
`FOR UPDATE SKIP LOCKED`), read the body and `body_rev`, gzip it, and store the copy with its
revision (assigning one from `logs_body_rev_seq` to a row written before migration 0096), guarded
by the `body_rev` it read. A row whose build fails is skipped for the rest of the pass.

## Rejected alternatives

- A resident per-project upload agent replacing the inline `Stop` upload is not used. The inline
  `Stop` upload plus the detached prompt-submit upload cover the freshness need without a
  long-lived process per project.
