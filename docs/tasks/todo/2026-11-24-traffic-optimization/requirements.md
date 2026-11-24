---
type: "Task"
title: "Traffic Optimization: Append Uploads and Compressed Large Answers"
description: "Cut traffic where it hurts: the hook uploads only the new lines of a growing session log (full-upload fallback on anything suspicious), and large API answers (session OTEL first) are compressed."
---

# 2026-11-24: Traffic Optimization: Append Uploads and Compressed Large Answers

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** hook, server
**Owner:** denistsyplakov
**Created:** 2026-11-24
**Tracker:** GH-169 https://github.com/DataArt/artisyn-log-hub/issues/169

## Description

Two traffic problems found while checking task `2026-11-23-session-logs-streaming` on the Pi,
kept in one task at the user's request:

- **Part A — hook uploads** (the main one): after every turn the hook reads, sanitizes, hashes,
  gzips (synchronous `zlib.gzipSync`) and re-sends the whole growing transcript (~5 MB per turn
  for a 6-hour session), so the cost per session is ~quadratic on the developer's machine.
- **Part B — session OTEL tab**: `GET …/sessions/:sessionId/otel` answers ~9 MB of uncompressed
  JSON (almost all `spans`) for a 6-hour session and the tab takes ~11 s on the Pi; the server has
  no response compression for JSON. The rest of the server load is not a concern, but OTEL must
  open quickly.

Part A approach:

- The append path is an extra mechanism on top of the existing full upload: on anything wrong or
  suspicious the hook falls back to the full upload, so correctness never depends on the new path
  (hard user requirement).
- Only the transport and the hook's own work become proportional to the new lines; server-side
  computation stays full, because server load is not critical (a team may not open Log Hub for
  days).
- All append state is the hook's; the server keeps no hashes and no per-log append state (the
  queue row's own `start_line` is not such state).
- The append is a new route, not a parameter on the old one, because an old server would store
  the delta as the whole body.

## Functional Requirements

Part A — hook append uploads:

- **FR-1 Append path.** For a log file the server already holds, the hook sends only the complete
  lines added since its last successful upload (append or full) instead of the whole file. When
  the new complete lines hold 0 records (no growth, only a partial trailing line, or only blank /
  malformed lines), the hook sends no request for that file and still moves `bytes` / `hash`
  past the complete lines; the server answers 400 to an empty append body (→ full upload, FR-6).
- **FR-2 Only the delta is processed.** The prefix already sent is only read to re-hash it; it is
  never re-sanitized, re-compressed or re-sent.
- **FR-3 Complete lines only.** A trailing line without its newline (being written) is not sent; it
  goes with the next upload.
- **FR-4 Hook-side check.** The hook stores, per file, the bytes and lines it has uploaded and
  the hash of those bytes. Before an upload it hashes the same byte range of the current file; the
  delta is sent only when the hash is unchanged.
  - `bytes` is the raw-file offset just after the last newline processed; `hash` is the sha256 of
    the raw file bytes `[0, bytes)`. Both stay hook-side only and are never compared with server
    state. The full upload itself is unchanged: `lines` is the record count it actually sent, and
    append state is stored only when the sent body ended exactly at a newline; otherwise (a
    trailing line without newline that still parsed) no state is stored and the next upload is full.
  - The state lives as new optional fields (e.g. `appendBytes`, `appendLines`, `appendSha256`) on
    the file's existing manifest-v2 entry in `.claude-logs.sent`; `forgetFailedUploads*` removes
    them with the entry, older hooks ignore them, and missing or malformed fields mean "no state".
  - A "line" (the stored line count, the delta's start line and the server's count) is one stored
    JSON record: a non-blank line kept by `sanitizeNdjson`, i.e. what ends up as an element of
    `logs.body` (`jsonb_array_length`). Blank and malformed lines are not counted.
