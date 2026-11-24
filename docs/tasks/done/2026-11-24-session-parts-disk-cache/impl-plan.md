# Implementation Plan: Disk File Cache for Session Log Parts

## TL;DR

- New global Nest module `PartCacheModule` / `PartCacheService` (`server/src/logs/part-cache/`), with no DB access. It exposes `openForRead`, `touchOnHit`, `store`, `removeLogFolders`, `sweep` and `getAdminView`, plus a sweep timer that runs in every worker.
- `SessionLogPartsService.streamPart` changes. A hit is checked against the file first, then one query reads only the revision columns, then the file is streamed. A miss runs today's single query, then writes the cache file in the background. Headers, ETag, 304 and the limiter are unchanged.
- Four delete paths call `removeLogFolders`: `purgeSessionChildData` (`RETURNING id`), admin repo delete, team repo delete and account deletion (a new select of `logs.id` before the `users` cascade).
- API: an additive `partCache` field on `GET /api/v1/admin/system`. No other route, payload, ETag or hook change.
- DB changes: none. No new npm packages.
- New env vars, all optional:
  - `SESSION_PART_CACHE_ENABLED` (default on)
  - `SESSION_PART_CACHE_DIR` (default `<UPLOAD_QUEUE_DIR>/part-cache`)
  - `SESSION_PART_CACHE_TTL_DAYS` (14)
  - `SESSION_PART_CACHE_MAX_MB` (1024)
  - `SESSION_PART_CACHE_SWEEP_INTERVAL_MS` (3 h)
- Client: a new `PartCacheCard` on the Admin System tab. `Card` moves out of `AdminSystemTab.tsx` into a shared file.
- Tests: contract row `F01-admin-system` gets a comment only (the shape is asserted in the scenario); new steps 16–21 in `@S-SESS-03` and step 4c in `@S-ADM-01`; the scenario stand env adds a 1 s sweep in every mode and a 1 MB cap in mode C.

## Reference

- Requirements: [requirements.md](requirements.md)
- Research archive: [research/findings-1.md](research/findings-1.md)
- File-system PoC: [docs/pocs/2026-11-24-1530-part-cache-fs-semantics/README.md](../../../pocs/2026-11-24-1530-part-cache-fs-semantics/README.md)

## Design Decisions

**DD-1 Configuration** (`part-cache.config.ts`, read once by `readPartCacheConfig()` when the service is constructed):

| Key | Env var | Default | Parse |
|---|---|---|---|
| `enabled` | `SESSION_PART_CACHE_ENABLED` | `true` | `process.env.X !== 'false'` (house style, `budget-threshold.scheduler.ts:20`) |
| `dir` | `SESSION_PART_CACHE_DIR` | `path.join(process.env.UPLOAD_QUEUE_DIR \|\| 'upload-queue', 'part-cache')` | `path.resolve(...)`, relative to the CWD; created on demand by the first `store()` or sweep (DD-7) |
| `ttlDays` | `SESSION_PART_CACHE_TTL_DAYS` | `14` | `readPositiveIntEnv` (`server/src/common/env-int.ts`) |
| `maxBytes` | `SESSION_PART_CACHE_MAX_MB` | `1024` → 1,073,741,824 | `readPositiveIntEnv(...) * 1_048_576` |
| `sweepIntervalMs` | `SESSION_PART_CACHE_SWEEP_INTERVAL_MS` | `10_800_000` (3 h) | `readPositiveIntEnv` |

Constants, exported from the same file:

| Constant | Value |
|---|---|
| `PART_CACHE_TOUCH_THROTTLE_MS` | 3,600,000 |
| `PART_CACHE_STALE_TEMP_MS` | 600,000 |
| `PART_CACHE_STATE_FILE` | `'.sweep-state.json'` |
| `PART_CACHE_DELETE_RECHECK_MS` | 5,000 |
| `PART_CACHE_FILE_RE` | `/^(\d+)\.json\.gz$/` |
| `PART_CACHE_TEMP_RE` | `/^\.tmp-/` |
| `PART_CACHE_STATE_TEMP_RE` | `/^\.sweep-state\.json\.tmp-/` |
| `PART_CACHE_LOG_DIR_RE` | `/^\d+$/` |

The default dir copies the default of `resolveStagingDir()` (`upload-queue.service.ts:132`) instead of calling it, because that function creates the directory as a side effect.

**DD-2 Layout.**
- Final file: `<dir>/<logId>/<bodyRev>.json.gz`.
- Temp file: `<dir>/<logId>/.tmp-<bodyRev>-<pid>-<8 random hex>.json.gz`.
- Sweep state: `<dir>/.sweep-state.json`, written via the temp file `<dir>/.sweep-state.json.tmp-<pid>-<8 random hex>`.

