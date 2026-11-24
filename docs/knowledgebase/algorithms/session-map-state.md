---
type: "Algorithm"
title: "Session Map state"
description: "The Session Map tab builds its view of a session from the parts manifest and the loaded part bodies — the same pre-compressed parts every session tab reads — and turns it into the session log parser's and the map model's inputs."
tags: [algorithm]
generated: { by: "human:denistsyplakov", at: "2026-11-24T12:00:00+04:00" }
reviewed: no
reviewer: none
---

# Session Map state

## Purpose

The Session Map tab needs the whole session tree: the root's lines, every sub-agent's lines with
its linkage (parent, Workflow run, `.meta.json` labels), the sub-agent stats, the Workflow runs,
and whether the session is still live. It takes all of it from the session's log parts
(`GET …/logs/parts` and one gzip part per log), the data every other session tab reads, so a
large session costs the compressed parts once and the browser cache afterwards. It replaced the
`/logs/delta` merge (2026-11-24, task `2026-11-23-session-logs-streaming`): the delta's full
snapshot was one uncompressed document of the whole tree (55 MB for a 6-hour session).
`toParseInputs` then turns the state into the inputs the session log parser and the map model
take, keyed the same way the rest of the session view keys them.

## Code

- Implementation: `client/src/viewer/pages/repository/session-log/session-map/session-map-state.ts`
  (`emptyMapState`, `NOT_LIVE`, `buildSessionMapState`, `toParseInputs`). The caller is
  `useSessionMapData.ts` in the same folder; it receives the assembled logs of
  `useSessionLogParts` (the tab renders behind `AllSessionPartsGate`, so every part is loaded).
- Twins: none. The `agent-` prefix stripping and the parent map reuse `stripAgentPrefix` and
  `buildAgentParentMap` from `session-log/log-parser.ts`.
- Test: `client/src/viewer/pages/repository/session-log/session-map/session-map-state.algo.test.ts`.

## Input and output

`buildSessionMapState(manifest, logs, receivedAt)` takes the parts manifest, the assembled logs
(`assembleSessionLogs`: `main` = root artisyn ++ root claude, `subagents` = the loaded sub-agent
parts in manifest order) and the client time the manifest arrived. It returns `main`,
`subagents` (each `{sessionId, parentSessionId, workflowRunId, agentDescription, workflowPhase,
logs}`), `subagentStats` keyed by sub-agent `sessionId`, `workflows`, `liveness`
(`{hasOtel, live, lastActivityAt}`), `serverTime` and `receivedAt`.

## Rules

### Build

1. **Main.** `main` is the assembled `main`, unchanged.
2. **Sub-agents.** One entry per assembled sub-agent, in the assembled order; a sub-agent part the
   manifest lists but whose body is not loaded is not held. `parentSessionId`,
   `agentDescription` and `workflowPhase` come from the assembled entry (`null` when absent).
3. **Workflow run.** `workflowRunId` comes from the manifest part with the same `sessionId` and
   `logType` `claude-subagent`; no such part → `null`.
4. **Liveness and server time** come from the manifest. An older server's manifest has neither:
   `liveness` is `NOT_LIVE` (`{hasOtel: false, live: false, lastActivityAt: null}`, so the tab
   shows Replay) and `serverTime` is `''`.
5. **Stats and workflows** come from the manifest; `receivedAt` is passed through.

### Parse inputs (`toParseInputs`)

1. `main` is the state's `main`, as `/logs` returns it.
2. `subagentLogs`: each sub-agent's `logs`, keyed by its `sessionId` without the `agent-` prefix.
3. `agentParentMap`: agent id → parent agent id, both without the prefix; `null` when
   `parentSessionId` is `null`.
4. `workflowRunIds`: agent id (no prefix) → `workflowRunId`, only for sub-agents that have one.
5. `agentDescriptions`: agent id (no prefix) → `agentDescriptionText(agentDescription)` (the
   trimmed description), only for sub-agents whose description is not `null`, empty or
   whitespace-only.

## Edge cases

- A full tree with an unloaded sub-agent part, a Workflow agent and a nested agent: SMS-01.
- An older server's manifest without `liveness` / `serverTime`: SMS-02.
- A sub-agent whose only matching part is not a `claude-subagent` part, and one with no part:
  SMS-03.
- Parse inputs (main, prefix stripping, parent map, workflow run ids): SMS-04.
- `agentDescriptions` trimmed, blank and `null` descriptions skipped: SMS-05.

## Examples

Rows with `input.build` build a state. A manifest is written in short form: `parts` hold only the
fields a row sets (the rest default to `null`, `rev` to `r1`), `stats` maps a sub-agent
`sessionId` to its `inputTokens` (the other stats fields are 0), `workflows` lists the runs'
`toolUseId`s, a missing `liveness` is not live, a missing `serverTime` is a fixed time, and
`omitLiveness: true` drops both fields (an older server). `expected` lists only the state keys
the row checks, in the same short form. Rows with `input.parse` run `toParseInputs` on a state
with that `main` and those `subagents`; `expected` holds the five maps as objects.

Rows (5): [`docs/algorithm-examples/session-map-state.json`](../../algorithm-examples/session-map-state.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Unloaded sub-agent parts are held with empty lines" -> SMS-01 (agent-r appears).
- "`workflowRunId` taken from the assembled entry" -> SMS-01 (p loses wf-1).
- "Absent liveness stored as `undefined`" -> SMS-02.
- "`workflowRunId` matched by `sessionId` alone" -> SMS-03 (agent-p gets wf-x).
- "`subagentLogs` keyed with the `agent-` prefix" -> SMS-04.
- "Blank descriptions kept in `agentDescriptions`" -> SMS-05.

## Where the result is visible

The Session Map tab: the main card, every agent card and the LIVE / Replay badge. A live session
re-reads the manifest every `SESSION_MAP_POLL_MS`; a changed part is re-fetched and the next
state carries its lines, so a new agent appears without a reload.
