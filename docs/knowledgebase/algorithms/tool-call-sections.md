---
reviewed: 2026-10-23
reviewer: ai
---

# Tool-call sections and permission attribution

## Purpose

A prompt turn in the Logs view splits its tool calls into Files, Skills, Agents and Tools, and
marks the calls that needed a permission prompt ("⚠ requested") or were denied ("⚠ denied"). The
user must see each call in exactly one section, and a permission badge on the call that actually
asked — not on the first call of the same tool in the turn.

## Code

- Implementation: `client/src/viewer/pages/repository/session-log/tool-calls.ts`
  (`TOOL_SECTION`, `toolSection`, `FILE_TOOL_NAMES`, `PERMISSION_WINDOW_MS`, `deepEqual`,
  `deepSubset`, `extractRawToolCalls`, `buildToolResultIndex`, `buildAllToolCalls`,
  `extractPermissionEvents`, `attributePermissionEvents`).
- Callers (not part of the rule): `log-parser.ts` builds `PromptTurn.allToolCalls` /
  `SubAgentNode.allToolCalls` with these functions and derives `toolCalls`, `files`, `skills`
  and the Agent links from the sections; it runs the attribution once per log (main transcript
  and each sub-agent) and stores the unattributed count in
  `ParsedSession.unattributedPermissionEvents`.
- Twins: none. The hook (2.24.0+) records `tool_use_id` on `PermissionDenied`; `PermissionRequest`
  never carries one.
- Test: `client/src/viewer/pages/repository/session-log/tool-calls.algo.test.ts` (vitest).

## Input and output

- A call: `{id, name, input, startedAt, endedAt?}`. `startedAt` is the timestamp of the assistant
  line with the `tool_use`; `endedAt` is the timestamp of the user line with its `tool_result`
  (absent while the call has no result).
- A permission event: `{kind: 'request' | 'denied', toolName, toolInput | null, ts, toolUseId?}`
  (the rules below call its `ts` `t`),
  read from artisyn `PermissionRequest` / `PermissionDenied` lines (`tool_name`, `tool_input`,
  `timestamp`, `tool_use_id`). `toolInput` is `null` on old hooks (a missing `tool_input` is the
  same as `null`). A `tool_use_id` that is `null`, empty or not a string counts as absent: the
  hook writes `tool_use_id || null`.
- Output: `section` per call, `permissionRequested` / `permissionDenied` set on matched calls,
  and the number of events that matched no call.

## Input producer (outside the rules, not pinned by the rows)

These are properties of how the logs are read, not of the attribution rule. The rows always
give well-formed calls and events, so these are not reachable from the examples (the one
exception, the event sort, is pinned by TS-20):

- A `tool_use` block without an id, a name or an input is skipped. `extractRawToolCalls` can be
  limited to a turn (`uuidSet`) or skip sidechain lines (`skipSidechain`).
- An artisyn line without `hook_event_name` or `timestamp`, with an unparseable timestamp, or
  with a hook event other than `PermissionRequest` / `PermissionDenied` is dropped. An event
  without `tool_name` gets the name `''`, which no call has, so it ends up unattributed.
- A call without a parseable `startedAt` is never a candidate; an unparseable `endedAt` counts
  as absent (+∞).
- Calls are sorted by comparing their ISO `timestamp` strings (stable; calls without a
  timestamp last). For each `tool_use_id` the first `tool_result` gives `endedAt`, and
  `durationMs` is left out when it would be negative or not finite.
- Events are sorted by time both in `extractPermissionEvents` and again in
  `attributePermissionEvents`; either sort alone gives the same result.
- The result and status fields of a call (`buildToolResultIndex` / `buildAllToolCalls`: the
  result text with its `[binary data, N bytes]` placeholder, `bytes`, `isError`, `interrupted`,
  `denialKind`, `status` via `outcomeToStatus`, and `result` only for non-empty content) are
  not part of this rule; the status is `tool-call-outcome.md`.
- Call ids are unique in a real log; if two calls shared an id, rule 3 would flag the first one
  in start order.
- `FILE_TOOL_NAMES` and `isFileToolName` (used by the Files section) are derived in code from
  `TOOL_SECTION`, so they follow rule 1 by construction. `FILE_ERROR_MAX_CHARS` (the length of
  a failed file call's error text) lives in the same file but is display trimming, not part of
  this rule.

## Rules

### Sections

1. `toolSection(name)` is looked up in `TOOL_SECTION`, by exact, case-sensitive name, among the
   map's own entries only (so a name such as `constructor` is not found and maps to `tool`):
   - `Read`, `Edit`, `Write`, `MultiEdit`, `Glob` → `file`;
   - `Skill` → `skill`;
   - `Agent` → `agent`;
   - every other name → `tool` (Bash, PowerShell, MCP tools, `NotebookEdit`, the legacy `Task`,
     unknown and new tools).
2. (No rule: the Files-section name set is derived from rule 1 in code; see "Input producer".)

### Permission attribution (`attributePermissionEvents`)

Events are processed in time order (stable: events with the same timestamp keep their log
order). For each event:

3. **By id.** If the event (`request` or `denied`) has a `toolUseId`, the call with that id is
   flagged, whatever its
   name, input and window, and even if it is already flagged. If no call has that id, the event
   is unattributed — there is no fallback to name or input.
4. **Candidates.** Otherwise the candidates are the calls that:
   - have `name === toolName`;
   - are not yet flagged for this event's kind (a call can be flagged once as requested and once
     as denied);
   - are pending at `t`: `startedAt − PERMISSION_WINDOW_MS ≤ t ≤ endedAt + PERMISSION_WINDOW_MS`,
     with `PERMISSION_WINDOW_MS` = 2000 and `endedAt` = +∞ when the call has no result. Both
     bounds are inclusive.
