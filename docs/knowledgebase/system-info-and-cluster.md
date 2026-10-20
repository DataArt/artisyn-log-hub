---
type: "Architecture Guide"
title: "System Info & Cluster Parallel Launch"
description: "Native node:cluster launch (server/src/cluster/), the System Info API, and the Admin Panel System Info tab."
tags:
  - server
  - cluster
timestamp: "2026-09-02T00:00:00+04:00"
---

# System Info & Cluster Parallel Launch

Docker/production runs the server as a **native `node:cluster`** deployment: one primary (supervisor)
process forks N Node.js HTTP workers that share the listening socket, instead of a single Node process.
This doc covers the cluster launch setup and the System Info API/UI added to observe it.

The launcher is first-party code in `server/src/cluster/` — there is no external process manager, no
`pm2-runtime` container `CMD` and no `ecosystem.config.js`. PM2 is not used because it is AGPL-3.0 and the
`ncc` server bundle inlines its dependencies statically, so shipping it would put AGPL code inside the
distributed bundle.

---

## Cluster launch

### `server/src/cluster/`

Six files, all inside the ncc bundle (`server/src/main.ts` is the only entry point, so no file is
copied into the image separately any more):

| File | Role |
|---|---|
| `cluster.constants.ts` | The seven policy values: `CLUSTER_MODE_PRIMARY`, `WORKER_MIN_UPTIME_MS` (10 s), `WORKER_RESTART_BACKOFF_START_MS` (1 s), `WORKER_RESTART_BACKOFF_MAX_MS` (30 s), `WORKER_CRASH_BUDGET` (10), `SHUTDOWN_GRACE_MS` (8 s), `WORKER_STATS_INTERVAL_MS` (10 s) |
| `cluster-messages.ts` | The worker↔primary IPC contract: `WorkerStatsMessage`, `SupervisorSnapshotMessage`, `ApiKeyCacheInvalidateMessage`, and their mandatory type guards (`process.on('message')` hands over `unknown`) |
| `worker-slot-registry.ts` | All restart/crash-budget/shutdown policy, as a pure class with an injected `now: () => number` and **no** `node:cluster` reference |
| `cluster-primary.ts` | `runClusterPrimary(logger)` — thin `node:cluster` glue: fork, event wiring, broadcast, signal handling. The only consumer of `node:cluster` in the codebase |
| `worker-stats-reporter.ts` | Worker-side singleton (`workerStatsReporter`) — pushes this worker's RSS to the primary and caches the snapshot broadcast back |
| `api-key-cache-ipc.ts` | Worker-side half of the API-key cache invalidation channel: `invalidateApiKeyCache()` (local drop + send), `listenForApiKeyInvalidation()` (registered in `main.ts` bootstrap) |

**Mode switch** (bottom of `server/src/main.ts`):

```ts
if (process.env.CLUSTER_MODE === CLUSTER_MODE_PRIMARY && !cluster.isWorker) {
  runClusterPrimary(new AppLogger());
} else {
  bootstrap().catch(/* … */);
}
```

`!cluster.isWorker` — not the env var — is what distinguishes primary from child, because
`cluster.fork()` inherits `CLUSTER_MODE=primary` into every worker's env. The module-level
`uncaughtException` / `unhandledRejection` handlers near the top of `main.ts` serve both branches; the
primary registers none of its own.

`CLUSTER_MODE` is the one environment variable the launcher adds. Its only meaningful value is
`primary`; unset (or anything else) is the single-process boot used in local dev. It is supplied by the
runtime image (`ENV CLUSTER_MODE=primary`), is not meant to be operator-tuned, and is therefore listed
**commented out** in `server/.env.example:16`. No compose file sets it — the value arrives with the image.

