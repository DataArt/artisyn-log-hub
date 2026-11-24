---
type: "Research"
title: "Traffic Optimization — planning research findings 1"
description: "Verbatim codebase research report from plan-deep (2026-11-24); audit archive only."
---

## Requirements summary
The task has two parts. **Part A (hook + server):** for `claude` and `claude-subagent` logs the server already holds, the hook sends only the new complete lines to a new route, `POST /api/v2/logs/append`. The route mirrors the full route: same query params plus `startLine`, same API-key auth, same foreign and deleted-session answers, same response shape. The hook keeps its own state per file (`appendBytes`, `appendLines`, `appendSha256`) as optional fields on the manifest-v2 entry. It re-hashes the prefix `[0, bytes)` and sends a delta only when that hash is unchanged. The server stages the delta in `upload_queue` with a new nullable `start_line` column. Append rows are never coalesced or superseded and run in arrival order per key under the tree lock. The worker checks the age first, then `startLine` against the stored line count (`jsonb_array_length(body)`). It appends and re-derives everything as after a full upload, with `body_sha256 = NULL`, `body_received_at` = the append row's time, and `body_rev` moving on through the trigger. A mismatch gives a `failed` row (`error_kind='server'`, `error_message='upload-full'`) that reaches the hook once through `failedUploads`. Any doubt on the hook side means a full upload. Cases listed in FR-6 include a 404, which also turns the append path off for that server URL for 1 h. The hook gets a MINOR version bump. **Part B (server):** large JSON API answers (OTEL session, repo and team; the parts manifest; the sessions list) are gzipped when the client accepts it, with `Vary: Accept-Encoding`, a size threshold and non-blocking zlib. Already-compressed parts and streamed answers are left alone. Results are measured on the Pi and recorded in `notes.md`.

## Wireframes
None referenced. `open_questions_ru.md` says no questions are open; the last answer (no fixed number for Part B) is already in requirements.

## Knowledgebase
- `docs/knowledgebase/upload-queue.md`: the queue lifecycle. Covers coalescing (`COALESCED_LOG_TYPES`, `deleteSupersededRows`), the hash skip, the ordering guard (DD-19), `failedUploads` (DD-25), measurement outcomes, and the "house pattern" (`SKIP LOCKED` plus a lease). It needs a new section on append rows.
- `docs/knowledgebase/hook-api-versioning.md`
  - Lines 31–60: "why a new route" — the append route follows the same reasoning.
  - Compatibility matrix and the `contentSha256` / `uploadFeedback` sections at about lines 722–783 and 899–921 of the original file: add the new hook-version row there (FR-10a).
  - `otel-realtime`: its 404 → off-for-1 h row is the model for the append 404 rule.
  - "Per-route body limits": a new ingest route must be added to `LOG_INGEST_ROUTES`.
- `docs/knowledgebase/hook-system-overview.md`, "Upload pipeline": the namespaces, the two manifests and the skip rule, scoped-path recording (prompt upload and the `SessionEnd` flush record the current `claude` transcript), `forgetFailedUploadsInMaps`, chunking/gzip/resume, and the `gzipUnsupported` latch on a non-validation 400.
- `docs/knowledgebase/algorithms/hook-upload-skip.md` + `docs/algorithm-examples/hook-upload-skip.json` (24 rows, kinds `skip`/`resume`/`params`; test `hook/.claude/telemetry_tool/__tests__/upload-skip.algo.test.js`). This is the natural place for the append-decision algorithm, as a new `kind` (e.g. `append`) with rows covering no state, shorter file, changed hash, 0 records, torn line, over budget, pending upload, and 404 cooldown.
- `docs/knowledgebase/algorithms/ingest-hash-skip.md`: no rule change. IS-09 ("cleared stored hash → process") already covers `body_sha256 = NULL` after an append.
- `docs/knowledgebase/static-asset-serving.md` §6 "Rejected alternatives": says runtime `compression` was rejected for static files. It also says compressing API answers is "a separate, still-open question" with a concern about interaction with `gzip-sniff.middleware.ts`. Part B closes that question; update the section.
- `docs/knowledgebase/server-endpoint-map.md`
  - "Cross-cutting behaviour" (lines 114–161): add the compression rule there.
  - "Backward compatibility of hook-facing routes" (163–184): a missing route answers 404 = feature off; a non-validation 400 on `/api/v2/logs` turns hook gzip off.