- **FR-4a Server-side check, through the upload queue.** The delta carries the number of the line
  it starts at. Like the full route, the append route only stages the delta in the upload queue and
  answers 2xx before it is processed; the check and the append run in the queue worker. Append rows
  are kept out of coalescing (they are never `superseded` and never supersede a full row) and are
  processed in arrival order after any earlier full row of the same log. The worker appends only
  when `startLine` equals the number of lines it holds for that log; otherwise it marks the row
  `failed` with reason `upload-full` and changes nothing. That failure reaches the hook later
  through the existing `uploadFeedback` / `failedUploads` channel, so the fallback to a full upload
  happens one turn late; this is accepted, the mismatch is expected to be rare.
  - `upload_queue` gets a nullable `start_line integer` column (new migration; NULL = full upload,
    set = append row; old rows and old hooks keep NULL). Rows with `start_line IS NOT NULL` are
    skipped by the coalescing pick in `claimNextPendingRow`, by `deleteSupersededRows` and by the
    superseded measurements.
  - Rows of one `(user_id, session_id, log_type)` key run one at a time in `received_at, id`
    order: a row is not claimed while its key has an older `pending` / `processing` row. The
    start-line check and the append run under the tree lock `upsert` already takes.
  - An `upload-full` row is `status = 'failed'`, `error_kind = 'server'`,
    `error_message = 'upload-full'`; its staged delta is deleted at once. It is delivered once
    through `failedUploads`, never returned by `getPendingWarnings` (no `broken-upload-file`
    warning or recommendation), deleted once delivered, and recorded with its own
    `upload_queue_measurements.outcome` `upload-full` (not counted as a failure).
- **FR-4c Append route contract.** `POST /api/v2/logs/append` takes the same query parameters as
  `POST /api/v2/logs` (`sessionId`, `type`, `parentSessionId`, `workflowRunId`,
  `agentDescription`, `workflowPhase`, `snapshotId` / `okfSnapshotId`, `contentSha256`,
  `uploadFeedback`) plus `startLine`, uses the same API-key auth, and gives foreign and deleted
  (tombstoned) sessions the same answers as the full route. Its success body has the same shape as
  the non-chunked full upload (`warnings`, `failedUploads`, `unknownSnapshotId` /
  `unknownOkfSnapshotId`, `sessionDeleted`); a start-line mismatch is never a synchronous status
  (FR-4a). `contentSha256` on an append covers the delta bytes only and is checked against the staged
  delta; it is never written to `logs.body_sha256`. The route is added to `LOG_INGEST_ROUTES`
  (logs body limit, text/NDJSON parser, gzip sniffing).
- **FR-4d Ingest bookkeeping after an append.** `logs.body_sha256` is set to NULL (unknown, so the
  next full upload is always processed); `body_received_at` is the append's received time;
  `ingest_version` is the current version; `body_rev` advances through the existing trigger. An
  append older than the stored body (a newer full upload already completed) is discarded without
  changing the body, with the same status and measurement as a stale full upload, and is not
  reported in `failedUploads`; this age check runs before the start-line check.
- **FR-5 Same result as a full upload.** After an append, the stored body equals the body a full
  upload of the same file would store, and every derived figure (stats, workflows, tool usage, gz
  copy, `body_rev`, OTEL projection inputs, session end-time watermark) is recomputed exactly as
  after a full upload.
- **FR-6 Fallback to full upload — always safe.** The hook does the existing full upload whenever
  anything is wrong or unknown, including at least: no stored state for the file; the file is
  shorter than what was uploaded; the hash of the uploaded part changed; any `failedUploads` entry
  whose `{sessionId, type}` matches the file, whether the failed row was an append or a full upload
  (the hook drops its append state for that file; the entry shape is unchanged); the append route
  answers 404 (an old server without the route — the hook then turns the append path off for that
  server URL for 1 h, like the `otel-realtime` 404 rule, with one `hook.log` line), any other
  non-2xx, a network error
  or a timeout; any exception in the delta path; the delta (after gzip) does not fit one request
  within `CHUNK_SIZE_BYTES` (there is no chunked append); `.claude-logs.pending` holds an
  unfinished chunked upload of the file (it is finished or restarted as a full upload). After every
  2xx upload (delta or full) the hook stores the new bytes, lines and hash; a row that fails later
  on the server self-heals through the next start-line mismatch.
- **FR-9 Concurrency.** Two uploads of the same file racing (e.g. `Stop` and `SessionEnd`) never
  produce a duplicated or lost line: the queue worker's start-line check fails the second delta
  and, on that `failedUploads` feedback, the hook falls back to a full upload.
