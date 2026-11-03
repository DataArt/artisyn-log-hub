---
reviewed: 2026-10-15
reviewer: ai
---

# Work time: how long Claude worked in a session

## Purpose

"Autonomous work time" is the time Claude spent answering prompts, without the time the session
sat idle waiting for the user. Every "per hour" number (Productivity, Analytics Work Time,
Executive Summary) divides by it, so an idle gap counted as work makes a session look slow, and a
lost answer makes it look fast.

## Code

- Implementation: `server/src/logs/claude-extractor.ts`, `computeWorkTime` (not exported),
  reached through `extractClaudeStats(lines).workTimeMs`, which also decides which events are
  prompts and which are answers.
- Twins:
  - `hook/.claude/telemetry_tool/post-turn-analysis-worker.js` (`deriveWorkTimeMs`, a port of
    the same rule, `computeWorkTime` line for line). It differs in which events it reads: it
    counts sidechain assistant events too, and it does not take as prompts user events that are
    sidechain, have empty or missing content, or have array content without a text block; it
    excludes `isMeta` only when it is exactly `true`; it does not take an object as content; and it
    reads any timestamp through `Date.parse`, so a non-string timestamp whose text form is a date
    (an array holding an ISO string) counts there but not on the server (a number does not: it
    turns into a digit string, which is no date). It has no sub-agent-log mode; it runs on the
    main session's entries only. Each difference is pinned by a pair of rows
    with the same events: one marked `"only": "server"`, one `"only": "hook"`; each test skips
    the other side's rows.
- Not a twin: the client (`client/src/viewer/pages/repository/session-log/log-parser.ts`). Its
  code calls its prompt filter (`isQualifyingUserEvent`) a twin of the hook's, which is true for
  deciding what a prompt is, but the client then
  computes a per-turn work time over the parent chain and sums it as `totalWorkTimeMs`
  (see `docs/knowledgebase/session-log-view.md`, "Work time"); that is a different algorithm and
  is not run against these rows. Like the server, it keeps the answers after a
  `<task-notification>` in the prompt's turn (work time runs from Enter to the final stop,
  background agents included).
- Tests:
  - `server/src/logs/claude-extractor.algo.spec.ts`;
  - `hook/.claude/telemetry_tool/__tests__/work-time.algo.test.js`.

The code is the source of truth for this rule (decision of the test-suite cleanup task): older
documents that derive work time from `turn_duration` events are wrong; those events are not read.

## Rules

1. **Prompts.** A `user` event is a prompt when it has a string `promptId` and is none of:
   `isMeta` (any truthy value); a sub-agent result (`toolUseResult` an object whose `agentId` is
   present, i.e. not `null`/missing, even `""` or `0`); string content starting (after leading whitespace) with
   `<command-name>` or `<task-notification>` (the tag elsewhere in the text does not count, and
   array content is never checked for the tags). Nothing
   else is required of it (a sidechain flag or empty content does not matter on the server).
   Each `promptId` counts once, at the **earliest** timestamp among its occurrences that qualify
   as prompts and have a valid timestamp, wherever they appear in the file.
2. **Answers.** Every `assistant` event of the main thread is an answer time. Sidechain assistant
   events (`isSidechain` exactly `true`, sub-agent traffic copied into the main log) are skipped, except
   when the log itself is a sub-agent log (`isSubagentLog`), where every event is sidechain.
   An event whose `timestamp` is not a string that parses as a date is ignored, as a prompt and
   as an answer (a numeric timestamp too). Times are exact milliseconds; nothing is rounded.
   `isSubagentLog` is set by the ingest for a sub-agent's own log file; the main log uses the
   default `false`.
3. Sort the prompt times and the answer times.
4. For each prompt at time `p`, with the next prompt at `q` (none for the last prompt): take the
   **latest** answer time `a` with `p < a` and, if there is a next prompt, `a <= q`. If there is
   one, add `a - p`; otherwise add nothing.
5. Work time is the sum, in milliseconds. No prompts: 0.
6. **Hook twin differences** (the hook rows): the hook counts every answer, sidechain ones too;
   it takes a user event as a prompt only if it has a `message` object (a string `message` does
   not count; the server reads it as having no content), `isSidechain` is not exactly `true`, `isMeta` is not
   exactly `true`, the content is a non-empty string or an array with a text block, and the
   text does not start with the two tags; and it reads any timestamp with `Date.parse` of its
   text form. On the server `toolUseResult` must be a non-array object to count as a sub-agent
   result.

So an answer at exactly the next prompt's time belongs to the earlier prompt, an answer at
exactly the prompt's own time belongs to none, and the idle time between the last answer and the
next prompt is never counted.

## Edge cases

- One prompt, several answers: WT-01; two prompts: WT-02; idle gap: WT-04.
- Answer exactly at the next prompt: WT-03.
- Prompt with no answer: WT-05; answer before any prompt: WT-12; no prompts: WT-11.
- Repeated `promptId`: WT-06.
- Non-prompt user events do not split a turn: WT-07 (meta), WT-08 (`<command-name>`), WT-09
  (sub-agent result).
- Sidechain answers: WT-10. Events out of order in the file: WT-13.
- A prompt whose only answers come before it: WT-14. A repeated `promptId` seen later first:
  WT-15. `<task-notification>`: WT-16. Two prompts at the same time: WT-17.
