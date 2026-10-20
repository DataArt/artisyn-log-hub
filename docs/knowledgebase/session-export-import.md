---
type: "Reference"
title: "Session Export, Import and Statistics Export"
description: "Moving a repository's sessions between Log Hub instances: the zip format synthesised from stored logs, background jobs tracked in export_import_jobs, the owner-or-admin gate, import validation (format version, zip limits, zip-slip guard, strict JSONL), the session.json pre-check and ownership conflicts (409), single-user-mode reassignment, the keep-longer merge and author resolution, bootstrap import; plus the client-side Session Statistics Export."
tags:
  - server
  - client
  - export
timestamp: "2026-10-14T00:00:00+04:00"
---

# Session Export, Import and Statistics Export

The repository **Settings → Import/Export** sub-tab (`ImportExportSection.tsx`) holds two separate
features:

- **Session export and import** — moves raw sessions between Log Hub instances as a zip
  (server-side jobs).
- **Session Statistics Export** — downloads derived per-session statistics for reporting
  (client-side, no raw conversation).

## Session export and import

| Piece | File |
|---|---|
| Controller (7 repo routes + 3 bootstrap routes) | `server/src/logs/repository-export-import.controller.ts` |
| Export/import logic | `server/src/logs/repository-export-import.service.ts` |
| Zip format helpers | `server/src/logs/export-import-zip.ts` |
| Import limits | `server/src/logs/import-limits.ts` |
| Job rows | `server/src/logs/export-import-jobs.service.ts`, table [`export_import_jobs`](db-tables.md#export_import_jobs) |
| Job cleanup | `server/src/logs/export-import-job-cleanup.scheduler.ts` |
| UI | `client/src/viewer/pages/repository/export-import/` (`ImportExportSection.tsx`, `ExportPanel.tsx`, `ImportPanel.tsx`) |

### Access

Every repository route calls `RepositoriesService.assertRepoOwnerOrAdmin()` first: repository
access as for any read, and — when a `teamId` is passed — the caller must be that team's owner or
an app admin. A plain team member cannot export or import, because both read or write every
member's sessions. In a `restricted` team, members who have not acknowledged the disclosure are
left out of the export (see
[authorization-and-authentificaiton.md](authorization-and-authentificaiton.md)).

### Export format

There is no on-disk JSONL tree to copy: export **synthesises** JSONL from the stored `logs.body`
arrays. The zip contains:

```
meta.json
sessions/<sessionId>/session.json
sessions/<sessionId>/claude.jsonl
sessions/<sessionId>/artisyn.jsonl
```

- `meta.json` — `formatVersion` (`EXPORT_FORMAT_VERSION`, currently `1`), `createdAt`,
  `sourceHost`, `sourceRepoUrl`, `sourceRepoContext` (personal or team), optional `description`,
  `sessionCount`, `approxUncompressedBytes`.
- `session.json` — session id, parent session id, workflow run id, first prompt, start/end time,
  git branch, a frozen `stats` snapshot (display only), and per log type the author's
  `userEmail`. An email is stored instead of a user id because a raw id means nothing in another
  database.

Scope is `all`, a date range or a list of session ids. `GET …/export-import/scope` previews the
session count and approximate size before a job starts. Sessions are processed in batches of
`EXPORT_IMPORT_CHUNK_SIZE` (25), yielding the event loop between batches.

### Jobs

Export and import run as background jobs. A job row in `export_import_jobs` (kind `export`,
`import` or `staged_upload`; status `staged`, `running`, `done` or `error`) carries progress, so any
cluster worker can answer the status poll, not only the one running the job. Files are staged in
`EXPORT_IMPORT_DIR` (default `export-import`, relative to the process CWD). A cleanup scheduler
deletes expired job rows and files (`EXPORT_IMPORT_JOB_TTL_MS`, default 30 min).

Import is two steps: upload (the zip is staged and its `meta.json` summary returned), then confirm
(the job starts).

### Import validation

The import job aborts with an error status on the first problem:

- the file is not a zip (checked by the `PK\x03\x04` signature);
- a limit from `import-limits.ts` is exceeded, measured on the real decompressed bytes rather than
  the sizes the zip headers declare: `IMPORT_MAX_UPLOAD_BYTES` (default 5 GiB),
  `IMPORT_MAX_ENTRIES` (20000), `IMPORT_MAX_UNCOMPRESSED_BYTES` (20 GiB), `IMPORT_MAX_ENTRY_BYTES`
  (400 MiB — below the V8 maximum string length, since one entry is read into one string);
- an entry path is absolute or escapes the extraction root (`isSafeZipEntryPath`, the zip-slip
  guard), checked before anything is read or written;
- `meta.formatVersion` differs from the importing server's `EXPORT_FORMAT_VERSION`;
- a `.jsonl` entry has a malformed line. Import parsing is strict (`parseNdjsonLines`), unlike the
  upload queue, which tolerates a small share of torn lines (see
  [upload-queue.md](upload-queue.md) § "Malformed lines").

Every `sessions/<id>/session.json` is also validated **at upload and again at confirm, in every
auth mode** (`RepositoryExportImportService.findImportConflicts()`, which reads only those
entries, lazily, with the same zip-slip guard and entry-size limits as the job). The archive is
rejected with `ImportArchiveInvalidError` when:

- the JSON is invalid;
- `sessionId` is not a non-empty string of at most 255 characters;
- `parentSessionId` is neither `null` nor such a string;
- `logs` is not an object;
- a present `logs.claude` / `logs.artisyn` has a non-string `userEmail`;
- the same `sessionId` appears in two `session.json` entries.

The controller marks the staged upload `error` with the message and answers **422**. Any other
error thrown by the check (an unsafe entry path, an import limit) also becomes a 422, never a 500.
Such an archive used to fail only later, as a job `error`.

### Import merge rules

- **Keep-longer.** An existing `(sessionId, logType)` log is overwritten only when the incoming
  body has more lines; otherwise the existing body is kept. Parent session and workflow run ids are
  upserted either way.
- **Stats are re-derived** from the imported `claude` body (`extractClaudeStats`,
  `session_file_stats`); the snapshot in `session.json` is never trusted.
- **Authors.** Each log's `userEmail` is resolved to an existing user, or a placeholder user is
  created. On a team import, each author is added to the team once. An existing own session keeps
  the importer as its owner, and single-user mode resolves no authors at all (see below).
- **Target repository.** `artisyn` logs are always linked to the repository being imported into,
  even when the merge left the body unchanged, so the session appears there.

#### Ownership conflicts

Outside single-user mode an import may never touch another user's data. The **importer** is the
handler's `req.user.id` on every route, admin and team-owner imports included (there is no admin
bypass): upload checks against the uploader, confirm checks again against the confirmer.