Every path segment is built from a number (`logId: number`, and `bodyRev` matched against `/^\d+$/` before use). Rows with no `body_rev` (legacy revision `u…`) are never cached.

**DD-3 Module.** `PartCacheModule` is `@Global()`, like `LoadGovernorModule` (`server/src/common/load-governor/load-governor.module.ts:10`). It provides and exports `PartCacheService` and is imported once in `server/src/app.module.ts`. `SessionLogPartsService`, `SessionsService`, `AdminService`, `TeamsService`, `AccountDeletionService` and `SystemInfoService` inject it without any module import, so no new `forwardRef` cycle appears. The service never touches the DB.

**DD-4 `PartCacheService` API** (the seam later chunks build against):

```ts
export interface PartCacheHit { stream: NodeJS.ReadableStream & { destroy(): void }; size: number; filePath: string; mtimeMs: number }
get enabled(): boolean
openForRead(logId: number, bodyRev: string): Promise<PartCacheHit | null>   // null = miss or any error (non-ENOENT errors logged warn)
touchOnHit(hit: PartCacheHit): void                                          // fire-and-forget utimes when now - mtimeMs > TOUCH_THROTTLE_MS
store(logId: number, bodyRev: string, gz: Buffer): void                      // fire-and-forget fill (DD-6); never throws
removeLogFolders(logIds: readonly number[]): void                            // fire-and-forget (DD-8); never throws
sweep(trigger: 'timer' | 'cap'): Promise<PartCacheSweepState | null>          // DD-7; null when skipped (already running / disabled)
getAdminView(): Promise<PartCacheView>                                       // DD-10
```

- `openForRead` uses `fs.promises.open(path, 'r')`, `fh.stat()` and `fh.createReadStream()`.
- When `enabled` is false every method is a no-op: `openForRead` returns `null`, `sweep` returns `null`, and no timer is registered.

**DD-5 Read path** (`streamPart`):

1. The cache is checked only when `cache.enabled && meta.bodyRev !== null && meta.gzReady`. Then `hit = await cache.openForRead(meta.logId, meta.bodyRev)`.
2. On a hit, read the revision only:
   `SELECT body_rev::text AS rev, (body_rev IS NOT NULL AND body_gz_rev = body_rev AND body_gz IS NOT NULL) AS gz_ok FROM logs WHERE id = $1`
   - `IS NOT NULL` does not detoast `body_gz`.
   - No row: destroy the stream and throw 404.
   - `gz_ok` true and `rev === meta.bodyRev`: serve from the file.
   - Anything else: destroy the stream and fall through to today's query.
3. Serving from the file:
   - This happens only after the revision query in step 2, so nothing has been written when a 404 is thrown.
   - Before setting any header, pull the first chunk with the stream's async iterator. If that read fails, log a warning, destroy the stream and fall through to the DB path (FR-10).
   - The first chunk is never dropped. In the gzip branch it is written first. In the gunzip branch it goes into `zlib.createGunzip()` ahead of the rest, via `Readable.from(firstThenRest())`, where `firstThenRest` is an async generator that yields the first chunk and then the remaining iterator.
   - Then set the same headers as today: `Vary`, `ETag: "<rev>"`, `Cache-Control`, `Content-Type`, status 200.
   - Gzip accepted: add `Content-Encoding: gzip` and `Content-Length: hit.size`, then write the first chunk and the rest with `writeChunk`.
   - Gzip not accepted: pipe the chunks through `zlib.createGunzip()` and write them with `writeChunk`.
   - Always `stream.destroy()` in a `finally`.
   - Call `cache.touchOnHit(hit)` after `res.end()`.
4. Miss: today's single query, unchanged. After `res.end()`, when `row.gz !== null && /^\d+$/.test(row.rev)`, call `cache.store(meta.logId, row.rev, row.gz)`. This also runs when the client did not accept gzip.
5. Errors after the first byte propagate as today, and `runLimited` aborts the socket (`session-logs-stream.service.ts:46-73`).
6. Hits still take a `LogStreamLimiter` permit, so `repositories.controller.ts` does not change.

**DD-6 Fill (`store`)** runs detached and catches every error, logging it through one `RepeatedFailureLog` (`server/src/common/repeated-failure-log.ts`) with the message `Part cache write failed for log <id>: <err>`. Steps:

