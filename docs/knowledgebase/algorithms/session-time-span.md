---
reviewed: 2026-10-21
reviewer: ai
---

# Session time span: from the first prompt to the last activity

## Purpose

A session's start and end time (`logs.start_time` / `logs.end_time` of its `artisyn` log) give
the span the user sees in the sessions list and the session header, and they place the session
in date filters and analytics. A session that sat idle after `SessionStart` (or after a `/clear`)
until its first prompt must not look hours long: the span starts at the first submitted prompt.

## Code

- Implementation: `server/src/logs/artisyn-extractor.ts` (`extractTimestampRange`, with the
  `NON_ACTIVITY_LINE_TYPES` set above it).
- Callers (they store the result; how they store it is not part of the rule):
  - ingest, `logs.service.ts` (`upsert`), for every `artisyn` upload: the upload's body replaces
    the stored one and both columns are overwritten with the result, `null` included;
  - `recompute-all-sessions`, `repositories.service.ts`: writes the pair only when at least one
    value is non-null, otherwise keeps the stored pair.
  - Not a caller: repository import (`logs.service.ts`, the import writer) takes `startTime` /
    `endTime` as-is from the export's `session.json` and never runs this rule.
  Sessions ingested before this rule keep their stored span until one of the two callers runs
  for them again (no backfill).
- Twins: none. Related, not a twin: the golden oracle `tests/golden/check-arithmetic.mjs`
  computes the expected span of the golden fixtures on its own and is not run against these
  rows. At the time of writing it still takes the smallest timestamp of the root's lines as the
  start; task `2026-09-26-session-anomalies-otel-port` (Design Decision 10, a later chunk) moves
  it to rule 3: the first `prompt_start` timestamp, falling back to the smallest one. It does not
  reimplement rule 1, because no golden `artisyn.jsonl` holds a timestamped non-activity line.
- Test: `server/src/logs/artisyn-extractor.algo.spec.ts`.

## Input and output

The input is the list of parsed lines of one `artisyn` upload (hook events such as
`{"type":"artisyn","hook_event_name":"SessionStart","timestamp":...}`, prompt lines such as
`{"event":"prompt_start","prompt":"...","timestamp":...}`, and snapshot lines such as
`{"type":"code-inventory",...}`). The output is `{startTime, endTime}`, each an ISO 8601 UTC
string with milliseconds (`2026-09-26T19:14:02.000Z`) or `null`.

## Rules

1. **Activity lines.** A line counts only if both hold:
   - its `type` is not in `NON_ACTIVITY_LINE_TYPES` (`hook-status`, `system-context`,
     `skill-definitions`, `agent-definitions`, `mcp-config`, `harness-snapshot`,
     `harness-snapshot-ref`, `code-inventory`); any other `type`, or none, is fine;
   - its `timestamp` is a non-empty string that `Date.parse` accepts.
   Every other line is ignored by every rule below.
2. **Prompt lines.** An activity line whose `event` is exactly `prompt_start` or the legacy
   `prompt` is a prompt line, whatever its `prompt` text (an empty prompt still counts).
3. **Start.** `startTime` = the smallest timestamp among the prompt lines. If there is no prompt
   line, `startTime` = the smallest timestamp among all activity lines.
4. **End.** `endTime` = the largest timestamp among all activity lines (prompt lines included).
5. "Smallest" and "largest" compare the parsed instants, not the position in the file.
6. With no activity line at all, both are `null`.
7. **Output format.** Each value is written back from the parsed instant as
   `new Date(ms).toISOString()`: UTC, with milliseconds, whatever offset or precision the input
   had (`2026-09-26T12:14:02+02:00` becomes `2026-09-26T10:14:02.000Z`).

## Edge cases

- Idle lead-in before the first prompt (the `/clear` shape): TS-01.
- No prompt line, start falls back to the first activity line: TS-02.
- Legacy `prompt` event: TS-03. Empty prompt text: TS-04.
- First prompt line in file order has an invalid timestamp: TS-05; the only prompt line has an
  empty timestamp, so the fallback applies: TS-10.
- Prompt lines out of file order: TS-06. The largest activity line not last in the file: TS-11.
  No prompt line and the smallest activity line not first in the file: TS-12.