- **FR-9a Compressed tail.** An append whose tail is large (e.g. the first append after a long
  offline period) is sent gzip like a full upload, through the same `Content-Encoding: gzip`
  handling. A small tail may go uncompressed; planning picks the threshold.
- **FR-10 Scope of files.** The append path is used only for `claude` and `claude-subagent` logs
  (the large ones). `artisyn` logs are small, uploaded separately and get per-upload lines in front
  of the file, so they stay out of scope and keep the full upload; every other upload kind keeps
  its current behaviour too.
- **FR-10a Hook version bump.** The hook's MINOR version is bumped (a new backwards-compatible
  upload mechanism, `.claude/rules/hook.md` "Version bump"): `hook/.claude/telemetry_tool/version.json`,
  then `npm run build:hooks-installer` (installer package and tarballs) and the dogfooded copy in
  `.artisyn/marketplace/plugins/log-hub-hooks/` (`scripts/` + `plugin.json` `version`). The new
  version gets its row in `docs/knowledgebase/hook-api-versioning.md` (what it adds, how it behaves
  against an older server, including the 1 h append-off after a 404).

Part B — compressed session OTEL:

- **FR-11 Compressed OTEL answer.** The session OTEL route answers gzip when the client accepts it
  (`Accept-Encoding`), identity otherwise, with `Vary: Accept-Encoding`; the JSON is unchanged.
- **FR-12 General rule for large answers.** Every large JSON answer of the
  API is compressed the same way, not only the session OTEL route: at least the repository and
  team OTEL routes, the parts manifest (~415 KB for a 64-part session) and the sessions list.
  Planning picks the mechanism (one shared response-compression step with a size threshold) and
  keeps out what is already compressed (log parts, precompressed static) and streamed answers
  that must not be buffered.

## Non-Functional Requirements

- Hook API backward compatibility (CLAUDE.md "Hook API"): new hook + old server → 404 on the new
  route, full uploads, no data loss; old hook + new server → unchanged behaviour (documented per
  FR-10a).
- Apart from re-hashing the uploaded part, the hook's per-turn work on the delta path (sanitize,
  compress, send) is proportional to the new lines, not to the file.
- Never augment Claude logs: the stored body stays the uploaded lines as-is (hook rule).
- Part B: compression must not block the worker's event loop on a large answer (stream through
  `zlib`, not `gzipSync`) and must fit the Pi (1 GB RAM, `mem_limit` 448 MiB for three workers).
- Part B has no fixed numeric target: the result is measured on the Pi and recorded, not gated.

## Acceptance Criteria

- [ ] FR-1/FR-2: with a 5 MB transcript already uploaded, a turn that adds 20 lines makes the hook
      send one request carrying only those lines (verified in a scenario by the request body size
      and a hook log line whose sanitize/gzip byte counts equal the delta size, not the file size).
- [ ] FR-4: a transcript with a blank line and a torn (malformed) line in the already-uploaded part
      still takes the append path on later turns, and the stored body equals a full upload's.
- [ ] FR-4c: a delta upload still returns `warnings` / `failedUploads` to the hook; foreign and
      deleted sessions get the same answers as on the full route.
- [ ] FR-3: a file whose last line has no newline yet uploads all lines but that one; the next
      upload sends it.
- [ ] FR-4/FR-5: after a full upload followed by several deltas, the stored `logs.body` equals
      the body a single full upload of the final file stores, and the session's derived figures
      (stats, workflows, tool usage, cost) are equal in both cases.
- [ ] FR-4/FR-6: an edit of an already uploaded line (same length or not) changes the hash and the
      next upload is a full one with the correct body.
- [ ] FR-4a: a delta whose start line differs from the server's line count ends as a `failed`
      row with reason `upload-full`, reported to the hook in `failedUploads`, and the stored body
      is unchanged; append rows are never `superseded` and are applied in arrival order after an
      earlier full row of the same log; the mismatch produces no `warnings` entry and no
      `broken-upload-file` recommendation, and the row is gone after delivery.
- [ ] FR-4d: after a delta, `logs.body_sha256` is NULL, `body_received_at` equals the append
      row's `received_at` and `body_rev` has advanced; a following full upload of the same file is
      processed, not skipped as unchanged; an append older than the stored body leaves it unchanged
      and is not reported in `failedUploads` (steps in the existing upload scenario).