1. Skip if `gz.length > maxBytes` (FR-8a).
2. `mkdir(<dir>/<logId>, {recursive: true})`.
3. Skip if the final file already exists.
4. Write the temp file with flag `'wx'`, then `rename` it to the final name.
5. If the rename fails with `EPERM`, `EEXIST` or `EBUSY` and the final file exists, count that as success and unlink the temp file. The PoC showed that on Windows a rename over an open file fails with `EPERM`.
6. FR-6: list `<logId>/`, unlink each `<n>.json.gz` with `BigInt(n) < BigInt(bodyRev)` and subtract their sizes. Only strictly older revisions go, so a concurrent writer of a newer revision is never undone.
7. Add `gz.length` to the per-process `estimatedBytes`. If that is now over `maxBytes`, call `void this.sweep('cap')`.

**DD-7 Sweep.**
- Timer: `SchedulerRegistry` plus `setInterval(sweepIntervalMs)`, named `'part-cache-sweep'`. The first sweep runs at `onApplicationBootstrap`, which also seeds `estimatedBytes`. A `sweepRunning` guard applies, and `onModuleDestroy` removes the interval and awaits an in-flight sweep. This is the pattern of `log-retention.service.ts` and `export-import-job-cleanup.scheduler.ts:43-80`.
- A `'cap'` trigger that arrives while a sweep is running sets `rerunRequested`, and one more pass runs afterwards.
- One pass:
  1. `mkdir(dir, {recursive: true})`, so the state file can always be written and the admin view has a `lastSweep` soon after boot. If that fails, the error goes to the state's `error` field (best effort) and the pass ends.
  2. In the top level, look only at directories matching `PART_CACHE_LOG_DIR_RE`, and unlink files matching `PART_CACHE_STATE_TEMP_RE` that are older than `PART_CACHE_STALE_TEMP_MS`. Everything else is left alone, including the state file.
  3. In each `<logId>/`, collect files matching `PART_CACHE_FILE_RE` as `{path, size, mtimeMs}`. Unlink temp files older than `PART_CACHE_STALE_TEMP_MS`. Ignore any other name.
  4. TTL: unlink files with `mtimeMs < now - ttlDays * 86_400_000`.
  5. Cap: sort the rest by `mtimeMs` ascending and unlink until the total is at or below `maxBytes`.
  6. `rmdir` each `<logId>/` emptied during the pass, ignoring `ENOTEMPTY` and `ENOENT`.
  7. `ENOENT` on any unlink counts as success.
  8. Set `estimatedBytes` to the resulting total.
  9. Write the state file (DD-9).

**DD-8 Deleted data (`removeLogFolders`).**
- For each id: `rm(<dir>/<logId>, {recursive: true, force: true})` right away. It first stats the `*.json.gz` files and adds them to `removedByDataDeletion {files, bytes}`, a per-process counter since start.
- Then the same removal runs once more after `PART_CACHE_DELETE_RECHECK_MS`, with an `unref`'d timer. This second pass happens after the caller's transaction has committed, and removes a file a concurrent miss may have written meanwhile.
- A rollback costs only a cache refill. Anything still missed is caught by the TTL sweep.
- The ids are numbers, and any non-integer id is skipped.

**DD-9 State file** (`PartCacheSweepState`, written as JSON via a temp file and rename; if the rename fails with `EPERM`, `writeFile` writes the target directly):

```ts
interface PartCacheSweepState {
  at: string;                 // ISO end time
  durationMs: number;
  trigger: 'timer' | 'cap';
  sizeBytes: number;          // total *.json.gz bytes after the pass
  fileCount: number;
  oldestReadAt: string | null; // ISO of the smallest mtime left, null when empty
  removedTtl: { files: number; bytes: number };
  removedCap: { files: number; bytes: number };
  removedTempFiles: number;
  error: string | null;       // message of a pass-level failure (e.g. EACCES on dir), else null
}
```

**DD-10 Admin view** (`PartCacheView`, the `partCache` field of `GET /api/v1/admin/system`):

```ts
interface PartCacheView {
  enabled: boolean;
  dir: string;                       // resolved absolute path
  maxBytes: number;
  ttlDays: number;
  sweepIntervalMs: number;
  lastSweep: PartCacheSweepState | null;   // read from the state file; null when absent/unreadable or disabled
  removedByDataDeletion: { files: number; bytes: number };   // the answering worker process, since its start
}
```

- `removedByDataDeletion` is per worker process, so in cluster mode its value can differ between reloads, depending on which worker answers. That is accepted, as for `eventLoopLagMs` and `requests`, and the UI labels it "this worker".

- Size, file count and oldest last read come from `lastSweep`, and the UI labels them "as of last sweep". An admin request never scans the folder.
- The server type sits in `part-cache.types.ts` and is re-used by `system-info.types.ts`. The client declares its own copy, following the `SystemInfo` isolation convention.

**DD-11 Logging.** Log warnings for:
- a failed write;
- a non-ENOENT open or read error on a hit (the request falls back to the DB);
- a sweep error.

