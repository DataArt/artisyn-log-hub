---
type: "Reference"
title: "Session Data Retention"
description: "Automated session retention/purge job: config env vars, eligibility rules, purge mechanics, audit trail, and the hook-side project-local OTEL file prune."
tags:
  - retention
  - sessions
  - scheduler
  - hooks
timestamp: "2026-08-07T00:00:00+04:00"
---

# Session Data Retention

## Purpose

`SessionRetentionService` is a background scheduler that permanently ("hard") deletes
old session data so the database doesn't grow unbounded. It is configured
entirely via environment variables; the admin "Data Retention" tab only displays the current
setting and session-age stats (read-only, see Related).

**Location:** `server/src/sessions/session-retention.service.ts`
**Registered in:** `server/src/sessions/sessions.module.ts`

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `SESSION_RETENTION_DAYS` | `30` | Root sessions whose earliest log row is older than this many days become eligible for purge |
| `SESSION_RETENTION_CHECK_INTERVAL_MS` | `1800000` (30 min) | How often the scheduler ticks and checks for eligible sessions |
| `SESSION_RETENTION_PURGE_BATCH_SIZE` | `200` | Max root sessions purged per tick, so one tick's work stays bounded even after a large backlog (e.g. first deploy) |

All three fall back to their default via `Number(process.env.X) || default` if unset, empty, or
non-numeric — there is no required configuration. Renamed from `SESSION_RETENTION_INTERVAL_MS` /
`SESSION_RETENTION_BATCH_SIZE` to the current names with no backward-compatible fallback: a
deployment still setting the old names silently falls back to defaults instead of erroring.

**Read timing** (`SessionRetentionService`):
- `SESSION_RETENTION_CHECK_INTERVAL_MS` is read once in `onModuleInit()` to size the
  `setInterval(...)` call. Changing it requires a process restart — re-reading it inside `tick()`
  cannot resize an already-created interval.
- `SESSION_RETENTION_DAYS` and `SESSION_RETENTION_PURGE_BATCH_SIZE` are read fresh on every tick,
  so changing them takes effect on the next firing without a restart.

Defined in `server/.env.example` under "Session retention cleanup".

## Eligibility

A root session (`parent_session_id IS NULL`, `deleted = false`) is purged when its earliest
`logs.created_at` predates `now() - SESSION_RETENTION_DAYS days`. Notably:

- A root session with **zero log rows** has no earliest-log signal to test against, so it is
  excluded from the eligibility query (an inner join against `logs`).
- An **already soft-deleted** session (`deleted = true`) is excluded — the eligibility query
  requires `deleted = false`, so a session a user already deleted is never a retention candidate
  regardless of how old its data is.
- Eligible roots are processed oldest-first, up to `SESSION_RETENTION_PURGE_BATCH_SIZE` per tick.

## Purge mechanics

For each eligible root, `SessionsService.hardPurgeExpiredSessions()` (`server/src/sessions/sessions.service.ts`):

1. Walks the session tree (`getDescendantSessionIds`) to find all descendants.
2. Splits descendants into still-active vs. already individually soft-deleted — only active ones
   get their child data captured/purged; an already soft-deleted descendant's data is already gone.
3. In one transaction per root (so one bad root can't roll back roots already purged earlier in
   the same tick): writes a `deleted_session_log` audit row per active session (`deletedByUserId:
   null` marks it as an automated purge, not a user action — see `docs/knowledgebase/db-tables.md`
   § `deleted_session_log`), deletes child data (`session_stats`, `session_call_tokens`,
   `session_costs`, `user_favorite_sessions`, `session_file_stats`, `session_okf_access` (step c2),
   `logs`, orphaned `contexts`, queued `upload_queue` rows), then hard-deletes
   the `sessions` rows themselves — root and every descendant (including any already-soft-deleted
   one, whose bare row is still hard-deleted even though its data was already purged).
4. Per-root failures are logged and skipped; the loop continues with the remaining roots in the
   batch.

### Orphan harness-snapshot and OKF-snapshot cleanup

`purgeSessionChildData()` (`sessions.service.ts`, shared by soft delete, hard delete, admin family
delete and this retention job) ends with two more steps, after the child-data deletes above and
before the `sessions` rows themselves are removed:

- **g.** Clears `sessions.harness_snapshot_id` and `sessions.okf_snapshot_id` to `NULL` for every
  session id in the batch. This must run before step h, since h's orphan test is "no session
  references this snapshot id any more".