- A `code-inventory` snapshot older than the session: TS-07; newer than the session: TS-09.
  Each other non-activity type: TS-13 (`hook-status`), TS-14 (`system-context`), TS-15
  (`skill-definitions`), TS-16 (`agent-definitions`), TS-17 (`mcp-config`), TS-18
  (`harness-snapshot`), TS-19 (`harness-snapshot-ref`).
- A numeric timestamp: epoch ms TS-20, a short number TS-23. A `null` or missing timestamp:
  TS-21.
- `prompt_stop` and a `UserPromptSubmit` hook line are not prompt lines: TS-24.
- The latest activity line is a prompt line: TS-25.
- An activity line of a `type` outside the set: TS-26.
- Input with an offset or without milliseconds, normalised on output: TS-22.
- Empty input: TS-08; non-empty input with no activity line left: TS-27.
- Null vs 0: a prompt start at the epoch (0 ms) after an earlier line, TS-28; a single line at
  0 ms as start and end, TS-29.
- A non-activity line that carries `event: "prompt_start"`: TS-30.

## Examples

`input.lines` are the upload's lines exactly as listed (the test only adds a `session_id` to
each); `expected` is `{startTime, endTime}`. All times are on 2026-09-26, UTC.

Rows (30): [`docs/algorithm-examples/session-time-span.json`](../../algorithm-examples/session-time-span.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- Old rule, start = smallest activity timestamp -> TS-01 (17:08:59), TS-03, TS-04, TS-06.
- Start = the first prompt line in file order -> TS-06 (10:04:00); the last one -> TS-06
  (10:03:00); the largest -> TS-06 (10:04:00).
- Only `prompt_start` counts, not the legacy `prompt` -> TS-03 (10:00:00).
- Prompt line requires non-empty `prompt` text -> TS-04 (10:00:30 becomes 10:00:00).
- Prompt line chosen before the timestamp is validated, with a fallback when it is invalid ->
  TS-05 (10:00:00); fallback disabled once any prompt line is seen -> TS-10 (null start).
- No fallback without a prompt line -> TS-02, TS-07 (null start).
- End = the last prompt line -> TS-01 (19:14:02); end = the activity line last in the file ->
  TS-11 (10:03:00), and TS-09 (16:00:00) when unfiltered.
- Fallback start = the activity line first in the file -> TS-12 (10:02:00).
- Non-activity filter applied only to the start -> TS-09; dropped altogether -> TS-07, TS-09;
  one type missing from `NON_ACTIVITY_LINE_TYPES` -> the row for that type, TS-07 and
  TS-13..TS-19 (04:00:00).
- Timestamps read with `new Date(ts)` instead of string-only -> TS-20 (00:00:00 from the
  number), TS-21 (1970-01-01 from `null`); the string check dropped (`Date.parse(ts)` on any
  value) -> TS-23 (2026-01-01 from the number 2026).
- Prompt line = any `event` containing `prompt`, or a `UserPromptSubmit` hook line -> TS-24
  (10:00:40 or 10:00:20).
- End skips prompt lines -> TS-25 (10:05:00).
- An allow-list (`artisyn` and type-less lines only) instead of the deny-list -> TS-26
  (10:00:00).
- Fallback to all lines when no activity line is left -> TS-27 (04:00:00).
- Raw input string returned instead of `toISOString()` -> TS-22.
- Empty input returns an empty string or an epoch date instead of null -> TS-08.
- A parsed 0 ms treated as "no value": `minPromptTs || minTs` -> TS-28 (1969-12-31T23:59:59);
  `startTs ? ... : null` -> TS-28, TS-29 (null start); `maxTs ? ... : null` -> TS-29 (null end).
- Prompt lines detected before the non-activity filter -> TS-30 (04:00:00).

## Where the result is visible

- API: `startTime` / `endTime` of each session in `GET …/sessions` (repository sessions list).
- Sessions list row: the end time.
- Session pane, Info tab → Timeline → Duration (end − start), as read in `S-INGEST-02`.
- Date-range filters and the repository analytics charts (`client/src/viewer/pages/repository/analytics/*`,
  which place each session by `startTime`) and reports (`topSessions[].startTime`): a session
  falls on the day of its first prompt.