Each goes through its own `RepeatedFailureLog`. A sweep that removed something logs at `log` level. A failed `utimes` is ignored, at debug level.

**DD-12 Staging scanners (FR-2).** No code change. Every scanner matches `<uploadId>.chunk*` or a prefix of a session or upload id, or unlinks named files (research §FR-2), and `getDiskUsage` sizes only `logs/`. The KB `upload-queue.md` gets a one-line note that `part-cache/` is not staging.

**DD-13 Admin card UI.**
- The card is labelled "Part cache" and sits in the same `grid md:grid-cols-3` row as DB Space; that row now renders when either card has data.
- Lines and test ids:
  - `part-cache-status`: "Enabled" or "Disabled".
  - `part-cache-size`: "<formatBytes(sizeBytes)> of <formatBytes(maxBytes)> · <n> files".
  - `part-cache-ttl`: "TTL <ttlDays> days · oldest read <DateTime>".
  - `part-cache-last-sweep`: "Last sweep <DateTime> (<trigger>): removed <f> files / <bytes> by TTL, <f> / <bytes> by cap", or "No sweep yet".
  - `part-cache-deleted`: "Removed with deleted data (this worker): <f> files / <bytes>".
  - `part-cache-dir`: the path, in small muted monospace with a `title`.
- When disabled, only `part-cache-status` and `part-cache-dir` show.
- The card root is `data-testid="part-cache-card"`.
- `Card` moves from `AdminSystemTab.tsx:60` to `client/src/viewer/pages/admin/tabs/system-card.tsx`, so the new component can use it without a circular import.

**DD-14 Scenario stand env.**
- `tests/scenarios/modes.ts` `standEnv` adds `SESSION_PART_CACHE_SWEEP_INTERVAL_MS: '1000'` for every mode, so TTL and cap effects show within a step.
- Mode `c` adds `SESSION_PART_CACHE_MAX_MB: '1'` (1,048,576 bytes). Mode A keeps the 1 GB default, so its cache steps are never disturbed by eviction.
- The cache dir is the default: `<runDir>/upload-queue/part-cache`.
- `scripts/__tests__/scenarios-stand.test.js` checks only named keys, so it needs no change.

**DD-15 Scenario step split** (S-SESS-03 runs in `@mode-a @mode-c`):
- On the mode-C stand, parallel scenarios fill the same 1 MB cache, so any cache file can be evicted at any second. Mode-C assertions must therefore never depend on one file surviving. They check only that a file appears (poll), that the oldest dummy goes, that the total drops to the cap at some poll, and that over-cap parts and blocked folders never get a file.
- Checks that need a file to survive run only when `standMode() === 'a'`:
  - the DD-16 not-from-Postgres proof;
  - the old-revision check, which needs the old file to still be there;
  - the TTL-keep check (a file backdated 13 days survives).
- The cap and over-cap checks run only when `standMode() === 'c'`.
- Every other cache step runs in both modes.
- Step 21 deletes GS-07 and then the whole golden repo, so it must stay the last step of `@S-SESS-03`.
- "Re-upload W1" means the call already used in step 14:
  - take the W1 upload from `materializeGolden('gs-05', { runId: repo.runId })`;
  - get a key from `createApiKey(owner.api)`;
  - `api.post('/api/v2/logs', …)` with the extra line(s), then `waitForQueueIdle(db, owner.id, { timeoutMs: 30_000 })`.
- Timeouts: raise `test.setTimeout` in `@S-SESS-03` from 300,000 to 480,000 ms, and in `@S-ADM-01` from 180,000 to 210,000 ms.
- The over-cap part is W1 re-uploaded with one extra line holding 1,572,864 base64 characters of random data (1,179,648 random bytes). Its gzip cannot be smaller than about 1,179,648 bytes, which is over 1,048,576, and the body stays under `LOGS_MAX_BODY_MB=2` (2,097,152 bytes).

