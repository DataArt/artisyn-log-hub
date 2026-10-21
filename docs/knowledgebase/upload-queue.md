---
type: "Architecture Guide"
title: "Upload Queue (async log ingest, chunked upload, worker stats)"
description: "How POST /api/v2/logs stages uploads and a cluster-safe scheduler ingests them: queue lifecycle and statuses, chunked upload and reassembly, malformed-line tolerance, the admin Upload Queue tab and its worker statistics, and the hook-side upload order and unchanged-file skip."
tags:
  - server
  - hooks
  - upload
timestamp: "2026-10-14T00:00:00+04:00"
---

# Upload Queue

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
   claims the oldest `pending` row with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`,
   which is cluster-safe without any instance-index gating. A tick keeps claiming rows until the
   queue is empty or `UPLOAD_QUEUE_TICK_BUDGET_MS` (default 500ms, `0` allowed) has passed, and
   always processes at least one row, so a burst of small `claude-otel` chunks drains in one tick.
   An in-process flag stops two ticks of the same process from overlapping.
4. **Ingest.** The staged file is parsed and passed to `LogsService.upsert()`. On success the row is
   deleted first, then a measurement is recorded and the file is unlinked (best effort — the row is
   the source of truth).
5. **Fail.** A read, parse or DB error marks the row `failed` with `error_message` and logs it with
   `Logger.error`, which is how it reaches the admin Error Logs tab. The hook sees it as a warning on
   its next upload. An upload into a session owned by another user is marked
   `rejected_foreign_session` instead, and its file is deleted.
6. **Recover.** A `processing` row whose `updated_at` is older than
   `UPLOAD_QUEUE_LEASE_TIMEOUT_MS` (default 3 min) goes back to `pending`. This runs at bootstrap and
   at the start of every tick, and only touches lapsed leases, so a row another worker is still
   processing is never disturbed.

A tick-level DB error is logged and swallowed, and the next tick retries. On shutdown the
scheduler stops the interval and awaits the in-flight tick before the DB pool closes.

Admins manage failed rows from the Upload Queue tab: `DELETE /api/v1/admin/upload-queue/failed`
clears them, `POST /api/v1/admin/upload-queue/reprocess-failed` re-queues them, and
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

Only `success` rows feed throughput; failures count toward utilisation. Measurements older than
`UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS` (default 7 days) are pruned at most once per
`UPLOAD_QUEUE_MEASUREMENT_PRUNE_INTERVAL_MS` (default 5 min) per process. All three values are
read from `process.env` on every call, so e2e overrides apply after bootstrap. The Upload Queue tab
polls the stats while it is open.

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

More on the manifest and namespaces: [hook-system-overview.md](hook-system-overview.md).

## Rejected alternatives

- A resident per-project upload agent replacing the inline `Stop` upload is not used. The inline
  `Stop` upload plus the detached prompt-submit upload cover the freshness need without a
  long-lived process per project.