**What the primary does on startup.** It computes `instances = computeInstanceCount(os.availableParallelism())`
and `poolMax = computeWorkerPoolMax(instances)` once, builds a `WorkerSlotRegistry(instances)`, and forks
slots `0..instances-1` with
`cluster.fork({ NODE_APP_INSTANCE: String(slot), DB_POOL_MAX: String(poolMax) })`. `cluster.fork(env)`
merges over the child's inherited env, so an operator-supplied `DB_POOL_MAX` is overridden — exactly what
`ecosystem.config.js`'s `env` block used to do. `cluster.schedulingPolicy` is left at Node's default
(`SCHED_RR` off Windows), and the listening socket is shared by `cluster` itself, so `bootstrap()`'s
`app.listen()` is unchanged.

The primary runs with `NODE_APP_INSTANCE` unset, so its own `AppLogger` writes the unsuffixed
`logs/app-<day>.log` — and `FILE_NAME_PATTERN` in `error-logs.service.ts` makes the `-i<N>` suffix
optional, so a primary-side fatal line is already discoverable in Admin → Error Logs.

**Restart policy (`WorkerSlotRegistry`).** Per-slot state is
`{ instance, pid, status, restarts, lastRestartAt, rssBytes, consecutiveFastCrashes, forkedAt }` with
`status` one of `'starting' | 'online' | 'restarting' | 'stopped'`. On exit:

- shutting down → `ignore` (no counter is touched);
- uptime ≥ `WORKER_MIN_UPTIME_MS` → reset `consecutiveFastCrashes`, re-fork immediately;
- uptime < `WORKER_MIN_UPTIME_MS` → count a fast crash and re-fork after
  `min(1s × 2^(n-1), 30s)` — 1, 2, 4, 8, 16, 30, 30, 30, 30 s (151 s cumulative) — until the 10th
  consecutive fast crash, which marks the slot `'stopped'` and gives it up.

An exit with code 0 outside shutdown takes the same branches as any other exit: the app never exits
cleanly on its own. On give-up the primary logs one fatal `AppLogger.error` line naming the slot and the
last exit code/signal; once **every** slot is `'stopped'` it calls `process.exit(1)`, handing the
container back to Docker's `restart: unless-stopped` rather than fork-looping.

**Slot reuse is the guarantee that matters for logs and for the admin table:** the replacement worker is
forked into the *dead worker's own index*, so `NODE_APP_INSTANCE` is stable across a crash and no new
`app-<day>-i<N>.log` series is ever started. `worker.id` is never used as an instance number.

**Shutdown interlock.** On the first `SIGTERM`/`SIGINT` (re-entrant calls are ignored) the primary marks
the registry as shutting down, `clearTimeout`s every pending re-fork timer (a scheduled timer would
otherwise fork mid-shutdown), forwards the signal **once** to each live worker via
`worker.process.kill(signal)` so each runs Nest's `enableShutdownHooks()` path (including
`DatabaseModule.onApplicationShutdown()`'s `pool.end()`), and starts a `SHUTDOWN_GRACE_MS` (8 s) timer.
It exits 0 as soon as the `cluster.on('exit')` handler sees the last live worker go, or — if the timer
fires first — `SIGKILL`s the stragglers and then exits 0. The 8 s sits under Docker's default 10 s
`docker stop` grace period, so a normal `docker stop` completes without a `SIGKILL`.

**Snapshot broadcast.** The primary sends its merged `SupervisorInfo` snapshot to every live worker (a)
on any slot state change (forked / online / exit / gave up) and (b) on receipt of each worker's stats
message, each `worker.send()` in its own try/catch (a worker mid-exit throws `ERR_IPC_CHANNEL_CLOSED`).
Clause (b) is what closes a new worker's cold-start window: `cluster.on('online')` fires when the child
*process* spawns, long before Nest constructs `SystemInfoService` and `workerStatsReporter.start()`
registers its `message` listener, so a worker never receives its own `online` broadcast — it gets a
snapshot one round trip after its own first push instead.

**API-key cache invalidation.** Each worker keeps an in-memory LRU of validated API keys
(`server/src/api-keys/api-key-cache.ts`, 256 entries, keyed by `sha256(rawKey)`, value
`{ keyId, userId, expiresAt }`) so a hook request skips the argon2 check on a hit. Because every worker
has its own cache, a revocation must reach all of them:

- Triggers: `ApiKeysService.delete()`, `ApiKeysService.update()` when `expiresAt` changes, and
  `AccountDeletionService.hardDeleteUser()`. Each calls `invalidateApiKeyCache({ keyId })` or
  `({ userId })`, which drops the entries locally and then `process.send`s
  `{ type: 'api-key-cache-invalidate', keyId?, userId? }` (`API_KEY_CACHE_INVALIDATE_MESSAGE`).
- The primary (`cluster-primary.ts`) validates it with `isApiKeyCacheInvalidateMessage` (at least one of
  `keyId`/`userId`, both numbers when present) and rebroadcasts a rebuilt message — only the validated
  fields — to **every** live worker, the sender included (a second drop is a no-op), each `worker.send()`
  in its own try/catch.
- Workers apply it via the listener from `listenForApiKeyInvalidation()`.
- Without an IPC channel (local dev, jest — `process.send` undefined) sending and listening are no-ops;
  the local drop already covered the only process.
- A cache hit still rejects a key whose `expiresAt <= now`, so expiry needs no message.

### `server/src/common/instance-count.ts`

```ts
export function computeInstanceCount(cpus: number): number {
  return Math.max(1, Math.max(3, Math.min(Math.floor(cpus / 2), 15)));
}

export function computeWorkerPoolMax(instances: number): number {
  return Math.max(5, Math.floor(20 / instances));
}
```

- **Instance count formula**: at least 3, at most `floor(cpus / 2)`, capped at 15 — ensures at least 3
  workers regardless of CPU count while capping at 15 to avoid multiplying DB connections/memory
  unboundedly. This is now the **single** source of truth for the formula (`ecosystem.config.js` used to
  duplicate it because a plain-CommonJS file copied into the image could not `require()` compiled
  TypeScript; the primary is inside the bundle, so that duplication is gone).
- **`computeWorkerPoolMax`**: divides a ~20-connection ceiling across all workers so the combined pool
  size stays roughly constant regardless of worker count. Its `20` mirrors the
  `Number(process.env.DB_POOL_MAX) || 20` fallback in `database.module.ts` / `system-info.service.ts`.
- Both are used by `SystemInfoService.getSystemInfo()` (for the *expected* instance count, compared
  against the *actual* `supervisor.processes.length`) and by `cluster-primary.ts` (for the fork count and
  the per-worker `DB_POOL_MAX`).

### Dockerfile changes (multi-stage build, repo-root `Dockerfile`)

- **`GIT_COMMIT` build arg**: `ARG GIT_COMMIT=unknown` in the runtime stage, baked into `build-info.json`
  (see below) so the running app can report which commit it was built from.
- **`RELEASE_STAMP` build arg**: `ARG RELEASE_STAMP=unknown` in the runtime stage — the UTC
  `YYYYMMDD-HHMMSS` release identity that `scripts/release.js` (or CI) generates; it is a
  separate field rather than a bumped `version`.
- **`build-info.json`**: written during the runtime stage —
  `printf '{"version":"%s","gitCommit":"%s","releaseStamp":"%s"}' "$VERSION" "${GIT_COMMIT:-unknown}" "${RELEASE_STAMP:-unknown}" > dist/public/static/build-info.json`.
  `VERSION` comes from `server/package.json` (captured at the end of the server-build stage into
  `/app/dist/.app-version`) and is **no longer bumped** by a release run. Read by `readBuildInfo()`
  (`server/src/common/build-info.ts`) through `SystemInfoService.getBuildInfo()` (cached after first
  read); falls back to `{ version: 'dev', gitCommit: 'unknown', releaseStamp: 'dev' }` when the file
  doesn't exist (local/dev, unbundled). A file written by an image built **before** the stamp existed
  carries only two fields; the missing one is normalized to `'unknown'` on read, so the rest of the
  app can treat `BuildInfo.releaseStamp` as always present. The same three fields widen the **public**
  `GET /health/version` payload — `client/src/viewer/hooks/useBuildVersion.ts` declares its own
  two-field interface and simply ignores the extra one.