**DD-16 "Not read from Postgres" proof.**
- The `logs_body_guard` trigger fires only on `UPDATE OF body` (`0096_logs_streaming_skip_tombstones.sql:55`), so a scenario may overwrite `body_gz` without changing the revision.
- With the file cached, the step sets `body_gz` to `gzip('[]')`, keeping `body_gz_rev`. It checks that the response still carries the original bytes, then restores the original `body_gz`.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/src/logs/part-cache/part-cache.config.ts` | new | DD-1 config reader + constants |
| `server/src/logs/part-cache/part-cache.types.ts` | new | `PartCacheHit`, `PartCacheSweepState`, `PartCacheView` (DD-4, DD-9, DD-10) |
| `server/src/logs/part-cache/part-cache.service.ts` | new | DD-4..DD-8 service + sweep timer |
| `server/src/logs/part-cache/part-cache.module.ts` | new | `@Global()` module (DD-3) |
| `server/src/app.module.ts` | modify | import `PartCacheModule` |
| `server/src/logs/session-log-parts.service.ts` | modify | DD-5 hit/miss in `streamPart`; inject `PartCacheService` |
| `server/src/sessions/sessions.service.ts` | modify | `purgeSessionChildData` step d `.returning({ id: logs.id })` → `removeLogFolders` |
| `server/src/admin/admin.service.ts` | modify | `removeRepo`: `removeLogFolders(logIds)` after `:652` delete |
| `server/src/teams/teams.service.ts` | modify | repo delete: `removeLogFolders(logIds)` after `:644` delete |
| `server/src/users/account-deletion.service.ts` | modify | select `logs.id WHERE user_id` before the `users` delete (`:208`) → `removeLogFolders` |
| `server/src/system-info/system-info.types.ts` | modify | `partCache: PartCacheView` |
| `server/src/system-info/system-info.service.ts` | modify | inject `PartCacheService`; `partCache: await getAdminView()` |
| `server/test/contract/registry/f01-infra.ts` | modify | `F01-admin-system` comment (see Test coverage plan) |
| `client/src/models/admin.ts` | modify | `SystemInfoPartCache` type + `partCache` on `SystemInfo` (`:210`) |
| `client/src/viewer/pages/admin/tabs/system-card.tsx` | new | `Card` moved out of `AdminSystemTab.tsx` |
| `client/src/viewer/pages/admin/tabs/PartCacheCard.tsx` | new | DD-13 card |
| `client/src/viewer/pages/admin/tabs/AdminSystemTab.tsx` | modify | import `Card`, render `PartCacheCard` |
| `release-template/.env.example` | modify | 5 commented vars near `:121-140` |
| `server/.env.example` | modify | same vars, commented (`:26` area) |
| `server/README.md` | modify | env list (`:145` area) |
| `user-docs/server-configuration.md` | modify | env table rows (shape of `LOG_RETENTION_*`, `:21-23`) |
| `user-docs/component-reference.md` | modify | volume table `:84` (cache in `upload-queue` volume), admin panel `:108` |
| `release-template/INSTALL.md` | modify | backup note `:264`: `part-cache/` not needed in backups, safe to delete |
| `docs/knowledgebase/session-part-cache.md` | new | KB article for the cache (DD-1..DD-11) |
| `docs/knowledgebase/index.md` | modify | index line for the new article |
| `docs/knowledgebase/session-log-view.md` | modify | §"The parts API" (`:134-178`): hit/miss paragraph + link |
| `docs/knowledgebase/server-endpoint-map.md` | modify | parts route note (`:304-313`) + `partCache` on admin/system |
| `docs/knowledgebase/system-info-and-cluster.md` | modify | add the resolver to the CWD-relative list (`:197-215`) |
| `docs/knowledgebase/upload-queue.md` | modify | note: `part-cache/` subfolder is not staging (DD-12) |
| `tests/scenarios/modes.ts` | modify | DD-14 env |
| `tests/scenarios/view/s-sess-03.spec.ts` | modify | steps 16–21 |
| `tests/scenarios/auth/s-adm-01.spec.ts` | modify | step 4c, timeout |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` | modify | §S-SESS-03: steps 16–21 |
| `docs/qaa-overview/scenarios/01-auth-access-admin.md` | modify | §S-ADM-01: step 4c (and step count) |

## API changes

`GET /api/v1/admin/system` (admin only, unchanged guards `SessionAuthGuard` + `AdminGuard`, `admin-panel.controller.ts:60-63`):
- The response gains the field `partCache: PartCacheView` (DD-10). It is additive, and every other field is unchanged.
- No request parameters change.

No other route changes. The parts route keeps its headers, ETag, 304 and 404/400 behaviour byte for byte.

## Test coverage plan

- **API contract:**
  - `bodyMatches` deep-equals each top-level key (`server/test/contract/run-case.ts:842-849`). `partCache` holds a machine-specific `dir` and a changing `lastSweep`, so it cannot be pinned there.
  - `F01-admin-system` therefore keeps `expect: { status: 200 }` and gets a comment naming the new `partCache` field and saying its shape is asserted in `@S-ADM-01` step 4c.
  - `F01-admin-system-member` (403) is unchanged.
  - The contract harness itself does not change.
- **Scenario `@S-SESS-03`** (`tests/scenarios/view/s-sess-03.spec.ts`), new steps after step 15:
  - 16: fill and hit, plus the not-from-DB proof.
  - 17: no pre-warm and old-revision removal.
  - 18: FR-7 touch, plus the TTL check in mode A.
  - 19: cap and over-cap in mode C.
  - 20: fail open.
  - 21: session and repository deletion.
