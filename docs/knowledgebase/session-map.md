---
type: "Architecture Guide"
title: "Session Map Tab"
description: "The session view's Session Map tab (realtime and replay): the logs delta route and its cursor, the client data flow delta → merge → parse → model, polling and reload, the suspended /logs watermark refetch, tool families and colours, grouping, time-position states, and the file list."
tags:
  - client
  - server
  - session-view
  - realtime
timestamp: "2026-11-03T00:00:00+04:00"
---

# Session Map Tab

The **Session Map** tab (tab id `session-map`, group `overview`, promoted after Agent Tree in the
"What happened" lens) draws one session as cards: a main card for the root session, one column per
workflow run, one column "Agents spawned by the main session", and a nested card for each sub-agent
of a sub-agent. A bottom timeline (tool-family bins, failures, cumulative cost) sets the **time
position** `t`; every card, counter and the side panel show the session as it was at `t`.

- **Realtime:** while the session is live the tab polls a delta route every 10 s and, by default,
  follows "now".
- **Replay:** a finished session is loaded once; Play / speeds / scrubbing move `t` over it.

Task: `docs/tasks/todo/2026-11-01-session-map-tab/` (impl-plan Design Decisions are cited as DD-n).

## Data flow

```
GET …/logs/delta?cursor=  →  mergeSessionMapDelta  →  toParseInputs  →  parseSessionLogs  →  buildSessionMapModel
   (server, per poll)          (SessionMapState)       (main, subagentLogs,   (ParsedSession)     (nodes, columns,
                                                         agentParentMap, …)                         timeline bins)
                                                                                                        ↓
                                                                    stateAt / countersAt / highlightSet at time t
```

The tab does **not** use the `/logs` payload of `useRepositoryData`; it keeps its own state.

### Server: `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta`

Route row and response shape: [`server-endpoint-map.md`](server-endpoint-map.md). Algorithm and
examples: [`algorithms/session-logs-delta.md`](algorithms/session-logs-delta.md).

- **Access** is the same chain as `/logs` (`resolveSessionLogsAccess`,
  `server/src/logs/session-logs-access.ts`), so both routes answer 403 / 404 identically.
- **Cursor v1** is opaque base64url JSON, one entry per `(session, log_type)` row:
  `[sid, type, updated_at µs, line count, fingerprint]`. A missing, broken or oversized cursor
  (`DELTA_CURSOR_MAX_CHARS` = 12 000) means "full snapshot". When the next cursor would be longer
  than that, the server returns `cursor: ''` and the next poll is a full snapshot again.
- **Rows** are classified by `classifyDeltaRows` (unchanged / changed / new / stale). Only changed
  and new rows have their body read, so an empty poll never reads `logs.body`. A changed row is
  checked with `checkGrowth` (line count must not shrink, the fingerprint of the last known line must
  match); otherwise the answer is `200 {reload: true}`.
- **Workflows** are re-extracted (`resolveWorkflowAgentLinkage`, `server/src/logs/workflow-linkage.ts`)
  only when the root `claude` row or the agent set changed; otherwise `workflows: null` (keep the old
  list).
