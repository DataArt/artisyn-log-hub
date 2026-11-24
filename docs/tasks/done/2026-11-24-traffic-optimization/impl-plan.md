---
type: "Plan"
title: "Traffic Optimization — implementation plan"
description: "Append uploads for claude / claude-subagent logs (new route, queue start_line, hook append state) and gzip for large JSON API answers via a res.json wrapper."
---

# Implementation plan — 2026-11-24-traffic-optimization

## TL;DR

- **New route** `POST /api/v2/logs/append` (API key, `LogsV2Controller`): stages a delta of a
  `claude` / `claude-subagent` log in `upload_queue` with `start_line`; same answers as the
  non-chunked `POST /api/v2/logs`.
- **DB:** migration `0097_upload_queue_start_line.sql` adds nullable `upload_queue.start_line integer`.
  No other schema change, no new index.
- **Server ingest:** a new pure `decideIngestAppend()` (`server/src/logs/ingest-append.ts`, new
  algorithm doc). `LogsService.upsert` gets an append mode (`UpsertIngestMeta.appendStartLine`) and
  a new result `upload-full`. Queue changes: append rows are claimed in order per key and never
  coalesced or superseded. A mismatch fails the row as `upload-full`: no warning, delivered once
  through `failedUploads`, then deleted.
- **Server API answers:** a new middleware `createJsonGzipMiddleware()`
  (`server/src/common/json-gzip.ts`, registered in `AppModule.configure()`) wraps `res.json` on
  `/api/*` and gzips answers at or above `API_GZIP_MIN_BYTES` with async `zlib.gzip`.
  - `API_GZIP_MIN_BYTES` is a new env var, default 8192.
  - It keeps `Vary` and `ETag`/304.
  - `acceptsGzip` moves to `server/src/common/accept-encoding.ts`.
  - No new npm package; the PoC rejected `compression`.
- **Hook 3.2.0 → 3.3.0:** a new module `append-upload.js` (`planAppend`, `stateAfterFull`,
  `uploadWithAppend`, a 404 cooldown file `append-off.json`).
  - Manifest-v2 entries get optional `appendBytes` / `appendLines` / `appendSha256`.
  - The Stop scan, the prompt upload and the `SessionEnd` flush use the append path for `claude` /
    `claude-subagent` and fall back to the full upload on any doubt.
  - Changed existing hook interfaces:
    - `sanitizeNdjson()` returns an extra `records`;
    - `recordScopedClaudeUpload()` takes an optional 5th `appendState`;
    - `uploadFile()` takes an optional 16th `appendStartLine`;
    - `upload-logs.js` exports a new `isGzipUnsupported()`;
    - `V2_VALIDATION_MESSAGES` gets 4 new texts.
- **Other server type changes:**
  - `UpsertIngestMeta.bodySha256` becomes `string | null`;
  - `saveRawUpload` gets a 4th `startLine`;
  - the admin `reprocessFailed` skips `upload-full` rows.
- **Test fixture:** a new frozen hook `tests/fixtures/legacy-hooks/3.1.0/` (from `v1.5.1`).
- **Contract runner:** `ExpectSpec` gets an `expect.headers` check, so rows can assert
  `Content-Encoding` / `Vary`.

## Reference

- Requirements: [requirements.md](requirements.md)
- Evidence and PoC note: [notes.md](notes.md); PoC
  [`docs/pocs/2026-11-24-1549-api-response-compression/`](../../../pocs/2026-11-24-1549-api-response-compression/README.md)
- Research archive (not needed to implement): `research/findings-1.md`

## Design Decisions

### Server — append route and queue

1. **Route.** `POST /api/v2/logs/append` lives in `LogsV2Controller`, which has `postLogs` at
   `server/src/logs/logs-v2.controller.ts:48-210`, with `@HttpCode(201)` and `ApiKeyAuthGuard`.
   - **Query params.** It takes the same params as `postLogs` minus the chunk params
     (`uploadId`, `chunkIndex`, `totalChunks`, `totalSize`), plus `startLine`. The full list is in
     API changes.
   - **Order of checks:**
     1. missing `sessionId` / `type`: the existing 400 texts;
     2. `type` not in `claude` / `claude-subagent`: 400 `Append is supported only for claude and claude-subagent logs`;
     3. `startLine` missing: 400 `Missing startLine query parameter`;
     4. `startLine` not `/^\d{1,9}$/`: 400 `startLine must be a non-negative integer`;
     5. empty or whitespace body: the existing 400 `Request body must not be empty`;
     6. foreign session, then deleted session: the same answers as `postLogs` (:151, :165, :352–397);
     7. `saveRawUpload(rawBody, meta, contentSha256, startLine)`. Today's signature is
        `saveRawUpload(rawBody, meta: SaveRawUploadMeta, contentSha256?)`; it gains a 4th
        positional `startLine: number | null = null`;
     8. the same response object as the non-chunked branch of `postLogs`.
   - **Shared code.** The non-chunked branch of `postLogs` (from the foreign check through the
     return) is extracted into a private `stageSingleUpload(params, rawBody, contentSha256,
     startLine: number | null, req, uploadFeedback)`, and both routes call it.
2. **Body parsing.** Add `{ path: 'api/v2/logs/append', method: RequestMethod.POST }` to
   `LOG_INGEST_ROUTES` (`server/src/common/body-limits.ts:48`). That gives the route the logs body
   limit, the text/NDJSON parsers and gzip sniffing.
3. **Column.** `upload_queue.start_line integer NULL`. NULL marks a full upload and a value marks
   an append row. Drizzle: `startLine: integer('start_line')` on `uploadQueue`
   (`server/src/database/schema/index.ts:2119`). Raw row: `start_line: number | null` on
   `UploadQueueRawRow` (`upload-queue-scheduler.service.ts:38`).
4. **Claim rule** (`claimNextPendingRow`, `upload-queue-scheduler.service.ts:354-405`).
   - **First pick.** The oldest-row query adds `AND (start_line IS NULL OR NOT EXISTS (SELECT 1
     FROM upload_queue o WHERE o.user_id = upload_queue.user_id AND o.session_id =
     upload_queue.session_id AND o.log_type = upload_queue.log_type AND o.status IN
     ('pending','processing') AND (o.received_at, o.id) < (upload_queue.received_at,
     upload_queue.id)))`. The existing `idx_upload_queue_session_id_received_at` serves the
     subquery.
   - **Coalescing jump.** It runs only when the first pick has `start_line IS NULL`, and the
     "newest" query adds `AND start_line IS NULL`.
   - **Full rows ignore append rows.** For the queue F1, A1, F2, the worker claims F2; A1 is
     processed later and is discarded as stale by the age check (Design Decision 6).
