---
type: "Architecture Guide"
title: "Session Log Part Disk Cache"
description: "Disposable disk cache of session-log part bodies (gzip) behind GET …/logs/parts/:partSessionId/:logType: SESSION_PART_CACHE_* config, file layout, PartCacheService API, hit/miss read path, fill, TTL and size-cap sweep, removal with deleted data, sweep state file, admin view and Part cache card."
tags:
  - server
  - logs
  - cache
generated: { by: "claude-code", at: "2026-11-24T18:00:00+04:00" }
---

# Session Log Part Disk Cache

The parts route (`GET …/sessions/:sessionId/logs/parts/:partSessionId/:logType`, see
[session-log-view.md](session-log-view.md) "The parts API") serves `logs.body_gz` from Postgres.
Reading a large TOASTed blob for every view is expensive, so the server keeps a copy of each part
it has served in a **disposable file cache**. The database stays the source of truth: the folder
can be deleted at any time (server running or stopped), is never backed up, and refills on the
next reads. Task: `2026-11-24-session-parts-disk-cache`; file-system semantics were checked in the
PoC [docs/pocs/2026-11-24-1530-part-cache-fs-semantics/](../pocs/2026-11-24-1530-part-cache-fs-semantics/README.md)
(on Windows a rename over an open file fails with `EPERM`).

| Piece | File |
|---|---|
| Config + constants | `server/src/logs/part-cache/part-cache.config.ts` (`readPartCacheConfig()`) |
| Types | `server/src/logs/part-cache/part-cache.types.ts` (`PartCacheHit`, `PartCacheSweepState`, `PartCacheView`) |
| Service | `server/src/logs/part-cache/part-cache.service.ts` (`PartCacheService`) |
| Module | `server/src/logs/part-cache/part-cache.module.ts` (`@Global()`, imported in `app.module.ts`) |
| Read path | `server/src/logs/session-log-parts.service.ts` (`streamPart`) |
| Delete paths | `sessions.service.ts` (`purgeSessionChildData`), `admin.service.ts` (`removeRepo`), `teams.service.ts` (repo delete), `users/account-deletion.service.ts` |
| Admin API | `system-info/system-info.service.ts` → `partCache` on `GET /api/v1/admin/system` |
| Admin UI | `client/src/viewer/pages/admin/tabs/PartCacheCard.tsx` (uses `Card` from `system-card.tsx`) |

## Configuration (DD-1)

Read once when the service is constructed. All optional.

| Env var | Default | Meaning |
|---|---|---|
| `SESSION_PART_CACHE_ENABLED` | on | Only the exact value `false` turns the cache off. Off, every method is a no-op: `openForRead` returns `null`, `sweep` returns `null`, no timer is registered, and every read goes to the DB exactly as before the cache existed. |
| `SESSION_PART_CACHE_DIR` | `<UPLOAD_QUEUE_DIR \|\| upload-queue>/part-cache` | `path.resolve`d against the CWD (`/app/dist` in the image, so it lands in the `upload_queue_data` volume). Created on demand by the first fill or sweep. The default copies `resolveStagingDir()`'s default instead of calling it, because that function creates its folder. |
| `SESSION_PART_CACHE_TTL_DAYS` | `14` | Files not read for this many days are removed. |
| `SESSION_PART_CACHE_MAX_MB` | `1024` | Cap of the total `*.json.gz` size, in MiB. |
| `SESSION_PART_CACHE_SWEEP_INTERVAL_MS` | `10800000` (3 h) | Sweep timer, in every worker. The scenario stand sets 1 s (and a 1 MB cap in mode C). |

Constants in the same file: touch throttle 1 h, stale temp file age 10 min, delete re-check 5 s,
state file `.sweep-state.json`, and the name regexes below.

## Layout (DD-2)

- Part: `<dir>/<logId>/<bodyRev>.json.gz` — the exact bytes of `logs.body_gz` for that revision.
- Temp: `<dir>/<logId>/.tmp-<bodyRev>-<pid>-<8 hex>.json.gz`, renamed to the final name.
- Sweep state: `<dir>/.sweep-state.json`, written through `.sweep-state.json.tmp-<pid>-<8 hex>`.

Every path segment is a number (`logId`, and `bodyRev` checked against `/^\d+$/`), so no user
input reaches a path. Rows without `body_rev` (legacy revision `u…`) are never cached. A file's
**mtime is its "last read" time**: TTL and cap eviction both use it.

## Module and API (DD-3, DD-4)

`PartCacheModule` is global, so the six consumers inject `PartCacheService` without a module
import and no `forwardRef` cycle appears. The service never touches the DB.

| Method | Behaviour |
|---|---|
| `enabled` | The config switch. |
| `openForRead(logId, bodyRev)` | `fs.promises.open` + `stat` + `createReadStream`; `null` on a miss or any error (non-`ENOENT` errors logged as a warning). |
| `touchOnHit(hit)` | Fire-and-forget `utimes` when the file's mtime is more than 1 h old; failures are logged at debug only. |
| `store(logId, bodyRev, gz)` | Fire-and-forget fill (below); never throws. |
| `removeLogFolders(ids)` | Fire-and-forget removal (below); never throws. |
| `sweep(trigger)` | One sweep pass; `null` when disabled or skipped. |
| `getAdminView()` | The `partCache` admin field. |

## Read path (DD-5)

In `streamPart`, only when `enabled`, the row has a numeric `bodyRev` and its gzip copy is valid:

1. `openForRead`. A miss goes straight to the DB path.
2. **Hit**: `SELECT body_rev::text, (body_rev IS NOT NULL AND body_gz_rev = body_rev AND body_gz IS NOT NULL)`
   — `IS NOT NULL` does not detoast `body_gz`. No row → close the file and answer 404. Revision
   changed or copy invalid → close the file and fall through to the DB path.