- **Cluster launch**: the runtime stage installs no process manager. It sets `ENV CLUSTER_MODE=primary`
  beside `ENV PORT=3000` and the container `CMD` is plain `["node", "index.js"]` — the bundle's own mode
  switch turns that one process into the primary, and the primary forks the workers.
- **`WORKDIR /app/dist`** is set **after** the `COPY … ./dist` steps and the build-info `RUN` (both of
  which are relative to `/app`), immediately before `CMD`. It is what makes every CWD-relative resolver
  land where it used to under `ecosystem.config.js`'s `cwd: __dirname` (also `/app/dist`).

### Persistent volumes (`docker-compose.yml`)

The runtime image's `WORKDIR /app/dist` is the container's CWD, and both the file logger
(`common/app-logger.ts`) and the upload queue's staging directory (`UploadQueueService.resolveStagingDir()`)
resolve their directory names (`logs`, `upload-queue`) relative to CWD by default — i.e. `/app/dist/logs`
and `/app/dist/upload-queue`. Neither is backed by a bind mount inside the container image itself, so
`docker-compose.yml` mounts named volumes at both paths (`logs_data`, `upload_queue_data`). Without these,
a redeploy (image rebuild + container recreation) wipes both directories while leaving the external
Postgres DB untouched — any `upload_queue` row whose staged `.raw` file hadn't been processed yet becomes
permanently unrecoverable (reprocessing it fails with `ENOENT`), and `server/logs/app-*.log` history (used
by the admin Error Logs tab) resets to empty.

The full set of CWD-relative resolvers `WORKDIR /app/dist` governs: `resolveStagingDir()`
(`UPLOAD_QUEUE_DIR` || `upload-queue` → `upload_queue_data`), `SystemInfoService.getLogsDir()`,
`app-logger.ts`'s `new DailyRotateStream('logs')`, `sql-logger.ts`'s `new DailyRotateSqlStream('logs')`
and `error-logs.service.ts` (all `logs` → `logs_data`), plus `logs/export-import-zip.ts`
(`EXPORT_IMPORT_DIR` || `export-import`, deliberately ephemeral with no volume).

**A second, code-level cause of the same `ENOENT` symptom (fixed, see below).** Even with the volume
correctly mounted, `UploadQueueService.reassembleChunks()` used to delete a chunked upload's `.chunkN`
part-files *before* updating the `upload_queue` row to point at the reassembled `${uploadId}.raw` file. A
process restart in that exact window (e.g. the supervisor forwarding `SIGTERM` for a redeploy, mid-tick)
left the row pointing at a part-file that no longer existed — `UploadQueueSchedulerService` then failed
every retry identically, forever, with `ENOENT: ... chunk0`. Seen twice in ~1 month of prod logs. Fixed by
reordering the DB update ahead of the unlink, so a crash there can only ever leave harmless leftover files,
never a dangling row. `UploadQueueSchedulerService.processRow()` also self-heals any row already stuck in
this state from before the fix, by falling back to `${uploadId}.raw` when the recorded file-name 404s, and
any *other* `ENOENT` now has a staging-dir file listing appended to `errorMessage` (visible in the admin
Upload Queue tab) so a genuinely missing file is diagnosable without shelling into the container.

---

## `ai-tool-versions` scheduler — cluster-safe npm dist-tag check (2026-09-23)

`server/src/ai-tool-versions/` (`AiToolVersionsModule`, registered in `app.module.ts`) records the
Claude Code npm dist-tags (`stable`, `latest`) so the client's `claude-version` Summary detector and the
"Claude Code Version Usage" report can compare a session's CLI version against the releases that were
current when it started. Tables: `ai_tool_version` (fetch state) and `ai_tool_version_history`
(append-only) — see `db-tables.md`. Read side: `GET /api/v1/ai-tool-versions/:toolName`.