5. **Superseding.** `deleteSupersededRows` (`upload-queue.service.ts:568`) adds
   `AND start_line IS NULL`, so append rows are never deleted as superseded and get no
   superseded measurement.
6. **`decideIngestAppend` (algorithm `ingest-append`).** File: `server/src/logs/ingest-append.ts`.
   - Input: `{ stored: { receivedAt: Date | null, lineCount: number | null } | null,
     rowReceivedAt: Date, startLine: number }`.
   - Output: `'stale' | 'upload-full' | 'append'`.
   - Rules, in order:
     1. `stored === null` gives `upload-full`;
     2. `stored.receivedAt !== null && rowReceivedAt < stored.receivedAt` gives `stale`;
     3. `lineCount === null || lineCount !== startLine` gives `upload-full`;
     4. otherwise `append`.
7. **Append mode of `upsert`** (`logs.service.ts:483`).
   - **Type change.** `UpsertIngestMeta` (`ingest-version.ts:19`) becomes
     `{ bodySha256: string | null; receivedAt: Date; appendStartLine?: number }`.
   - **Read the stored log.** When `appendStartLine` is set, the transaction runs one query right
     after `lockAndUpsertSession`: `SELECT body_received_at, CASE WHEN jsonb_typeof(body) =
     'array' THEN jsonb_array_length(body) END AS line_count FROM logs WHERE session_id =
     <sessionRowId> AND log_type = <logType>`.
   - **Then branch on `decideIngestAppend`:**
     - `stale`: set `superseded = true` and return, as the existing superseded path does.
     - `upload-full`: throw a module-private `AppendMismatch` error, so the transaction rolls back
       the session upsert. Catch it outside and return `{ status: 'upload-full' }`.
     - `append`: select `body`, set `lines = [...storedBody, ...deltaLines]` and continue
       unchanged. The insert/update, `writeClaudeDerived` and `markTreeStale` then see the full
       body. The existing `setWhere` writes `body_sha256 = NULL` (from `ingest.bodySha256`) and
       `body_received_at` = the row's time.
   - **Result type.** `UpsertResult.status` gains `'upload-full'`.
8. **Worker branch for an append row** (`processRow`, `upload-queue-scheduler.service.ts:408`).
   - **Same as a full row:** the staged-file read, the `content_sha256` check (it covers the
     delta) and the tombstone pre-check.
   - **Skipped for an append row:** `checkUnchanged`.
   - **Parse and upsert.** `parseNdjsonLinesTolerant(rawBody)`, then `upsert(..., { bodySha256:
     null, receivedAt: new Date(row.received_at), appendStartLine: row.start_line })`.
   - **Result handling:**
     - `upload-full` calls the new `failUploadFull(row, filePath, startedAt)`;
     - `superseded` calls `completeRow(..., 'superseded')`;
     - `foreign-session`, `deleted` and `ok` work as today.
   - **Other consumers.** Every other consumer of `UpsertResult` treats `upload-full` like a
     failure it does not expect. Only the scheduler ever passes `appendStartLine`, so only the
     scheduler can receive `upload-full`.
9. **`upload-full` row.** The constant is `UPLOAD_FULL_REASON = 'upload-full'`, exported from
   `upload-queue.service.ts`.
   - **`failUploadFull`** (modelled on `failContentHashMismatch` :668):
     - unlinks the staged file (ignoring ENOENT);
     - sets the row to `status = 'failed'`, `error_kind = 'server'`,
       `error_message = 'upload-full'`, `failure_delivered = false`;
     - inserts one `upload_queue_measurements` row with outcome `upload-full`.
   - **Measurement outcome.** `UploadQueueMeasurementOutcome`
     (`upload-queue-stats.constants.ts:51`) gains `'upload-full'`. The admin stats count only
     `success` / `failure`, so they need no change.
   - **Hidden from warnings.** `getPendingWarnings` (:482) adds
     `error_message IS DISTINCT FROM 'upload-full'`.
   - **Delivered once, then deleted.** `takeFailedUploadsForFeedback` (:526) returns
     `id, error_message` too. It then deletes the returned rows whose `error_message` is
     `upload-full`, in the same call. The feedback entry shape is unchanged.
   - **Admin actions.** `reprocessFailed` (`server/src/admin/upload-queue-admin.service.ts:171`)
     skips `upload-full` rows. `clearFailed` (:135) still deletes them; its unlink already ignores
     errors.

### Server — JSON gzip (Part B)

10. **Mechanism: a `res.json` wrapper, not `compression`.** Nest replies every plain-object
    handler result through `response.json(body)`. The PoC showed that `compression` 1.8.2 answers
    `br` to browsers, which breaks FR-11's "gzip".
    - **File and wiring.** `server/src/common/json-gzip.ts` exports
      `createJsonGzipMiddleware({ thresholdBytes })` and `apiGzipMinBytes()`, which returns
      `readPositiveIntEnv('API_GZIP_MIN_BYTES', 8192)` (`server/src/common/env-int.ts:7`).
    - **Registration.** In `AppModule.configure()` (`server/src/app.module.ts:165`):
      `consumer.apply(createJsonGzipMiddleware({ thresholdBytes: apiGzipMinBytes() })).forRoutes('*')`,
      right after `securityHeaders` (:198). Registering it here, not in `main.ts`, means the
      contract and e2e test apps (`createTestApp`) get it too.
    - **Scope.** It applies only when the path of `req.originalUrl` (query stripped) starts with
      `/api/`. `req.path` is not used, because it is mount-relative inside Nest middleware.
    - **What the wrapped `res.json(body)` does, in order:**
      1. `res.vary('Accept-Encoding')`;
      2. if `Content-Encoding` is already set, `req.method === 'HEAD'` or `!acceptsGzip(req)`,
         call the original `res.json`;
      3. `text = JSON.stringify(body)`. If `text === undefined`, call the original `res.json`.
      4. If `Buffer.byteLength(text) < thresholdBytes`, set the `Content-Type` (step 5 rule) and
         `res.send(text)`, so the body is not stringified twice.
      5. set `Content-Type: application/json; charset=utf-8` unless one is already set;
      6. if `req.app.get('etag fn')` is a function and no `ETag` is set, set `ETag` to
         `fn(text, 'utf8')`, the same weak ETag Express would send;
      7. if `req.fresh`, answer `304` with no body;
      8. otherwise run async `zlib.gzip(text)`, then set `Content-Encoding: gzip` and
         `Content-Length`, then `res.end(gz)`;
      9. if gzip fails, `res.send(text)` uncompressed.
    - **Documentation.** `API_GZIP_MIN_BYTES` is documented in `server/.env.example`.
    - **Contract suite.** The contract `global-setup.ts` sets `API_GZIP_MIN_BYTES=1`, so every
      contract answer to a gzip-accepting client is gzipped whatever the fixture size. superagent
      decodes it, so other rows are unaffected. The below-threshold case is covered by scenarios.
    - **Excluded by construction:** streamed `@Res()` routes, log parts, precompressed static and
      downloads, because none of them goes through `res.json`.