- `docs/knowledgebase/db-schema-code.md` + `db_state.sql`: hand-written migration with `COMMENT ON`, then `npm run db:state`. Never `drizzle-kit generate`. The next file is `server/drizzle/migrations/0097_*.sql` (latest is `0096_logs_streaming_skip_tombstones.sql`, which defines the `logs_body_guard` trigger at lines 42–56). Use the `db-state-update` and `migrations-data-integrity` skills.
- `docs/knowledgebase/test/overview.md`, `scenarios.md`, `contract-tests.md`: the three test kinds and the stand helpers (`waitForQueueIdle`, `postLogs`).
- `.claude/rules/hook.md`: the version bump steps (`version.json` → `npm run build:hooks-installer` → dogfooded `scripts/` + `plugin.json`), `update-install-instructions`, and "never augment claude logs".

## Existing patterns
**Server — ingest**
- `server/src/logs/logs-v2.controller.ts:48-210`, `postLogs`. The append route mirrors it.
  - Order of checks: param checks, then `isForeignSession` (:151), then `isDeletedSession` / `deletedSessionAnswer` (:165, :352–397), then `saveRawUpload`, then `getPendingWarnings`, `resolveUnknown*SnapshotId`, `failedUploadsFeedback` (:400).
  - The empty-body 400 is at :94–99.
  - `contentSha256` parsing is at :141–146.
- `server/src/logs/upload-queue.service.ts`
  - :149 `saveRawUpload`: add `startLine` to the insert.
  - :27 `COALESCED_LOG_TYPES`.
  - :482 `getPendingWarnings`: selects **every** `failed` row of the user. It must exclude `upload-full` rows (FR-4a).
  - :526 `takeFailedUploadsForFeedback` (`UPDATE … RETURNING`, `failure_delivered`): "deleted once delivered" means rewriting this as a DELETE for `upload-full` rows, or a follow-up delete.
  - :568 `deleteSupersededRows`: needs `AND start_line IS NULL`.
- `server/src/logs/upload-queue-scheduler.service.ts`
  - :354–405 `claimNextPendingRow`: picks the oldest pending row, then jumps to the newest of the same key. Both picks need `start_line IS NULL` handling plus the "no older pending/processing row of the key" guard.
  - :408 `processRow`: sha check (:455), tombstone, `checkUnchanged`, `parseNdjsonLinesTolerant`, `logsService.upsert(..., {bodySha256, receivedAt})` (:519).
  - :619 `completeRow`.
  - :668 `failContentHashMismatch` is the template for an `upload-full` fail. Unlike that function, the `upload-full` path deletes the staged delta at once and records its own outcome.
- `server/src/logs/logs.service.ts`
  - :342 `lockAndUpsertSession`: the owner lock, then the tree lock (`lockSessionTreeForIngest`), then the tombstone check.
  - :444 `checkUnchanged`.
  - :483–1036 `upsert`, with the ordering guard `setWhere` on `body_received_at` at :635–637 and the superseded branch at :648.
  - The age check and the start-line check must run in the same transaction after the tree lock. That means an append variant inside `upsert`: read the stored body and `jsonb_array_length`, check, then build `stored ++ delta` lines and pass them to `writeClaudeDerived` (:684).
  - `writeImportedLog` (:1290–1337) already uses `jsonb_array_length` and writes `bodySha256: null` / `bodyReceivedAt`. Reuse those idioms.
