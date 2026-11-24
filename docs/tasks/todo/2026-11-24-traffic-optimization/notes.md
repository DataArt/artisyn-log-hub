---
type: "Note"
title: "Traffic Optimization — notes"
description: "Evidence and the original design input behind the traffic-optimization requirements."
---

# Notes

## 2026-11-24 — evidence and original input (moved from requirements.md)

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

Evidence: the Pi log during session `9fc6b5cc` shows `Reassembled uploadId=… (4599721 bytes)` /
`(4890906 bytes)` every few turns; `hook/.claude/telemetry_tool/upload-logs.js` reads, hashes and
gzips the whole body per upload.

The user's design model (2026-11-24 — "keep it this simple"), formalised in FR-4 / FR-4a / FR-4c / FR-10:

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

### Part B — session OTEL measurement

Measured on the Pi, session `9fc6b5cc` (2026-11-24): `GET /api/v1/repositories/77/sessions/<id>/otel?interval=auto&stackBy=structure&tz=…`
→ 200 in ~10.5 s, no `Content-Encoding`, 9.2 MB decoded: `spans` 8.6 MB (6264 spans), `calls`
0.6 MB, the rest small. The server has no response compression for JSON (no `compression`
middleware; only the log parts and precompressed static assets are served gzip).