11. **Shared `acceptsGzip`.** It moves unchanged from `server/src/logs/session-log-parts.service.ts:46`
    to `server/src/common/accept-encoding.ts` (exported). `session-log-parts.service.ts` imports it.

### Hook — append path

12. **State fields** on a `.claude-logs.sent.v2` entry: `appendBytes` (integer ≥ 0),
    `appendLines` (integer ≥ 0) and `appendSha256` (64 lowercase hex = sha256 of the raw file bytes
    `[0, appendBytes)`). `readManifestV2` (`upload-skip.js:111-129`) keeps all three only when
    all three are valid; otherwise it drops them. `isValidEntry` stays as it is.
13. **`sanitizeNdjson` adds `records`** (`ndjson-sanitize.js`): the count of non-blank lines it
    kept, which equals the server's `jsonb_array_length` contribution. The existing return fields
    are unchanged.
14. **`planAppend({ buf, state, appendOff, pendingChunked })`** in the new
    `hook/.claude/telemetry_tool/append-upload.js` is pure. Rules, in order:
    1. no `state`: `{kind:'full', reason:'no-state'}`;
    2. `appendOff`: `'append-off'`;
    3. `pendingChunked`: `'pending-chunked'`;
    4. `buf.length < state.bytes`: `'shorter'`;
    5. `sha256(buf[0, bytes)) !== state.sha256`: `'hash-changed'`;
    6. let `end = buf.lastIndexOf(0x0a) + 1`. If `end <= state.bytes`, return `{kind:'none',
       newState: state}`;
    7. `s = sanitizeNdjson(buf[bytes, end))` and `newState = { bytes: end, lines: state.lines +
       s.records, sha256: sha256(buf[0, end)) }`;
    8. if `s.records === 0`, return `{kind:'none', newState}`;
    9. otherwise return `{kind:'append', startLine: state.lines, delta: s.body, records:
       s.records, newState}`.
15. **`stateAfterFull(buf)`** (pure, same module).
    - Let `end = buf.lastIndexOf(0x0a) + 1`.
    - If the bytes after `end` hold a non-blank line that `JSON.parse` accepts after trimming,
      return `null` (the sent body included a record after the last newline).
    - Otherwise return `{ bytes: end, lines: sanitizeNdjson(buf[0, end)).records, sha256:
      sha256(buf[0, end)) }`.
16. **Sending a delta.**
    - **Gzip.** The pure `chooseAppendEncoding({ plainBytes, gzipBytes, gzipUnsupported,
      loopback })` in `append-upload.js` returns `'gzip'` only when all of these hold; otherwise
      it returns `'identity'`:
      - `plainBytes ≥ APPEND_GZIP_MIN_BYTES` (16384);
      - `gzipUnsupported` is not latched;
      - the server is not loopback;
      - `gzipBytes < plainBytes`.

      These are the gates of `uploadFileMaybeCompressed` (`upload-logs.js:1131`) plus the size
      threshold. `gzipBytes` is computed only when the first three hold.
    - **Reading the latch.** `gzipUnsupported` is a module `let` (`upload-logs.js:288`), so
      `upload-logs.js` exports a getter `isGzipUnsupported()`. `isLoopbackServerUrl` is already
      exported.
    - **Encoding rejection.** If a gzipped delta fails and `isEncodingRejection(result)` (which
      latches the flag) is true, the same delta is retried once uncompressed, as
      `uploadFileMaybeCompressed` does. Any other failure gives the fallback reason of Design
      Decision 18.
    - **Size limits.** The result is fallback `over-budget` when either holds:
      - the uncompressed delta is over `APPEND_MAX_PLAIN_BYTES = 512000`. A pre-append server
        parses an unknown route with its 512,000-byte global text parser (`GLOBAL_BODY_LIMIT`,
        `server/src/common/body-limits.ts:17`), so a bigger delta would get a 413 there instead of
        a 404;
      - the wire body is `> CHUNK_SIZE_BYTES` (921,600).
    - **Request.** `uploadFile` (`upload-logs.js:510`) gets a 16th positional param
      `appendStartLine`. When it is a number, the URL base is `/api/v2/logs/append` and it adds
      `&startLine=<n>`. `contentSha256` = `bodyContentSha256(delta)`.
    - **Validation messages.** The four new 400 texts from Design Decision 1 are added to
      `V2_VALIDATION_MESSAGES` (`upload-logs.js:295`).
17. **404 cooldown.**
    - **File.** `<telemetryDir>/append-off.json` holds `{ "<serverUrl without trailing slash>":
      <untilEpochMs> }`, written with temp file + rename.
    - **Functions.** `isAppendOff(telemetryDir, serverUrl, now)` and
      `markAppendOff(telemetryDir, serverUrl, now)`, with `APPEND_OFF_MS = 3_600_000`. A missing
      or malformed file counts as off = false.
    - **On a 404 or 413 from the append route:** `markAppendOff`, then one `hook.log` line
      `append route not available on <origin> (HTTP <code>) — append uploads off for 1 h`, then
      the full upload. A 413 is treated like a 404 as a safety net for old servers.