- **Scheduler.** `AiToolVersionsScheduler` runs in **every** cluster worker: one unawaited
  `runCheck('claude-code')` in `onApplicationBootstrap`, then a `setInterval` registered in
  `SchedulerRegistry` as `ai-tool-version-check` (with an `isTickRunning` guard; `onModuleDestroy`
  clears it and awaits an in-flight tick). Same mechanics as `turn-end-advisor-orphan-cleanup.scheduler.ts`.
- **Cluster claim** (`AiToolVersionsService.runCheck`). Seed the row with
  `INSERT INTO ai_tool_version (tool_name) VALUES ($1) ON CONFLICT (tool_name) DO NOTHING`, then:

  ```sql
  UPDATE ai_tool_version SET last_attempt_at = now()
   WHERE tool_name = $1
     AND (fetched_at IS NULL OR fetched_at < now() - make_interval(hours => 24))      -- STALE_AFTER_HOURS
     AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(hours => 1)) -- RETRY_AFTER_HOURS
  RETURNING tool_name
  ```

  Only the worker that gets a row back calls npm; everyone else returns `'skipped'`. So at most one
  fetch per 24 h cluster-wide on success, retries no sooner than 1 h after a failure (1–2 h in practice
  with hourly ticks), and a worker crashing mid-fetch blocks others for one hour. On success one
  transaction writes `version_map` + `fetched_at` and appends a history row only when `stable` or
  `latest` changed (`effective_from = fetched_at`). A failure (network, non-2xx, bad payload) is logged
  at error level and changes nothing beyond the claim's `last_attempt_at`.
- **Env flags** (read at bootstrap, not import time; documented in `server/.env.example`):
  `AI_TOOL_VERSION_CHECK_ENABLED` — only the literal `false` disables the scheduler entirely (`server/test/contract/setup/global-setup.ts` and the scenario stand (`tests/scenarios/modes.ts`)
  set it so test runs never reach npm);
  `AI_TOOL_VERSION_CHECK_INTERVAL_MS` — tick interval, default `3600000` (1 h) when unset or not a
  positive integer.
- **Outbound dependency.** This is the server's first outbound HTTP call: a global `fetch` of
  `https://registry.npmjs.org/-/package/@anthropic-ai/claude-code/dist-tags` with a 5 s
  `AbortSignal.timeout`. A deployment without egress to `registry.npmjs.org` just logs a failed check
  each retry window; the history stays empty, and the detector and report treat every session as
  "unchecked" (no finding, not counted) rather than erroring. Set `AI_TOOL_VERSION_CHECK_ENABLED=false`
  to silence it.

---

## `model-pricing` scheduler: cluster-safe daily Anthropic pricing fetch (2026-10-13)

`server/src/model-pricing/` (`ModelPricingModule`, registered in `app.module.ts` after
`AiToolVersionsModule`) keeps `model_pricing` current from Anthropic's pricing page. It is a copy of
the `ai-tool-versions` pattern above. The parser, apply rules and OpenRouter import are described in
[model-pricing-research.md](model-pricing-research.md). Tables are in `db-tables.md`
(`model_pricing_fetch_state`, `model_pricing_meta`).

- **Scheduler.** `ModelPricingScheduler` runs in **every** cluster worker:
  - one unawaited `AnthropicPricingFetchService.runFetch()` in `onApplicationBootstrap`
  - then a `setInterval` registered in `SchedulerRegistry` as `model-pricing-fetch` (`SCHEDULER_NAME`)
  - an `isTickRunning` re-entry guard; `onModuleDestroy` clears the interval and awaits an in-flight tick
- **Cluster claim** (`AnthropicPricingFetchService.runFetch`):
  - Seed `model_pricing_fetch_state` row `'anthropic'` with `ON CONFLICT DO NOTHING`.
  - Then run `UPDATE … SET last_attempt_at = now() WHERE source = 'anthropic' AND (last_success_at IS NULL OR last_success_at < now() - make_interval(hours => 24)) AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(hours => 1)) RETURNING`.
    The two hour values are `STALE_AFTER_HOURS` and `RETRY_AFTER_HOURS`.
  - Only the worker that gets the row back fetches. Every other worker returns `'skipped'` and
    writes nothing.
  - The result is the same as for the dist-tag check: at most one fetch per 24 h cluster-wide on
    success, and retries no sooner than 1 h after a failure.
