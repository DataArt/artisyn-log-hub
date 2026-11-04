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

Rows (40): [`docs/algorithm-examples/tool-call-sections.json`](../../algorithm-examples/tool-call-sections.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
