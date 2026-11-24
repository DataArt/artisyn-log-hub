---
type: "Algorithm"
title: "Ingest hash skip: when a staged upload is dropped unparsed"
description: "Decides whether the upload queue may drop a staged claude / claude-subagent / tool-calls upload without parsing it, because the stored row already holds the same body, derived by the same INGEST_VERSION, for the same user and against the same tree edit records."
tags: [algorithm, ingest, upload-queue, performance]
generated: { by: "claude-code", at: "2026-11-23T19:15:00+04:00" }
reviewed: no
reviewer: none
---

# Ingest hash skip: when a staged upload is dropped unparsed

## Purpose

Hooks re-send whole transcripts often (every Stop, every SessionEnd). Parsing and re-deriving an
unchanged multi-megabyte transcript costs CPU and rewrites derived rows for nothing. The upload
queue therefore hashes the staged body first and drops the upload when nothing it feeds could
change — without ever skipping an upload whose derivation would differ.

## Code

- Implementation: `server/src/logs/ingest-skip.ts` (`decideIngestSkip`), with
  `INGEST_VERSION` in `server/src/logs/ingest-version.ts`.
- Caller: `LogsService.checkUnchanged` (`server/src/logs/logs.service.ts`), called by
  `UploadQueueSchedulerService.processRow` before parsing; `skip` deletes the queue row and
  records a `skipped` measurement.
- The stored fields are written by `LogsService.upsert`'s body statement: `body_sha256`,
  `ingest_version`, `stats_edit_sha256` (and `edit_records_sha256` on `artisyn` rows). The
  `logs_body_guard` trigger clears `body_sha256` when another writer changes the body.
- Twins: none.
- Test: `server/src/logs/ingest-skip.algo.spec.ts`.

## Input and output

`decideIngestSkip(stored, incoming)` returns `skip` or `process`.

- `stored`: the `logs` row of the upload's `(session, log_type)` — `{bodySha256, ingestVersion,
  userId, statsEditSha256}` — or `null` when there is none.
- `incoming`: `{logType, bodySha256, userId, treeEditSha256}`. `bodySha256` is the sha256 hex of
  the staged raw body string as UTF-8, computed before parsing. `treeEditSha256` is
  `readTreeEditSha` of the session: the `edit_records_sha256` of the nearest ancestor-or-self
  with an `artisyn` log, `''` when there is none or it is NULL.

## Rules

The answer is `skip` only when all of these hold, else `process`:

1. `logType` is `claude`, `claude-subagent` or `tool-calls` (`artisyn` and `claude-otel` are
   always processed).
2. A stored row exists and its `bodySha256` is not NULL.
3. `stored.bodySha256 = incoming.bodySha256`.
4. `stored.ingestVersion = INGEST_VERSION` (currently 1; the rows assume 1 — bumping the
   constant means updating the rows).
5. `stored.userId = incoming.userId`.
6. For `claude` and `claude-subagent` only: `stored.statsEditSha256 = incoming.treeEditSha256`
   (exact string equality; `''` matches `''`, NULL matches nothing).

## Edge cases

- All equal: IS-01; empty edit sha on both sides: IS-02.
- `tool-calls` ignores the edit sha: IS-03.
- One mismatching field each: hash IS-04, version IS-05, legacy NULL version IS-06, user IS-07,
  edit sha IS-08, cleared stored hash IS-09.
- No stored row: IS-10.
- Never-skipped types: `artisyn` IS-11, `claude-otel` IS-12.

## Examples

Each row's `input` is `{stored, incoming}` and `expected` the decision.

Rows (12): [`docs/algorithm-examples/ingest-hash-skip.json`](../../algorithm-examples/ingest-hash-skip.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Edit sha compared for `tool-calls` too → IS-03.
- Edit sha not compared for transcripts → IS-08.
- Version check dropped → IS-05, IS-06.
- NULL stored hash treated as a match for a NULL-ish incoming → IS-09.
- `artisyn` added to the skippable types → IS-11.

## Where the result is visible

An identical re-upload keeps the row's `updated_at` and its `session_stats`, and the upload
queue's measurements show a `skipped` outcome instead of `success` (excluded from the admin
throughput figures).
