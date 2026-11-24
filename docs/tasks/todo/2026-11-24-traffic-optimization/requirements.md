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
kept in one task at the user's request ("оптимизация трафика"):

- **Part A — hook uploads** (the main one): the hook re-sends the whole growing transcript every
  turn.
- **Part B — session OTEL tab**: `GET …/sessions/:sessionId/otel` answers ~10 MB of uncompressed
  JSON (almost all `spans`) for a 6-hour session; the tab takes ~11 s on the Pi. The rest of the
  server load is not a concern, but OTEL must open quickly.

### Part A — raw idea

Raw idea (from the session of task `2026-11-23-session-logs-streaming`):

> Hook: incremental (append-only) upload of growing session logs, as an additional mechanism on
> top of the existing full upload. Today after every turn the hook reads the whole transcript,
> runs sanitizeNdjson over it, computes sha256 of the whole body (contentSha256, hook 3.2.0),
> gzipSync-s it in chunk slices and uploads it all (observed ~5 MB per turn for a 6-hour session)
> — cost grows with the file, so total cost per session is ~quadratic and it is noticeable on the
> developer's machine. Goal: the hook sends only the new complete lines; the server appends them
> and then computes everything over the full session exactly as if the whole file had been
> uploaded (derived figures, gz copy, stats unchanged). Hard requirement from the user: this is an
> extra mechanism — on anything wrong or suspicious (base mismatch, unknown state, old server,
> rewritten/truncated file, partial last line, hash mismatch, any error) the hook falls back to
> the existing full upload, so correctness never depends on the new path.

Why: the cost that matters is on the developer's machine — every turn of a long session re-reads,
re-hashes, re-compresses (synchronous `zlib.gzipSync`) and re-sends the whole transcript. Server
load is not critical (a team may not open Log Hub for days), so server-side computation stays
full; only the transport and the hook's own work become proportional to the new lines.

Evidence: the Pi log during session `9fc6b5cc` shows `Reassembled uploadId=… (4599721 bytes)` /
`(4890906 bytes)` every few turns; `hook/.claude/telemetry_tool/upload-logs.js` reads, hashes and
gzips the whole body per upload.

Design (the user's model, 2026-11-24 — keep it this simple):

- **All state is the hook's.** For each log file the hook stores, next to its manifest
  (`.claude-logs.sent.v2`), how much of the file it has uploaded (bytes and lines) and the hash
  of those bytes.
- **Next upload.** The hook hashes the same first bytes of the file again and compares:
  - hash unchanged → the file only grew → send only the new complete lines (the delta);
  - hash changed, file shorter, no stored state, or anything else unexpected → upload the whole
    file the old way.
- **The server keeps no hashes and no extra state.** It appends the delta to the stored body and
  then does everything exactly as after a full upload. The only check it makes: the delta says
  which line it starts at, and the server compares that with the number of lines it holds. If they
  differ (lines missing, out of order, a race), it answers "upload everything" and the hook does a
  full upload.
- **New route** `POST /api/v2/logs/append`, not a parameter on the old route: an old server would
  store the delta as the whole body. An old server answers 404 → the hook does a full upload.
- Applies to `claude` transcripts, `claude-subagent` transcripts and `artisyn` logs; `.meta.json`
  and other small files stay full.

### Part B — session OTEL answer

Measured on the Pi, session `9fc6b5cc` (2026-11-24): `GET /api/v1/repositories/77/sessions/<id>/otel?interval=auto&stackBy=structure&tz=…`
→ 200 in ~10.5 s, no `Content-Encoding`, 9.2 MB decoded: `spans` 8.6 MB (6264 spans), `calls`
0.6 MB, the rest small. The server has no response compression for JSON (no `compression`
middleware; only the log parts and precompressed static assets are served gzip).

## Functional Requirements

Part A — hook append uploads:

- **FR-1 Append path.** For a log file the server already holds, the hook sends only the complete
  lines added since its last successful upload (append or full) instead of the whole file.
- **FR-2 Only the delta is processed.** The prefix already sent is only read to re-hash it; it is
  never re-sanitized, re-compressed or re-sent.
- **FR-3 Complete lines only.** A trailing line without its newline (being written) is not sent; it
  goes with the next upload.
- **FR-4 Hook-side check.** The hook stores, per file, the bytes and lines it has uploaded and
  the hash of those bytes. Before an upload it hashes the same byte range of the current file; the
  delta is sent only when the hash is unchanged.
- **FR-4a Server-side check.** The delta carries the number of the line it starts at. The server
  appends only when that equals the number of lines it holds for that log; otherwise it answers
  with a distinct "upload everything" status and changes nothing. The server stores no hashes and
  no other append state.
- **FR-5 Same result as a full upload.** After an append, the stored body equals the body a full
  upload of the same file would store, and every derived figure (stats, workflows, tool usage, gz
  copy, `body_rev`, OTEL projection inputs, session end-time watermark) is recomputed exactly as
  after a full upload.
- **FR-6 Fallback to full upload — always safe.** The hook does the existing full upload whenever
  anything is wrong or unknown, including at least: no stored state for the file; the file is
  shorter than what was uploaded; the hash of the uploaded part changed; the server answers
  "upload everything", 404 (an old server without the route), any other non-2xx, a network error
  or a timeout; any exception in the delta path. After every successful upload (delta or full)
  the hook stores the new bytes, lines and hash.
- **FR-9 Concurrency.** Two uploads of the same file racing (e.g. `Stop` and `SessionEnd`) never
  produce a duplicated or lost line: the server's start-line check rejects the second delta and
  the hook falls back to a full upload.
- **FR-9a Compressed tail.** An append whose tail is large (e.g. the first append after a long
  offline period) is sent gzip like a full upload, through the same `Content-Encoding: gzip`
  handling (decided 2026-11-24). A small tail may go uncompressed; planning picks the threshold.
- **FR-10 Scope of files.** The append path is used for `claude`, `claude-subagent` and `artisyn`
  logs; every other upload kind keeps its current behaviour.
- **FR-10a Hook version bump.** The hook's MINOR version is bumped (a new backwards-compatible
  upload mechanism, `.claude/rules/hook.md` "Version bump"): `hook/.claude/telemetry_tool/version.json`,
  then `npm run build:hooks-installer` (installer package and tarballs) and the dogfooded copy in
  `.artisyn/marketplace/plugins/log-hub-hooks/` (`scripts/` + `plugin.json` `version`). The new
  version gets its row in `docs/knowledgebase/hook-api-versioning.md` (what it adds, how it behaves
  against an older server).