- **Liveness** is `computeOtelLiveness(otel_session_state, now)` from
  `server/src/logs/otel/otel-facts.reader.ts` — the same rule as the OTEL tab's `live`
  ([`otel-tabs.md`](otel-tabs.md#realtime-states-dd-14-dd-15)). Without OTEL data (`hasOtel: false`)
  a session is never live, so the tab shows it as replay.

### Client: merge, parse, model

- `mergeSessionMapDelta(prev, delta)` (`session-map-delta-merge.ts`) appends root artisyn / claude
  lines and sub-agent lines, adds new sub-agents with their linkage (`sessionId`,
  `parentSessionId`, `workflowRunId`) and meta (`agentDescription`, `workflowPhase`: `string | null`,
  from `newSubagents[]`; `null` from an older server), replaces stats, keeps the old `workflows` on
  `null`, and stores `cursor`, `liveness`, `serverTime` and `receivedAt`. A poll sent with an empty
  cursor replaces the state. The initial load is itself a delta from cursor 0, so `mergeSubagents`
  is the single place the meta enters, for the first load and for live arrivals. Examples:
  [`algorithms/session-map-delta-merge.md`](algorithms/session-map-delta-merge.md).
- **Live meta for known agents (DD-15).** `subagentAppends[]` entries also carry `agentDescription` /
  `workflowPhase`. The server pushes an append with `lines: []` when a changed sub-agent has no new
  lines but non-null meta (a meta-only re-upload still bumps `logs.updated_at`). `mergeSubagents`
  copies a non-null append value onto the known `SessionMapSubagent` and never clears a stored value
  with `null`; an empty-lines entry changes only the meta. An older client already skips
  empty-line appends.
- `toParseInputs(state)` gives `parseSessionLogs` the same inputs `/logs` would: `main` =
  `artisyn ++ claude`, `subagentLogs` keyed **without** the `agent-` prefix, `agentParentMap`,
  `subagentStats`, `workflows`, plus a `workflowRunId` map for grouping and `agentDescriptions`
  (`Map<bareAgentId, string>`, only non-empty `agentDescriptionText` values). `harnessSnapshot` is `null`.
- `buildSessionMapModel(parsed, inputs, pricing, {live, serverTimeMs})` (`session-map-model.ts`)
  builds the nodes (cost, share, family counts, top tools, calls, failures, peak context, first /
  last activity, finished flag, per-call events), the columns (`groupAgents`) and the timeline bins.
  It is memoised on the merged state, so a scrub never rebuilds it. Examples:
  [`algorithms/session-map-model.md`](algorithms/session-map-model.md).
- Per `t`: `stateAt` (future / running / done), `countersAt` (elapsed, failed, calls, agents
  started / total, cost so far / total), `highlightSet` (top 5 by cost, or agents with failures),
  `orderAgents` (by start or by cost).

## Polling and reload

`useSessionMapData` drives the poll through the shared `useOtelLivePoll`
(`pages/repository/otel/useOtelLivePoll.ts`, unchanged): interval `SESSION_MAP_POLL_MS` (10 s),
`isLive = state.liveness.live`, `resetKey = repoId|sessionId|teamId|reloadGen`. The hook brings the
visible-page / idle-stop rules, catch-up on return, `refresh()` and the `hidden` / `idle` indicator
("LIVE · updates paused" in the header).

- **Reload** (`{reload: true}`): `reloadGen` is bumped (new `resetKey` → one empty-cursor snapshot)
  and the `['session-logs', repoId, sessionId, teamId]` query is invalidated. The last good state
  stays on screen until the snapshot arrives; "following now" is kept, otherwise `t` is clamped to
  the new end.
- **Errors:** a failed poll keeps the last good state and shows "update failed" in the header. With
  no state yet the session-logs error panel is shown. A 403 / 404 drops the state and stops polling
  until the session or team changes.
- **Refresh button:** `SessionMapTab` registers its `refresh` with `SessionDetailPane`
  (`registerRefresh`); while the Map tab is open the pane's refresh button polls the delta instead of
  invalidating `/logs`.

## Watermark suspension

`useRepositoryData` normally refetches `/logs` silently whenever the selected session's end-time
watermark moves (each hook upload). With `suspendSilentLogsRefetch` — passed by `RepositoryView` as
`sessionTab === 'session-map'` — both watermark effects skip, so `seenEndTimeRef` keeps the old
value. Leaving the tab re-runs the effect (the flag is in its dependency list) and `/logs` is fetched
once. This keeps a realtime Map from downloading the whole payload on every upload.

## Tool families

One table, `FAMILIES` in `session-map.constants.ts`, matched by tool name in this order:

| family | label | tools | colour |
|---|---|---|---|
| `explore` | Read · Grep · Glob | `Read`, `Grep`, `Glob`, `LS`, `WebFetch`, `WebSearch` | `#0ea5e9` |
| `edit` | Edit · Write | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `#10b981` |
| `shell` | Bash · PowerShell | `Bash`, `PowerShell`, `Monitor`, `BashOutput`, `KillShell` | `#f59e0b` |
| `mcp` | MCP | name starts with `mcp__` | `#8b5cf6` |
| `orch` | Skill · Agent · Workflow | `Skill`, `Agent`, `Task`, `Workflow`, `ToolSearch`, `TaskStop`, `CronCreate`, `CronDelete` | `#ec4899` |
| `other` | other | anything else | `#94a3b8` |

- A failed call (status `error` or `rejected`, `classifyToolOutcome`) is red `#ef4444`.
- Cumulative cost line `#2563eb`; context bar `#64748b`; the cost bar uses `zoneColor` and
  `ZoneLegend` from `analytics/` (imported, not copied).

## Grouping and states (summary)

- An **agent** is a `claude-subagent` session whose id starts with `agent-`. An agent whose parent
  is another agent is nested under it; otherwise an agent with a `workflowRunId` goes to the column
  of that workflow run (a still-running run gets a column keyed by `workflowRunId`, labelled from
  the k-th running `WorkflowRun`, or "workflow run"); otherwise it goes to "Agents spawned by the
  main session" (always last). Workflow columns are ordered by their earliest agent start.
- **Card label:** `agentRowLabel({agentId, prompt, agentDescription: inputs.agentDescriptions.get(agentId)})`
  — the `.meta.json` description (hook `2.31.0`+) first, else the cleaned prompt, else the agent
  id — then `truncateLabel`. The phase is not shown on the Map (only in the Agents table, see
  [session-log-view.md](session-log-view.md) § "Sub-agent meta labels").
- **Per-call cost:** an agent's priced total (its `subagentStats` row, else transcript tokens) is
  spread over its assistant messages by their own priced usage, split evenly over the message's
  `tool_use` blocks; the cumulative line ends at the tree cost.
- **States at `t`:** future (`t < f`), running (`f ≤ t ≤ l`, or in realtime at "now" while the
  session is live and the agent not finished), done.
- Full rules and examples: [`algorithms/session-map-model.md`](algorithms/session-map-model.md).

## URL state and playback

- Selected card → `smSel` URL param (`main`, `group:<key>` or the agent id), `replace: true`;
  deleted when the tab unmounts; an unknown id is ignored (`useSessionMapSelection.ts`).
- `useSessionMapPlayback`: speeds 1× / 10× / 60× / 300× (default 60×), `requestAnimationFrame`
  playback, End, Live. In realtime `following` pins `t` to
  `serverTime + (Date.now() − receivedAt)`, updated every second; any scrub stops following.
- Render budget: `performance.mark` / `measure` `session-map:render` in `SessionMapTab`, ≤ 100 ms
  (visual check only).

## Files

Client, `client/src/viewer/pages/repository/session-log/session-map/`:

| File | Role |
|---|---|
| `session-map.constants.ts` | Poll interval, bins, ticks, speeds, highlight size, `FAMILIES`, colours, layout sizes |
| `session-map-delta-merge.ts` | Pure: `SessionMapState`, `emptyMapState`, `mergeSessionMapDelta`, `toParseInputs` |
| `session-map-model.ts` | Pure: `toolFamily`, `perCallCosts`, `groupAgents`, `buildTimeline`, `buildSessionMapModel`, `stateAt`, `countersAt`, `highlightSet`, `orderAgents`, `columnRows` |
| `session-map-format.ts` | Cost, elapsed, clock and share formatting |
| `useSessionMapData.ts` | Delta poll, merge, reload, parse and model (DD-10, DD-12) |
| `useSessionMapPlayback.ts` | `t`, following, play / pause, speed, End, Live (DD-18) |
| `useSessionMapSelection.ts` | `smSel` URL param |
| `SessionMapTab.tsx` | Container: layout, highlight / order, `registerRefresh`, error states, render mark |
| `SessionMapHeader.tsx` | Badge, first prompt, five counters, Highlight / Order selects, `ZoneLegend` |
| `SessionMapCards.tsx`, `SessionMapAgentCard.tsx` | Main card, group columns, agent cards (cost bar, `MixBar`, top tools, failed badge, context bar) |
| `SessionMapSidePanel.tsx` | Metrics, family / failed chips, call log, `ToolCallDetailModal` |
| `SessionMapTimeline.tsx` | SVG bins, failure ticks, cost line, ticks, marker, scrub, play controls, legend |

Wiring outside the folder: `viewer/tab-ids.ts` (tab row), `session-lenses.ts` (lens promotion),
`session-lazy-tabs.ts` / `session-tabs-lazy-group.ts` (shared lazy chunk), `SessionTabContent.tsx`
(renders the tab), `SessionDetailPane.tsx` (refresh routing), `useRepositoryData.ts` / `RepositoryView.tsx` (watermark
suspension), `viewer/api.ts` (`SessionLogsDeltaData`, `fetchSessionLogsDelta`).

Server, `server/src/logs/`: `session-logs-delta.ts` (pure cursor codec, `classifyDeltaRows`,
`checkGrowth`), `session-logs-delta.service.ts` (`SessionLogsDeltaService.getDelta`, shared
`selectSubagentStats`), `dto/session-logs-delta.dto.ts`, `session-logs-access.ts`,
`workflow-linkage.ts`, `otel/otel-facts.reader.ts` (`computeOtelLiveness`), route
`getSessionLogsDelta` in `repositories.controller.ts`.

User help: `user-docs/session-log.md` § Session Map.
