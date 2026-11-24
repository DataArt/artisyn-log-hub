---
type: "Task"
title: "Disk File Cache for Session Log Parts"
description: "Serve pre-compressed session log part bodies from a file cache on the working-data volume instead of reading bytea from Postgres each time; files not read for N days (default 14) are swept by a timer."
---

# 2026-11-24: Disk File Cache for Session Log Parts

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server
**Owner:** denis.tsyplakov
**Created:** 2026-11-24
**Tracker:** GH-171 https://github.com/DataArt/artisyn-log-hub/issues/171

## Description

Raw idea:

> Disk file cache for session log parts (no nginx): serve pre-compressed session log part bodies
> (logs.body_gz) from files on the server's working-data volume (a subfolder of LOG_HUB_DATA_DIR,
> where upload-queue / export-import staging files live) instead of reading bytea from Postgres on
> every request. Auth and metadata stay in Node; DB stays the source of truth, disk is only a
> rebuildable cache. Files named by logId + body_rev (immutable, no invalidation). Cleanup by
> timer: files not read for more than N days (config, default 14) are deleted.

Context (from task `2026-11-23-session-logs-streaming`): the parts API
(`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/parts/:partSessionId/:logType`,
`SessionLogPartsService.streamPart` in `server/src/logs/session-log-parts.service.ts`) already
serves the stored gzip copy `logs.body_gz` byte for byte, with an ETag of the part revision and a
cheap 304 on revalidation. What still costs is the **first** read of a big part: node-postgres
fetches the whole `bytea` in one go, in the text protocol (hex, ~2× the compressed size), then
decodes it into a Buffer — a memory/CPU peak per request, no streaming, TOAST reads evicting useful
pages from shared buffers, and the `LogStreamLimiter` queueing such requests. Reading the same
bytes from a file and streaming them removes all of that.

Explicitly **no nginx** (or any other reverse proxy) in the image: everything stays inside the
Node server, so the change works the same in Docker, in the release kit and on the Pi.

## Functional Requirements

- **FR-1 Location.** The cache lives in a subfolder of the existing working-data volume — the one
  holding the upload-queue staging files. New env var `SESSION_PART_CACHE_DIR`; default is a
  `part-cache/` subfolder of the resolved `UPLOAD_QUEUE_DIR`, so existing installs (release
  `docker-compose.yml` mounts `${LOG_HUB_DATA_DIR}/upload-queue`) get a persistent cache without
  editing their compose file. The path is resolved like the other staging dirs (relative to the
  process CWD, created on demand) — no developer-machine-specific paths.
- **FR-2 Staging scanners ignore it.** Every code path that lists the upload-queue staging dir
  (`UploadQueueService` scans, `upload-queue-scheduler` diagnostics, admin Upload Queue cleanup)
  skips the `part-cache` subdirectory — it never counts as a staged upload, an orphan or garbage.
- **FR-3 File naming.** One file per part body revision, named only from server-side values:
  `<logId>/<body_rev>.json.gz` (numeric ids — no user-controlled path segments). A file, once
  written, is never modified: a new revision is a new file, so there is no invalidation.
- **FR-4 Serve from disk.** `streamPart` keeps its auth, tree/metadata checks, 404/400/304 logic
  and ETag exactly as today. When the row has a valid gzip copy (`body_gz_rev = body_rev`) and the
  file for that revision exists, the body is streamed from the file (`Content-Encoding: gzip` when
  accepted, decompressed on the fly as a stream when not) without reading `body_gz` from Postgres.
  The ETag still names the revision of the bytes actually sent.
- **FR-5 Fill on read.** A miss (no file for the current revision) is served from the DB exactly as
  today, and the gzip bytes are then written to the cache: temp file in the same folder + atomic
  rename, so a concurrent reader (another cluster worker) never sees a partial file. Rows without a
  valid gzip copy (served from `body::text`) are not cached.
- **FR-6 Old revisions.** Writing a new revision's file removes older revision files of the same
  `logId` (best effort).
- **FR-7 Last-read tracking.** Each served hit records the read time on the file itself (mtime via
  `utimes`, throttled — at most once per file per hour or so), because `atime` is unreliable
  (`noatime`/`relatime`, overlay filesystems).