- **Persist.** Price writes and the fetch-state update (`last_result` `changed` / `unchanged`,
  `last_counts { changed }`, `last_success_at`) share one transaction under
  `pg_advisory_xact_lock(MODEL_PRICING_LOCK_KEY)`. A failure (network, non-2xx, a page the parser
  rejects) writes no price. It records `last_result = 'failed'` and `last_error`, and is logged at
  error level.
- **Env flags** (read at call time, not import time; documented in `server/.env.example`):
  - `MODEL_PRICING_FETCH_ENABLED`: only the literal `false` disables the scheduler entirely. `server/test/contract/setup/global-setup.ts` and the scenario stand (`tests/scenarios/modes.ts`)
    set it, so test runs never reach the network. It stays
    enabled in the dev watch server by default; developers can set it to `false` locally.
  - `MODEL_PRICING_FETCH_INTERVAL_MS`: the tick interval. The default is `3600000` (1 h), also used
    when the value is unset or not a positive integer.
- **Outbound dependency.**
  - The scheduler makes a global `fetch` of `https://platform.claude.com/docs/en/about-claude/pricing.md`
    with a 15 s `AbortSignal.timeout`.
  - A deployment without egress there logs a failed fetch each retry window, and prices stay as they
    are. Set `MODEL_PRICING_FETCH_ENABLED=false` to silence it.
  - The admin-only OpenRouter import (`https://openrouter.ai/api/v1/models`, 20 s timeout) is **not**
    scheduled. It runs only on the admin's button click, in the request's worker, and is serialized
    against the fetch by the same advisory lock.

---

## Server-side rolling logs — worker instance suffix

Both rotating loggers (`server/src/common/app-logger.ts` and `server/src/common/sql-logger.ts`) append a
`-i<N>` suffix to their daily filenames when `NODE_APP_INSTANCE` is set — i.e. in every cluster worker —
so parallel workers don't interleave writes into the same file. Because a crashed worker is re-forked into
the **same slot index**, its replacement keeps writing to the same `-i<N>` file rather than starting a new
series, so the per-worker log history stays continuous across restarts. The cluster primary itself runs
with `NODE_APP_INSTANCE` unset and writes the unsuffixed file. See `server-conventions.md`
§ Server-Side Rolling Logs for the full behaviour (`computeInstanceSuffix()`, filename patterns).

---

## System Info API

**Module:** `server/src/system-info/` (`SystemInfoModule`, exports `SystemInfoService`)

**Endpoint:** `GET /api/v1/admin/system` — `AdminPanelController.getSystemInfo()` in
`server/src/admin/admin-panel.controller.ts`. Guards: `SessionAuthGuard` + `AdminGuard` (same as the rest of
`AdminPanelController`). See `server-endpoint-map.md` for the full route table.

**Response shape:** `SystemInfoResponse` in `server/src/system-info/system-info.types.ts` — the single named
source of truth for the endpoint. The client declares an independent `SystemInfo` interface in
`client/src/models/admin.ts` rather than importing this server type (per the `RepoRow`/`AdminRepo`
server/client type-isolation convention used elsewhere).