5. **Score** each candidate:
   - 3 when `deepEqual(call.input, toolInput)`;
   - else 2 when `deepSubset(call.input, toolInput)` (the hook may add default keys);
   - 1 when `toolInput` is `null` (old hooks: time and name only);
   - else 0, and the candidate is dropped.
6. **Pick** the highest score. On a tie, prefer the candidate with the latest `startedAt ≤ t`; if
   none started at or before `t`, the earliest `startedAt`. Equal starts keep the call order
   (the first one wins).
7. No candidate left → the event is unattributed. Never fall back to name only.
8. A `request` event sets `permissionRequested`, a `denied` event sets `permissionDenied`.

### Deep compare

9. `deepEqual(a, b)` over JSON values: object key order is ignored, objects must have the same
   key set, arrays compare by position and length, everything else with `===`.
10. `deepSubset(sub, sup)`: every key of `sub` exists in `sup` with a deep-subset value; arrays
    compare by position and must have the same length, and each element of `sub` must be a
    deep subset (not deep equal) of the element at the same position in `sup`; everything else
    with `===`.

## Edge cases

- Every file tool: TS-01. Skill and Agent: TS-02.
- Bash, MCP, `Task`, `NotebookEdit` and a lower-case `read` are all `tool`: TS-03.
- Two pending calls of the same tool, the second one asked (exact input, keys in another order):
  TS-04.
- A hook-added default key (subset match) on a file tool: TS-05.
- An exact match beats a subset match that started later, closer to the event: TS-06.
- No `tool_input` (old hooks): tie broken by the latest start at or before `t`: TS-07.
- Window end: 1 ms outside TS-08, exactly on the bound TS-09. Window start, both sides: TS-10.
- `tool_use_id` wins over a better input match: TS-11; an unknown id is unattributed: TS-12.
- A call is flagged at most once per kind, but can be both requested and denied: TS-13.
- Another tool's name never matches: TS-14.
- Arrays compare by position: TS-15; and by length: TS-22.
- A `null` or empty `tool_use_id` counts as no id: TS-16.
- A call without a result stays pending (window end +∞): TS-17.
- Tie-break boundaries: a candidate starting exactly at `t` TS-18; no candidate started yet
  TS-19.
- Events listed out of time order: TS-20.
- `tool_use_id` ignores name and window: TS-21.
- Events but no calls: TS-23.
- An exact match in another key order against a later subset match: TS-24.
- Window start, 1 ms outside with no other event: TS-25.
- Tied candidates with equal starts: TS-26 (started before `t`), TS-30 (not started yet), TS-31
  (both start exactly at `t`).
- Array elements that are subsets (a hook-added default key inside each `edits` element): TS-29.
- A tool name that is an `Object.prototype` member: TS-32.
- A higher score later in call order: TS-33. A tie at score 3: TS-34.
- Two `denied` events without an id on one call: TS-35.
- An event whose tool name differs from the call only by case: TS-36.
- Two events at the same timestamp, where their order decides: TS-37.
- A `tool_use_id` that is a number: TS-38.
- A nested array against a string, and a nested object against `null`: TS-39, TS-40.
- `tool_use_id` on a call that is already flagged: TS-27.
- An event with no `tool_input` key at all: TS-28.

## Examples

Times are milliseconds after a fixed base (`2026-01-01T00:00:00.000Z`).

- `input.calls`: `[{id, name, input, ts, endTs?}]`. The test turns each call into an assistant
  line (`timestamp` = base + `ts`) holding one `tool_use` block, and, when `endTs` is given, a user
  line (`timestamp` = base + `endTs`) holding its `tool_result` with the text `ok`. It then runs
  `extractRawToolCalls` → `buildToolResultIndex` → `buildAllToolCalls`.
- `input.perms` (optional): `[{kind, tool_name, tool_input, ts, tool_use_id?}]`. Each becomes an
  artisyn line with `hook_event_name` `PermissionRequest` (`kind: "request"`) or
  `PermissionDenied` (`kind: "denied"`), `tool_name`, `tool_input`, `timestamp` = base + `ts` and
  `tool_use_id` when given. The test runs `extractPermissionEvents` →
  `attributePermissionEvents` over the calls.
- `expected.sections`: call id → section. `expected.flags`: call id → the flags set on it, in the
  order `requested`, `denied`; a call that is not listed has no flag. `expected.unattributed`: the
  returned count.

