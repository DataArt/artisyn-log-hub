---
type: "Reference"
title: "Server Log Subsystem"
description: "The server's own operational logging (not telemetry/session logs): pino app and SQL loggers, daily file rotation, no built-in retention, the Admin Panel Error Logs tab and Logs Archive download."
tags:
  - server
  - logging
timestamp: "2026-10-14T00:00:00+04:00"
---

# Server Log Subsystem

Reference for the server's own **operational** logging (pino, file rotation, the Admin Panel's
Error Logs / Logs Archive features). This is distinct from the product's telemetry/session logs
(Claude Code hook events ingested via `/api/v2/logs` — the only upload route since v1 was
removed, see `hook-api-versioning.md`, `session-log-view.md` and
`db-tables.md`) — "log" here means "what the NestJS process writes about itself."

## Two independent pino loggers

Both live under `server/src/common/` and are self-contained by design (day-tag/instance-suffix
logic is intentionally duplicated rather than shared):

| Logger | File | Writes to | Used via |
|---|---|---|---|
| App logger | `app-logger.ts` | `logs/app-YYYY-MM-DD[-iN].log` | `AppLogger` (NestJS `LoggerService`), passed to `NestFactory.create()` in `main.ts` — all internal NestJS log calls go through it |
| SQL logger | `sql-logger.ts` | `logs/sql-YYYY-MM-DD[-iN].log` | `logSqlQuery(sql, durationMs, error?)` — every query (`info`), slow queries over `SLOW_QUERY_THRESHOLD_MS` (100ms, `warn`), and query errors (`error`) |

**Suppressing routine noise:** prefix a query's SQL text with `NO_LOG_MARKER` (`/* no-log */`,
e.g. `` sql`${sql.raw(NO_LOG_MARKER)} UPDATE ...` `` in a drizzle template) to skip its `info`-level
"SQL query" line — used by `UploadQueueSchedulerService`'s per-tick lease-reclaim and claim
queries, which would otherwise flood the SQL log every second. `warn`/`error` logging for the same
query still fires regardless of the marker (`isNoLogQuery()` checks it only in the `info` branch).

**Rotation:** a custom `DailyRotateStream`-style `Writable` (not `pino-roll` — its transport
workers don't run inside `ncc` bundles) opens a new file once the calendar day changes
(`computeDayTag()`). The app logger also multistreams to `pino-pretty` for colourised stdout.

**Worker instance suffix:** in a cluster worker, `computeInstanceSuffix()` reads
`NODE_APP_INSTANCE` (the 0-based worker slot index the cluster primary sets on `cluster.fork()`) and
appends `-i<N>` so parallel workers don't interleave writes into one file. A restarted worker is
re-forked into the same slot, so it keeps writing to the same `-i<N>` file rather than starting a new
series. Empty/unset in local dev (single process) and in the cluster primary itself.

**Retention: none.** No code anywhere deletes old `app-*.log`/`sql-*.log` files — they accumulate
in `server/logs/` indefinitely until removed externally. See "Gotchas" below.

## Admin Panel features built on top of these files

### Error Logs tab
- `GET /api/v1/admin/error-logs` → `ErrorLogsService.getErrorLogs()`
  (`server/src/error-logs/error-logs.service.ts`)
- Scans the `MAX_FILES_TO_SCAN` (30) most recent `app-*.log` files (matched via
  `FILE_NAME_PATTERN`, sorted by the embedded day tag — directory listing, not a backward day walk,
  so other workers' `-i<N>` files are found too), parses lines at `ERROR` level via `LINE_PATTERN`
  (the fixed-width logback format written by `logback-formatter.ts`), merges/sorts newest-first,
  and returns up to `MAX_ENTRIES` (30) `{ timestamp, source, message, details }` entries.
  Returns `{ entries: [] }` (not an error) if `logs/` doesn't exist yet.
- Client: `AdminErrorLogsTab.tsx` (`client/src/viewer/pages/admin/tabs/`) — fetches once on mount
  (plain `useState`/`useEffect`, no auto-refresh); columns Timestamp / Source / Message
  (+ muted details line).

### Logs Archive download
- `GET /api/v1/admin/logs-archive` → `AdminPanelController.downloadLogsArchive()` →
  `SystemInfoService.createLogsArchive()` (`server/src/system-info/system-info.service.ts`) zips
  the whole `logs/` directory (via `archiver`) to a temp file, streams it as the response, then
  unlinks the temp zip.
- Client: the "Logs Archive" tile in `AdminSystemTab.tsx` — calls `downloadLogsArchive()` (`api.ts`)
  and triggers a browser download via a `Blob` + temporary `<a download>`.

## Gotchas

- **No day-based cleanup exists in code.** If you see stale documentation or assumptions about an
  "N-day retention," verify against `app-logger.ts`/`sql-logger.ts` directly — there is no
  `setInterval`/cron/`@Cron` anywhere in `server/src` that deletes log files.
- **Logs are not persisted across container recreation.** `docker-compose.yml` mounts no volume
  for `server/logs/` — it lives in the container's writable layer only. A container restart
  (`restart: unless-stopped`) keeps the same filesystem, but recreating the container (rebuild/
  redeploy) wipes all accumulated logs. In practice this is often the real reason prod only shows
  a few days of history — not any retention logic.
- Rotation is **daily**, not hourly — file names carry only `YYYY-MM-DD` (no hour component).
  A reference to an hourly `app-YYYY-MM-DD-HH.log` name does not match any file the server writes.
- **Deleting/reprocessing an `upload_queue` row does not remove its log line.** The Error Logs tab
  reads `ERROR` lines straight from `app-*.log`, independent of the `upload_queue` table's current
  state. If you manually reproduce a failure against the real dev server (e.g. POSTing malformed
  NDJSON to check how the Error Logs / Upload Queue tabs render it) and then clear or reprocess that
  row via the admin UI, the DB row disappears but the `Logger.error(...)` call already written to
  disk stays — the tab keeps showing it until the file ages out of the 30-file scan window. This is
  not caused by the automated e2e suite: `test/helpers/create-app.helper.ts` builds the test app
  with the default console-only NestJS logger (no `logger: appLogger` override, unlike `main.ts`),
  so `npm run test:e2e`/`test:e2e:full` runs never write to `app-*.log` at all. Any test-fixture-
  looking `sessionId` you spot in the Error Logs tab (e.g. `v2-admin-list-*`, `v2-reprocess-*` from
  the old, now deleted, upload-queue jest spec) is therefore residue from someone manually replaying that scenario
  against the live dev server, not the automated suite.
