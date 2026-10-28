---
reviewed: no
reviewer: none
---

# Tool wrapper matching: joining wrapper records to the transcript `tool_use` that ran them

## Purpose

A monitored CLI call can be seen twice: the hook's wrapper records what the tool really printed
and how it exited, and the transcript records the Bash / PowerShell `tool_use` the agent issued
and what the agent saw back. The Tools/MCP tab shows one call with both sides — full output next
to "agent saw", a `cut` marker when the agent saw less, an "Open in session" link to the turn —
so each wrapper record has to be joined to the `tool_use` that ran it. Records no command names
(a tool run by a script or another tool) are kept as `indirect`, and recognised invocations with
no record are kept as transcript-only (`no wrapper`).

## Code

- Implementation: `server/src/logs/tool-monitoring/wrapper-record-matching.ts`
  (`matchWrapperRecords`, `isCut`).
- Inputs come from `server/src/logs/tool-monitoring/tool-calls-log.ts` (`parseToolCallsLog`,
  the wrapper records) and [cli-command-recognition](cli-command-recognition.md) (the monitored
  invocations of each Bash / PowerShell `tool_use`); constant `MATCH_WINDOW_SLACK_MS` = 2000 in
  `tool-usage.constants.ts`.
- Caller: `server/src/logs/tool-monitoring/tool-usage-builder.ts` (`buildTreeToolUsage`).
- Twins: none.
- Test: `server/src/logs/tool-monitoring/wrapper-record-matching.algo.spec.ts` (jest).

## Input and output

`matchWrapperRecords(records, transcriptCliCalls)` takes the tree's wrapper records (`tool`,
`args`, `startedAtMs`, `bytes.stdout` / `bytes.stderr`, `consumerClosed`) and every Bash /
PowerShell `tool_use` of the tree (`toolUseId`, `ts`, `resultTs`, its recognised invocations —
"slots" — and `agentSawBytes`, the bytes of the result the agent saw). It returns `matched`
(record + `tool_use` + slot + `cut`), `indirect` (record + `toolUseId` or null + `cut`) and
`transcriptOnly` (`tool_use` + slot).

## Rules

1. **Window.** A `tool_use` with a timestamp has the window
   `[ts − MATCH_WINDOW_SLACK_MS, end + MATCH_WINDOW_SLACK_MS]` (both ends inclusive), where `end` is
   its `resultTs`, or `ts` itself when it has no result. A `tool_use` without a timestamp has no
   window and never matches.
2. **Record order.** Records are taken in `startedAt` order (then `callId`).
3. **Match.** A record matches a free slot of a `tool_use` whose window contains `startedAt` and
   whose slot names the record's tool (case-insensitive, without `.exe` / `.cmd` / `.bat` /
   `.ps1`) with an equal first argument (both absent counts as equal). Ties go to the earliest
   `tool_use` (by `ts`, then input order) and, inside it, to its first free slot. A slot takes one
   record.
4. **Indirect.** A record with no such slot is `indirect`. It is linked to the `tool_use` whose
   window contains `startedAt` and which started latest at or before `startedAt`; when every
   containing window started after `startedAt`, to the earliest containing one; when no window
   contains it, `toolUseId` is null.
5. **Transcript-only.** Every slot left without a record after all records are placed is a
   transcript-only call (hint `no_wrapper`), in `tool_use` input order, then slot order.
6. **Cut.** `cut` = the record's `consumerClosed`, or — for a **matched** record whose `tool_use`
   has a known `agentSawBytes` — `agentSawBytes` < `bytes.stdout + bytes.stderr`. An indirect
   record's `cut` is its `consumerClosed` only.

## Edge cases

- Plain match: WM-01. Two calls of the tool in one command: WM-02. Tie between two `tool_use`s:
  WM-12. Tool name case / `.exe`: WM-13. Both first arguments absent: WM-16.
- Indirect inside a window (no slot names it): WM-03; slot exists but the first argument
  differs: WM-04. Indirect link choice among several windows: WM-14.