18. **`async uploadWithAppend(ctx)`** is the orchestrator for the three call sites.
    - **Input.** `ctx = { buf, state, manifestKey, serverUrl, apiKey, namespace, sessionId,
      parentSessionId, workflowRunId, agentMeta, timeoutMs, hookSessionId, cwd, telemetryDir }`.
      - `buf` is the raw file `Buffer` and `state` is the v2 entry's append state or null.
      - `snapshotQuery` is not needed: append is never used for `artisyn`.
      - Inside the module, `pendingChunked` is read from `.claude-logs.pending` for `manifestKey`
        (the reader at `upload-logs.js:793`) and `appendOff` from `isAppendOff(telemetryDir,
        serverUrl, Date.now())`.
      - The gzip latch and the loopback test come from `isGzipUnsupported()` and
        `isLoopbackServerUrl()` (Design Decision 16).
      - It logs through the existing `hookLog`.
    - **Output.** One of:
      - `{ kind: 'none', newState }`: no request;
      - `{ kind: 'appended', result, newState, records, startLine, plainBytes, wireBytes }`: a 2xx;
      - `{ kind: 'full-needed', reason }`: the caller runs its existing full upload and stores
        `stateAfterFull(buf)`.
    - **Fallback `reason` values:**
      - from `planAppend`: `no-state`, `append-off`, `pending-chunked`, `shorter`,
        `hash-changed`;
      - from sending: `over-budget`, `route-missing` (404/413), `http-<status>` (any other
        non-2xx), `timeout`, `network` (any other request error with no status), `error` (an
        exception).
      - The caller adds `failed-feedback` (Design Decision 19).
19. **`failedUploads` rule.** This replaces the `keepKey` exemption for append state.
    - After an append 2xx whose `failedUploads` contains this file's `{sessionId, type}`, the
      caller runs the full upload at once, with reason `failed-feedback`.
    - After a full upload whose `failedUploads` contains it, the v2 entry is stored without the
      append fields.
    - Other keys are handled as today (`forgetFailedUploadsInMaps`, which drops the whole entry).
20. **Call sites.**
    - **Stop scan.** `processFile` (`send-logs-hook.js:2256`), for namespaces `claude` /
      `claude-subagent` only.
    - **Prompt upload.** The session's own transcript (`prompt-upload-hook.js:167-204`).
    - **`SessionEnd` flush.** The session's own transcript (`send-logs-hook.js:1526`).
    - **Scoped-path state.** The scoped paths read the state from `readManifestV2`. They record it
      with `recordScopedClaudeUpload(telemetryDir, sessionId, readSize, preReadMtimeMs,
      appendState)`, a new optional 5th argument written as the three fields; a `null` argument
      writes none. On the append path the recorded `size` is the read size.
    - **Unchanged:** `artisyn`, `tool-calls`, `claude-otel` and `.meta.json`.
    - **Order in `processFile`.**
      1. stat, then `decideUploadSkip`, unchanged; a skipped file never reaches the append path;
      2. `readFileSync` gives `buf`;
      3. for `claude` / `claude-subagent`, `uploadWithAppend`;
      4. on `none`, write v1 = read size and v2 = `{size: readSize, mtimeMs: statMtimeMs,
         paramsSha256, ...newState as append fields}`, count the file as skipped and send nothing;
      5. on `appended`, apply Design Decision 19, then write the same entries with `newState`;
      6. on `full-needed`, the existing sanitize → upload → manifest code runs. On success it
         writes v2 with `stateAfterFull(buf)` fields, unless that is `null` or Design Decision 19
         says otherwise.
    - **Scoped paths.** They follow the same order without `decideUploadSkip`. They record only
      when the existing scoped-path recording rule allows it.
21. **`hook.log` lines.**
    - Append:
      `<key>: appended <records> lines from line <startLine>: <plainBytes> B → <wireBytes> B gz`,
      or `… <plainBytes> B uncompressed`. The byte counts are exact integers, so a scenario can
      compare them with the delta size.
    - Fallback: `<key>: append not used (<reason>) — full upload`, with the reasons of Design
      Decision 18. It is not written for the reason `no-state`.
22. **Version.** Hook `3.2.0` → `3.3.0`. The last release, `v1.5.1`, ships `3.1.0`; `3.2.0` was
    never released, so the compatibility baseline is `3.1.0`.

### Contract runner

23. **`ExpectSpec.headers?: Record<string, string | null>`** (`server/test/contract/types.ts:155`),
    checked in `run-case.ts` next to `bodyText` (:837). Header names are case-insensitive. A
    string value must be contained in the response header value (case-insensitive); `null` means
    the header must be absent. superagent sends `Accept-Encoding: gzip, deflate` by default. A row
    can send `Accept-Encoding: identity` through the case's existing `headers`.

### Algorithm row shapes

24. **`docs/algorithm-examples/ingest-append.json`**
    - Rows: `{ id: "IA-NN", input: { stored: null | { receivedAt: ISO|null, lineCount:
      int|null }, rowReceivedAt: ISO, startLine: int }, expected: { decision } }`.
    - Required rows, at least one each: no stored log; stale (older than stored);
      equal time not stale; NULL stored time; count mismatch below and above; NULL count;
      a match gives `append`.
