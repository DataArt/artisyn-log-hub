---
type: "Task"
title: "Disk File Cache for Session Log Parts"
description: "Serve pre-compressed session log part bodies from a file cache on the working-data volume instead of reading bytea from Postgres each time; files not read for N days (default 14) are swept by a timer, a size cap (default 1 GB) evicts by last read, and the Admin Panel shows the cache state."
---

# 2026-11-24: Disk File Cache for Session Log Parts

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server, client (Admin System tab)
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
  valid gzip copy (served from `body::text`) are not cached. No pre-warming: the cache is filled
  only by reads, never by the `log-body-gz.service` drain or any other background job.
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
- **FR-8a Size cap.** Total cache size is capped by `SESSION_PART_CACHE_MAX_MB` (default **1024**,
  i.e. 1 GB). When the total is over the cap, files are deleted in order of oldest last read (FR-7
  mtime) until it is back under the cap. The cap is enforced by the sweep, and a write that pushes
  the known total over the cap triggers an eviction pass without waiting for the next timer tick
  (the cap may be exceeded briefly, never for long). A single part larger than the cap is not
  cached at all.
- **FR-9 Deleted data.** Every path that deletes `logs` rows also deletes those rows' cached part
  folders (`<logId>/`), so deleted data does not linger on disk for up to N days:
  `SessionsService.purgeSessionChildData` (session delete, tombstone / deleted-session cleanup
  drain, retention purge `hardPurgeExpiredSessions`, admin `hardDeleteSessionsInTx`), the admin
  repository delete (`admin.service.ts`), the team repository delete (`teams.service.ts`) and
  account deletion (`account-deletion.service.ts`, where `logs` go by the `users` FK cascade).
- **FR-10 Fail open.** Any cache error (dir not writable, disk full, read error, file vanished
  between check and open) is logged and the request is served from the DB as today; a cache
  failure never fails a request. A file that fails mid-stream after headers were sent is handled
  the same way an aborted DB stream is today.
- **FR-11 Disable switch.** The cache can be turned off by config (e.g.
  `SESSION_PART_CACHE_ENABLED=false`); off means exactly today's behaviour.
- **FR-11a Admin view.** The Admin Panel System tab (`AdminSystemTab.tsx`) shows the cache state:
  enabled/disabled, folder path, current size vs the cap, file count, TTL, oldest last-read time,
  time and result of the last sweep (files/bytes removed by TTL, by cap, by deletion). The data
  comes as a new additive `partCache` field of the existing `GET /api/v1/admin/system` response
  (admin-only, like the rest of the panel); its contract registry row `F01-admin-system` is
  updated.
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
- [ ] FR-8a: with `SESSION_PART_CACHE_MAX_MB` set low, reading more parts than fit leaves the total
      at or under the cap shortly after, and the files removed are the least recently read ones;
      the default cap is 1024 MB; a part larger than the cap is served but not cached.
- [ ] FR-5: no cache file appears for a part that was never requested, even after the gzip drain
      has built its copy.
- [ ] FR-9: deleting a session and deleting a repository each remove their part folders from the
      cache.
- [ ] FR-10: with the cache dir unwritable, part requests still succeed from the DB and a warning is
      logged.
- [ ] FR-11: with the cache disabled, no files are written and responses match today's.
- [ ] FR-11a: an admin sees the cache size, cap, file count, TTL and last sweep result in the Admin
      Panel; a non-admin cannot reach it.
- [ ] FR-12: env examples and KB/user docs list the new variables with their defaults.

## Testing

- **No algorithm doc** — the eviction logic (TTL + cap by last read) is trivial and is not treated
  as an algorithm.
- **Scenario** — steps in `@S-SESS-03` (`tests/scenarios/view/s-sess-03.spec.ts`, already reads
  `…/logs/parts`): cache hit/miss, revision change, TTL / cap eviction, deletion cleanup; a step in
  `@S-ADM-01` (`tests/scenarios/auth/s-adm-01.spec.ts`) for the System tab cache block.
- **API contract** — update row `F01-admin-system` in `server/test/contract/registry/f01-infra.ts`
  for the new `partCache` field; the parts route itself does not change.

## Common sense considerations

- FR-2 already holds for today's scanners (they match `<uploadId>.chunk*` / session-id prefixes and
  unlink named files only); the requirement is to keep it that way, verified by the AC.
- `body_rev` comes from the global sequence `logs_body_rev_seq`, so `<logId>/<body_rev>` never
  names two different bodies.
- A hit reads only the revision columns (`body_rev`, `body_gz_rev`) from Postgres, never
  `body_gz`; a miss keeps today's single query.
- Rows with `body_rev` NULL (pre-0096, ETag `u<updated_at>`) are not cached.
- FR-9 file deletion runs best-effort after the DB transaction; a rollback only costs a cache
  refill, and anything missed is caught by the TTL sweep.
- The "known total" for the FR-8a write trigger is a per-process estimate seeded by the last scan;
  the sweep always recomputes the total from disk, so cluster workers need no shared state.
- The last sweep result is stored in a small state file in the cache folder (skipped by the
  sweep), so the admin view shows the same result whichever cluster worker serves it.
- TTL / cap scenario steps use small env values on the scenario stand and backdate file mtimes
  instead of waiting real days.
- The miss path still holds the whole `body_gz` Buffer, as today; only hits stream from disk.

## Notes

<!-- Append timestamped notes here as work progresses -->
