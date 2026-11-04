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

Rows (17): [`docs/algorithm-examples/tool-wrapper-matching.json`](../../algorithm-examples/tool-wrapper-matching.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
