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

```examples
[
  {
    "id": "UE-01",
    "input": {"fn": "classify", "error": {"message": "Failed query: insert into \"session_changed_paths\" (...) values ($1)\nparams: 41372,D:\\work\\x.ts", "cause": {"code": "40P01", "message": "deadlock detected", "detail": "Process 1 waits for ShareLock on transaction 2"}}},
    "expected": {"kind": "transient", "code": "40P01", "summary": "database error 40P01: deadlock detected", "logDetail": "code=40P01 detail=Process 1 waits for ShareLock on transaction 2"},
    "note": "Rules 1–3: the deadlock sits in `cause`; no SQL, no params, no local path in the summary. The case that prompted the rule."
  },
  {
    "id": "UE-02",
    "input": {"fn": "classify", "error": {"message": "Failed query: insert ...", "cause": {"code": "23505", "message": "duplicate key value violates unique constraint \"session_changed_paths_session_path_key_unique\"", "constraint": "session_changed_paths_session_path_key_unique", "table": "session_changed_paths"}}},
    "expected": {"kind": "server", "code": "23505", "summary": "database error 23505 (session_changed_paths_session_path_key_unique): duplicate key value violates unique constraint \"session_changed_paths_session_path_key_unique\"", "logDetail": "code=23505 constraint=session_changed_paths_session_path_key_unique table=session_changed_paths"},
    "note": "Rule 2: an integrity error is the server's, not the file's; rule 3 names the constraint."
  },
  {
    "id": "UE-03",
    "input": {"fn": "classify", "error": {"message": "Failed query: insert ...", "cause": {"code": "22001", "message": "value too long for type character varying(255)"}}},
    "expected": {"kind": "file", "code": "22001", "summary": "database error 22001: value too long for type character varying(255)", "logDetail": "code=22001"},
    "note": "Rule 2: a data exception is the body's fault."
  },
  {
    "id": "UE-04",
    "input": {"fn": "classify", "error": {"message": "Failed query: select 1", "cause": {"code": "08006", "message": "connection failure"}}},
    "expected": {"kind": "transient", "code": "08006"},
    "note": "Rule 2: the connection class is retried."
  },
  {
    "id": "UE-05",
    "input": {"fn": "classify", "error": {"message": "wrapped", "cause": {"message": "Failed query", "cause": {"code": "40001", "message": "could not serialize access due to concurrent update"}}}},
    "expected": {"kind": "transient", "code": "40001", "summary": "database error 40001: could not serialize access due to concurrent update"},
    "note": "Rule 1: found two levels down the cause chain."
  },
  {
    "id": "UE-06",
    "input": {"fn": "classify", "error": {"message": "ENOENT: no such file or directory, open 'upload-queue/1-a.raw'", "code": "ENOENT"}},
    "expected": {"kind": "server", "code": "ENOENT", "summary": "ENOENT: no such file or directory, open 'upload-queue/1-a.raw'", "logDetail": "code=ENOENT"},
    "note": "Rule 4: a Node errno is not a SQLSTATE (lower-case / too long) and is the server's problem."
  },
  {
    "id": "UE-07",
    "input": {"fn": "classify", "error": {"message": "Failed query: insert into x values ($1)\nparams: 1"}},
    "expected": {"kind": "server", "code": null, "summary": "database query failed", "logDetail": ""},
    "note": "Rule 5: a Drizzle wrapper with no SQLSTATE anywhere."
  },
  {
    "id": "UE-08",
    "input": {"fn": "classify", "error": {"message": "Malformed NDJSON: invalid JSON line 2 of 3 (5 chars): Unexpected end of JSON input"}},
    "expected": {"kind": "file", "code": null, "summary": "Malformed NDJSON: invalid JSON line 2 of 3 (5 chars): Unexpected end of JSON input", "logDetail": ""},
    "note": "Rule 6: the body itself is broken."
  },
  {
    "id": "UE-09",
    "input": {"fn": "classify", "error": {"message": "line one\nline two"}, "repeat": 0},
    "expected": {"kind": "file", "summary": "line one"},
    "note": "Rules 6–7: only the first line."
  },
  {
    "id": "UE-10",
    "input": {"fn": "classify", "error": {"message": "x"}, "repeat": 400},
    "expected": {"kind": "file", "summaryLength": 300, "summaryEndsWith": "…"},
    "note": "Rule 7: a 400-character message is cut to 299 characters plus the ellipsis."
  },
  {
    "id": "UE-11",
    "input": {"fn": "warning", "fileName": "1-a.raw", "errorMessage": "database error 40P01: deadlock detected (after 5 attempts)", "errorKind": "server"},
    "expected": {"warning": "Log Hub could not process upload 1-a.raw (server-side error, not a hook problem; an admin can reprocess it in Admin › Upload Queue) — database error 40P01: deadlock detected (after 5 attempts)"},
    "note": "Rule 9: a server-side failure does not blame the hook."
  },
  {
    "id": "UE-12",
    "input": {"fn": "warning", "fileName": "1-a.raw", "errorMessage": "Malformed NDJSON: invalid JSON line 2 of 3", "errorKind": "file"},
    "expected": {"warning": "Hook uploaded broken file: 1-a.raw — Malformed NDJSON: invalid JSON line 2 of 3"},
    "note": "Rule 10: the old text for a really broken file (S-INGEST-03 matches its prefix)."
  },
  {
    "id": "UE-13",
    "input": {"fn": "warning", "fileName": "1-a.raw", "errorMessage": "Failed query: insert into \"session_changed_paths\" (...)\nparams: 41372,D:\\work\\x.ts", "errorKind": null},
    "expected": {"warning": "Log Hub could not process upload 1-a.raw (server-side error, not a hook problem; an admin can reprocess it in Admin › Upload Queue) — database query failed"},
    "note": "Rules 8–9: a row failed before the migration — no SQL, no params, no local path, and recognised as server-side."
  },
  {
    "id": "UE-14",
    "input": {"fn": "warning", "fileName": "1-a.raw", "errorMessage": null, "errorKind": null},
    "expected": {"warning": "Hook uploaded broken file: 1-a.raw — unknown error"},
    "note": "Rule 8: no stored message at all."
  }
]
```