```examples
[
  {
    "id": "TS-01",
    "input": {"calls": [
      {"id": "r1", "name": "Read", "input": {"file_path": "src/a.ts"}, "ts": 0},
      {"id": "e1", "name": "Edit", "input": {"file_path": "src/a.ts"}, "ts": 1},
      {"id": "w1", "name": "Write", "input": {"file_path": "src/b.ts"}, "ts": 2},
      {"id": "m1", "name": "MultiEdit", "input": {"file_path": "src/c.ts"}, "ts": 3},
      {"id": "g1", "name": "Glob", "input": {"pattern": "**/*.ts"}, "ts": 4}
    ]},
    "expected": {"sections": {"r1": "file", "e1": "file", "w1": "file", "m1": "file", "g1": "file"}, "flags": {}, "unattributed": 0},
    "note": "Rule 1: the five file tools map to 'file'. No events, so no flags and nothing unattributed."
  },
  {
    "id": "TS-02",
    "input": {"calls": [
      {"id": "s1", "name": "Skill", "input": {"skill": "changelog"}, "ts": 0},
      {"id": "a1", "name": "Agent", "input": {"description": "explore"}, "ts": 1}
    ]},
    "expected": {"sections": {"s1": "skill", "a1": "agent"}, "flags": {}, "unattributed": 0},
    "note": "Rule 1: Skill -> skill, Agent -> agent."
  },
  {
    "id": "TS-03",
    "input": {"calls": [
      {"id": "b1", "name": "Bash", "input": {"command": "ls"}, "ts": 0},
      {"id": "x1", "name": "mcp__github__get_issue", "input": {"number": 1}, "ts": 1},
      {"id": "t1", "name": "Task", "input": {"description": "old agent"}, "ts": 2},
      {"id": "n1", "name": "NotebookEdit", "input": {"notebook_path": "a.ipynb"}, "ts": 3},
      {"id": "q1", "name": "read", "input": {"file_path": "src/a.ts"}, "ts": 4}
    ]},
    "expected": {"sections": {"b1": "tool", "x1": "tool", "t1": "tool", "n1": "tool", "q1": "tool"}, "flags": {}, "unattributed": 0},
    "note": "Rule 1: none of these names is in TOOL_SECTION, so all are 'tool'. The legacy Task stays 'tool' (not 'agent'); 'read' differs from 'Read' by case, so it is not a file tool."
  },
  {
    "id": "TS-04",
    "input": {
      "calls": [
        {"id": "b1", "name": "Bash", "input": {"command": "npm test", "description": "Run tests"}, "ts": 4000, "endTs": 6000},
        {"id": "b2", "name": "Bash", "input": {"command": "rm -rf dist", "description": "Clean"}, "ts": 5000}
      ],
      "perms": [{"kind": "request", "tool_name": "Bash", "tool_input": {"description": "Clean", "command": "rm -rf dist"}, "ts": 5300}]
    },
    "expected": {"sections": {"b1": "tool", "b2": "tool"}, "flags": {"b2": ["requested"]}, "unattributed": 0},
    "note": "Rule 4: t = 5300. b1 window [2000, 8000] and b2 window [3000, +inf] both hold t. Rule 5: b1's input differs (score 0, dropped); b2's input has the same keys and values in another order, deepEqual (rule 9) -> score 3. b2 is flagged requested. Name-only matching (the old rule) would flag b1, the first Bash."
  },
  {
    "id": "TS-05",
    "input": {
      "calls": [{"id": "e1", "name": "Edit", "input": {"file_path": "src/a.ts", "old_string": "a", "new_string": "b"}, "ts": 0}],
      "perms": [{"kind": "request", "tool_name": "Edit", "tool_input": {"file_path": "src/a.ts", "old_string": "a", "new_string": "b", "replace_all": false}, "ts": 300}]
    },
    "expected": {"sections": {"e1": "file"}, "flags": {"e1": ["requested"]}, "unattributed": 0},
    "note": "Rule 4: e1 is pending at 300 (window [-2000, +inf]). Rule 5: not deepEqual (the event has the extra key replace_all), but every key of the call's input is in the event with the same value -> deepSubset, score 2 > 0. Flagged requested, in the file section. Exact-match-only scoring would leave it unattributed."
  },
  {
    "id": "TS-06",
    "input": {
      "calls": [
        {"id": "c2", "name": "Bash", "input": {"command": "ls", "timeout": 5000}, "ts": 0},
        {"id": "c1", "name": "Bash", "input": {"command": "ls"}, "ts": 1000}
      ],
      "perms": [{"kind": "request", "tool_name": "Bash", "tool_input": {"command": "ls", "timeout": 5000}, "ts": 1200}]
    },
    "expected": {"sections": {"c2": "tool", "c1": "tool"}, "flags": {"c2": ["requested"]}, "unattributed": 0},
    "note": "Rule 4: both pending at 1200. Rule 5: c2 equal -> 3; c1 {command: ls} is a subset of the event -> 2. Rule 6: the highest score wins, c2, although c1 started later and closer to t. Picking by start time first would flag c1."
  },
  {
    "id": "TS-07",
    "input": {
      "calls": [
        {"id": "c1", "name": "Bash", "input": {"command": "a"}, "ts": 0},
        {"id": "c2", "name": "Bash", "input": {"command": "b"}, "ts": 1000},
        {"id": "c3", "name": "Bash", "input": {"command": "c"}, "ts": 3000}
      ],
      "perms": [{"kind": "request", "tool_name": "Bash", "tool_input": null, "ts": 1500}]
    },
    "expected": {"sections": {"c1": "tool", "c2": "tool", "c3": "tool"}, "flags": {"c2": ["requested"]}, "unattributed": 0},
    "note": "Rule 4: t = 1500; windows start at -2000, -1000 and 1000, none has a result, so all three are pending. Rule 5: tool_input null -> all score 1. Rule 6: started at or before 1500 are c1 (0) and c2 (1000); the latest is c2. Taking the latest start overall would pick c3 (3000 > t); taking the earliest would pick c1."
  },
  {
    "id": "TS-08",
    "input": {
      "calls": [{"id": "c1", "name": "Bash", "input": {"command": "ls"}, "ts": 0, "endTs": 1000}],
      "perms": [{"kind": "request", "tool_name": "Bash", "tool_input": {"command": "ls"}, "ts": 3001}]
    },
    "expected": {"sections": {"c1": "tool"}, "flags": {}, "unattributed": 1},
    "note": "Rule 4: c1's window ends at endedAt + 2000 = 3000; t = 3001 is outside, so there is no candidate. Rule 7: unattributed = 1, no flag (no name-only fallback)."
  },
  {
    "id": "TS-09",
    "input": {
      "calls": [{"id": "c1", "name": "Bash", "input": {"command": "ls"}, "ts": 0, "endTs": 1000}],
      "perms": [{"kind": "request", "tool_name": "Bash", "tool_input": {"command": "ls"}, "ts": 3000}]
    },
    "expected": {"sections": {"c1": "tool"}, "flags": {"c1": ["requested"]}, "unattributed": 0},
    "note": "Rule 4: t = 3000 = 1000 + 2000, on the inclusive end bound -> candidate, score 3. Flagged. An exclusive end bound would leave it unattributed."
  },
  {
    "id": "TS-10",
    "input": {
      "calls": [{"id": "c1", "name": "Bash", "input": {"command": "ls"}, "ts": 5000}],
      "perms": [
        {"kind": "request", "tool_name": "Bash", "tool_input": {"command": "ls"}, "ts": 2999},
        {"kind": "request", "tool_name": "Bash", "tool_input": {"command": "ls"}, "ts": 3000}
      ]
    },
    "expected": {"sections": {"c1": "tool"}, "flags": {"c1": ["requested"]}, "unattributed": 1},
    "note": "Rule 4: c1's window starts at 5000 - 2000 = 3000. The event at 2999 is 1 ms before -> no candidate, unattributed 1. The event at 3000 is on the inclusive start bound -> c1 flagged requested."
  },
  {
    "id": "TS-11",
    "input": {
      "calls": [
        {"id": "b1", "name": "Bash", "input": {"command": "curl x"}, "ts": 0},
        {"id": "b2", "name": "Bash", "input": {"command": "curl y"}, "ts": 100}
      ],
      "perms": [{"kind": "denied", "tool_name": "Bash", "tool_input": {"command": "curl y"}, "ts": 200, "tool_use_id": "b1"}]
    },
    "expected": {"sections": {"b1": "tool", "b2": "tool"}, "flags": {"b1": ["denied"]}, "unattributed": 0},
    "note": "Rule 3: the event carries tool_use_id b1, so b1 is flagged denied, although b2's input would score 3. Scoring before the id check would flag b2."
  },
  {
    "id": "TS-12",
    "input": {
      "calls": [{"id": "b1", "name": "Bash", "input": {"command": "curl x"}, "ts": 0}],
      "perms": [{"kind": "denied", "tool_name": "Bash", "tool_input": {"command": "curl x"}, "ts": 200, "tool_use_id": "zz"}]
    },
    "expected": {"sections": {"b1": "tool"}, "flags": {}, "unattributed": 1},
    "note": "Rule 3: no call has id zz -> unattributed, with no fallback to the name + input match that b1 would win. A fallback would flag b1."
  },
  {
    "id": "TS-13",
    "input": {
      "calls": [{"id": "b1", "name": "Bash", "input": {"command": "ls"}, "ts": 0}],
      "perms": [
        {"kind": "request", "tool_name": "Bash", "tool_input": {"command": "ls"}, "ts": 100},
        {"kind": "request", "tool_name": "Bash", "tool_input": {"command": "ls"}, "ts": 200},
        {"kind": "denied", "tool_name": "Bash", "tool_input": {"command": "ls"}, "ts": 300}
      ]
    },
    "expected": {"sections": {"b1": "tool"}, "flags": {"b1": ["requested", "denied"]}, "unattributed": 1},
    "note": "Rule 4: the request at 100 flags b1 requested. The request at 200 finds b1 already flagged for 'request' -> no candidate, unattributed 1. The denied event at 300 is another kind, b1 is not yet flagged denied -> flagged denied."
  },
  {
    "id": "TS-14",
    "input": {
      "calls": [{"id": "b1", "name": "Bash", "input": {"command": "ls"}, "ts": 0}],
      "perms": [{"kind": "request", "tool_name": "Write", "tool_input": null, "ts": 100}]
    },
    "expected": {"sections": {"b1": "tool"}, "flags": {}, "unattributed": 1},
    "note": "Rule 4: the only call is a Bash call, the event is for Write -> no candidate (a null input would otherwise score 1). Unattributed 1."
  },
  {
    "id": "TS-15",
    "input": {
      "calls": [{"id": "m1", "name": "MultiEdit", "input": {"file_path": "a.ts", "edits": [{"old_string": "a", "new_string": "b"}, {"old_string": "c", "new_string": "d"}]}, "ts": 0}],
      "perms": [{"kind": "request", "tool_name": "MultiEdit", "tool_input": {"file_path": "a.ts", "edits": [{"old_string": "c", "new_string": "d"}, {"old_string": "a", "new_string": "b"}]}, "ts": 100}]
    },
    "expected": {"sections": {"m1": "file"}, "flags": {}, "unattributed": 1},
    "note": "Rules 9-10: the edits arrays hold the same two objects in the other order; arrays compare by position, so neither deepEqual nor deepSubset holds -> score 0, dropped. Unattributed 1. An order-insensitive array compare would flag m1."
  },
  {
    "id": "TS-16",
    "input": {"calls":[{"id":"b1","name":"Bash","input":{"command":"ls"},"ts":0,"endTs":100}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":{"command":"ls"},"ts":50,"tool_use_id":null},{"kind":"denied","tool_name":"Bash","tool_input":{"command":"ls"},"ts":60,"tool_use_id":""}]},
    "expected": {"sections":{"b1":"tool"},"flags":{"b1":["requested","denied"]},"unattributed":0},
    "note": "Rule 3: a null or empty tool_use_id (the hook writes `|| null`) counts as no id, so both events go to rules 4-6. @50: b1 is a candidate (window [-2000, 2100]) and the input is equal -> 3 -> requested. @60: b1 is not yet flagged as denied -> 3 -> denied. Treating null or '' as an id would find no call and leave both unattributed (2)."
  },
  {
    "id": "TS-17",
    "input": {"calls":[{"id":"b1","name":"Bash","input":{"command":"npm test"},"ts":0}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":{"command":"npm test"},"ts":10000}]},
    "expected": {"sections":{"b1":"tool"},"flags":{"b1":["requested"]},"unattributed":0},
    "note": "Rule 4: b1 has no result, so endedAt = +inf and the window is [0 - 2000, +inf] = [-2000, +inf]; 10000 is inside. Equal input -> 3 -> requested. A call without a result treated as ending at its start would give the window [-2000, 2000] and leave the event unattributed."
  },
  {
    "id": "TS-18",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"a"},"ts":0},{"id":"c2","name":"Bash","input":{"command":"b"},"ts":1000}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":1000}]},
    "expected": {"sections":{"c1":"tool","c2":"tool"},"flags":{"c2":["requested"]},"unattributed":0},
    "note": "Rules 5-6: no tool_input, so both score 1. Starts at or before t = 1000 are {0, 1000}; the latest is 1000 -> c2. The 'at or before' is inclusive: with start < t only c1 (0) qualifies and c1 would be flagged."
  },
  {
    "id": "TS-19",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"a"},"ts":1500},{"id":"c2","name":"Bash","input":{"command":"b"},"ts":1800}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":1000}]},
    "expected": {"sections":{"c1":"tool","c2":"tool"},"flags":{"c1":["requested"]},"unattributed":0},
    "note": "Rule 4: windows start at 1500 - 2000 = -500 and 1800 - 2000 = -200, both <= 1000, so both are candidates. Rules 5-6: both score 1; neither started at or before t = 1000, so the earliest start (1500) wins -> c1. Taking the latest start in this branch would flag c2."
  },
  {
    "id": "TS-20",
    "input": {"calls":[{"id":"y1","name":"Bash","input":{"command":"y"},"ts":0,"endTs":100},{"id":"x1","name":"Bash","input":{"command":"x"},"ts":1000}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":3000},{"kind":"request","tool_name":"Bash","tool_input":null,"ts":2000}]},
    "expected": {"sections":{"y1":"tool","x1":"tool"},"flags":{"x1":["requested"]},"unattributed":1},
    "note": "Events are processed in time order although the log lists 3000 first. Windows: y1 [-2000, 2100], x1 [-1000, +inf]. @2000: both candidates, both score 1, starts <= 2000 are {0, 1000} -> latest x1. @3000: y1 is out (3000 > 2100), x1 is already flagged -> no candidate -> unattributed 1. Processing in log order would give @3000 -> x1, then @2000 -> y1 (x1 flagged), so both flagged and 0 unattributed."
  },
  {
    "id": "TS-21",
    "input": {"calls":[{"id":"b1","name":"Bash","input":{"command":"rm -rf dist"},"ts":0,"endTs":100},{"id":"b2","name":"Bash","input":{"command":"rm -rf dist"},"ts":59000}],"perms":[{"kind":"denied","tool_name":"Edit","tool_input":{"file_path":"x.ts"},"ts":60000,"tool_use_id":"b1"}]},
    "expected": {"sections":{"b1":"tool","b2":"tool"},"flags":{"b1":["denied"]},"unattributed":0},
    "note": "Rule 3: the event has tool_use_id b1, so b1 is flagged although the name differs (Edit vs Bash), the input differs and t = 60000 is far outside b1's window [-2000, 2100]. Rules 4-6 are skipped; by score, b2 (pending, but another name and input) would not match either, so an id used only as one more filter would leave the event unattributed."
  },
  {
    "id": "TS-22",
    "input": {"calls":[{"id":"g1","name":"Grep","input":{"pattern":"x","paths":["src"]},"ts":0}],"perms":[{"kind":"request","tool_name":"Grep","tool_input":{"pattern":"x","paths":["src","test"]},"ts":100}]},
    "expected": {"sections":{"g1":"tool"},"flags":{},"unattributed":1},
    "note": "Rules 9-10: paths has length 1 in the call and 2 in the event. deepEqual: arrays of different length -> false. deepSubset: arrays must have the same length -> false. Score 0, dropped -> unattributed 1. Dropping the length check in either compare would score 3 or 2 and flag g1."
  },
  {
    "id": "TS-23",
    "input": {"calls":[],"perms":[{"kind":"request","tool_name":"Bash","tool_input":{"command":"ls"},"ts":0},{"kind":"denied","tool_name":"Bash","tool_input":{"command":"ls"},"ts":10}]},
    "expected": {"sections":{},"flags":{},"unattributed":2},
    "note": "Rule 7: no calls at all, so every event has no candidate -> unattributed = number of events = 2."
  },
  {
    "id": "TS-24",
    "input": {"calls":[{"id":"c1","name":"Edit","input":{"replace_all":false,"old_string":"x","file_path":"a.ts"},"ts":0},{"id":"c2","name":"Edit","input":{"file_path":"a.ts","old_string":"x"},"ts":500}],"perms":[{"kind":"request","tool_name":"Edit","tool_input":{"file_path":"a.ts","old_string":"x","replace_all":false},"ts":1000}]},
    "expected": {"sections":{"c1":"file","c2":"file"},"flags":{"c1":["requested"]},"unattributed":0},
    "note": "Rules 5, 9-10: c1 has the same three keys and values in another order -> deepEqual -> 3. c2 lacks replace_all -> deepSubset -> 2. Rule 6: 3 beats 2 -> c1. If only deepEqual were key-order-sensitive, c1 would fall to 2 (still a subset), tie with c2, and the latest start <= 1000 (c2 at 500) would win."
  },
  {
    "id": "TS-25",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"make"},"ts":5000}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":2999}]},
    "expected": {"sections":{"c1":"tool"},"flags":{},"unattributed":1},
    "note": "Rule 4: the window starts at 5000 - 2000 = 3000; 2999 < 3000, so c1 is not a candidate -> rule 7 -> unattributed 1. A start bound wider by 1 ms (2999) would flag c1."
  },
  {
    "id": "TS-26",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"a"},"ts":0},{"id":"c2","name":"Bash","input":{"command":"b"},"ts":0}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":100}]},
    "expected": {"sections":{"c1":"tool","c2":"tool"},"flags":{"c1":["requested"]},"unattributed":0},
    "note": "Rules 5-6: both score 1 and both started at 0 <= 100, with equal starts; equal starts keep the call order, so the first call, c1, wins."
  },
  {
    "id": "TS-27",
    "input": {"calls":[{"id":"b1","name":"Bash","input":{"command":"ls"},"ts":0,"endTs":100}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":{"command":"ls"},"ts":50},{"kind":"request","tool_name":"Bash","tool_input":{"command":"ls"},"ts":60,"tool_use_id":"b1"}]},
    "expected": {"sections":{"b1":"tool"},"flags":{"b1":["requested"]},"unattributed":0},
    "note": "Rule 3 (and it applies to request events too): @50 has no id, b1 scores 3 -> requested. @60 has id b1, so b1 is flagged again even though it is already flagged for request; the flag stays set and the event is attributed. Unattributed 0."
  },
  {
    "id": "TS-28",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"ls"},"ts":0}],"perms":[{"kind":"request","tool_name":"Bash","ts":100}]},
    "expected": {"sections":{"c1":"tool"},"flags":{"c1":["requested"]},"unattributed":0},
    "note": "The event has no tool_input key at all, which is the same as null (Input and output). Rule 5: score 1; c1 is the only candidate (window [-2000, +inf]) -> requested."
  },
  {
    "id": "TS-29",
    "input": {"calls":[{"id":"m1","name":"MultiEdit","input":{"file_path":"a.ts","edits":[{"old_string":"a","new_string":"b"}]},"ts":0}],"perms":[{"kind":"request","tool_name":"MultiEdit","tool_input":{"file_path":"a.ts","edits":[{"old_string":"a","new_string":"b","replace_all":false}]},"ts":100}]},
    "expected": {"sections":{"m1":"file"},"flags":{"m1":["requested"]},"unattributed":0},
    "note": "Rule 9: the edits element has 2 keys in the call and 3 in the event -> not deepEqual. Rule 10: file_path is equal; edits are arrays of the same length 1, and element 0 of the call is a deep subset of element 0 of the event (the hook added replace_all) -> deepSubset -> score 2 -> m1 requested. Comparing array elements with deepEqual would score 0 and leave the event unattributed."
  },
  {
    "id": "TS-30",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"a"},"ts":1500},{"id":"c2","name":"Bash","input":{"command":"b"},"ts":1500}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":1000}]},
    "expected": {"sections":{"c1":"tool","c2":"tool"},"flags":{"c1":["requested"]},"unattributed":0},
    "note": "Rule 4: both windows start at 1500 - 2000 = -500 <= 1000. Rules 5-6: both score 1; neither started at or before t = 1000, so the earliest start wins, and the starts are equal (1500), so the call order decides: c1."
  },
  {
    "id": "TS-31",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"a"},"ts":1000},{"id":"c2","name":"Bash","input":{"command":"b"},"ts":1000}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":1000}]},
    "expected": {"sections":{"c1":"tool","c2":"tool"},"flags":{"c1":["requested"]},"unattributed":0},
    "note": "Rules 5-6: both score 1 and both started exactly at t = 1000, which counts as \"at or before t\"; the starts are equal, so the call order decides: c1."
  },
  {
    "id": "TS-32",
    "input": {"calls":[{"id":"x1","name":"constructor","input":{},"ts":0}]},
    "expected": {"sections":{"x1":"tool"},"flags":{},"unattributed":0},
    "note": "Rule 1: 'constructor' is not one of the map's own entries -> every other name -> tool. No events."
  },
  {
    "id": "TS-33",
    "input": {"calls":[{"id":"e1","name":"Edit","input":{"file_path":"a.ts","old_string":"x"},"ts":0},{"id":"e2","name":"Edit","input":{"file_path":"a.ts","old_string":"x","replace_all":false},"ts":500}],"perms":[{"kind":"request","tool_name":"Edit","tool_input":{"file_path":"a.ts","old_string":"x","replace_all":false},"ts":1000}]},
    "expected": {"sections":{"e1":"file","e2":"file"},"flags":{"e2":["requested"]},"unattributed":0},
    "note": "Rule 4: both pending (windows [-2000, +inf] and [-1500, +inf]). Rule 5: e1 lacks replace_all -> subset -> 2; e2 has the same three keys -> equal -> 3. Rule 6: the highest score wins -> e2, although e1 comes first in call order."
  },
  {
    "id": "TS-34",
    "input": {"calls":[{"id":"b1","name":"Bash","input":{"command":"npm test"},"ts":0},{"id":"b2","name":"Bash","input":{"command":"npm test"},"ts":1000}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":{"command":"npm test"},"ts":1500}]},
    "expected": {"sections":{"b1":"tool","b2":"tool"},"flags":{"b2":["requested"]},"unattributed":0},
    "note": "Rule 5: both inputs equal the event -> both score 3. Rule 6: a tie at score 3 uses the same tie-break as any tie: starts at or before 1500 are {0, 1000}, the latest is 1000 -> b2."
  },
  {
    "id": "TS-35",
    "input": {"calls":[{"id":"b1","name":"Bash","input":{"command":"rm -rf dist"},"ts":0,"endTs":100}],"perms":[{"kind":"denied","tool_name":"Bash","tool_input":{"command":"rm -rf dist"},"ts":50},{"kind":"denied","tool_name":"Bash","tool_input":{"command":"rm -rf dist"},"ts":60}]},
    "expected": {"sections":{"b1":"tool"},"flags":{"b1":["denied"]},"unattributed":1},
    "note": "Rule 4: @50 b1 is pending ([-2000, 2100]) and not flagged as denied -> score 3 -> denied. @60 b1 is already flagged for kind denied, so it is not a candidate -> rule 7 -> unattributed 1."
  },
  {
    "id": "TS-36",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"ls"},"ts":0}],"perms":[{"kind":"request","tool_name":"bash","tool_input":null,"ts":100}]},
    "expected": {"sections":{"c1":"tool"},"flags":{},"unattributed":1},
    "note": "Rule 4: name === toolName is exact; 'bash' is not 'Bash' -> no candidate -> rule 7 -> unattributed 1."
  },
  {
    "id": "TS-37",
    "input": {"calls":[{"id":"c1","name":"Bash","input":{"command":"a"},"ts":0},{"id":"c2","name":"Bash","input":{"command":"b"},"ts":1000}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":null,"ts":1500},{"kind":"request","tool_name":"Bash","tool_input":{"command":"b"},"ts":1500}]},
    "expected": {"sections":{"c1":"tool","c2":"tool"},"flags":{"c2":["requested"]},"unattributed":1},
    "note": "Same timestamp, so the log order is kept: the null-input event first. Rules 5-6: c1 and c2 both score 1; starts <= 1500 are {0, 1000} -> c2. Second event: c2 is already flagged; c1 input {command: a} vs {command: b} -> 0 -> no candidate -> unattributed 1. In the reverse order the exact event would take c2 (3) and the null event c1, leaving 0 unattributed."
  },
  {
    "id": "TS-38",
    "input": {"calls":[{"id":"b1","name":"Bash","input":{"command":"ls"},"ts":0,"endTs":100}],"perms":[{"kind":"request","tool_name":"Bash","tool_input":{"command":"ls"},"ts":50,"tool_use_id":5}]},
    "expected": {"sections":{"b1":"tool"},"flags":{"b1":["requested"]},"unattributed":0},
    "note": "Input and output: a tool_use_id that is not a string counts as absent, so rule 3 does not apply. Rule 4: b1 pending ([-2000, 2100]); rule 5: equal input -> 3 -> requested."
  },
  {
    "id": "TS-39",
    "input": {"calls":[{"id":"g1","name":"Grep","input":{"pattern":"x","paths":["a"]},"ts":0}],"perms":[{"kind":"request","tool_name":"Grep","tool_input":{"pattern":"x","paths":"a"},"ts":100}]},
    "expected": {"sections":{"g1":"tool"},"flags":{},"unattributed":1},
    "note": "Rules 9-10: paths is an array in the call and a string in the event; an array only compares with an array -> neither deepEqual nor deepSubset -> score 0 -> unattributed 1."
  },
  {
    "id": "TS-40",
    "input": {"calls":[{"id":"q1","name":"mcp__db__query","input":{"query":{"sql":"select 1"}},"ts":0}],"perms":[{"kind":"request","tool_name":"mcp__db__query","tool_input":{"query":null},"ts":100}]},
    "expected": {"sections":{"q1":"tool"},"flags":{},"unattributed":1},
    "note": "Rule 1: an MCP tool -> tool. Rules 9-10: query is an object in the call and null in the event; an object only compares with an object -> score 0 -> unattributed 1."
  }
]
```