- **FR-8 TTL sweep.** A timer deletes cache files not read for more than N days. Config:
  `SESSION_PART_CACHE_TTL_DAYS` (default **14**) and a sweep interval
  `SESSION_PART_CACHE_SWEEP_INTERVAL_MS` (default a few hours). Empty `<logId>/` folders and
  stale temp files left by a crashed write are removed too. Safe to run from several cluster
  workers at once (deleting an already-deleted file is not an error).
- **FR-9 Deleted data.** When a session or repository is deleted (including the tombstone /
  deleted-session cleanup drain), its cached part files are deleted as well — deleted data must not
  linger on disk for up to N days.
- **FR-10 Fail open.** Any cache error (dir not writable, disk full, read error, file vanished
  between check and open) is logged and the request is served from the DB as today; a cache
  failure never fails a request. A file that fails mid-stream after headers were sent is handled
  the same way an aborted DB stream is today.
- **FR-11 Disable switch.** The cache can be turned off by config (e.g.
  `SESSION_PART_CACHE_ENABLED=false`); off means exactly today's behaviour.
- **FR-12 Docs.** `release-template/.env.example`, `server/.env.example`, the relevant KB article(s)
  and user docs (admin / install) describe the new variables and that the folder is a disposable
  cache (not needed in backups; safe to delete while the server is stopped or running).

## Non-Functional Requirements

- Backward compatible: no API, payload, ETag or hook change; old clients and old hooks are
  unaffected. Existing installs need no compose or `.env` change.
- Memory: serving a cache hit streams the file — no full-body Buffer in Node.
- Security: the cache is served only after the same access checks as today; file paths are built
  only from numeric server-side ids; the folder is not exposed by any static route.
- Offline-first: no external component or download.

## Acceptance Criteria

- [ ] FR-1: with no new env vars, the cache appears under `<UPLOAD_QUEUE_DIR>/part-cache/`; with
      `SESSION_PART_CACHE_DIR` set, it is used instead. In the release compose the folder lands on
      the `${LOG_HUB_DATA_DIR}/upload-queue` volume and survives a container restart.
- [ ] FR-2: upload-queue stats, diagnostics and admin cleanup behave the same with a populated
      `part-cache/` subfolder as without it.
- [ ] FR-3/FR-5: the first request for a part with a valid gzip copy is served from the DB and
      leaves `<logId>/<body_rev>.json.gz` whose bytes equal `body_gz`; no partial file is ever
      visible under the final name.
- [ ] FR-4: a second request (no `If-None-Match`) returns identical bytes and headers (ETag,
      `Content-Encoding`, `Content-Length`) without reading `body_gz` from Postgres; a client
      without gzip gets the decompressed body.
- [ ] FR-6: after the body is re-uploaded (new `body_rev`) and read again, only the new revision's
      file remains for that `logId`.
- [ ] FR-7/FR-8: a file whose last read is older than `SESSION_PART_CACHE_TTL_DAYS` is deleted by
      the next sweep; a file read within the window is kept; the default is 14 days.
- [ ] FR-9: deleting a session (and a repository) removes its part files from the cache.
- [ ] FR-10: with the cache dir unwritable, part requests still succeed from the DB and a warning is
      logged.
- [ ] FR-11: with the cache disabled, no files are written and responses match today's.
- [ ] FR-12: env examples and KB/user docs list the new variables with their defaults.

## Open Questions

- Fill strategy: lazy fill on first read only (as written in FR-5), or also pre-warm from the
  `log-body-gz.service` drain right after building the gzip copy? Lazy keeps the cache to what
  people actually open; pre-warm makes the first open fast too but writes files nobody may read.
- Should there be a total size cap (e.g. `SESSION_PART_CACHE_MAX_MB`, evicting least recently read
  first) in addition to the TTL, for small disks like the Pi?
- Should the admin System Info tab show the cache size / file count / hit rate?
- Is the eviction rule (last-read throttling + TTL decision) worth an algorithm doc with table
  rows, or is a scenario step enough? Per the test policy: scenario step in the existing
  session-logs streaming scenario; contract registry unchanged (no route change).

## Notes

<!-- Append timestamped notes here as work progresses -->
