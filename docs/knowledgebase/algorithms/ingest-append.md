---
type: "Algorithm"
title: "Ingest append: when a staged delta is applied to the stored transcript"
description: "Decides what the upload queue does with an append row (a delta of a claude / claude-subagent transcript staged by POST /api/v2/logs/append with a start_line): append it to the stored body, discard it as stale, or fail it as upload-full so the hook re-sends the whole file."
tags: [algorithm, ingest, upload-queue, performance]
generated: { by: "claude-code", at: "2026-11-24T20:00:00+04:00" }
reviewed: no
reviewer: none
---

# Ingest append: when a staged delta is applied to the stored transcript

## Purpose

A Claude Code transcript only grows, so hook `3.3.0`+ sends only the new complete lines of a
`claude` / `claude-subagent` file (`POST /api/v2/logs/append`, with the 0-based record index the
delta starts at). The server must store `stored body + delta` only when the stored body ends
exactly where the delta starts. Any other state would lose or duplicate lines, so the row is
either discarded (an older upload) or failed as `upload-full`, which makes the hook re-send the
whole file. A wrong `append` corrupts the transcript; a wrong `upload-full` costs one full upload.

## Code

- Implementation: `server/src/logs/ingest-append.ts` (`decideIngestAppend`).
- Caller: `LogsService.upsert` (`server/src/logs/logs.service.ts`) in append mode
  (`UpsertIngestMeta.appendStartLine`, `server/src/logs/ingest-version.ts`). Inside the ingest
  transaction, right after `lockAndUpsertSession`, it reads `body_received_at` and
  `jsonb_array_length(body)` (NULL when the body is not a JSON array) of the `logs` row of
  `(session, log_type)`. Only `UploadQueueSchedulerService.processRow` passes `appendStartLine`,
  for a row with `upload_queue.start_line` set.
- What each decision does: `append` → `lines = [...storedBody, ...deltaLines]` and the normal
  upsert continues (derived rows see the full body; `body_sha256` is written NULL);
  `stale` → the upsert returns `superseded` and the row completes with a `superseded`
  measurement; `upload-full` → a module-private `AppendMismatch` rolls the transaction back and
  the worker calls `failUploadFull` ([../upload-queue.md](../upload-queue.md) § "Append rows").
- Design: task `docs/tasks/todo/2026-11-24-traffic-optimization/` (DD-6, DD-7).
- Twins: none. The hook side of the same contract (which `startLine` it sends) is
  [hook-upload-skip.md](hook-upload-skip.md) (`planAppend`, `stateAfterFull`).
- Test: `server/src/logs/ingest-append.algo.spec.ts`.

## Input and output

`decideIngestAppend({ stored, rowReceivedAt, startLine })` returns `stale`, `upload-full` or
`append`.

- `stored`: `{ receivedAt, lineCount }` of the stored `logs` row, or `null` when there is none.
  `receivedAt` is `logs.body_received_at` (NULL for a body written before that column existed);
  `lineCount` is the record count of the stored body (NULL when the body is not an array).
- `rowReceivedAt`: `upload_queue.received_at` of the append row.
- `startLine`: `upload_queue.start_line`, an integer ≥ 0.

## Rules

In this order; the first that matches decides:

1. `stored` is `null` → `upload-full` (nothing to append to).
2. `stored.receivedAt` is not NULL and `rowReceivedAt < stored.receivedAt` → `stale` (strictly
   older; an equal time is not stale).
3. `stored.lineCount` is NULL, or `stored.lineCount ≠ startLine` → `upload-full`.
4. Otherwise → `append`.

Rule 2 comes before rule 3 on purpose: an append row older than the stored body is discarded
silently even when its `startLine` no longer matches, because a later upload already replaced
what it would have extended — asking the hook for a full upload then would be wasted traffic.

## Edge cases

- No stored log: IA-01.
- Older than the stored body: IA-02; older and mismatching (stale wins): IA-09.
- Equal times are not stale: IA-03.
- Stored time NULL (never stale): IA-04.
- Count mismatch below and above `startLine`: IA-05, IA-06.
- Stored count NULL (not an array): IA-07.
- A newer row that matches: IA-08; an empty stored array and `startLine` 0: IA-10.

## Examples

Each row's `input` is `{ stored: null | { receivedAt: ISO | null, lineCount: int | null },
rowReceivedAt: ISO, startLine: int }` (times as ISO strings the test turns into `Date`s), and
`expected` is `{ decision }`.

Rows (10): [`docs/algorithm-examples/ingest-append.json`](../../algorithm-examples/ingest-append.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `<=` instead of `<` in the stale check (equal time treated as stale) → IA-03.
- NULL stored time compared as epoch 0 or as "now" → IA-04.
- Count check before the stale check → IA-09.
- Only `lineCount < startLine` treated as a mismatch (a shorter delta start accepted) → IA-06.
- NULL `lineCount` treated as 0 → IA-07 (with `startLine` 0 it would append onto a non-array).
- No stored row treated as an empty body (append from line 0) → IA-01.

## Where the result is visible

The session's transcript in the viewer equals the file on disk after full + delta uploads. A
mismatch is never a synchronous status: it shows as an `upload-full` measurement in the admin
Upload Queue statistics (not counted as a failure) and reaches the hook once through
`failedUploads`, after which the hook re-sends the whole file. A stale row shows as a
`superseded` measurement.