## Mutations

- `Task` mapped to `agent` -> TS-03.
- Case-insensitive section lookup -> TS-03 (`read` → `file`).
- Name-only matching (the old rule) -> TS-04 (b1 flagged).
- Exact match only, no subset score -> TS-05 (unattributed).
- Key-order-sensitive compare in both `deepEqual` and `deepSubset` (e.g. `JSON.stringify`) ->
  TS-04 (unattributed); in `deepEqual` only -> TS-24 (c2 flagged instead of c1).
- Order-insensitive array compare -> TS-15 (m1 flagged).
- Start time preferred over score -> TS-06 (c1 flagged).
- Tie broken by the latest start overall -> TS-07 (c3); by the earliest start -> TS-07 (c1).
- Exclusive window bounds -> TS-09 (end) and TS-10 (start, second event unattributed too).
- Window too wide by 1 ms at the end -> TS-08 (flagged); at the start -> TS-25 (flagged).
- Score before the `tool_use_id` check -> TS-11 (b2 flagged).
- An unknown `tool_use_id` falls back to scoring -> TS-12 (b1 flagged).
- "Already flagged" not checked, or checked across both kinds -> TS-13 (unattributed 0, or no
  `denied`).
- Tool name not checked -> TS-14 (b1 flagged).
- `tool_use_id: null` used as an id -> TS-16 (the request event unattributed, 1); `''` used as an
  id -> TS-16 (the denied event unattributed, 1); both -> 2.