25. **`hook-upload-skip.json`** gets new kinds.
    - **`append`:** input `{ kind:'append', file: "<utf8 text>", state: null | { bytes, lines,
      sha256Of: "<utf8 text>" }, appendOff, pendingChunked }`.
      - The test computes `state.sha256 = sha256(sha256Of)`.
      - Expected: `{ kind, reason?, startLine?, delta?: "<utf8>", newState?: { bytes, lines } }`.
        The test also asserts `newState.sha256 === sha256(file[0, newState.bytes))`.
      - Rows cover every Design Decision 14 rule: no state; off; pending; shorter; hash changed;
        no growth; partial tail only; blank/malformed-only tail; a normal delta; a delta after a
        blank and a torn line in the prefix; CRLF lines.
    - **`append-state`:** input `{ kind:'append-state', file }`, expected `{ state: null |
      { bytes, lines } }`.
      - Rows: ends with a newline; a parseable partial tail; an unparseable partial tail; blank
        lines.
    - **`append-encoding`:** input `{ kind:'append-encoding', plainBytes, gzipBytes,
      gzipUnsupported, loopback }`, expected `{ encoding }`.
      - Rows: 16383 bytes gives identity and 16384 gives gzip; latched gives identity; loopback
        gives identity; gzip not smaller gives identity.
      - This kind covers FR-9a, because the scenario fake hub is loopback and never sees gzip.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/drizzle/migrations/0097_upload_queue_start_line.sql` | add `start_line` | hand-written, `COMMENT ON COLUMN` |
| `server/drizzle/migrations/meta/_journal.json` | migration entry | per `docs/knowledgebase/db-schema-code.md` |
| `server/src/database/schema/index.ts` | `uploadQueue.startLine` | :2119 |
| `docs/knowledgebase/db_state.sql` | regenerated | `db-state-update` skill |
| `server/src/logs/ingest-append.ts` | **new** `decideIngestAppend` | Design Decision 6 |
| `server/src/logs/ingest-append.algo.spec.ts` | **new** table test | mirrors `ingest-skip.algo.spec.ts` |
| `server/src/logs/ingest-version.ts` | `UpsertIngestMeta` nullable hash + `appendStartLine` | Design Decision 7 |
| `server/src/logs/logs.service.ts` | append mode in `upsert`, `upload-full` result | Design Decision 7 |
| `server/src/logs/upload-queue.service.ts` | `saveRawUpload` startLine, superseding, warnings, feedback delete, `UPLOAD_FULL_REASON` | Design Decisions 5, 9 |
| `server/src/logs/upload-queue-scheduler.service.ts` | claim rule, append branch, `failUploadFull` | Design Decisions 4, 8, 9 |
| `server/src/logs/upload-queue-stats.constants.ts` | outcome `upload-full` | :51 |
| `server/src/admin/upload-queue-admin.service.ts` | `reprocessFailed` skips `upload-full` | :171 |
| `server/src/logs/logs-v2.controller.ts` | `postLogsAppend`, `stageSingleUpload` | Design Decision 1 |
| `server/src/common/body-limits.ts` | `LOG_INGEST_ROUTES` entry | Design Decision 2 |
| `server/src/common/accept-encoding.ts` | **new**, `acceptsGzip` moved here | Design Decision 11 |
| `server/src/common/json-gzip.ts` | **new** middleware | Design Decision 10 |
| `server/src/logs/session-log-parts.service.ts` | import shared `acceptsGzip` | |
| `server/src/app.module.ts` | register middleware in `configure()` | after `securityHeaders` :198 |
| `server/.env.example` | document `API_GZIP_MIN_BYTES` | |
| `server/test/contract/setup/global-setup.ts` | `API_GZIP_MIN_BYTES=1` | next to the other env lines :113–140 |
| `tests/fixtures/legacy-hooks/README.md` | row for `3.1.0` (`v1.5.1`) | |
| `hook/.claude/telemetry_tool/append-upload.js` | **new** module | Design Decisions 14–18 |
| `hook/.claude/telemetry_tool/ndjson-sanitize.js` | `records` | Design Decision 13 |
| `hook/.claude/telemetry_tool/upload-skip.js` | append fields read/write, `recordScopedClaudeUpload` 5th arg | Design Decisions 12, 20 |
| `hook/.claude/telemetry_tool/upload-logs.js` | `appendStartLine` param, validation messages | Design Decision 16 |
| `hook/.claude/telemetry_tool/send-logs-hook.js` | Stop scan + `SessionEnd` flush use append | Design Decisions 18–21 |
| `hook/.claude/telemetry_tool/prompt-upload-hook.js` | own transcript uses append | Design Decision 20 |
| `hook/.claude/telemetry_tool/version.json` | `3.3.0` | Design Decision 22 |
| `hook/.claude/telemetry_tool/__tests__/upload-skip.algo.test.js` | `append`, `append-state` kinds | Design Decision 25 |
| `.artisyn/marketplace/plugins/log-hub-hooks/` (`scripts/`, `plugin.json`) | dogfooded copy | `.claude/rules/hook.md` |
| `docs/algorithm-examples/ingest-append.json` | **new** rows | Design Decision 24 |
| `docs/algorithm-examples/hook-upload-skip.json` | new rows | Design Decision 25 |
| `docs/knowledgebase/algorithms/ingest-append.md` | **new** algorithm doc | OKF `type: "Algorithm"` |
| `docs/knowledgebase/algorithms/hook-upload-skip.md`, `algorithms/README.md`, `index.md` | doc rows | |
| `docs/knowledgebase/upload-queue.md`, `hook-api-versioning.md`, `hook-system-overview.md`, `server-endpoint-map.md`, `static-asset-serving.md` | KB updates | Chunk 9 |
| `server/test/contract/types.ts`, `run-case.ts` | `expect.headers` | Design Decision 23 |
| `server/test/contract/registry/f15-ingest.ts`, `f25-otel.ts`, `f17-sessions.ts` | rows | |
| `tests/scenarios/helpers/ingest.ts` | `postLogsAppend` helper | next to `postLogs` :24 |
| `tests/scenarios/ingest/s-ingest-02.spec.ts`, `-03`, `-04` | steps | |
| `tests/scenarios/hook/s-hook-01.spec.ts`, `s-compat-01.spec.ts` | steps | |
| `tests/fixtures/legacy-hooks/3.1.0/` | frozen hook | `scripts/scenarios/freeze-legacy-hook.mjs --commit v1.5.1` |
| `tests/scenarios/view/s-otel-01.spec.ts`, `s-sess-03.spec.ts` | gzip steps | |

## API changes

**New: `POST /api/v2/logs/append`** (API key, `X-API-Key`)

- Query:
  - `sessionId`, `type` (`claude` | `claude-subagent`): required;
  - `startLine`: required, integer ≥ 0, at most 9 digits;
  - optional, parsed exactly as in `postLogs`: `parentSessionId`, `workflowRunId`,
    `agentDescription`, `workflowPhase`, `snapshotId`, `snapshotFull`, `okfSnapshotId`,
    `okfSnapshotFull`, `contentSha256` (sha256 of the delta body), `uploadFeedback` (`1`). The
    hook sends none of the snapshot params on this route.
- Body: NDJSON text (`text/plain` / `application/x-ndjson`), optionally `Content-Encoding: gzip`.
- Answers:
  - `201 { warnings: string[], failedUploads?: {sessionId, type}[], unknownSnapshotId?,
    unknownOkfSnapshotId? }`: the same TypeScript return type as the non-chunked `postLogs`
    branch;
  - a foreign session gets `201 { warnings }`;
  - a deleted session gets `deletedSessionAnswer` (`{ warnings, sessionDeleted: true, … }`);
  - `400` with the texts of Design Decision 1;
  - `401` without a key.
- A start-line mismatch is never a synchronous status; it arrives later through `failedUploads`.

**Changed: every `/api/*` JSON answer.**

- An answer of at least `API_GZIP_MIN_BYTES` bytes (default 8192) to a client that accepts gzip
  gets `Content-Encoding: gzip`. HEAD answers are not compressed.
- Every `/api/*` answer sent through `res.json` gets `Vary: Accept-Encoding`.
- The bodies themselves are unchanged.

## Database changes

`0097_upload_queue_start_line.sql`:

```sql
ALTER TABLE upload_queue ADD COLUMN start_line integer;
COMMENT ON COLUMN upload_queue.start_line IS 'Append upload: the 0-based record index the staged delta starts at (POST /api/v2/logs/append); NULL = whole-file upload.';
```

- **Data and rollback:** nullable with no default, so existing rows and old hooks stay NULL and no
  backfill is needed. A rollback is `DROP COLUMN`. No index.
- **Trigger:** the `logs_body_guard` trigger (`0096_logs_streaming_skip_tombstones.sql:42-56`)
  already keeps `body_sha256 = NULL` when an update also writes a new `body_received_at`, and it
  advances `body_rev`.

## Test coverage plan

Only the three kinds the policy allows.

- **Algorithm**
  - **New `ingest-append`.** New doc `docs/knowledgebase/algorithms/ingest-append.md`, rows
    `docs/algorithm-examples/ingest-append.json` and table test
    `server/src/logs/ingest-append.algo.spec.ts`. The function is new, so all three files are new
    together, as the policy allows.
  - **Extended `hook-upload-skip`.** New row kinds `append`, `append-state` and `append-encoding`
    for `planAppend` / `stateAfterFull` / `chooseAppendEncoding`. The existing test file
    `upload-skip.algo.test.js` gets three `case`s.
- **API contract**
  - **`f15-ingest.ts`, new rows for `POST /api/v2/logs/append`:**
    - 201: a staged row with `start_line`;
    - 400: missing `startLine`, bad `startLine`, a non-claude type, an empty body;
    - a foreign session;
    - a deleted session;
    - 401.
  - **`f25-otel.ts`:** session OTEL, repository OTEL and team OTEL rows with `expect.headers`
    (`gzip` + `Vary`), plus one identity row (`Accept-Encoding: identity`).
  - **`f17-sessions.ts`:** the same for the parts manifest and the sessions list, plus one
    identity row.
  - The runner gains `expect.headers` (Design Decision 23). The suite runs with
    `API_GZIP_MIN_BYTES=1`, so the threshold itself is covered by scenarios.
- **Scenario**
  - **`s-ingest-02`, FR-4a/4d/5/9 (server side, raw HTTP):**
    - full + deltas equals a single full upload (body and derived figures);
    - `body_sha256` is NULL, `body_received_at` and `body_rev` after a delta;
    - the next full upload is processed;
    - a stale append is discarded silently;
    - append rows are never superseded and are applied in order after an earlier full row;
    - two concurrent deltas end in one `upload-full` and a full re-upload gives one copy of every
      line.
  - **`s-ingest-03`:** the append route's 400s.
  - **`s-ingest-04`:** an `upload-full` row is delivered once through `failedUploads`, gives no
    `warnings` entry and no `broken-upload-file`, is gone after delivery and has the `upload-full`
    measurement.
  - **`s-hook-01`** (fake hub):
    - FR-1/2/3: the delta body and `hook.log` byte counts; the partial last line goes next turn;
      0 records means no request;
    - FR-4: blank and torn lines in the prefix;
    - FR-6: every fallback trigger;
    - the 404 cooldown;
    - FR-9a: a loopback delta goes uncompressed. The gzip choice itself is covered by the
      `append-encoding` rows, and a gzipped delta stored identically by `s-ingest-02`;
    - FR-10: `artisyn`, `.meta.json` and `tool-calls` stay on the full route.
  - **`s-compat-01`:** the frozen `3.1.0` hook against the new server (two Stops, the body is
    correct), and the current hook against the stand (append path, the body equals the file).
  - **`s-otel-01`, `s-sess-03`:** FR-11/12 gzip vs identity, decoded JSON identical.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | DB schema: `upload_queue.start_line` | 4 | first; everything server-side reads the column |
| 2 | Server ingest: append decision + `upsert` append mode | 4 | needs 1 |
| 3 | Server queue service: staging, superseding, `upload-full` delivery | 6 | needs 1, 2 |
| 4 | Server queue worker: claim rule + append branch | 4 | needs 2, 3 |
| 5 | Server API: append route | 4 | needs 3 |
| 6 | Server JSON gzip middleware | 4 | independent of 1–5 |
| 7 | Hook core: state, sanitize count, append module, transport | 7 | builds against API changes / Design Decisions 1, 12–19 |
| 8 | Hook call sites, version and packaging | 7 | needs 7 |
| 9 | KB and docs | 7 | after code |
| 10 | Tests: algorithm tables | 5 | needs 2, 7 |
| 11 | Tests: contract runner + rows | 5 | needs 5, 6 |
| 12 | Tests: server ingest scenarios | 5 | needs 1–5 |
| 13 | Tests: hook scenarios + compat | 6 | needs 7, 8 |
| 14 | Tests: gzip scenarios | 4 | needs 6 |

### Chunk 1 — DB schema: `upload_queue.start_line`
- [ ] Create `server/drizzle/migrations/0097_upload_queue_start_line.sql` with the SQL in Database changes (hand-written, follow `migrations-data-integrity` skill).
- [ ] Register the migration in `server/drizzle/migrations/meta/_journal.json` the way `0096_logs_streaming_skip_tombstones` is registered (see `docs/knowledgebase/db-schema-code.md`; never `drizzle-kit generate`).
- [ ] Add `startLine: integer('start_line')` to `uploadQueue` in `server/src/database/schema/index.ts` (:2119).
- [ ] Apply the migration to the local dev DB and run the `db-state-update` skill to regenerate `docs/knowledgebase/db_state.sql`.

### Chunk 2 — Server ingest: append decision + `upsert` append mode
- [ ] Create `server/src/logs/ingest-append.ts` exporting `decideIngestAppend` and its input/output types exactly per Design Decision 6.
- [ ] In `server/src/logs/ingest-version.ts` change `UpsertIngestMeta` to `{ bodySha256: string | null; receivedAt: Date; appendStartLine?: number }` per Design Decision 7; fix any type fallout.
- [ ] In `LogsService.upsert` (`logs.service.ts:483`) add the append branch after `lockAndUpsertSession` per Design Decision 7 (line-count query, `decideIngestAppend`, `stale` → superseded, `append` → stored body + delta lines).
- [ ] Add the private `AppendMismatch` error thrown inside the transaction and caught outside it to return `{ status: 'upload-full' }`; add `'upload-full'` to `UpsertResult.status` (:100) and fix every `UpsertResult` consumer the typecheck flags (Design Decision 8 "Other consumers").

### Chunk 3 — Server queue service: staging, superseding, `upload-full` delivery
- [ ] `saveRawUpload` (`upload-queue.service.ts:149`): add the 4th positional parameter `startLine: number | null = null` (after `contentSha256`) and write it to `start_line`.
- [ ] Export `UPLOAD_FULL_REASON = 'upload-full'` from `upload-queue.service.ts`; add `'upload-full'` to `UploadQueueMeasurementOutcome` (`upload-queue-stats.constants.ts:51`).
- [ ] `deleteSupersededRows` (:568): add `AND start_line IS NULL` to the inner SELECT (Design Decision 5).
- [ ] `getPendingWarnings` (:482): exclude rows whose `error_message` is `UPLOAD_FULL_REASON` (`IS DISTINCT FROM`).
- [ ] `takeFailedUploadsForFeedback` (:526): also return `id, error_message`, then delete the returned rows with `error_message = UPLOAD_FULL_REASON`; feedback shape unchanged (Design Decision 9).
- [ ] `reprocessFailed` in `server/src/admin/upload-queue-admin.service.ts` (:171): skip rows whose `errorMessage` is `UPLOAD_FULL_REASON`; leave `clearFailed` as is.

### Chunk 4 — Server queue worker: claim rule + append branch
- [ ] Add `start_line: number | null` to `UploadQueueRawRow` (`upload-queue-scheduler.service.ts:38`).
- [ ] `claimNextPendingRow` (:354): add the first-pick `NOT EXISTS` guard and restrict the coalescing jump to `start_line IS NULL` rows, both per Design Decision 4.
- [ ] `processRow` (:408): for `row.start_line !== null` skip `checkUnchanged` and call `upsert` with `{ bodySha256: null, receivedAt, appendStartLine: row.start_line }`; map results per Design Decision 8.
- [ ] Add `failUploadFull(row, filePath, startedAt)` modelled on `failContentHashMismatch` (:668), behaving exactly per Design Decision 9.

### Chunk 5 — Server API: append route
- [ ] In `logs-v2.controller.ts` extract the non-chunked branch of `postLogs` into private `stageSingleUpload(...)` per Design Decision 1; `postLogs` keeps identical behaviour.
- [ ] Add `@Post('logs/append') postLogsAppend(...)` (201, `ApiKeyAuthGuard`) with the query params and the check order of Design Decision 1, calling `stageSingleUpload` with the parsed `startLine`.
- [ ] Use the exact 400 texts of Design Decision 1 (`Append is supported only for claude and claude-subagent logs`, `Missing startLine query parameter`, `startLine must be a non-negative integer`).
- [ ] Add `{ path: 'api/v2/logs/append', method: RequestMethod.POST }` to `LOG_INGEST_ROUTES` in `server/src/common/body-limits.ts` (:48).

### Chunk 6 — Server JSON gzip middleware
- [ ] Create `server/src/common/accept-encoding.ts` exporting `acceptsGzip(req)` moved unchanged from `session-log-parts.service.ts:46`; import it there.
- [ ] Create `server/src/common/json-gzip.ts` with `apiGzipMinBytes()` and `createJsonGzipMiddleware({ thresholdBytes })` implementing Design Decision 10 step by step.
- [ ] Register the middleware in `AppModule.configure()` (`server/src/app.module.ts`) right after `securityHeaders` (:198), per Design Decision 10 "Registration".
- [ ] Document `API_GZIP_MIN_BYTES` (default 8192, minimum gzip size of `/api` JSON answers) in `server/.env.example`.

### Chunk 7 — Hook core: state, sanitize count, append module, transport
- [ ] `ndjson-sanitize.js`: add `records` (non-blank kept lines) to the `sanitizeNdjson` result per Design Decision 13.
- [ ] `upload-skip.js`: `readManifestV2` keeps `appendBytes` / `appendLines` / `appendSha256` when all valid (Design Decision 12); `writeManifestV2` writes them when present.
- [ ] `upload-skip.js`: `recordScopedClaudeUpload` takes an optional 5th `appendState` (`{bytes, lines, sha256}` or null) written as the three fields (Design Decision 20).
- [ ] `upload-logs.js`: add the 16th `uploadFile` param `appendStartLine`, the four new 400 texts in `V2_VALIDATION_MESSAGES` and the exported getter `isGzipUnsupported()`, per Design Decision 16.
- [ ] Create `append-upload.js` with pure `planAppend`, `stateAfterFull` and `chooseAppendEncoding` exactly per Design Decisions 14–16, exported for the algorithm test.
- [ ] In `append-upload.js` add `isAppendOff` / `markAppendOff` and `APPEND_OFF_MS` per Design Decision 17.
- [ ] In `append-upload.js` add `uploadWithAppend(ctx)` per Design Decisions 16–18: `APPEND_GZIP_MIN_BYTES = 16384`, `APPEND_MAX_PLAIN_BYTES = 512000`, the over-budget checks, 404/413 → `markAppendOff`, the reason values.

### Chunk 8 — Hook call sites, version and packaging
- [ ] `send-logs-hook.js` `processFile` (:2256): for `claude` / `claude-subagent` call `uploadWithAppend` before the full upload; record v1 + v2 entries with the append state, per Design Decisions 18–21.
- [ ] Apply the `failedUploads` rule of Design Decision 19 in `processFile`, the prompt upload and the `SessionEnd` flush.
- [ ] `runSessionEndFlush` (`send-logs-hook.js:1526`) and `prompt-upload-hook.js` (:167–204): use `uploadWithAppend` for the session's own transcript and pass the state to `recordScopedClaudeUpload`.
- [ ] Add the `hook.log` append and fallback lines of Design Decision 21 (next to `formatUploadResultLine`, :1421).
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `3.3.0`, run `npm run build:hooks-installer`, refresh `.artisyn/marketplace/plugins/log-hub-hooks/` (`scripts/` + `plugin.json` version) per `.claude/rules/hook.md`.
- [ ] Run the `update-install-instructions` skill for the hook change.
- [ ] Run `npm test` in `hook/` and fix failures.

### Chunk 9 — KB and docs
- [ ] `docs/knowledgebase/upload-queue.md`: new "Append rows" section (`start_line`, claim rule, no coalescing/superseding, `upload-full` lifecycle, measurement outcome), per Design Decisions 3–9.
- [ ] `docs/knowledgebase/hook-api-versioning.md`: the route under "why a new route", the 3.3.0 compatibility-matrix row (old server → 404/413 → full + 1 h off; deltas capped at 512,000 bytes), new 400 texts, `LOG_INGEST_ROUTES` entry.
- [ ] `docs/knowledgebase/hook-system-overview.md` "Upload pipeline": the append path, manifest fields, `append-off.json`, the three call sites, the fallback list.
- [ ] `docs/knowledgebase/static-asset-serving.md` §6: record the API-compression decision (`res.json` wrapper, why not `compression`, PoC link) instead of "still open".
- [ ] `docs/knowledgebase/server-endpoint-map.md`: `POST /api/v2/logs/append` row; "Cross-cutting behaviour" gzip rule for `/api` JSON answers.
- [ ] Write `docs/knowledgebase/algorithms/ingest-append.md` (OKF `type: "Algorithm"`, same sections as `ingest-hash-skip.md`) and update `hook-upload-skip.md` with `planAppend` / `stateAfterFull`.
- [ ] Add `ingest-append` to `docs/knowledgebase/algorithms/README.md` and `docs/knowledgebase/index.md`; update `hook-upload-skip` lines there to mention `append-upload.js`.

### Chunk 10 — Tests: algorithm tables
- [ ] Create `docs/algorithm-examples/ingest-append.json` with the rows of Design Decision 24.
- [ ] Create `server/src/logs/ingest-append.algo.spec.ts` mirroring `ingest-skip.algo.spec.ts`, loading `ingest-append` rows and asserting `decideIngestAppend`.
- [ ] Add `append`, `append-state` and `append-encoding` rows to `docs/algorithm-examples/hook-upload-skip.json` per Design Decision 25.
- [ ] Add the three cases to `hook/.claude/telemetry_tool/__tests__/upload-skip.algo.test.js` (importing from `../append-upload`) per Design Decision 25.
- [ ] Run `npm run test` in `server/` and `npm test` in `hook/`; fix failures.

### Chunk 11 — Tests: contract runner + rows
- [ ] Add `headers?: Record<string, string | null>` to `ExpectSpec` (`server/test/contract/types.ts:155`) and its check in `run-case.ts` next to `bodyText` (:837), per Design Decision 23.
- [ ] `registry/f15-ingest.ts`: rows for `POST /api/v2/logs/append` listed in Test coverage plan, following the existing `POST /api/v2/logs` rows.
- [ ] Set `process.env.API_GZIP_MIN_BYTES = '1'` in `server/test/contract/setup/global-setup.ts` next to the other env lines (:113–140), per Design Decision 10 "Contract suite".
- [ ] `registry/f25-otel.ts` and `registry/f17-sessions.ts`: add `expect.headers` (`Content-Encoding: gzip`, `Vary: Accept-Encoding`) to session / repository / team OTEL, parts-manifest (:898) and sessions-list (:60) rows, plus one identity row each (`Accept-Encoding: identity` → `Content-Encoding: null`).
- [ ] Run `npm run test:contract` from `server/` and fix failures.

### Chunk 12 — Tests: server ingest scenarios
- [ ] Add `postLogsAppend(api, {sessionId, type, startLine, body, gzip?, contentSha256?})` to `tests/scenarios/helpers/ingest.ts` next to `postLogs` (:24).
- [ ] `s-ingest-02.spec.ts`: steps: full + deltas equal one full upload (body, stats, workflows, tool usage, cost); after a delta `body_sha256` NULL, `body_received_at` = the row's `received_at`, `body_rev` advanced; the next full upload is processed, not skipped; an older append leaves the body unchanged and is absent from `failedUploads`.
- [ ] `s-ingest-02.spec.ts`: steps: append rows never superseded and applied in order after an earlier full row; a gzipped delta (`postLogsAppend` with `gzip: true`) stored identically; two concurrent same-`startLine` deltas end with exactly one copy of every line after the full re-upload.
- [ ] `s-ingest-03.spec.ts`: steps for the append route's 400s (empty body, missing / bad `startLine`, non-claude type).
- [ ] `s-ingest-04.spec.ts`: a mismatching delta becomes `upload-full`, is delivered once via `failedUploads`, gives no `warnings` entry and no `broken-upload-file`, then the row is gone; then run the three scenarios (`--only scenarios --grep`).

### Chunk 13 — Tests: hook scenarios + compat
- [ ] `s-hook-01.spec.ts`: an append step: 5 MB transcript uploaded, 20 lines added, one `/append` request carrying only them, and `hook.log` byte counts equal to the delta; the partial last line goes next turn; a 0-record growth sends nothing.
- [ ] `s-hook-01.spec.ts`: a blank and a torn line in the uploaded prefix still give the append path; against the loopback hub a 20,000-byte delta goes uncompressed (gzip selection itself is the `append-encoding` algorithm rows).
- [ ] `s-hook-01.spec.ts`: one step per fallback trigger (no state, shorter file, edited line, `failedUploads` entry, 5xx, timeout, over-budget tail, pending chunked upload), each ending in a full upload of the whole file.
- [ ] `s-hook-01.spec.ts`: the hub answers 404 on `/append` → a full upload, `append-off.json` is written, the next Stop is full; the same for 413; `artisyn`, `.meta.json`, `tool-calls` stay on `/api/v2/logs`.
- [ ] Freeze the `3.1.0` hook (`node scripts/scenarios/freeze-legacy-hook.mjs --commit v1.5.1`) and add its row to `tests/fixtures/legacy-hooks/README.md`; `s-compat-01.spec.ts`: a step where it does two Stops on a growing transcript against the stand and the body is correct.
- [ ] `s-compat-01.spec.ts`: the current hook against the stand appends on the second Stop and the stored body equals the file; then run `s-hook-01` and `s-compat-01` (`--only scenarios --grep`).

### Chunk 14 — Tests: gzip scenarios
- [ ] `s-otel-01.spec.ts` (:216, :1071): first upload one extra OTEL chunk of 200 spans (each with a 100-character attribute) to the step's session, then assert session, repository and team OTEL answer `gzip` + `Vary` to a gzip client and identity without `Accept-Encoding`, with identical decoded JSON.
- [ ] `s-sess-03.spec.ts` (:1064): the parts manifest and the sessions list answer `gzip` + `Vary` above 8192 bytes and identity (with `Vary`) for a small answer and without `Accept-Encoding`.
- [ ] `s-sess-03.spec.ts`: a log-part download is not compressed twice (one gunzip parses) and the streamed `/logs` answer gets no `Content-Encoding`.
- [ ] Run `s-otel-01` and `s-sess-03` (`--only scenarios,contract --grep`) and fix failures.

Post-release (not a chunk; acceptance check outside the implement loop): once the release is on the
Pi, record in `notes.md` the OTEL tab of session `9fc6b5cc` (bytes transferred and the median of 3
cold loads) against the before value already in `notes.md`.