```ts
interface SystemInfoResponse {
  instances: { expected: number; actual: number };  // expected = computeInstanceCount(cpus.visible); actual = supervisor.processes.length
  cpus: { visible: number; raw: number };            // visible = os.availableParallelism(); raw = os.cpus().length
  loadAverage: [number, number, number];             // 1m / 5m / 15m, os.loadavg()
  memory: { processRssBytes: number; systemUsedBytes: number; systemTotalBytes: number };
  uptime: { processSeconds: number; containerSeconds: number | null }; // null when not running inside a container
  db: {
    connected: boolean;
    pingMs: number | null;                           // null when connected=false
    pool: { max: number; total: number; idle: number; waiting: number };
  };
  dbSpace: {
    available: boolean;                              // false = DB role lacks size-inspection rights (or query failed)
    logsTableRowEstimate: number | null;              // pg_class.reltuples
    logsTableBytes: number | null;                    // pg_total_relation_size('logs')
    databaseTotalBytes: number | null;                // pg_database_size(current_database())
  };
  build: { version: string; gitCommit: string; releaseStamp: string };
  // releaseStamp: UTC YYYYMMDD-HHMMSS; 'unknown' on a pre-stamp image, 'dev' with no build-info.json
  node: { version: string; env: string };
  eventLoopLagMs: number;                             // this-instance only
  requests: { perSecond: number; active: number };    // this-instance only
  disk: { logsDirBytes: number; filesystemTotalBytes: number; filesystemFreeBytes: number };
  supervisor: SupervisorInfo;
}
interface SupervisorInfo {
  clustered: boolean;                     // false when running as a single process with no cluster primary
  processes: WorkerProcessSummary[];      // one row per worker slot, in slot order
}
interface WorkerProcessSummary {
  instance: number | null;      // 0-based slot index == NODE_APP_INSTANCE; null in the single-process fallback
  pid: number;                  // last known pid for the slot; -1 if never forked
  memoryBytes: number | null;   // worker-self-reported process.memoryUsage().rss; null until the slot has reported
  restarts: number;
  lastRestartAt: string | null; // ISO string, null if never restarted
  status: string;               // 'starting' | 'online' | 'restarting' | 'stopped', or 'online (single process)'
}
```

There is **no** `cpuPercent` field: per-process CPU sampling was a process-manager feature and is not
reproduced. There is deliberately no "sampled at" / staleness field either — the snapshot is pushed on a
10 s cadence and the response carries no timestamp for it.

### `SystemInfoService` (`system-info.service.ts`)

Assembles the response from several independent sources. Two async calls are run in parallel via
`Promise.all` (`getDbInfo`, `getDbSpace`); `getBuildInfo` and `getSupervisorInfo` are called synchronously
outside that group:

- **DB info** (`getDbInfo`) — connects, runs `SELECT 1`, measures ping; reports pool stats from the
  injected `PG_POOL`. Independent try/catch from `getDbSpace()` so a permissions failure in one never
  affects the other.
- **DB space** (`getDbSpace`) — `pg_class.reltuples`, `pg_total_relation_size('logs')`,
  `pg_database_size(current_database())`. `available: false` (all three fields `null`) on any query failure,
  e.g. insufficient DB role privileges.
- **Supervisor info** (`getSupervisorInfo`, synchronous) — reads `workerStatsReporter.getSnapshot()`, the
  last snapshot the primary broadcast over the cluster IPC channel. This is a plain in-memory read: there
  is no request-time round trip to the primary. `null` means no snapshot has ever arrived, which is the
  **sole** signal that this process is not running under a cluster primary (local dev, jest,
  `node index.js` by hand) — it falls through to a single synthetic entry describing the current process
  (`clustered: false`, `instance: null`, `status: 'online (single process)'`). In cluster mode the snapshot
  always carries one row per slot `0..N-1`, including slots that have not reported yet, so
  `instances.actual` equals the configured worker count.
- **Build info** (`getBuildInfo`, cached after first read, called synchronously) — delegates to
  `readBuildInfo()` (`server/src/common/build-info.ts`), which reads
  `dist/public/static/build-info.json` (see Dockerfile section above), normalizes a missing
  `releaseStamp` to `'unknown'`, and falls back to
  `{ version: 'dev', gitCommit: 'unknown', releaseStamp: 'dev' }` when the file is absent (local dev).
- **Event loop lag** (`getEventLoopLagMs`) — `perf_hooks.monitorEventLoopDelay()` histogram, enabled once at
  service construction (singleton scope); reports 0 until at least one sample exists.
- **Disk usage** (`getDiskUsage`) — recursive size of `logs/` (resolved relative to CWD, same convention as
  the loggers) plus `fs.statfsSync()` filesystem totals; reports zero if `logs/` doesn't exist yet.