- A call without a result ends at its start -> TS-17 (unattributed).
- Tie-break with `start < t` instead of `≤` -> TS-18 (c1).
- Latest start when no candidate started yet -> TS-19 (c2).
- Events processed in log order, not time order -> TS-20 (y1 flagged too, unattributed 0). This
  is a double mutant: both event sorts must be removed.
- `tool_use_id` used as one more filter or score -> TS-21 (unattributed).
- No length check in `deepEqual` or `deepSubset` -> TS-22 (g1 flagged).
- Unattributed count not incremented when there are no calls -> TS-23 (0).
- Equal starts on a tie resolved to the later call (`>=` instead of `>`) -> TS-26 (c2).
- An id-matched call that is already flagged counted as unattributed -> TS-27 (1).
- An absent `tool_input` scored like a mismatch (0) instead of like `null` (1) -> TS-28
  (unattributed). This is a double mutant: the code normalises a missing input to `null` when
  reading the event and also scores `undefined` like `null`, so removing only one of the two
  guards changes nothing.
- Array elements in `deepSubset` compared with `deepEqual` -> TS-29 (unattributed).
- Equal starts with no candidate started yet resolved to the later call (`<=` instead of `<`) ->
  TS-30 (c2).
- "Started at or before `t`" tested with `<` for the current best -> TS-31 (c2).
- A higher score that comes later in call order not taking over (`score > bestScore` dropped) ->
  TS-33 (e1).
- The tie-break applied only to score-1 ties (first candidate wins on an exact or subset tie) ->
  TS-34 (b1).
- "Already flagged" checked only for `request` events -> TS-35 (unattributed 0).
- Case-insensitive tool-name match -> TS-36 (c1 flagged).
- Events with the same timestamp reordered by an unstable sort -> TS-37 (both flagged,
  unattributed 0); like TS-20 a double mutant (both sorts).
- Any non-empty, non-null `tool_use_id` taken as an id (a number) -> TS-38 (unattributed).
- `deepSubset` without the "sup is an array" check -> TS-39 (g1 flagged: `"a"[0]` equals `"a"`).
- `deepEqual` / `deepSubset` without the "is a plain object" check on the other side -> TS-40
  (the compare throws on `null`).
- Section lookup that also finds inherited properties (`TOOL_SECTION[name] ?? 'tool'`) -> TS-32
  (`constructor` gets a function, not `tool`).

## Where the result is visible

Session pane → Logs tab → a prompt turn (and a sub-agent's detail): which section (Files, Skills,
Agents, Tools) each call is listed in, and the "⚠ requested" / "⚠ denied" badges on the call rows,
in the tool-call modal header, the Context Growth step modal and the Bash tab.