- Indirect without any window: WM-05; window without a result: WM-15.
- Window boundaries: start inclusive WM-06, just past the end WM-07.
- Transcript-only: WM-08 (also WM-04, WM-05, WM-07, WM-15).
- `cut`: consumer closed WM-09; agent saw fewer bytes WM-10; equal bytes not cut WM-11;
  indirect ignores the byte rule WM-17.

## Examples

Times are seconds after a fixed base (rounded to whole ms). `input.uses` are the `tool_use`s in
input order: `id`, `ts`, `resultTs` (`null` = no result), `recognized` (slots: `tool`, `args`;
the test sets each slot's `operation` from its args) and `agentSawBytes` (default `null`).
`input.records` are wrapper records: `callId`, `tool`, `args`, `at` (= `startedAt`), `stdout` and
`stderr` byte counts (default 0) and `consumerClosed` (default false). `expected` lists, in
order, `matched` as `{callId, toolUseId, slot, cut}`, `indirect` as `{callId, toolUseId, cut}` and
`transcriptOnly` as `{toolUseId, slot, tool}`; each list is exact.

```examples
[
  {
    "id": "WM-01",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 12, "recognized": [{"tool": "zz", "args": ["build"]}], "agentSawBytes": 100}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["build"], "at": 10.5, "stdout": 100}]
    },
    "expected": {"matched": [{"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": false}], "indirect": [], "transcriptOnly": []},
    "note": "Rule 1: u1's window is [8, 14]; 10.5 is inside. Rule 3: slot 0 is zz with args[0] build = the record's -> matched. Rule 6: 100 seen >= 100 + 0 captured, not closed -> not cut."
  },
  {
    "id": "WM-02",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 15, "recognized": [{"tool": "zz", "args": ["build"]}, {"tool": "zz", "args": ["test"]}], "agentSawBytes": 300}],
      "records": [
        {"callId": "r1", "tool": "zz", "args": ["test"], "at": 11, "stdout": 50},
        {"callId": "r2", "tool": "zz", "args": ["build"], "at": 12, "stdout": 50}
      ]
    },
    "expected": {"matched": [
      {"callId": "r1", "toolUseId": "u1", "slot": 1, "cut": false},
      {"callId": "r2", "toolUseId": "u1", "slot": 0, "cut": false}
    ], "indirect": [], "transcriptOnly": []},
    "note": "Rule 2: r1 (11 s) first. Rule 3: r1's first argument test matches slot 1 only; r2's build matches slot 0. Rule 6: 300 >= 50 each -> not cut."
  },
  {
    "id": "WM-03",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 20, "recognized": []}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["x"], "at": 15}]
    },
    "expected": {"matched": [], "indirect": [{"callId": "r1", "toolUseId": "u1", "cut": false}], "transcriptOnly": []},
    "note": "Rule 3: u1 (e.g. 'npm test') names no monitored tool -> no slot. Rule 4: 15 is in u1's window [8, 22] and u1 started at 10 <= 15 -> indirect linked to u1."
  },
  {
    "id": "WM-04",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 12, "recognized": [{"tool": "zz", "args": ["build"]}]}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["test"], "at": 11}]
    },
    "expected": {"matched": [], "indirect": [{"callId": "r1", "toolUseId": "u1", "cut": false}], "transcriptOnly": [{"toolUseId": "u1", "slot": 0, "tool": "zz"}]},
    "note": "Rule 3: same tool but args[0] test != build -> no match. Rule 4: inside u1's window [8, 14] -> indirect, u1. Rule 5: slot 0 stays free -> transcript-only."
  },
  {
    "id": "WM-05",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 12, "recognized": [{"tool": "zz", "args": ["build"]}]}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["build"], "at": 100}]
    },
    "expected": {"matched": [], "indirect": [{"callId": "r1", "toolUseId": null, "cut": false}], "transcriptOnly": [{"toolUseId": "u1", "slot": 0, "tool": "zz"}]},
    "note": "Rule 1: 100 is outside [8, 14]. Rule 4: no window contains it -> indirect with toolUseId null. Rule 5: u1's slot is transcript-only."
  },
  {
    "id": "WM-06",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 12, "recognized": [{"tool": "zz", "args": ["build"]}]}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["build"], "at": 8}]
    },
    "expected": {"matched": [{"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": false}], "indirect": [], "transcriptOnly": []},
    "note": "Rule 1: the window start 10 - 2 = 8 is inclusive -> matched. Rule 6: agentSawBytes null and not closed -> not cut."
  },
  {
    "id": "WM-07",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 12, "recognized": [{"tool": "zz", "args": ["build"]}]}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["build"], "at": 14.001}]
    },
    "expected": {"matched": [], "indirect": [{"callId": "r1", "toolUseId": null, "cut": false}], "transcriptOnly": [{"toolUseId": "u1", "slot": 0, "tool": "zz"}]},
    "note": "Rule 1: the window ends at 12 + 2 = 14; 14.001 is 1 ms past it -> no window. Rules 4-5: indirect null, slot transcript-only."
  },
  {
    "id": "WM-08",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 11, "recognized": [{"tool": "find", "args": ["."]}]}],
      "records": []
    },
    "expected": {"matched": [], "indirect": [], "transcriptOnly": [{"toolUseId": "u1", "slot": 0, "tool": "find"}]},
    "note": "Rule 5: no records at all (old hook, wrapper off) -> the recognised find call is transcript-only."
  },
  {
    "id": "WM-09",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 11, "recognized": [{"tool": "zz", "args": []}], "agentSawBytes": 2000}],
      "records": [{"callId": "r1", "tool": "zz", "args": [], "at": 10, "stdout": 2000, "consumerClosed": true}]
    },
    "expected": {"matched": [{"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": true}], "indirect": [], "transcriptOnly": []},
    "note": "Rule 6: consumerClosed (e.g. zz | head -1) -> cut, even though 2000 seen = 2000 captured."
  },
  {
    "id": "WM-10",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 11, "recognized": [{"tool": "zz", "args": ["log"]}], "agentSawBytes": 110}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["log"], "at": 10.2, "stdout": 100, "stderr": 20}]
    },
    "expected": {"matched": [{"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": true}], "indirect": [], "transcriptOnly": []},
    "note": "Rule 6: captured 100 + 20 = 120 > 110 seen -> cut."
  },
  {
    "id": "WM-11",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 11, "recognized": [{"tool": "zz", "args": ["log"]}], "agentSawBytes": 120}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["log"], "at": 10.2, "stdout": 100, "stderr": 20}]
    },
    "expected": {"matched": [{"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": false}], "indirect": [], "transcriptOnly": []},
    "note": "Rule 6: 120 seen is not less than 120 captured -> not cut."
  },
  {
    "id": "WM-12",
    "input": {
      "uses": [
        {"id": "u1", "ts": 10, "resultTs": 11, "recognized": [{"tool": "zz", "args": ["build"]}]},
        {"id": "u2", "ts": 11, "resultTs": 12, "recognized": [{"tool": "zz", "args": ["build"]}]}
      ],
      "records": [
        {"callId": "r1", "tool": "zz", "args": ["build"], "at": 11.5},
        {"callId": "r2", "tool": "zz", "args": ["build"], "at": 11.6}
      ]
    },
    "expected": {"matched": [
      {"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": false},
      {"callId": "r2", "toolUseId": "u2", "slot": 0, "cut": false}
    ], "indirect": [], "transcriptOnly": []},
    "note": "Rule 1: windows u1 [8, 13], u2 [9, 14]; both contain 11.5 and 11.6. Rule 3: r1 goes to the earliest, u1; u1's only slot is then taken, so r2 goes to u2."
  },
  {
    "id": "WM-13",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 11, "recognized": [{"tool": "ZZ", "args": ["sync"]}]}],
      "records": [{"callId": "r1", "tool": "zz.exe", "args": ["sync"], "at": 10}]
    },
    "expected": {"matched": [{"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": false}], "indirect": [], "transcriptOnly": []},
    "note": "Rule 3: ZZ and zz.exe both normalise to zz -> matched."
  },
  {
    "id": "WM-14",
    "input": {
      "uses": [
        {"id": "u1", "ts": 10, "resultTs": 30, "recognized": []},
        {"id": "u2", "ts": 20, "resultTs": 25, "recognized": []}
      ],
      "records": [
        {"callId": "r1", "tool": "find", "args": ["x"], "at": 22},
        {"callId": "r2", "tool": "find", "args": ["y"], "at": 9}
      ]
    },
    "expected": {"matched": [], "indirect": [
      {"callId": "r2", "toolUseId": "u1", "cut": false},
      {"callId": "r1", "toolUseId": "u2", "cut": false}
    ], "transcriptOnly": []},
    "note": "Rule 2: r2 (9) before r1 (22). Rule 4: 9 is only in u1's window [8, 32] and u1 started at 10 > 9 -> the earliest containing window, u1. 22 is in u1 [8, 32] and u2 [18, 27]; both started at or before 22, u2 latest -> u2."
  },
  {
    "id": "WM-15",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": null, "recognized": [{"tool": "zz", "args": ["build"]}]}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["build"], "at": 12.5}]
    },
    "expected": {"matched": [], "indirect": [{"callId": "r1", "toolUseId": null, "cut": false}], "transcriptOnly": [{"toolUseId": "u1", "slot": 0, "tool": "zz"}]},
    "note": "Rule 1: no result -> end = ts, window [8, 12]; 12.5 is outside -> indirect null; the slot is transcript-only."
  },
  {
    "id": "WM-16",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 11, "recognized": [{"tool": "zz", "args": []}]}],
      "records": [{"callId": "r1", "tool": "zz", "args": [], "at": 10.5}]
    },
    "expected": {"matched": [{"callId": "r1", "toolUseId": "u1", "slot": 0, "cut": false}], "indirect": [], "transcriptOnly": []},
    "note": "Rule 3: both first arguments are absent -> equal -> matched."
  },
  {
    "id": "WM-17",
    "input": {
      "uses": [{"id": "u1", "ts": 10, "resultTs": 20, "recognized": [], "agentSawBytes": 10}],
      "records": [{"callId": "r1", "tool": "zz", "args": ["x"], "at": 12, "stdout": 500}]
    },
    "expected": {"matched": [], "indirect": [{"callId": "r1", "toolUseId": "u1", "cut": false}], "transcriptOnly": []},
    "note": "Rule 6: an indirect record's cut is consumerClosed only; the 10 < 500 byte comparison does not apply (the turn's output is not this tool's)."
  }
]
```

## Mutations

- Window end inclusive of slack missing (no `+ 2 s`) -> WM-06 / WM-07 boundaries; start
  exclusive -> WM-06.
- Window of a result-less `tool_use` taken as unbounded -> WM-15.
- First argument ignored when matching -> WM-04 (would match), WM-02 (wrong slots).
- A slot reused by a second record -> WM-12 (both on u1).
- Tie to the latest `tool_use` instead of the earliest -> WM-12.
- Case-sensitive or `.exe`-sensitive tool comparison -> WM-13.
- Indirect linked to the earliest window always -> WM-14 (r1 to u1); never linked -> WM-03.
- `cut` without stderr in the captured bytes -> WM-10 (100 < 110 would not be cut); `<=`
  instead of `<` -> WM-11; byte rule applied to indirect records -> WM-17.

## Where the result is visible

- Repository → **Tools/MCP** tab: a call's `source` (wrapper / transcript / both), the `cut`,
  `indirect` and `no wrapper` hints in the calls table, "Full output" vs "Agent saw" in the call
  details and the "Open in session" link (`toolUseId`).
- Storage: `session_tool_usage.calls` of `channel = 'cli'` rows; an `indirect` record belongs to
  the tree's root node (DD-8).