`findImportConflicts(stagedFilePath, importerId)` reports one `{ sessionId, reason }` per
`(session, reason)` pair; one session can carry several reasons:

| Reason | Condition |
|---|---|
| `foreign-session` | `sessionId` exists, is not soft-deleted, and at least one `logs`/`logs_otel` row has `user_id` ≠ importer |
| `foreign-author` | the normalised (`trim().toLowerCase()`) `logs.claude.userEmail` or `logs.artisyn.userEmail` is the email of a user with `id` ≠ importer whose `password_hash IS DISTINCT FROM` the import-placeholder hash (so `azure-oauth` and auto-provisioned users with a NULL hash count as registered) |
| `foreign-parent` | a non-null `parentSessionId` points to a session with at least one `logs`/`logs_otel` row of another user — **soft-deleted parents count too**, because a restore would re-attach the child |

The queries are `findForeignSessionIds(db, ids, userId, { includeDeleted })` (false for the
session check, true for the parent check) and `findForeignAuthorEmails(db, emails, userId)` in
`logs.service.ts`, both batched by `IMPORT_CONFLICT_QUERY_BATCH` (1000). The pre-check uses the
strict "any row" rule on purpose; the in-transaction guard below uses `findSessionOwnerId`
(`LIMIT 1`), so a session with mixed-author logs is blocked by the pre-check.