- `server/src/logs/ingest-version.ts`: `UpsertIngestMeta.bodySha256` is typed `string`. It must allow `null` for an append (FR-4d).
- `server/src/logs/upload-queue-stats.constants.ts:51`: the `UploadQueueMeasurementOutcome` union. Add `upload-full`. The `outcome varchar(20)` column fits it; the stats in `server/src/admin/upload-queue-stats.service.ts:136-151` count only success/failure, so nothing changes there.
- `server/src/admin/upload-queue-admin.service.ts:135,171`: `clearFailed` / `reprocessFailed` act on all `failed` rows. Reprocessing an `upload-full` row whose delta was deleted would hit ENOENT, so exclude those rows.
- `server/src/common/body-limits.ts:48` `LOG_INGEST_ROUTES`, read by `app.module.ts:236-238` (gzip sniffer `inflateSniffedGzip`), `:273` (global-parser exclude) and `logs/logs.module.ts:229` (text/ndjson parsers).
- Migration and trigger: the `logs_body_guard` trigger (`0096…sql:42-56`) clears `body_sha256` only when neither `body_sha256` nor `body_received_at` changed. Writing `body_sha256 = NULL` with a new `body_received_at` keeps it NULL, as FR-4d wants. The trigger always advances `body_rev`.
- Schema: `server/src/database/schema/index.ts:2119` `uploadQueue` (add `startLine: integer('start_line')`). The raw row type is `UploadQueueRawRow` at `upload-queue-scheduler.service.ts:38`.

**Server — compression (Part B)**
- Two `Accept-Encoding` parsers already exist; reuse one rather than add a third.
  - `server/src/logs/session-log-parts.service.ts:46` `acceptsGzip(req)` (honours `q=0`).
  - `server/src/common/precompressed-static.ts:122` `pickEncoding`.
- `session-log-parts.service.ts:60-65,189-216` is the header pattern: always set `Vary: Accept-Encoding`, set `Content-Encoding: gzip`, and use `res.end` with stored gz bytes. These answers already carry `Content-Encoding`, so a shared step must skip a response that already has it.
- Streamed answers to keep out:
  - `server/src/logs/repositories.controller.ts` `/logs` and `/logs/delta`, which use `@Res()` with `writeChunk` from `server/src/logs/streaming/response-stream.ts`.
  - Other `@Res()` routes: `admin-panel.controller.ts` (2), `installer.controller.ts`, `repository-export-import.controller.ts`, `auth.controller.ts`, `azure-callback.controller.ts`.
  - There is no `@Sse`.
- The routes in scope return plain objects, so Nest replies through `res.json`:
  - `otel/otel-facts.controller.ts:241` `GET :repoId/otel/facts` and `:265` `GET :repoId/sessions/:sessionId/otel`
  - `otel/otel-team-facts.controller.ts:94` `GET :teamId/otel/facts`
  - `repositories.controller.ts:1811` `GET …/logs/parts` and `:562` `GET :repoId/sessions`
- Global middleware is registered in `server/src/main.ts:100-123` (security header, then `createPrecompressedStaticMiddleware`).
- `compression` is **not** in `server/node_modules`; `negotiator` and `accepts` are there as transitive packages.

**Hook**
- `hook/.claude/telemetry_tool/send-logs-hook.js`
  - :2256–2500 `processFile`, the single place for the Stop scan: stat before read, then `decideUploadSkip`, `readFileSync`, `sanitizeNdjson`, artisyn prepends, then chunked or `uploadFileMaybeCompressed`, then `forgetFailedUploadsInMaps`, then the manifest v1 + v2 write.
  - On success the v2 entry is rebuilt as `{size, mtimeMs, paramsSha256}` at :2470–2475, which would drop the append fields.
  - :1421 `formatUploadResultLine`: the hook log line the FR-1 acceptance criterion reads.
  - :1526 `runSessionEndFlush`: sends the **raw** body, then `recordScopedClaudeUpload`.