- **h.** `deleteOrphanHarnessSnapshots(tx)` (`server/src/logs/harness-snapshot.ts`): deletes every
  `harness_snapshots` row that no `sessions.harness_snapshot_id` references any more, across **all**
  owners (`DELETE FROM harness_snapshots hs WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE
  s.harness_snapshot_id = hs.snapshot_id)`). A row is conservative to delete: it survives as long
  as any session anywhere still references its `snapshot_id`, so no owner join is needed. Then
  `deleteOrphanOkfSnapshots(tx)` (`server/src/logs/okf/okf-snapshot.ts`) does the same for
  `okf_snapshots` against `sessions.okf_snapshot_id`.

Step **c2** (earlier in the same function) deletes the session ids' `session_okf_access` rows
explicitly: the table cascades on a hard delete of `sessions`, but a soft delete keeps the row,
so without c2 the OKF tabs' access rows of a soft-deleted session would stay behind.

The same `deleteOrphanHarnessSnapshots(tx)` and `deleteOrphanOkfSnapshots(tx)` calls are also made
from the team-repo deletion path
(`server/src/teams/teams.service.ts`, step 4d), right after that path hard-deletes the `sessions`
rows that become orphaned once a repo is detached from a team (no other repo or log still
references them). Account deletion needs no explicit sweep: `harness_snapshots.user_id` and
`okf_snapshots.user_id` have `ON DELETE CASCADE` on `users`.

This is a genuine hard delete, distinct from user-triggered `deleteSession()`, which only
soft-deletes (`deleted = true`) and leaves the row and its data in place.

## Tests

Covered by S-SLIFE-08 (`tests/scenarios/sessions/s-slife-08.spec.ts`): the stand ticks the retention
scheduler every 50 ms and makes sessions old with `shiftSessionTree`. The former jest specs were deleted on 2026-10-16 (CLAUDE.md → "Test policy").

## Client-side: the project-local OTEL prune (hook `2.3.0`+)

Separate mechanism, separate machine, separate config — this one runs **in the hook**, on the
developer's disk, and never touches the database. It exists because `otel-receiver.js` writes a
`<telemetryDir>/otel/<session-id>.jsonl` file per session that nothing else would ever clean up.

- **Where:** `pruneOtelDir()` in `send-logs-hook.js`, called at the end of `runUpload()` on the
  `Stop`/`Interrupt` path — i.e. after the same run has already uploaded those files.
- **Config:** `otelRetentionDays` in `.artisyn/config/log-hub.json`, default `7`; `0` means "use the
  default". The whole pass (collection *and* prune) is skipped when `otelEnabled` is `false`.
- **Rule:** delete every `*.jsonl` in that directory whose `mtimeMs` is older than
  `retentionDays × 86400000`, plus any **zero-byte** `*.jsonl` regardless of age — `listJsonlFiles()`
  filters empty files out of the upload pass, so without this they would never be reconsidered.
  The current session's own file is never deleted.
- **Locking:** none of its own. It runs inside the `acquireUploadLock(telemetryDir, …)` that
  `main()` already holds, and the otel directory lives inside `telemetryDir`, so it is already
  serialised against a concurrent `prompt-upload-hook.js` run of the same project.
- **Failure handling:** each unlink is individually `try/catch`ed (a Windows file lock on one file
  must not abort the sweep) and one summary
  `otel prune: deleted=… kept=… failed=… retentionDays=…` line is written to `hook.log`.

Note the asymmetry with the server side above: pruning a local `.jsonl` file does **not** remove the
records from the hub. They were already uploaded, and on the server they are ordinary `logs` rows
with `log_type = 'otel'`, subject only to the global `SESSION_RETENTION_DAYS` purge, which is
log-type-agnostic. Lowering `otelRetentionDays` only shortens how long the raw files linger on disk.

See `docs/knowledgebase/otel-receiver.md` for the directory layout and
`docs/knowledgebase/hook-installation.md` § "OTEL settings" for the config keys.

## Related

- `docs/knowledgebase/db-tables.md` § `sessions`, § `deleted_session_log` — schema-level detail on
  the columns this service reads/writes.
- `client/src/viewer/pages/admin/tabs/AdminDataRetentionTab.tsx` (+ `DataRetentionChart.tsx`) — the
  admin "Data Retention" tab that surfaces the current retention setting and session-age stats.