Part B — compressed session OTEL:

- **FR-11 Compressed OTEL answer.** The session OTEL route answers gzip when the client accepts it
  (`Accept-Encoding`), identity otherwise, with `Vary: Accept-Encoding`; the JSON is unchanged.
- **FR-12 General rule for large answers** (decided 2026-11-24). Every large JSON answer of the
  API is compressed the same way, not only the session OTEL route: at least the repository and
  team OTEL routes, the parts manifest (~415 KB for a 64-part session) and the sessions list.
  Planning picks the mechanism (one shared response-compression step with a size threshold) and
  keeps out what is already compressed (log parts, precompressed static) and streamed answers
  that must not be buffered.

## Non-Functional Requirements

- Hook API backward compatibility (CLAUDE.md "Hook API"): new hook + old server → 404 on the new
  route, full uploads, no data loss; old hook + new server → unchanged behaviour. Documented in
  `docs/knowledgebase/hook-api-versioning.md` with a hook version bump.
- Apart from re-hashing the uploaded part, the hook's per-turn work on the delta path (sanitize,
  compress, send) is proportional to the new lines, not to the file.
- Never augment Claude logs: the stored body stays the uploaded lines as-is (hook rule).
- Part B: compression must not block the worker's event loop on a large answer (stream through
  `zlib`, not `gzipSync`) and must fit the Pi (1 GB RAM, `mem_limit` 448 MiB for three workers).
- Part B target: the session OTEL tab of a 6-hour session opens within a few seconds on the Pi.

## Acceptance Criteria

- [ ] FR-1/FR-2: with a 5 MB transcript already uploaded, a turn that adds 20 lines makes the hook
      send one request carrying only those lines (verified in a scenario by the request body size
      and a hook log line).
- [ ] FR-3: a file whose last line has no newline yet uploads all lines but that one; the next
      upload sends it.
- [ ] FR-4/FR-5: after a full upload followed by several deltas, the stored `logs.body` equals
      the body a single full upload of the final file stores, and the session's derived figures
      (stats, workflows, tool usage, cost) are equal in both cases.
- [ ] FR-4/FR-6: an edit of an already uploaded line (same length or not) changes the hash and the
      next upload is a full one with the correct body.
- [ ] FR-4a: a delta whose start line differs from the server's line count is rejected with
      "upload everything" and the stored body is unchanged.
- [ ] FR-6: each listed fallback trigger (no state, shorter file, changed hash, "upload
      everything", 404, 5xx, timeout) ends in a successful full upload with the correct body.
- [ ] FR-9: two concurrent uploads of the same grown file end with exactly one copy of every line.
- [ ] FR-10: `.meta.json` and the other non-log uploads are unchanged.
- [ ] Compatibility: the previous release's hook against the new server and the new hook against
      the previous release's server both upload correctly (`s-compat-01` style scenario step).
- [ ] FR-10a: `version.json`, the installer package, the tarballs' `installer-version.json` and the
      dogfooded `plugin.json` all carry the new MINOR version; `hook-api-versioning.md` has its row.
- [ ] FR-11: the session OTEL route answers `Content-Encoding: gzip` to a client that accepts it and
      identity to one that does not; the decoded JSON is identical (scenario step in
      `s-otel-01` and the route's contract row).
- [ ] FR-11 / NFR: on the Pi, the OTEL tab of session `9fc6b5cc` (or a session of similar size)
      opens markedly faster than the measured ~11 s; the number is recorded in the task notes.

## Notes

<!-- Append timestamped notes here as work progresses -->