- Events the hook reads differently, server and hook rows: sidechain answer (WT-10, WT-20),
  sidechain user event (WT-18, WT-21), empty user event (WT-19, WT-22), `isMeta: "yes"` (WT-23,
  WT-24), array content without text (WT-25, WT-26).
- Empty `agentId`: WT-27. Bad and numeric timestamps: WT-28, WT-29. Fractions of a second:
  WT-30. Command tag inside the text: WT-31. Numeric `promptId`: WT-32. Sub-agent log: WT-33.
  No events: WT-34. A bad timestamp on a prompt: WT-35. `agentId: null`: WT-36.
  `<task-notification>` after spaces: WT-37. Empty `promptId`: WT-38. Array timestamp: WT-39,
  WT-40. Object content: WT-41, WT-42. `isSidechain: "yes"`: WT-43.

## Examples

`input.events` is the log in file order. A user event is
`{"user": "<promptId>", "t": <seconds>}` with optional `"meta": true`, `"subagentResult": true`,
`"sidechain": <value>` (sets `isSidechain`), `"meta": <value>` (sets `isMeta` to that value), `"agentId": <value>` (a
sub-agent result with that id), `"content": <value>` (array or object content instead of text) or
`"text": "..."` (default text `"do the task"`); an assistant event is
`{"assistant": true, "t": <seconds>}` with optional `"sidechain": <value>`. `t` is seconds after a
fixed start time, `2026-10-01T10:00:00.000Z`; `"ts": <value>` replaces the timestamp with a raw
value. `"content": null` sends a user event with null content, `"noMessage": true` one without a
`message` at all, `"rawMessage": <value>` one whose `message` is that value, and `"toolUseResult": <value>` sets that field as given. `input.subagentLog`
runs the server as for a sub-agent's own log. `expected.workTimeMs` is the result in milliseconds.

Rows (63): [`docs/algorithm-examples/work-time.json`](../../algorithm-examples/work-time.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `<` instead of `<=` against the next prompt -> WT-03 (2 s instead of 12 s).
- `>=` instead of `>` against the own prompt is an equivalent mutant: an answer at exactly the
  prompt's time is either beaten by a later answer or adds `a - p = 0`, so no row can kill it.
- First instead of latest answer -> WT-01 (2 s).
- Idle time counted (last answer to next prompt) -> WT-04.
- An unanswered prompt counted up to the next prompt -> WT-05 (12 s). Answers without prompts
  counted as a span -> WT-11 (3 s). The first window opened at the session start -> WT-12
  (15 s). No upper bound with two prompts at one time -> WT-17 (8 s).
- Array timestamp on a prompt read by the server -> WT-55; ignored by the hook -> WT-56.
- Latest prompt time kept for a repeated `promptId` -> WT-06; first-seen time kept -> WT-15.
- No lower bound (answers before the prompt counted) -> WT-14.
- No upper bound -> WT-02, WT-04.
- `<task-notification>` taken as a prompt -> WT-16.
- Server prompt filter made as strict as the hook's -> WT-18, WT-19, WT-25; hook made as loose
  as the server's -> WT-21, WT-22, WT-26; hook ignoring sidechain answers -> WT-20.
- `isMeta` checked with `=== true` on the server -> WT-23; truthy in the hook -> WT-24.
- Sub-agent result detected by a truthy `agentId` -> WT-27.
- Unparseable or numeric timestamps used -> WT-28, WT-29. Times rounded to seconds -> WT-30.
- Command tag searched anywhere in the text -> WT-31. Non-string `promptId` accepted -> WT-32.
- Sidechain answers skipped in a sub-agent log -> WT-33. A crash on an empty event list -> WT-34.
- Timestamps of prompts not checked -> WT-35. `agentId: null` taken as a sub-agent result ->
  WT-36. Leading whitespace not ignored before `<task-notification>` -> WT-37. Empty `promptId`
  refused -> WT-38.
- Server reading non-string timestamps like the hook -> WT-39; hook made string-only -> WT-40.
- Object content refused on the server -> WT-41; accepted by the hook -> WT-42.
- `agentId` checked as truthy -> WT-50. Null or empty-array content: server WT-51, WT-53; hook
  WT-52, WT-54.
- Any `toolUseResult` taken as a sub-agent result -> WT-57. Tags checked inside array content ->
  WT-61. A string `message`: server WT-62, hook WT-63. `<command-message>` excluded like
  `<command-name>` -> WT-58. A user event without `message`: server WT-59, hook WT-60.
- Sidechain checked as truthy -> WT-43; a user event with a truthy sidechain flag refused (hook)
  -> WT-46.
- Earliest time taken over every occurrence, prompt or not -> WT-44.
- Hook reading only the first content block, or needing every block to be text -> WT-45.
- Tag searched anywhere for `<task-notification>` -> WT-47. `isMeta` checked for presence -> WT-48.
- Spaces-only text refused -> WT-49.
- Meta / command / sub-agent-result events taken as prompts -> WT-07, WT-08, WT-09.
- Sidechain answers counted (server) -> WT-10.
- No sorting -> WT-13.

## Where the result is visible

- Analytics -> Work Time and Productivity (per-hour figures), Executive Summary.
- Not here: Session -> Info "Autonomous work time" shows the client's per-turn sum (see Code).
- API: `workTimeMs` on the session list and `session_stats.work_time_ms`.