- **Scenario `@S-ADM-01`** (`tests/scenarios/auth/s-adm-01.spec.ts`): step 4c checks the API `partCache` field and the System tab card. Step 2 already covers non-admin 403 and anon 401.
- **Algorithm:** none. The requirements' Testing section states eviction is not an algorithm.
- **Not covered by a scenario:**
  - The FR-11 disabled switch, because the stand cannot toggle env per step. Its branch is a single `enabled` check in each method.
  - The FR-10 "warning logged" part. The scenario checks only that the request succeeds and that no file is written.
  - FR-2: every scenario that uploads already runs on a stand whose `upload-queue/` holds `part-cache/`.
  - Team repo delete (`teams.service.ts`) and account deletion (`account-deletion.service.ts`) are not checked for removed folders. They make the same `removeLogFolders` call that step 21 checks for session and admin repo delete, and the existing scenarios that run them still execute the new lines, so they count toward coverage: account deletion in `@S-AUTH-09` / `@S-ADM-02`, team repo delete in `@S-REPO-14`. The TTL sweep catches anything missed.

## Visual/UX notes

- Card layout and test ids are in DD-13. Use the existing `Card`, `formatBytes` (`client/src/viewer/lib/format`) and `DateTime` (`client/src/viewer/components/DateTime`).
- Text style follows the DB Space card (`AdminSystemTab.tsx:346-361`): `mt-2 text-sm font-bold text-foreground` for the main lines, and `text-xs text-muted-foreground font-mono truncate` for the folder path.
- No new wireframe is needed; the card is one more tile in an existing grid. Follow the `ui-components` skill.

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Part cache core service | 7 | new module; everything else depends on its API (DD-4) |
| 2 | Read path | 4 | `session-log-parts.service.ts` only |
| 3 | Deleted-data cleanup | 5 | four delete paths call `removeLogFolders` |
| 4 | Admin system API and perf | 4 | `partCache` field on admin/system; perf check after all server changes |
| 5 | Admin System tab card | 5 | client; consumes DD-10 shape |
| 6 | Docs and KB | 8 | env examples, user docs, KB |
| 7 | Tests: contract and stand env | 4 | registry comment, scenario env |
| 8 | Tests: S-SESS-03 fill/hit/TTL steps | 4 | steps 16–18 |
| 9 | Tests: S-SESS-03 cap/fail-open/delete, S-ADM-01 | 8 | steps 19–21, 4c, run them |

### Chunk 1 — Part cache core service
- [ ] Create `server/src/logs/part-cache/part-cache.config.ts`: `readPartCacheConfig()` returning `{enabled, dir, ttlDays, maxBytes, sweepIntervalMs}` and the exported constants, per DD-1.
- [ ] Create `server/src/logs/part-cache/part-cache.types.ts` with `PartCacheHit` (DD-4), `PartCacheSweepState` (DD-9) and `PartCacheView` (DD-10).
- [ ] Create `PartCacheService` in `part-cache.service.ts`: config read in constructor, `enabled` getter, `openForRead`, `touchOnHit` per DD-4, file layout per DD-2, logging per DD-11.
- [ ] Add `store()` to `PartCacheService` per DD-6 (over-`maxBytes` skip, temp file + rename, Windows `EPERM`/`EEXIST`/`EBUSY` handling, older-revision removal, `estimatedBytes`, `sweep('cap')` trigger).
- [ ] Add `sweep()`, the `SchedulerRegistry` timer `'part-cache-sweep'`, `onApplicationBootstrap` first sweep, `onModuleDestroy` cleanup and the state-file write, per DD-7 and DD-9.
- [ ] Add `removeLogFolders()` (DD-8) and `getAdminView()` (DD-10, reads the state file, returns `lastSweep: null` when it is missing or invalid).
- [ ] Create `@Global()` `PartCacheModule` (`part-cache.module.ts`) providing/exporting `PartCacheService`; import it in `server/src/app.module.ts`. Run `npm run typecheck` and `npm run lint` from `server/`.

### Chunk 2 — Read path
- [ ] Inject `PartCacheService` into `SessionLogPartsService` (`server/src/logs/session-log-parts.service.ts`) constructor.
- [ ] In `streamPart`, add the hit branch before today's query per DD-5 steps 1–3 (revision-only query, first-chunk probe with DB fallback, same headers, gzip / gunzip streaming, `finally` destroy, `touchOnHit` after `res.end()`).
- [ ] After the miss path's gzip `res.end()` and gunzip `res.end()`, call `cache.store(meta.logId, row.rev, row.gz)` when `row.gz !== null` and `row.rev` is all digits (DD-5 step 4).
- [ ] Update the `streamPart` doc comment to describe hit/miss; run `npm run typecheck` and `npm run lint` from `server/`.

