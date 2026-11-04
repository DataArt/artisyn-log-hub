---
reviewed: no
reviewer: none
---

# Session Map delta merge

## Purpose

The Session Map tab keeps its own copy of a session's logs and grows it from the
`GET …/sessions/:sessionId/logs/delta` responses (see [session-logs-delta](session-logs-delta.md))
instead of re-downloading the whole session every poll. The merge must add every new line exactly
once, place new agents with their linkage, and fall back to a clean full state whenever the poll
was sent without a cursor. `toParseInputs` then turns that copy into the inputs the session log
parser and the map model take, keyed the same way the rest of the session view keys them.

## Code

- Implementation: `client/src/viewer/pages/repository/session-log/session-map/session-map-delta-merge.ts`
  (`emptyMapState`, `mergeSessionMapDelta`, `toParseInputs`). The caller is `useSessionMapData.ts`
  in the same folder.
- Twins: none. The `agent-` prefix stripping and the parent map reuse `stripAgentPrefix` and
  `buildAgentParentMap` from `session-log/log-parser.ts`.
- Test: `client/src/viewer/pages/repository/session-log/session-map/session-map-delta-merge.algo.test.ts`.

## Input and output

`mergeSessionMapDelta(prev, delta)` takes the previous state (or `null`) and one non-reload delta
and returns a new state: `rootArtisynLines`, `rootClaudeLines`, `subagents` (each
`{sessionId, parentSessionId, workflowRunId, logs}`), `subagentStats` keyed by sub-agent
`sessionId`, `workflows`, `cursor`, `liveness`, `serverTime`. A `reload: true` answer is never
merged; the caller restarts with an empty cursor.

## Rules

### Merge

1. **Base.** When `prev` is `null` or `prev.cursor` is `''`, the poll was sent without a cursor and
   the delta is a full snapshot: the base is `emptyMapState`. Otherwise the base is `prev`.
2. **Root lines.** `rootArtisynLines = base ++ delta.rootArtisynLines`, and the same for
   `rootClaudeLines`. The two lists are kept apart.
3. **Sub-agent appends.** For a sub-agent already in the base, its `subagentAppends` lines are
   appended to its `logs`. An append for a sub-agent the base does not hold is dropped: there is no
   linkage to place it with.
4. **New sub-agents.** A `newSubagents` entry for a sub-agent not in the base is added after the
   known ones, in delta order, with its linkage and full lines. An entry for a sub-agent the base
   already holds replaces it in place (its lines are the full body, never appended).
5. **Stats.** `subagentStats = {...base, ...delta.subagentStats}`: overwritten per key.
6. **Workflows.** `delta.workflows === null` keeps the base list; a list replaces it.
7. **Cursor, liveness, server time** are taken from the delta.

### Parse inputs (`toParseInputs`)

1. `main = rootArtisynLines ++ rootClaudeLines`, as `/logs` returns `main`.
2. `subagentLogs`: each sub-agent's `logs`, keyed by its `sessionId` without the `agent-` prefix.
3. `agentParentMap`: agent id → parent agent id, both without the prefix; `null` when
   `parentSessionId` is `null`.
4. `workflowRunIds`: agent id (no prefix) → `workflowRunId`, only for sub-agents that have one.

## Edge cases

- First poll (`prev` null): SMD-01. `prev.cursor === ''` also means a full snapshot, nothing
  doubled: SMD-11.
- Appends to the root lists: SMD-02; to a sub-agent: SMD-03; to an unknown sub-agent (dropped):
  SMD-06.
- A new sub-agent with linkage: SMD-04; a "new" entry for a known sub-agent replaces it: SMD-05.
- Stats overwritten per key: SMD-07.
- `workflows: null` keeps the list: SMD-08; a list replaces it: SMD-09.
- Cursor, liveness, server time replaced: SMD-10.
- Parse inputs (main order, prefix stripping, parent map, workflow run ids): SMD-12.

## Examples

Rows with `input.delta` merge one delta into `input.prev` (`null` = first poll). A state or delta
is written in short form: missing lists are empty, `stats` maps a sub-agent `sessionId` to its
`inputTokens` (the other stats fields are 0), `workflows` lists the runs' `toolUseId`s, a missing
delta `workflows` is `null`, a missing delta `cursor` is `next`, a missing state `cursor` is `''`.
`expected` lists only the state keys the row checks, in the same short form. Rows with
`input.parse` run `toParseInputs` on that state; `expected` holds the four maps as objects.

Rows (12): [`docs/algorithm-examples/session-map-delta-merge.json`](../../algorithm-examples/session-map-delta-merge.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Base is `prev` even when its cursor is `''`" -> SMD-11 (lines doubled).
- "A new entry for a known sub-agent is appended" -> SMD-05.
- "Stats replaced as a whole" -> SMD-07 (agent-x lost).
- "`workflows: null` clears the list" -> SMD-08.
- "Unknown appends create a sub-agent without linkage" -> SMD-06.
- "`subagentLogs` keyed with the `agent-` prefix" -> SMD-12.

## Where the result is visible

The Session Map tab: the main card and every agent card while the session is live; a new agent
appears on the next poll, already in its column.