- `hook/.claude/telemetry_tool/upload-logs.js`
  - :510 `uploadFile`: the URL is hard-coded to `/api/v2/logs` (:516); it reads the 201 body up to 64 KiB and parses `failedUploads`.
  - :1131 `uploadFileMaybeCompressed`: `zlib.gzipSync`; gzip is used only if smaller and ≤ `CHUNK_SIZE_BYTES`.
  - :59 `CHUNK_SIZE_BYTES = 900 * 1024` = 921,600 bytes.
  - :295–304 `V2_VALIDATION_MESSAGES`: a 400 whose text is not in this list latches `gzipUnsupported`. The append route's own 400 texts (missing/invalid `startLine`, empty body) must be added, or one append 400 turns gzip off for the whole run.
  - :793/:843 read/write of `.claude-logs.pending`; :76 `bodyContentSha256`.
- `hook/.claude/telemetry_tool/upload-skip.js`
  - :95 `isValidEntry` and :111–129 `readManifestV2` **strip unknown fields** (they rebuild a clean `{size, mtimeMs, paramsSha256, fp?}`). The new fields must be read here.
  - An older 3.2.0 hook rewriting the file also drops them, which is safe: it means "no state".
  - :226 `recordScopedClaudeUpload`: overwrites the v2 entry.
  - :248/:276/:303 `failedUploadManifestKeys` / `forgetFailedUploadsInMaps` / `forgetFailedUploads`: these already drop the whole entry, so the append state goes with it.
- `hook/.claude/telemetry_tool/ndjson-sanitize.js`: `sanitizeNdjson` keeps non-blank lines that `JSON.parse` accepts after trimming. Server `parseNdjsonLinesTolerant` (`server/src/logs/ndjson-parser.ts:78-97`) applies the same rule, so the hook's line count can match `jsonb_array_length`.
- `hook/.claude/telemetry_tool/prompt-upload-hook.js:167-204`: a scoped full upload of the current `claude` transcript, then `recordScopedClaudeUpload`.
- `hook/.claude/telemetry_tool/otel-receiver.js:258,2768,2803-2807`: `RT_DISABLE_MS` (1 h), and 404/401/403 → `disableRealtime`. This state is **in-memory** in the long-lived receiver.

**Tests**
- Scenarios:
  - `tests/scenarios/ingest/s-ingest-02.spec.ts`, steps 12–16 (hash skip, superseded at :563, coalescing burst at :578, `body_rev` / gzip): add the FR-4a and FR-4d steps here.
  - `tests/scenarios/ingest/s-ingest-04.spec.ts` step 10 (:231, `content-hash-mismatch` → `failedUploads` once): the template for an `upload-full` step.
  - `tests/scenarios/ingest/s-ingest-03.spec.ts` (empty body, malformed, gzip shapes): add the append empty-body 400.
  - `tests/scenarios/hook/s-hook-01.spec.ts` (hook against a fake hub; steps 6b–6e cover manifest v2 and `failedUploads`; step 16 makes the hub answer `otel-realtime` with 404): the place for hook append steps and the "new hook vs old server = 404 → 1 h off" step.
  - `tests/scenarios/hook/s-compat-01.spec.ts` (frozen hooks from `tests/fixtures/legacy-hooks/`, added with `scripts/scenarios/freeze-legacy-hook.mjs`).
  - `tests/scenarios/view/s-otel-01.spec.ts` (:216 repo/session, :1071 team): FR-11/12 steps.
  - `tests/scenarios/view/s-sess-03.spec.ts:1064` (parts manifest): FR-12 step.
  - Helpers: `tests/scenarios/helpers/ingest.ts:24` `postLogs`, :108 outcomes; `helpers/queue.ts:53` `waitForQueueIdle`.
- Contract registry:
  - `server/test/contract/registry/f15-ingest.ts`: about 20 `POST /api/v2/logs` rows; add rows for `POST /api/v2/logs/append`.
  - `f25-otel.ts` (:733 `REPO_FACTS`, :1072 session OTEL).
  - `f17-sessions.ts` (:898 parts manifest, :60 sessions list).