- [ ] FR-1: a turn whose new bytes hold 0 records sends no log request; an empty append body gets 400.
- [ ] FR-6: after a 404 from the append route the hook makes no append attempt for 1 h and
      uploads full meanwhile.
- [ ] FR-6: each listed fallback trigger (no state, shorter file, changed hash, `upload-full`
      failure feedback, 404, 5xx, timeout, over-budget tail, pending chunked upload) ends in a
      successful full upload with the correct body.
- [ ] FR-9a: a delta above the threshold is sent with `Content-Encoding: gzip` and stored
      identically; one below it is sent uncompressed.
- [ ] FR-9: two concurrent uploads of the same grown file end with exactly one copy of every line.
- [ ] FR-10: `artisyn` logs, `.meta.json` and the other non-log uploads are unchanged.
- [ ] Compatibility: the previous release's hook against the new server and the new hook against
      the previous release's server both upload correctly (`s-compat-01` style scenario step).
- [ ] FR-10a: `version.json`, the installer package, the tarballs' `installer-version.json` and the
      dogfooded `plugin.json` all carry the new MINOR version; `hook-api-versioning.md` has its row.
- [ ] FR-11: the session OTEL route answers `Content-Encoding: gzip` to a client that accepts it and
      identity to one that does not; the decoded JSON is identical (scenario step in
      `s-otel-01` and the route's contract row).
- [ ] FR-12: the repository OTEL, team OTEL, parts manifest and sessions list routes answer
      `Content-Encoding: gzip` + `Vary: Accept-Encoding` above the size threshold to a
      gzip-accepting client and identity below it or without `Accept-Encoding`; log-part downloads
      and streamed answers are not compressed twice (contract rows plus steps in the existing
      sessions / OTEL scenarios).
- [ ] FR-11 / NFR: on the Pi, the OTEL tab of session `9fc6b5cc` (or a session of similar size)
      transfers less and opens faster than the measured ~11 s / ~9 MB; the bytes transferred and
      the tab load time (median of 3 cold loads) before and after are recorded in `notes.md`.

## Common sense considerations

- A "line" is one stored JSON record (non-blank, kept by `sanitizeNdjson`); the hook's byte offset and hash cover raw file bytes and stay hook-side (FR-4).
- The append route mirrors the full route's parameters, auth, response shape and foreign/deleted-session answers; "upload everything" is a `failed` append row with reason `upload-full`, reported via `failedUploads` (FR-4a, FR-4c).
- `contentSha256` on an append covers the delta bytes only (FR-4c).
- The append route is added to `LOG_INGEST_ROUTES` (FR-4c).
- After an append `body_sha256` is NULL, `body_received_at` is the append's time, `ingest_version` is current (FR-4d).
- The hook stores its new state on any 2xx; a later failed row self-heals through the next start-line mismatch (FR-6).
- No chunked append: an over-budget tail or a pending chunked upload means a full upload (FR-6).
- Acceptance criteria added for FR-2 (byte counts in the hook log), blank/torn lines, FR-4c, FR-9a and FR-12.
- An `upload-full` row: `failed`, `error_kind = 'server'`, delivered once via `failedUploads`, no user warning, deleted after delivery, own measurement outcome (FR-4a).
- `upload_queue.start_line` (nullable) marks append rows; they skip coalescing and superseding (FR-4a).
- Rows of one log key run one at a time in arrival order, under the existing tree lock (FR-4a).
- A stale append is discarded silently like a stale full upload; the age check runs first (FR-4d).
- The hook keeps append state as optional fields on its manifest-v2 entry (FR-4).
- The full upload is unchanged; append state is stored only when the sent body ended at a newline (FR-4).
- A 0-record delta sends no request; an empty append body gets 400 (FR-1).
- Any `failedUploads` entry for the file drops its append state; the entry shape is unchanged (FR-6).
- A 404 from the append route turns the append path off for 1 h, like `otel-realtime` (FR-6, FR-10a).

## Notes

<!-- Append timestamped notes here as work progresses -->

- Evidence (Pi measurements of session `9fc6b5cc`), the raw idea and the user's original design model: `notes.md`.