- **Request metrics** (`requests`) — read from the module-scoped `requestMetricsTracker` singleton (see
  below), this-instance only.

`workerStatsReporter.start()` is called from the service **constructor** (so the `message` listener is
registered exactly once, never per request) and `workerStatsReporter.stop()` from `onModuleDestroy()`. The
reporter returns immediately from `start()` when `typeof process.send !== 'function'` (local dev, jest),
which is what keeps the fallback path in play with no open handles.

### `RequestMetricsMiddleware` / `requestMetricsTracker` (`request-metrics.middleware.ts`)

A plain singleton (not a NestJS provider) tracking two this-instance metrics: an in-flight request counter
and a rolling 1-second window of request timestamps (for requests/sec). `RequestMetricsMiddleware` is
registered globally for all routes in `AppModule.configure()` (`consumer.apply(RequestMetricsMiddleware).forRoutes('*')`)
and writes to the tracker; `SystemInfoService` reads from it. Decoupled from DI so both sides can share state
without provider plumbing. `workerStatsReporter` follows the same precedent.

---

## Admin Panel UI — System Info tab

**Component:** `client/src/viewer/pages/admin/tabs/AdminSystemTab.tsx` — the first tab (`system-info`) in
`AdminPage.tsx`. See `client-component-map.md` and
`client-routing-and-layout.md` for the tab's place in the admin panel, and `client-component-map.md`'s
`AdminSystemTab.tsx` entry for the exact card/tile layout.

- Polls `GET /api/v1/admin/system` via react-query with `refetchInterval: 10_000` (10 s auto-refresh).
- Core card grid: Node Instances (actual/expected + status dot), Visible CPUs, Database (connected + ping),
  Memory (process/system with a bar), Uptime (process + container), Load Average (vs. visible CPUs).
- Secondary tiles strip: Build (version + short git commit), **Release** (`build.releaseStamp`, caption
  "build stamp (UTC)"), Node/Env, Event Loop lag, DB Pool (active/max), Disk (logs dir / filesystem
  total), Requests (per-second + active). Build and Release are deliberately separate tiles: `version`
  is a frozen semver, the stamp is the release identity.
- DB Space card: rendered only when `dbSpace.available` is true **and** `logsTableRowEstimate`,
  `logsTableBytes`, and `databaseTotalBytes` are all non-null.
- Per-worker breakdown table, 5 columns: PID, Memory, Restarts, Last Restart, Status (with a colored
  status dot). Rows are keyed by `instance ?? pid`, since a re-fork changes the pid but not the slot, and a
  `null` `memoryBytes` (slot forked but not yet reported) renders the same em-dash placeholder
  `lastRestartAt: null` uses. When `supervisor.clustered` is false the same 5 columns show a single
  fallback row for the current process instead (backend status string `'online (single process)'`; UI
  caption "Running without a supervisor — showing this process only").

### Release Downloads section

**Component:** `client/src/viewer/pages/admin/tabs/ReleaseDownloadsSection.tsx`, rendered by
`AdminSystemTab.tsx` directly below the per-worker breakdown table. No new tab and no new route — it
is part of the System Info tab.

It lists the release zips this instance carries (`GET /api/v1/admin/releases`, newest release stamp
only) and mints a 24-hour signed, unauthenticated download link per file
(`POST /api/v1/admin/releases/download-link`). Its own `useQuery(["admin-releases"])` is separate from
the tab's 10 s system-info poll and has no `refetchInterval` — the inventory only changes on a deploy.
An empty inventory **and** a failed query both render the single "No release zips on this instance"
row: an instance with no releases directory mounted is a normal local state, never an error.

The zips themselves are **not** part of the image and are **never** statically served — they arrive
through a read-only bind mount at `/app/dist/releases`, a sibling of the served `public/` tree. The
endpoints and the HMAC token contract are in `server-endpoint-map.md`; see
`client-component-map.md` for the component's own entry.