**Any conflict blocks the whole import.** The controller guard `assertNoImportConflicts` runs in
both upload handlers and both confirm handlers right after the `meta.json` parse; it marks the
staged upload `error` and answers `409 { statusCode, error: 'Conflict', message, conflicts }`
(the global `HttpExceptionFilter` passes `conflicts` through). The message comes from
`importConflictMessage()` in `upload-warnings.ts`: the count of distinct session ids and the first
`IMPORT_CONFLICT_MESSAGE_MAX_IDS` (5) of them plus «and N more», ending in "Nothing was imported."
Owners and emails are never named. A confirm of an upload that is no longer `staged` answers
**404 with the stored `errorMessage`**, so pressing «Import» again shows the same text.

**Write path.** `LogsService.importSession(input)` writes one session in one transaction:

1. `pg_advisory_xact_lock` on `session-owner:<sessionId>` (the same key as the hook `upsert()`);
2. a soft-deleted session returns `deleted` (silent skip);
3. unless `reassignToImporter`: the owner (`findSessionOwnerId`) must be null or the importer,
   otherwise it returns `foreign-session`;
4. the `sessions` upsert, then each log via `writeImportedLog()` with an `effectiveUserId`: the
   importer for an existing own session (it never gets a second owner) or in single-user mode,
   otherwise the log's resolved author;
5. in single-user mode, every `logs`/`logs_otel` row of the session is reassigned to the importer.

`importOneSession` first looks the owner up lock-free (`LogsService.getSessionOwnerId`). For an
existing own session no author is resolved and no placeholder is created; otherwise each author is
resolved by the normalised email. The team member is added only after an `ok` result. A
`foreign-session` result (a race after confirm) throws `importConflictRaceMessage()`, so the job
ends `error` and the sessions written before it stay. Only `foreign-session` is re-checked in the
transaction: a new author registering or a parent changing hands between confirm and write is an
accepted window.

#### Single-user mode

When `AUTH_MODE=none` (`RepositoryExportImportService.isSingleUserMode()`, via `ConfigService`)
there is one identity in practice, so: the `session.json` validation still runs (422), but no
conflict query runs and no 409 is ever returned; no author is resolved, no placeholder user is
created and no team member is added; every log of every imported session — existing ones
included, in `logs` and `logs_otel` — is reassigned to the importer.

Known limitations:

- When reassignment changes `user_id` but keep-longer keeps the body, the user-dependent derived
  rows (`session_cause_stats`, file-stat scopes) are not re-derived. «Recompute all sessions»
  heals them.
- Later hook uploads of a reassigned session from another identity are rejected by the session
  owner check (FR-30).

### Bootstrap import

`POST /api/v1/repositories/bootstrap-import/upload` → `…/:uploadToken/confirm` →
`…/:jobId/status` import a zip when no target repository exists yet — for example into an empty
server. The target repository is resolved or created from `meta.sourceRepoUrl` among the caller's
personal repositories, so these routes have no owner gate. The ownership pre-check runs on confirm
before the repository and the import team are resolved or created, so a blocked bootstrap import
(409 or 422) creates no repository and no team.

## Session statistics export

`client/src/viewer/pages/repository/SessionExportSection.tsx` exports **one structured record per
session** with the data the Session Info tab shows (tokens, cost, files, productivity, workflow
statistics).

- Parameters: a period (all, week, month or a custom date range) and, in a team view, an optional
  user.
- The records are computed **in the browser** by `session-export-runner.ts`: it fetches each
  session's logs and runs the shared `computeSessionInfoDerived()`
  (`client/src/viewer/pages/repository/session-log/session-info-derive.ts`), so the export always
  matches the tab. The result is zipped with JSZip as `sessions.json` in
  `session-stats-export_<from>_to_<to>.zip`.
- Statistics only: the first prompt, CLAUDE.md files and each workflow's arguments, summary and
  findings are left out.
- To make this possible, a **team owner may read members' session logs** (in a `restricted` team,
  only members who acknowledged the disclosure), the same as an app admin.