### Chunk 3 — Deleted-data cleanup
- [ ] `server/src/sessions/sessions.service.ts` `purgeSessionChildData` step d (`:378`): add `.returning({ id: logs.id })` and call `this.partCache.removeLogFolders(ids)`; inject `PartCacheService` in the constructor.
- [ ] `server/src/admin/admin.service.ts` `removeRepo`: after `tx.delete(logs)` (`:652`) call `this.partCache.removeLogFolders(logIds)`; inject `PartCacheService`.
- [ ] `server/src/teams/teams.service.ts` repo delete: after `tx.delete(schema.logs)` (`:644`) call `this.partCache.removeLogFolders(logIds)`; inject `PartCacheService`.
- [ ] `server/src/users/account-deletion.service.ts` `hardDeleteUser`: before `tx.delete(users)` (`:208`) select `logs.id WHERE logs.user_id = userId`, then call `this.partCache.removeLogFolders(ids)`; inject `PartCacheService`.
- [ ] Run `npm run typecheck` and `npm run lint` from `server/`.

### Chunk 4 — Admin system API and perf
- [ ] `server/src/system-info/system-info.types.ts`: add `partCache: PartCacheView` (import the type from `../logs/part-cache/part-cache.types`) to `SystemInfoResponse` with a doc comment per DD-10.
- [ ] `server/src/system-info/system-info.service.ts`: inject `PartCacheService`; in `getSystemInfo` read `getAdminView()` in the existing `Promise.all` and return it as `partCache`.
- [ ] Run `npm run typecheck`, `npm run lint` and `npm run test` from `server/`.
- [ ] Run `npm run perf` from `server/`, as `.claude/rules/server.md` requires, with no build or test running alongside. Compare against the baseline that rule names. If any metric degrades by more than 20 %, stop and ask the user.

### Chunk 5 — Admin System tab card
- [ ] `client/src/models/admin.ts`: add `SystemInfoPartCacheSweep` and `SystemInfoPartCache` interfaces mirroring DD-9/DD-10 and a required `partCache: SystemInfoPartCache` on `SystemInfo` (`:210`).
- [ ] Move `Card` from `AdminSystemTab.tsx:60` into new `client/src/viewer/pages/admin/tabs/system-card.tsx` (exported); import it back in `AdminSystemTab.tsx`.
- [ ] Create `client/src/viewer/pages/admin/tabs/PartCacheCard.tsx` with prop `partCache: SystemInfoPartCache`, lines, states and test ids per DD-13 and Visual/UX notes.
- [ ] `AdminSystemTab.tsx`: render `<PartCacheCard partCache={data.partCache} />` in the DB Space grid row; render the row when either card has content (DD-13).
- [ ] Run `bun run typecheck`, `bun run lint` and `bun run test` from `client/`.

### Chunk 6 — Docs and KB
- [ ] `release-template/.env.example` (near `:121-140`) and `server/.env.example` (`:26` area): add the five DD-1 env vars, commented out, with defaults and one-line meaning; say the folder is a disposable cache.
- [ ] `server/README.md` env list (`:145` area) and `user-docs/server-configuration.md` env table (rows shaped like `LOG_RETENTION_*`, `:21-23`): add the five DD-1 vars with defaults.
- [ ] `user-docs/component-reference.md`: volume table (`:84`) — `part-cache/` inside the `upload-queue` volume is a disposable cache; admin panel (`:108`) — the Part cache card per DD-13.
- [ ] `release-template/INSTALL.md` backup note (`:264`): `upload-queue/part-cache/` need not be backed up and is safe to delete with the server stopped or running.
- [ ] Create `docs/knowledgebase/session-part-cache.md` (OKF v0.3 front matter, `type: "Architecture Guide"`) covering DD-1–DD-12 (including the `SESSION_PART_CACHE_ENABLED=false` switch) and the PoC link; add its line to `docs/knowledgebase/index.md`.
- [ ] `docs/knowledgebase/server-endpoint-map.md`: note the `partCache` field on `GET /api/v1/admin/system` and the cache behind the parts route (`:304-313`).
- [ ] `docs/knowledgebase/session-log-view.md` §"The parts API" (`:134-178`): add a hit/miss paragraph linking `session-part-cache.md`; `system-info-and-cluster.md` (`:197-215`): add the cache dir resolver; `upload-queue.md`: DD-12 note.
- [ ] Run `npm run build:help` from the repo root so the in-app help picks up the `user-docs/` changes.