3. Pull the first chunk **before any header is set**; a read error logs a warning and falls back
   to the DB path (fail open, FR-10). The first chunk is never dropped.
4. Same headers as the DB path (`Vary`, `ETag: "<rev>"`, `Cache-Control`, `Content-Type`). Gzip
   accepted → `Content-Encoding: gzip` + `Content-Length: <file size>` and the raw file; otherwise
   the chunks are piped through `zlib.createGunzip()`. The stream is always destroyed in a
   `finally`; `touchOnHit` runs after `res.end()`.
5. **Miss**: today's single query unchanged. After `res.end()`, when the row had a gzip copy and a
   numeric revision, `store()` writes it — also when the client did not accept gzip. There is no
   pre-warm: only parts someone actually read get cached.

Hits still take a `LogStreamLimiter` permit, and errors after the first byte abort the socket as
before. 304s never touch the cache.

## Fill (DD-6)

Detached, every error caught and logged through one `RepeatedFailureLog`
(`Part cache write failed for log <id>: …`):

1. Skip a body larger than the whole cap.
2. `mkdir <dir>/<logId>`; skip when the final file already exists.
3. Write the temp file with flag `wx`, then `rename`. A rename failing with `EPERM` / `EEXIST` /
   `EBUSY` while the final file exists counts as success (Windows, concurrent writer), and the
   temp file is unlinked.
4. Remove `<n>.json.gz` files of **strictly older** revisions of the same log, so a concurrent
   writer of a newer revision is never undone.
5. Add the size to the per-process `estimatedBytes`; over the cap → `sweep('cap')`.

## Sweep (DD-7)

A `SchedulerRegistry` interval `'part-cache-sweep'` in every worker; the first pass runs at
`onApplicationBootstrap` (and seeds `estimatedBytes`), `onModuleDestroy` clears the timer and
awaits a running pass. A `sweepRunning` guard skips overlapping passes; a `'cap'` trigger during a
pass requests one more pass afterwards. One pass:

1. `mkdir` the cache dir (so the state file can always be written); a failure goes to the state's
   `error` field and ends the pass.
2. Top level: only `^\d+$` folders are looked at; stale state temp files are unlinked; everything
   else (including the state file) is left alone.
3. In each folder: collect `^\d+\.json\.gz$` files, unlink `.tmp-*` files older than 10 min,
   ignore other names.
4. **TTL**: unlink files whose mtime is older than `ttlDays`.
5. **Cap**: sort the rest by mtime ascending (least recently read first) and unlink until the
   total is at or below `maxBytes`.
6. `rmdir` emptied folders (ignoring `ENOTEMPTY` / `ENOENT`); `ENOENT` on unlink is success, so
   several workers sweeping the same folder do not conflict.
7. Reset `estimatedBytes` to the total and write the state file. A pass that removed something
   logs at `log` level; a pass error is a warning.

## Deleted data (DD-8)

The four hard-delete paths call `removeLogFolders(ids)` with the deleted `logs.id`s: session
purge (`purgeSessionChildData` deletes `logs … RETURNING id`), admin repo delete, team repo delete
and account deletion (which selects the user's `logs.id` before the `users` cascade). For each
integer id the folder is removed at once (`rm -r -f`, after statting its part files into the
per-process `removedByDataDeletion` counter) and once more 5 s later on an `unref`'d timer — after
the caller's transaction committed — to remove a file a concurrent miss may have written in
between. A rolled-back delete only costs a refill; anything still missed ages out by TTL.

## State file and admin view (DD-9, DD-10, DD-13)

`.sweep-state.json` (`PartCacheSweepState`): `at`, `durationMs`, `trigger`, `sizeBytes`,
`fileCount`, `oldestReadAt`, `removedTtl {files, bytes}`, `removedCap {files, bytes}`,
`removedTempFiles`, `error`. Written via temp file + rename (direct `writeFile` when the rename
fails with `EPERM`).

`GET /api/v1/admin/system` → `partCache` (`PartCacheView`): `enabled`, resolved `dir`,
`maxBytes`, `ttlDays`, `sweepIntervalMs`, `lastSweep` (the state file, `null` when missing,
unreadable or disabled) and `removedByDataDeletion` (**this worker** since its start — it can
differ between reloads in cluster mode). The admin request never scans the folder: size, file
count and oldest read are "as of last sweep". The client keeps its own copy of the type
(`client/src/models/admin.ts`).

The Admin → System tab shows the **Part cache** card next to DB Space (`data-testid` root
`part-cache-card`; lines `part-cache-status`, `-size`, `-ttl`, `-last-sweep`, `-deleted`, `-dir`).
Disabled, only the status and the folder show.

## Logging (DD-11)

Warnings, each through its own `RepeatedFailureLog`: a failed write, a non-`ENOENT` open or read
error on a hit (the request falls back to the DB), a sweep error. A failed `utimes` is debug.

## Upload-queue staging (DD-12)

The default folder lives inside `UPLOAD_QUEUE_DIR`, but no staging scanner touches it (see
[upload-queue.md](upload-queue.md)); the admin disk-usage figure sizes only `logs/`.

## Tests

Scenario `@S-SESS-03` (fill and hit with a not-from-Postgres proof, no pre-warm, old revision
removal, touch, TTL, cap and over-cap in mode C, fail open, session and repo deletion) and
`@S-ADM-01` (the `partCache` field and the card). The disabled switch and the "warning logged"
part of fail-open are not covered by a scenario. Eviction is not an algorithm, so there is no
algorithm doc.
