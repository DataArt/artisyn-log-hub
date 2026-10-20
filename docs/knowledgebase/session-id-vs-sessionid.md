---
type: "Reference"
title: "session_id vs sessionId — Never Use the Snake_Case Field as a Join Key"
description: "Why the snake_case session_id field seen in some raw Claude Code transcript lines is a CLI-internal artifact, distinct from the app's own camelCase sessionId, and must never be used as a join/attribution key."
tags:
  - telemetry
  - logs
timestamp: "2026-08-11T00:00:00+04:00"
---

# session_id vs sessionId

## The landmine

Raw Claude Code transcript lines (the `claude`-type log body stored in `logs.body`) can carry
**two differently-cased "session id" fields** that look interchangeable but are not:

- **`sessionId`** (camelCase) — the app's own session identifier. Every line in a session's log
  body carries this, and it always matches the session the line actually belongs to. This is the
  only field any server code reads.
- **`session_id`** (snake_case) — an occasional, CLI-internal field that shows up on some lines.
  It is **not** the app's session identifier and must never be treated as one.

## Where `session_id` comes from

The snake_case field is an artifact of the Claude Code CLI's own session-continuation mechanics:
`--resume` continuations and background-task rollovers stamp lines with the *origin* session's id
under `session_id`, even though the line is being appended to (and correctly belongs to) the
*current* session's transcript under its own `sessionId`.

This was investigated directly against the DB body for session `55b3523a` (flagged during the
`session-numbers-audit` workflow as a "session-identity mismatch", later closed as
not-a-bug): 78 of its 131
`claude`-log lines carry `session_id: "03158861-..."` — the id of the
session `55b3523a` was `--resume`d from — while every single line, including those 78, carries the
correct, matching `sessionId: "55b3523a-..."`. The lines are genuinely `55b3523a`'s own content;
nothing is mis-attributed.

## Why this matters

If any future code (a new extractor, an ad-hoc query, an analytics script) were to read
`session_id` off a transcript line and use it to group, join, or attribute the line to a session,
it would silently re-attribute a chunk of a resumed/rolled-over session's activity to its
*origin* session instead — a subtle, hard-to-notice data-integrity bug that would only surface on
sessions created via `--resume` or background-task rollover.

## The rule

- **Never** read the snake_case `session_id` field from a transcript line's JSON body as a
  join/attribution key, for any purpose (stats extraction, analytics grouping, dedup, backfills).
- Always use the camelCase `sessionId` field — it is the only field guaranteed to identify the
  session the line actually belongs to.
- Today, no server code reads the snake_case field: `server/src/logs/claude-extractor.ts`'s stats
  extraction only ever reads `sessionId`. Keep it that way.

## Not to be confused with: the `session_id` DB column

Several server files (`repositories.service.ts`, `active-sessions.service.ts`,
`logs.service.ts`, the Drizzle schema, etc.) reference a `session_id` **database column** — e.g.
`logs.session_id`, the FK from `logs` to `sessions`. That is an ordinary snake_case SQL column
name (per this project's DB naming convention, see
[Database Structure](db-tables.md)) and is unrelated to this note. It is populated from the
app's own `sessionId` at ingestion time and is safe to use. The landmine here is specifically the
snake_case field that can appear *inside the raw JSON body of a transcript line* — one level
deeper than the DB schema.

## If you're investigating a similar "identity mismatch" report

1. Check whether the discrepancy is between `sessionId` (correct) and `session_id` (CLI artifact)
   within the raw log body — if so, it is very likely not a bug; confirm no code path reads the
   snake_case field before spending more time on it.
2. Also check `isSidechain` lines: sub-agent proxy events correctly carry their *parent* session's
   `sessionId` by design — that is separate, expected behavior, not a mismatch either.