## Open gaps
1. **Scoped paths (prompt upload, `SessionEnd` flush) are not covered by the requirements.** Both do full uploads of the current `claude` transcript and `recordScopedClaudeUpload` overwrites the v2 entry, which drops the append fields. Without changes, the next `Stop` falls back to a full upload. Worse, if those paths left stale append fields behind, the hook would send a delta from the old `appendLines` while the server already holds more lines — a guaranteed `upload-full` failure. The plan must decide whether these paths use append, or at least update or drop the append state. The prompt upload is itself a per-prompt full-transcript traffic source.
2. **Persisting the 404 "append off for 1 h" state.** The `otel-realtime` rule lives in the long-running receiver's memory. Hook runs are short-lived processes (`Stop`, `--run-job`, prompt upload), so the cooldown needs a persisted file keyed by server URL. No existing pattern; `gzip-stat.json` and `throttle-state.js` are the nearest file-state examples.
3. **Claim ordering versus coalescing.** "A row is not claimed while its key has an older pending/processing row" conflicts with today's jump from the oldest row to the newest of the key (full rows). The plan must define the rule for the sequence full F1, append A1, full F2. Coalescing to F2 makes A1 stale (discarded by the age check), which is acceptable but must be spelled out. It must also define how the guard treats a `processing` row held by another worker.
4. **Appending inside `upsert`'s transaction.** This means reading the stored jsonb body (multi-MB) into JS and then running `writeClaudeDerived` over all lines. No existing "append" mode, so the plan designs it as a new `upsert` variant or parameter. `UpsertIngestMeta.bodySha256` must become nullable.
5. **Removing `upload-full` rows after delivery.** Today `failed` rows are only flagged `failure_delivered` and never deleted. They also show in the admin list and in `clearFailed` / `reprocessFailed`, and `getPendingWarnings` turns them into `broken-upload-file` warnings. All of these need explicit exclusions.
6. **Compression mechanism (Part B).** There is no existing API-compression code and `compression` is not a dependency. The plan must choose between adding `compression` and a small in-house middleware that wraps `res.send` / `res.json` using async `zlib.gzip` or `createGzip`. It also picks the threshold, the skip rules (already has `Content-Encoding`, streamed `@Res()` routes, non-`/api` paths), and reuses `acceptsGzip` / `pickEncoding`. Update KB `static-asset-serving.md` §6.
7. **Contract runner cannot check response headers.** `ExpectSpec` in `server/test/contract/types.ts:155` has no header assertions, and superagent sends `Accept-Encoding: gzip` and decodes it. Asserting `Content-Encoding` / `Vary` needs either a small `expect.headers` addition to the runner (`run-case.ts`) or scenario steps only.
8. **Version and compatibility baseline.** The last release, `v1.5.1`, ships hook `3.1.0`; `3.2.0` is on main and unreleased. So the bump is `3.2.0` → `3.3.0`, and "the previous release's hook" for the compatibility step is `3.1.0`. No frozen copy of it exists in `tests/fixtures/legacy-hooks/`, which holds 1.6.2, 2.6.1, 2.28.0 and 2.32.3. "The previous release's server" has no frozen stand, so that half needs a fake hub answering 404, as in `s-hook-01` step 16.
9. **No algorithm doc for the server-side append decision** (age check, then start-line check, then append or `upload-full`). Either add `kind` rows to an existing doc or create a new doc with its rows file, following the policy.
10. **Delta gzip threshold (FR-9a)** and the exact hook log-line format needed by the FR-1 acceptance criterion are not defined yet.
11. **Delta hashing.** The delta path needs a hash of the raw byte range `[0, bytes)`. The existing `bodyContentSha256` re-encodes UTF-8 and covers the whole body, so it is not the same function. Also, `contentSha256` on an append must hash only the delta, in the same UTF-8-normalised form the server uses.

The `ce` index was refreshed and used for route → controller lookups; nothing was written.
