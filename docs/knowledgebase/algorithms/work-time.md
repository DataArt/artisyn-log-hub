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

```examples
[
  {
    "id": "WT-01",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 2}, {"assistant": true, "t": 5}, {"assistant": true, "t": 9}]},
    "expected": {"workTimeMs": 9000},
    "note": "Rule 4: one prompt, latest answer 9 s: 9 - 0 = 9 s."
  },
  {
    "id": "WT-02",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 4}, {"user": "p2", "t": 10}, {"assistant": true, "t": 13}]},
    "expected": {"workTimeMs": 7000},
    "note": "p1: latest answer in (0, 10] is 4, 4 s. p2: latest after 10 is 13, 3 s. Sum 7 s. Without the upper bound p1 would take the answer at 13: 13 + 3 = 16 s."
  },
  {
    "id": "WT-03",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 10}, {"user": "p2", "t": 10}, {"assistant": true, "t": 12}]},
    "expected": {"workTimeMs": 12000},
    "note": "The answer at 10 is <= q = 10, so p1 gets 10 s; for p2 it is not > 10. p2 gets 12 - 10 = 2 s. Sum 12 s."
  },
  {
    "id": "WT-04",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 5}, {"user": "p2", "t": 100}, {"assistant": true, "t": 103}]},
    "expected": {"workTimeMs": 8000},
    "note": "The 95 s between the answer at 5 and the prompt at 100 is idle: 5 + 3 = 8 s."
  },
  {
    "id": "WT-05",
    "input": {"events": [{"user": "p1", "t": 0}, {"user": "p2", "t": 10}, {"assistant": true, "t": 12}]},
    "expected": {"workTimeMs": 2000},
    "note": "p1 has no answer in (0, 10], adds nothing; p2 adds 2 s."
  },
  {
    "id": "WT-06",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 3}, {"user": "p1", "t": 5}, {"assistant": true, "t": 8}]},
    "expected": {"workTimeMs": 8000},
    "note": "Rule 1: p1 counts once at its earliest time 0; one prompt, latest answer 8: 8 s (not 3 + 3)."
  },
  {
    "id": "WT-07",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 2}, {"user": "pm", "t": 20, "meta": true}, {"assistant": true, "t": 25}]},
    "expected": {"workTimeMs": 25000},
    "note": "Rule 1: the meta event is not a prompt, so p1 is the only prompt and its latest answer is 25: 25 s."
  },
  {
    "id": "WT-08",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 2}, {"user": "pc", "t": 20, "text": "  <command-name>/compact</command-name>"}, {"assistant": true, "t": 25}]},
    "expected": {"workTimeMs": 25000},
    "note": "Rule 1: text starting (after spaces) with <command-name> is not a prompt: 25 s as in WT-07."
  },
  {
    "id": "WT-09",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 2}, {"user": "ps", "t": 20, "subagentResult": true}, {"assistant": true, "t": 25}]},
    "expected": {"workTimeMs": 25000},
    "note": "Rule 1: a sub-agent result is not a prompt: 25 s."
  },
  {
    "id": "WT-10",
    "only": "server",
    "input": {"events": [{"user": "p1", "t": 0}, {"assistant": true, "t": 3}, {"assistant": true, "t": 50, "sidechain": true}]},
    "expected": {"workTimeMs": 3000},
    "note": "Rule 2: the sidechain answer at 50 is skipped; latest main answer 3: 3 s."
  },
  {
    "id": "WT-11",
    "input": {"events": [{"assistant": true, "t": 1}, {"assistant": true, "t": 4}]},
    "expected": {"workTimeMs": 0},
    "note": "Rule 5: no prompts, 0."
  },
  {
    "id": "WT-12",
    "input": {"events": [{"assistant": true, "t": 0}, {"user": "p1", "t": 10}, {"assistant": true, "t": 15}]},
    "expected": {"workTimeMs": 5000},
    "note": "Rule 4: the answer at 0 is not after any prompt; p1 gets 15 - 10 = 5 s."
  },
  {
    "id": "WT-13",
    "input": {"events": [{"assistant": true, "t": 13}, {"user": "p2", "t": 10}, {"assistant": true, "t": 4}, {"user": "p1", "t": 0}]},
    "expected": {"workTimeMs": 7000},
    "note": "Rule 3: the same events as WT-02 in a scrambled file order give the same 4 + 3 = 7 s."
  },
  {
    "id": "WT-14",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":5},{"user":"p2","t":10}]},
    "expected": {"workTimeMs":5000},
    "note": "Rule 4: p1 gets 5 s; p2 has no answer after 10, so it adds nothing. Without the lower bound p2 would take the answer at 5 and add 5 - 10 = -5 s, giving 0."
  },
  {
    "id": "WT-15",
    "input": {"events":[{"user":"p1","t":5},{"user":"p1","t":0},{"assistant":true,"t":8}]},
    "expected": {"workTimeMs":8000},
    "note": "Rule 1: p1 appears first at 5 but its earliest time is 0, so 8 - 0 = 8 s (first-seen would give 3 s)."
  },
  {
    "id": "WT-16",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pt","t":20,"text":"<task-notification>agent done</task-notification>"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 1: a task notification is not a prompt, so p1 runs to its latest answer: 25 s."
  },
  {
    "id": "WT-17",
    "input": {"events":[{"user":"p1","t":0},{"user":"p2","t":0},{"assistant":true,"t":4}]},
    "expected": {"workTimeMs":4000},
    "note": "Two prompts at 0: the first has the window (0, 0], empty; the second has (0, end) and the answer at 4: 4 s in all."
  },
  {
    "id": "WT-18",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"ps","t":20,"sidechain":true},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: on the server a sidechain user event with a promptId is a prompt, so p1 gets 2 s and ps gets 25 - 20 = 5 s: 7 s. (The hook ignores it and reports 25 s.)"
  },
  {
    "id": "WT-19",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pe","t":20,"text":""},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: empty text is not a command or a notification, so on the server it is a prompt: 2 + 5 = 7 s. (The hook ignores it and reports 25 s.)"
  },
  {
    "id": "WT-20",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":3},{"assistant":true,"t":50,"sidechain":true}]},
    "expected": {"workTimeMs":50000},
    "note": "Hook side of WT-10: the hook counts the sidechain answer at 50: 50 s."
  },
  {
    "id": "WT-21",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"ps","t":20,"sidechain":true},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Hook side of WT-18: the hook ignores a sidechain user event, so p1 runs to 25: 25 s."
  },
  {
    "id": "WT-22",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pe","t":20,"text":""},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Hook side of WT-19: the hook ignores an empty user event: 25 s."
  },
  {
    "id": "WT-23",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pm","t":20,"meta":"yes"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 1: isMeta \"yes\" is truthy, so not a prompt on the server: p1 runs to 25: 25 s."
  },
  {
    "id": "WT-24",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pm","t":20,"meta":"yes"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "The hook excludes isMeta only when it is exactly true, so pm is a prompt: 2 + 5 = 7 s."
  },
  {
    "id": "WT-25",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pa","t":20,"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: array content is never a command or a notification, so on the server pa is a prompt: 2 + 5 = 7 s."
  },
  {
    "id": "WT-26",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pa","t":20,"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "The hook needs a text block in array content; a tool result alone is not a prompt: 25 s."
  },
  {
    "id": "WT-27",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"ps","t":20,"agentId":""},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 1: an empty agentId is still present, so this is a sub-agent result, not a prompt: 25 s."
  },
  {
    "id": "WT-28",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":5},{"assistant":true,"t":9,"ts":"not a date"}]},
    "expected": {"workTimeMs":5000},
    "note": "Rule 2: the answer with an unparseable timestamp is ignored; latest answer 5: 5 s."
  },
  {
    "id": "WT-29",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":5},{"assistant":true,"t":9,"ts":1790848809000}]},
    "expected": {"workTimeMs":5000},
    "note": "Rule 2: a numeric timestamp is ignored, even one that, read as epoch milliseconds, is exactly 9 s after the start: 5 s."
  },
  {
    "id": "WT-30",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":0.25}]},
    "expected": {"workTimeMs":250},
    "note": "Times are exact milliseconds: 0.25 s = 250 ms (no rounding to seconds)."
  },
  {
    "id": "WT-31",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pc","t":20,"text":"see <command-name>/x</command-name>"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1 looks at the start of the text only: this text starts with \"see\", so pc is a prompt: 2 + 5 = 7 s."
  },
  {
    "id": "WT-32",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":7,"t":20},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 1: promptId 7 is a number, not a string, so not a prompt: 25 s."
  },
  {
    "id": "WT-33",
    "only": "server",
    "input": {"subagentLog":true,"events":[{"user":"p1","t":0,"sidechain":true},{"assistant":true,"t":3,"sidechain":true},{"assistant":true,"t":9,"sidechain":true}]},
    "expected": {"workTimeMs":9000},
    "note": "Rule 2: in a sub-agent log every event is sidechain and sidechain answers count: 9 s."
  },
  {
    "id": "WT-34",
    "input": {"events":[]},
    "expected": {"workTimeMs":0},
    "note": "Rule 5: no events, no prompts: 0."
  },
  {
    "id": "WT-35",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"p2","t":20,"ts":"not a date"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 2 on a prompt: p2 has an unparseable timestamp and is ignored, so p1 runs to 25: 25 s."
  },
  {
    "id": "WT-36",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pn","t":20,"agentId":null},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: agentId null counts as missing, so this is not a sub-agent result but a prompt: 2 + 5 = 7 s."
  },
  {
    "id": "WT-37",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pt","t":20,"text":"   <task-notification>done</task-notification>"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 1 ignores leading whitespace for <task-notification> too: not a prompt, 25 s."
  },
  {
    "id": "WT-38",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"","t":20},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1 needs a string promptId; the empty string is one, so it is a prompt: 2 + 5 = 7 s."
  },
  {
    "id": "WT-39",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":5},{"assistant":true,"t":9,"ts":["2026-10-01T10:00:09.000Z"]}]},
    "expected": {"workTimeMs":5000},
    "note": "Rule 2: the timestamp is an array, not a string, so the server ignores that answer: 5 s."
  },
  {
    "id": "WT-40",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":5},{"assistant":true,"t":9,"ts":["2026-10-01T10:00:09.000Z"]}]},
    "expected": {"workTimeMs":9000},
    "note": "The hook reads the same array timestamp as its text form, a valid date 9 s after the start: 9 s."
  },
  {
    "id": "WT-41",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"po","t":20,"content":{"note":"x"}},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: object content is not a command or a notification, so the server takes po as a prompt: 2 + 5 = 7 s."
  },
  {
    "id": "WT-42",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"po","t":20,"content":{"note":"x"}},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "The hook takes only string or array content; object content is not a prompt: 25 s."
  },
  {
    "id": "WT-43",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":3},{"assistant":true,"t":50,"sidechain":"yes"}]},
    "expected": {"workTimeMs":50000},
    "note": "Rule 2 skips only isSidechain exactly true; \"yes\" is not, so the answer at 50 counts: 50 s."
  },
  {
    "id": "WT-44",
    "input": {"events":[{"user":"p1","t":0,"meta":true},{"user":"p1","t":5},{"assistant":true,"t":8}]},
    "expected": {"workTimeMs":3000},
    "note": "Rule 1: the meta occurrence of p1 at 0 does not qualify, so p1 starts at its first real occurrence, 5: 8 - 5 = 3 s (taking 0 would give 8 s)."
  },
  {
    "id": "WT-45",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pm","t":20,"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"},{"type":"text","text":"and go on"}]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: array content is a prompt on the server; the hook needs any text block, and the second block is one: both 2 + 5 = 7 s."
  },
  {
    "id": "WT-46",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"py","t":20,"sidechain":"yes"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "A user event with isSidechain \"yes\" (not exactly true) is a prompt on both sides: 2 + 5 = 7 s."
  },
  {
    "id": "WT-47",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pt","t":20,"text":"note <task-notification>x</task-notification>"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1 looks only at the start of the text; the tag in the middle does not matter: a prompt, 7 s."
  },
  {
    "id": "WT-48",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pf","t":20,"meta":false},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: isMeta false is not meta, so pf is a prompt: 7 s."
  },
  {
    "id": "WT-49",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"ps","t":20,"text":"   "},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: text of only spaces is neither a command nor a notification, so it is a prompt on both sides: 7 s."
  },
  {
    "id": "WT-50",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pz","t":20,"agentId":0},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 1: agentId 0 is present (not null), so this is a sub-agent result, not a prompt: 25 s."
  },
  {
    "id": "WT-51",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pn","t":20,"content":null},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: null content is not a command or a notification, so on the server pn is a prompt: 7 s."
  },
  {
    "id": "WT-52",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pn","t":20,"content":null},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "The hook needs content; a null one is not a prompt: 25 s."
  },
  {
    "id": "WT-53",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pe","t":20,"content":[]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: an empty array is still array content, so on the server pe is a prompt: 7 s."
  },
  {
    "id": "WT-54",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pe","t":20,"content":[]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "The hook needs a text block; an empty array has none: 25 s."
  },
  {
    "id": "WT-55",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pa","t":20,"ts":["2026-10-01T10:00:20.000Z"]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 2 on a prompt: an array timestamp is not a string, so the server ignores pa and p1 runs to 25: 25 s."
  },
  {
    "id": "WT-56",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pa","t":20,"ts":["2026-10-01T10:00:20.000Z"]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 6: the hook reads the array timestamp as its text, 20 s, so pa is a prompt: 2 + 5 = 7 s."
  },
  {
    "id": "WT-57",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pr","t":20,"toolUseResult":{"status":"ok"}},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: a toolUseResult without agentId is no sub-agent result, so pr is a prompt: 7 s."
  },
  {
    "id": "WT-58",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pc","t":20,"text":"<command-message>review</command-message>"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: only <command-name> and <task-notification> are excluded; a text starting with <command-message> is a prompt: 7 s."
  },
  {
    "id": "WT-59",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pm","t":20,"noMessage":true},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: a user event without a message has no excluded text, so on the server pm is a prompt: 7 s."
  },
  {
    "id": "WT-60",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pm","t":20,"noMessage":true},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 6: the hook needs a message with content; without one pm is not a prompt: 25 s."
  },
  {
    "id": "WT-61",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"pa","t":20,"content":[{"type":"text","text":"<command-name>/x</command-name>"}]},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1 checks the tags only on string content; in array content the same text does not exclude the event: a prompt on both sides, 7 s."
  },
  {
    "id": "WT-62",
    "only": "server",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"ps","t":20,"rawMessage":"hello"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":7000},
    "note": "Rule 1: a string message is read as no content, which is not excluded, so on the server ps is a prompt: 7 s."
  },
  {
    "id": "WT-63",
    "only": "hook",
    "input": {"events":[{"user":"p1","t":0},{"assistant":true,"t":2},{"user":"ps","t":20,"rawMessage":"hello"},{"assistant":true,"t":25}]},
    "expected": {"workTimeMs":25000},
    "note": "Rule 6: the hook needs a message object with content; a string message is not a prompt: 25 s."
  }
]
```

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
