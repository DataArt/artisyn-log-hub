---
reviewed: 2026-11-02
reviewer: ai
---

# Upload error classification: retry, store, warn

## Purpose

When the upload queue fails to ingest a staged file, three things depend on *why*: whether the row
is worth another attempt, what short message is stored and shown, and whether the uploader is told
"your hook sent a broken file" or "Log Hub could not process it". Before this rule the queue stored
`err.message` verbatim — for a database error that is Drizzle's `Failed query: <SQL>\nparams:
<values>`, kilobytes long, full of the uploader's local paths, and silent about the real cause
(a Postgres deadlock, in the case that prompted it), which sits in `err.cause`.

## Code

- Implementation: `server/src/logs/upload-error.ts` (`classifyUploadError`,
  `formatFailedUploadWarning`, `shortenStoredErrorMessage`).
- Callers behind "Where the result is visible" (not part of the rule):
  `upload-queue-scheduler.service.ts` (retry or fail the row, log the details) and
  `upload-queue.service.ts` (`getPendingWarnings`, the `warnings` of `POST /api/v2/logs`).
- Twins: none.
- Test: `server/src/logs/upload-error.algo.spec.ts`.

## Rules

**Classification (`classifyUploadError`).**

1. The Postgres error is the first object in the `cause` chain (the error itself included, at
   most 5 levels) whose `code` is a five-character SQLSTATE (`[0-9A-Z]{5}`).
2. With a Postgres error, `kind` is:
   - `transient` for `40P01` (deadlock), `40001` (serialization failure), `55P03` (lock not
     available), any `08xxx` (connection) and `57P01`–`57P03` (backend shut down);
   - `file` for a data exception (class `22`, e.g. `22001` value too long) — a value in the body
     the column cannot hold;
   - `server` for anything else.
3. The summary of a Postgres error is `database error <code>[ (<constraint>)]: <message>`, using
   only the first line of the Postgres message. `logDetail` is `code=<code>` followed by
   `detail=`, `constraint=`, `table=`, `column=` for each of those fields that is a non-empty string.
4. Without a Postgres error, an error with a string Node `code` (`ENOENT`, `EACCES`, …) is
   `server`, summary = first line of its message, `logDetail` = `code=<code>`.
5. Otherwise a message starting with `Failed query:` (a Drizzle wrapper with no SQLSTATE in its
   causes) is `server` with the summary `database query failed`.
6. Anything else (NDJSON rejected, no valid lines, …) is `file`, summary = first line of the message.
7. Every summary is one line, at most 300 characters (cut to 299 plus `…`).

**Warning text (`formatFailedUploadWarning`).**

8. The stored message is shortened first: empty → `unknown error`; a legacy `Failed query: …` →
   `database query failed`; otherwise its first line, at most 300 characters.
9. A row is server-side when `error_kind = 'server'`, or when `error_kind` is NULL (written before
   the column existed) and the stored message starts with `Failed query:`. Its warning is
   `Log Hub could not process upload <file> (server-side error, not a hook problem; an admin can
   reprocess it in Admin › Upload Queue) — <short>`.
10. Every other row keeps the old text, `Hook uploaded broken file: <file> — <short>`.

**Retry (scheduler, not a pure function — described for completeness, checked by the code).** A
`transient` error sends the row back to `pending` with `attempts + 1` until
`UPLOAD_QUEUE_MAX_ATTEMPTS` (default 5); the claim skips such a row for `attempts × 2` seconds. The
last attempt marks it `failed` with `(after N attempts)` appended and `error_kind = 'server'`.
`server` and `file` errors fail at once with that `error_kind`.

## Where the result is visible

- The Upload Queue admin tab (`error_message`) and the admin Error Logs tab (the log line with
  `logDetail`, the attempt number and `kind`).
- The hook's `broken-upload-file` recommendation on the Hook state page, built from the warning.

## Examples

Rows (14): [`docs/algorithm-examples/upload-error-classify.json`](../../algorithm-examples/upload-error-classify.json) — test data for the table test; the rules above are enough to understand the algorithm.