### Chunk 7 — Tests: contract and stand env
- [ ] `server/test/contract/registry/f01-infra.ts` row `F01-admin-system` (`:79-84`): keep `expect: { status: 200 }`; add a comment that the answer now carries `partCache` (DD-10), asserted in `@S-ADM-01` step 4c because `bodyMatches` deep-equals top-level keys.
- [ ] `tests/scenarios/modes.ts` `standEnv` (`:133-170`): add `SESSION_PART_CACHE_SWEEP_INTERVAL_MS: '1000'` for every mode and `SESSION_PART_CACHE_MAX_MB: '1'` for mode `c`, each with a one-line comment (DD-14).
- [ ] Run `npm run test:scripts` and `npm run typecheck:tests` from the repo root.
- [ ] Run `npm run test:contract` from `server/` (in the background; app group — nothing else from that group concurrently).

### Chunk 8 — Tests: S-SESS-03 fill/hit/TTL steps
- [ ] `tests/scenarios/view/s-sess-03.spec.ts`: add the `stand` fixture and helpers:
  - `cacheFile(logId, rev)`, a path under `stand.runDir/upload-queue/part-cache`;
  - `logRow(sessionId, logType)`, returning `{id, rev, bodyGz}` from `logs` joined to `sessions`;
  - `allCacheBytes()`, summing all `*.json.gz` sizes.

  Mode branching uses `standMode()` from `../helpers/auth-mode` (DD-15). Raise `test.setTimeout` to 480,000 ms, and add a line for steps 16–21 to the header comment (lines 25–31).
- [ ] Step 16, after step 15:
  - Both modes: read the GS-05 root claude part, then poll until its cache file exists with bytes equal to `body_gz` and no `.tmp-` file is in its folder.
  - Mode A only: run the DD-16 proof. With `body_gz` set to `gzip('[]')`, gzip and identity reads return the original lines with the same ETag and `Content-Length`. Then restore `body_gz`.
- [ ] Step 17: re-upload W1 (DD-15) with a second marker line and poll until `body_gz_rev = body_rev`. Assert that no file exists for the new revision. Read the W1 part and poll until the new revision's file exists. In mode A, also assert that the old revision's file is gone.
- [ ] Step 18:
  - Both modes: backdate the GS-05 claude file 2 h, read the part, and poll until its mtime is within 60 s of now.
  - Mode A only: read the W2 part and the GS-05 artisyn part and poll for their files. Backdate W2 by 15 days and poll until it is gone (10 s). Backdate the artisyn file by 13 days and assert it still exists 3 s later.

### Chunk 9 — Tests: S-SESS-03 cap/fail-open/delete, S-ADM-01
- [ ] `s-sess-03.spec.ts` step 19a (mode C only, DD-15): write the dummy files `9000000001/1.json.gz` (mtime minus 3 days) and `9000000002/1.json.gz` (minus 2 days), 614,400 bytes each. Poll until the first dummy is gone and `allCacheBytes() <= 1048576`.
- [ ] Step 19b (mode C only): re-upload W1 (DD-15) with the DD-15 random base64 line, wait and `body_gz_rev = body_rev`, read the part (200, parses as a JSON array), and assert no file exists for its new revision after 3 s.
- [ ] Step 20 (both modes):
  1. Read the GS-01 claude part and keep its lines.
  2. `rm` its `<logId>` cache folder (recursive, force) and write a plain file at that path.
  3. Read again: expect 200, equal lines, and the path still a plain file.
  4. Delete the blocking file.
- [ ] Step 21a (both modes): read the GS-07 claude and artisyn parts. The owner calls `DELETE /api/v1/sessions/<sid7>` (204), and both GS-07 `<logId>` folders are gone within 10 s (poll).
- [ ] Step 21b (both modes, last step of the test): read the GS-05 claude part. A `users.user('admin')` calls `DELETE /api/v1/admin/repos/<repo.repoId>`, and every GS-05 `<logId>` folder is gone within 10 s (poll).
- [ ] `tests/scenarios/auth/s-adm-01.spec.ts` step 4c, after step 4:
  - The admin `GET /api/v1/admin/system` returns `partCache.enabled === true` and `ttlDays === 14`, and `lastSweep` is non-null within 10 s (poll).
  - The UI shows `part-cache-card`, `part-cache-status` ("Enabled") and `part-cache-size` (regex `/ of .* · \d+ files/`).
  - Raise its `test.setTimeout` to 210,000 ms.
- [ ] Add the new steps to `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` §S-SESS-03 (16–21) and `docs/qaa-overview/scenarios/01-auth-access-admin.md` §S-ADM-01 (4c, step count).
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03|@S-ADM-01"`, then the same with `--mode c`, from the repo root (in the background, one at a time).
