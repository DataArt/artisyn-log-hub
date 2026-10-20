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

```examples
[
  {
    "id": "TS-01",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T17:08:59.000Z"},
      {"event": "prompt_start", "prompt": "what time is it?", "timestamp": "2026-09-26T19:14:02.000Z"},
      {"event": "prompt_stop", "timestamp": "2026-09-26T19:15:10.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T19:14:02.000Z", "endTime": "2026-09-26T19:15:10.000Z"},
    "note": "Rule 3: the one prompt line is 19:14:02, so the start skips the 2h idle after SessionStart 17:08:59. Rule 4: the largest of 17:08:59, 19:14:02, 19:15:10 is 19:15:10. Regression for the audited row A (FR-5); the old rule (minimum over activity) gives 17:08:59."
  },
  {
    "id": "TS-02",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 3 fallback: no prompt line, so the start is the smallest activity timestamp 10:00:00; rule 4: the end is 10:05:00. A start that stays null without a prompt line fails here."
  },
  {
    "id": "TS-03",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt", "prompt": "fix the build", "timestamp": "2026-09-26T10:01:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:04:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:01:00.000Z", "endTime": "2026-09-26T10:04:00.000Z"},
    "note": "Rule 2: the legacy event name prompt is a prompt line, so rule 3 gives 10:01:00 (not the SessionStart 10:00:00); rule 4: 10:04:00."
  },
  {
    "id": "TS-04",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "", "timestamp": "2026-09-26T10:00:30.000Z"},
      {"event": "prompt_stop", "timestamp": "2026-09-26T10:02:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:30.000Z", "endTime": "2026-09-26T10:02:00.000Z"},
    "note": "Rule 2: a prompt_start with an empty prompt is still a prompt line, so rule 3 gives 10:00:30; rule 4: 10:02:00. An implementation that requires non-empty prompt text (like the first-prompt extractor) falls back to 10:00:00."
  },
  {
    "id": "TS-05",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "first", "timestamp": "not-a-date"},
      {"event": "prompt_start", "prompt": "second", "timestamp": "2026-09-26T10:03:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:03:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1 drops the line with 'not-a-date' (Date.parse fails), so the only prompt line is 10:03:00 (rule 3); rule 4: 10:05:00. Taking the first prompt line in the file and falling back when its timestamp is bad would give 10:00:00."
  },
  {
    "id": "TS-06",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "a", "timestamp": "2026-09-26T10:04:00.000Z"},
      {"event": "prompt_start", "prompt": "b", "timestamp": "2026-09-26T10:02:00.000Z"},
      {"event": "prompt_start", "prompt": "c", "timestamp": "2026-09-26T10:03:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:06:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:02:00.000Z", "endTime": "2026-09-26T10:06:00.000Z"},
    "note": "Rule 5: the prompt lines are 10:04, 10:02, 10:03 in file order; the smallest is 10:02:00 (the first in the file is 10:04, the last 10:03, the largest 10:04). Rule 4: 10:06:00."
  },
  {
    "id": "TS-07",
    "input": {"lines": [
      {"type": "code-inventory", "trackedFiles": 10, "trackedLines": 100, "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: code-inventory is not an activity line, so its 04:00:00 is ignored; no prompt line, so rule 3 falls back to 10:00:00; rule 4: 10:05:00. Counting it would give a start of 04:00:00."
  },
  {
    "id": "TS-08",
    "input": {"lines": []},
    "expected": {"startTime": null, "endTime": null},
    "note": "Rule 6: no activity line, both null."
  },
  {
    "id": "TS-09",
    "input": {"lines": [
      {"event": "prompt_start", "prompt": "go", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_stop", "timestamp": "2026-09-26T10:05:00.000Z"},
      {"type": "code-inventory", "trackedFiles": 10, "trackedLines": 100, "timestamp": "2026-09-26T16:00:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1 applies to the end too: the code-inventory line's 16:00:00 is ignored, so rule 4 gives 10:05:00; rule 3: the prompt line 10:00:00. Filtering non-activity lines only for the start would give an end of 16:00:00."
  },
  {
    "id": "TS-10",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "go", "timestamp": ""},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1 drops the prompt line with an empty timestamp, so there is no prompt line and rule 3 falls back to 10:00:00; rule 4: 10:05:00. Disabling the fallback as soon as any prompt line is seen would give a null start."
  },
  {
    "id": "TS-11",
    "input": {"lines": [
      {"event": "prompt_start", "prompt": "go", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"},
      {"type": "artisyn", "hook_event_name": "Stop", "timestamp": "2026-09-26T10:03:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 5 for the end: the largest of 10:00, 10:05, 10:03 is 10:05:00 although the 10:03 line is last in the file; rule 3: the prompt line 10:00:00."
  },
  {
    "id": "TS-12",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "Stop", "timestamp": "2026-09-26T10:02:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 3 fallback with rule 5: no prompt line; the smallest of 10:02, 10:00, 10:05 is 10:00:00 although the 10:02 line is first in the file; rule 4: 10:05:00."
  },
  {
    "id": "TS-13",
    "input": {"lines": [
      {"type": "hook-status", "hookVersion": "2.22.1", "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: hook-status is not an activity line, its 04:00:00 is ignored; fallback start 10:00:00, end 10:05:00. Dropping hook-status from the set gives 04:00:00."
  },
  {
    "id": "TS-14",
    "input": {"lines": [
      {"type": "system-context", "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: system-context is ignored, as in TS-13; dropping it from the set gives 04:00:00."
  },
  {
    "id": "TS-15",
    "input": {"lines": [
      {"type": "skill-definitions", "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: skill-definitions is ignored, as in TS-13; dropping it from the set gives 04:00:00."
  },
  {
    "id": "TS-16",
    "input": {"lines": [
      {"type": "agent-definitions", "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: agent-definitions is ignored, as in TS-13; dropping it from the set gives 04:00:00."
  },
  {
    "id": "TS-17",
    "input": {"lines": [
      {"type": "mcp-config", "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: mcp-config is ignored, as in TS-13; dropping it from the set gives 04:00:00."
  },
  {
    "id": "TS-18",
    "input": {"lines": [
      {"type": "harness-snapshot", "snapshotId": "s1", "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: harness-snapshot is ignored, as in TS-13; dropping it from the set gives 04:00:00."
  },
  {
    "id": "TS-19",
    "input": {"lines": [
      {"type": "harness-snapshot-ref", "snapshotId": "s1", "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: harness-snapshot-ref is ignored, as in TS-13; dropping it from the set gives 04:00:00."
  },
  {
    "id": "TS-20",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "early", "timestamp": 1790380800000},
      {"event": "prompt_start", "prompt": "real", "timestamp": "2026-09-26T10:01:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:01:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1 needs a string timestamp: the number 1790380800000 (epoch ms for 2026-09-26T00:00:00Z) is not one, so that line is ignored and the prompt start is 10:01:00. Accepting numbers (new Date(ts)) would give 00:00:00."
  },
  {
    "id": "TS-21",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "go", "timestamp": null},
      {"event": "prompt_start", "prompt": "no timestamp"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1: a null timestamp and a missing one are not strings, so neither prompt line counts; rule 3 falls back to 10:00:00, rule 4: 10:05:00. new Date(null) would give 1970-01-01T00:00:00.000Z."
  },
  {
    "id": "TS-22",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "go", "timestamp": "2026-09-26T12:14:02+02:00"},
      {"event": "prompt_stop", "timestamp": "2026-09-26T10:15:10Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:14:02.000Z", "endTime": "2026-09-26T10:15:10.000Z"},
    "note": "Output format: 12:14:02+02:00 is 10:14:02 UTC and is written back as 2026-09-26T10:14:02.000Z; 10:15:10Z gains its .000 milliseconds. Returning the raw string would keep +02:00 and the missing milliseconds."
  },
  {
    "id": "TS-23",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "early", "timestamp": 2026},
      {"event": "prompt_start", "prompt": "real", "timestamp": "2026-09-26T10:01:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:01:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1 needs a string timestamp: the number 2026 is ignored, so the prompt start is 10:01:00. Without the string check, Date.parse(2026) reads the text \"2026\" as 2026-01-01T00:00:00Z and that would become the start."
  },
  {
    "id": "TS-24",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "UserPromptSubmit", "timestamp": "2026-09-26T10:00:20.000Z"},
      {"event": "prompt_stop", "timestamp": "2026-09-26T10:00:40.000Z"},
      {"event": "prompt_start", "prompt": "go", "timestamp": "2026-09-26T10:01:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:01:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 2 is an exact match on event: prompt_stop (10:00:40) and a hook_event_name UserPromptSubmit line (10:00:20) are not prompt lines, so the start is the prompt_start 10:01:00; rule 4: 10:05:00."
  },
  {
    "id": "TS-25",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "one", "timestamp": "2026-09-26T10:01:00.000Z"},
      {"type": "artisyn", "hook_event_name": "Stop", "timestamp": "2026-09-26T10:05:00.000Z"},
      {"event": "prompt_start", "prompt": "two", "timestamp": "2026-09-26T10:07:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:01:00.000Z", "endTime": "2026-09-26T10:07:00.000Z"},
    "note": "Rule 4 includes prompt lines: the largest activity timestamp is the second prompt_start 10:07:00; rule 3: the smallest prompt line 10:01:00. An end that skips prompt lines gives 10:05:00."
  },
  {
    "id": "TS-26",
    "input": {"lines": [
      {"type": "custom-event", "timestamp": "2026-09-26T09:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T09:00:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1 is a deny-list: custom-event is not in NON_ACTIVITY_LINE_TYPES, so it is an activity line; no prompt line, so the fallback start is 09:00:00; end 10:05:00. An allow-list of artisyn and type-less lines gives 10:00:00."
  },
  {
    "id": "TS-27",
    "input": {"lines": [
      {"type": "code-inventory", "trackedFiles": 10, "trackedLines": 100, "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "bad"},
      {"type": "harness-snapshot-ref", "snapshotId": "s1"}
    ]},
    "expected": {"startTime": null, "endTime": null},
    "note": "Rule 6 on non-empty input: code-inventory is not an activity line, 'bad' does not parse and the snapshot ref has no timestamp, so no activity line is left: both null. Falling back to all lines would give 04:00:00 for both."
  },
  {
    "id": "TS-28",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "1969-12-31T23:59:59.000Z"},
      {"event": "prompt_start", "prompt": "x", "timestamp": "1970-01-01T00:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "Stop", "timestamp": "2026-09-26T10:00:00.000Z"}
    ]},
    "expected": {"startTime": "1970-01-01T00:00:00.000Z", "endTime": "2026-09-26T10:00:00.000Z"},
    "note": "Rule 1 accepts the epoch instant (it parses, to 0 ms), so it is a prompt line and rule 3 makes it the start, not the earlier SessionStart at -1000 ms; rule 4: 10:00:00. Treating a prompt start of 0 ms as no value (minPromptTs || minTs) falls back to 1969-12-31T23:59:59.000Z; a truthiness check on the start (startTs ? ... : null) gives null."
  },
  {
    "id": "TS-29",
    "input": {"lines": [
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "1970-01-01T00:00:00.000Z"}
    ]},
    "expected": {"startTime": "1970-01-01T00:00:00.000Z", "endTime": "1970-01-01T00:00:00.000Z"},
    "note": "One activity line at 0 ms and no prompt line: rule 3 falls back to it and rule 4 takes it as the largest, so both are the epoch. A truthiness check on the end (maxTs ? ... : null) gives a null end."
  },
  {
    "id": "TS-30",
    "input": {"lines": [
      {"type": "code-inventory", "event": "prompt_start", "trackedFiles": 10, "trackedLines": 100, "timestamp": "2026-09-26T04:00:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionStart", "timestamp": "2026-09-26T10:00:00.000Z"},
      {"event": "prompt_start", "prompt": "go", "timestamp": "2026-09-26T10:01:00.000Z"},
      {"type": "artisyn", "hook_event_name": "SessionEnd", "timestamp": "2026-09-26T10:05:00.000Z"}
    ]},
    "expected": {"startTime": "2026-09-26T10:01:00.000Z", "endTime": "2026-09-26T10:05:00.000Z"},
    "note": "Rule 1 comes before rule 2: the code-inventory line is not an activity line, so its event prompt_start does not make it a prompt line; the start is the real prompt 10:01:00, end 10:05:00. Detecting prompt lines before the non-activity filter gives 04:00:00."
  }
]
```

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
