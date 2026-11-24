---
type: "Architecture Guide"
title: "Session Map Tab"
description: "The session view's Session Map tab (realtime and replay): the client data flow parts → state → parse → model, the live manifest poll, the legacy logs delta route kept for older clients, tool families and colours, grouping, time-position states, and the file list."
tags:
  - client
  - server
  - session-view
  - realtime
generated: { by: "claude-code", at: "2026-11-24T12:00:00+04:00" }
---

# Session Map Tab

The **Session Map** tab (tab id `session-map`, group `overview`, promoted after Agent Tree in the
"What happened" lens) draws one session as cards: a main card for the root session, one column per
workflow run, one column "Agents spawned by the main session", and a nested card for each sub-agent
of a sub-agent. A bottom timeline (tool-family bins, failures, cumulative cost) sets the **time
position** `t`; every card, counter and the side panel show the session as it was at `t`.

- **Realtime:** while the session is live the tab re-reads the parts manifest every 10 s and, by
  default, follows "now".
- **Replay:** a finished session is loaded once; Play / speeds / scrubbing move `t` over it.

Task: `docs/tasks/done/2026-11-01-session-map-tab/` (impl-plan Design Decisions are cited as DD-n).
Since 2026-11-24 (task `2026-11-23-session-logs-streaming`) the tab reads the session's log parts
instead of `/logs/delta`: the delta's first answer was one uncompressed document of the whole tree
(55 MB, ~40 s on a Raspberry Pi for a 6-hour session), the parts are pre-compressed and cached.

## Data flow

```
manifest + every part  →  assembleSessionLogs  →  buildSessionMapState  →  toParseInputs  →  parseSessionLogs  →  buildSessionMapModel
 (useSessionLogParts,      (SessionLogsData)       (SessionMapState)        (main, subagentLogs,  (ParsedSession)     (nodes, columns,
  shared with all tabs)                                                      agentParentMap, …)                       timeline bins)
                                                                                                                         ↓
                                                                                     stateAt / countersAt / highlightSet at time t
```

- `SessionTabContent` renders the tab behind `AllSessionPartsGate` with `keepOnceLoaded` (keyed by
  session): it asks for every part, shows "Loading session logs n of m" until all are in, and then
  keeps the Map on screen while the parts a live session adds later load, so a new agent never
  unmounts the tab and its playback position.
- `useSessionMapData` gets the assembled logs (`logsQuery.data`) as a prop and observes the
  manifest query itself (same key `['session-logs', repoId, sessionId, teamId]` and fetcher as
  `useSessionLogParts`) for `liveness`, `serverTime` and the live interval.
- Algorithm and examples: [`algorithms/session-map-state.md`](algorithms/session-map-state.md).

### Liveness in the parts manifest

`GET …/logs/parts` carries `liveness` (`computeOtelLiveness(otel_session_state, now)` from
`server/src/logs/otel/otel-facts.reader.ts`, the same rule as the OTEL tab's `live`, see
[`otel-tabs.md`](otel-tabs.md#realtime-states-dd-14-dd-15)) and `serverTime` (ISO, when the
manifest was built), set in `SessionLogPartsService.buildManifest`. Without OTEL data
(`hasOtel: false`) a session is never live, so the tab shows it as replay. A manifest from an older
server has neither field: the client treats it as not live.

### Legacy: `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta`

No current client calls it; the route stays, unchanged, for an SPA bundle cached from an older
release. Route row and response shape: [`server-endpoint-map.md`](server-endpoint-map.md).
Algorithm and examples: [`algorithms/session-logs-delta.md`](algorithms/session-logs-delta.md).

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
- **Streaming.** `SessionLogsDeltaService.prepareDelta` decides everything from metadata before the
  first byte: `readSliceMeta` gives per row the length and the fingerprints computed in SQL, with no
  lines; the stale and growth checks, stats, workflows and the next cursor follow. A `reload` answer
  is plain JSON. Any other answer is streamed by `writeDelta` under the same per-worker
  `LogStreamLimiter` as `/logs`, in the former key order (`reload, rootArtisynLines,
  rootClaudeLines, subagentAppends, newSubagents, subagentStats, workflows, liveness, serverTime,
  cursor`). Each `lines` / `logs` value is one row's raw `jsonb_agg(…)::text` slice
  (`readSliceText`, lines `(prevN, len]` bounded by the metadata's length so the cursor stays
  exact), never parsed by the server. A row rewritten between the two reads aborts the response;
  the next poll recovers.
- **`subagentStats`** entries carry the same keys as `/logs`, ending with `cacheWrite5mTokens` /
  `cacheWrite1hTokens`.
- **Workflows** are re-read — stored `session_stats.workflows` (`readStoredWorkflows`), else parsed from
  the root claude body — and re-linked (`resolveWorkflowAgentLinkage`, `server/src/logs/workflow-linkage.ts`)
  only when the root `claude` row or the agent set changed; otherwise `workflows: null` (keep the old
  list).
- **Liveness** is `computeOtelLiveness(otel_session_state, now)` from
  `server/src/logs/otel/otel-facts.reader.ts` — the same rule as the OTEL tab's `live`
  ([`otel-tabs.md`](otel-tabs.md#realtime-states-dd-14-dd-15)). Without OTEL data (`hasOtel: false`)
  a session is never live, so the tab shows it as replay.

### Client: state, parse, model

- `buildSessionMapState(manifest, logs, receivedAt)` (`session-map-state.ts`) holds `main` (root
  artisyn ++ claude), the loaded sub-agents with their linkage (`parentSessionId`, `workflowRunId`
  from the agent's manifest part) and meta (`agentDescription`, `workflowPhase`), the stats and
  workflows of the manifest, `liveness`, `serverTime` and `receivedAt` (the manifest's
  `dataUpdatedAt`). It is rebuilt whenever the manifest or a part body changes. Examples:
  [`algorithms/session-map-state.md`](algorithms/session-map-state.md).
- `toParseInputs(state)` gives `parseSessionLogs` the same inputs `/logs` would: `main` =
  `artisyn ++ claude`, `subagentLogs` keyed **without** the `agent-` prefix, `agentParentMap`,
  `subagentStats`, `workflows`, plus a `workflowRunId` map for grouping and `agentDescriptions`
  (`Map<bareAgentId, string>`, only non-empty `agentDescriptionText` values). `harnessSnapshot` is `null`.
- `buildSessionMapModel(parsed, inputs, pricing, {live, serverTimeMs})` (`session-map-model.ts`)
  builds the nodes (cost, share, family counts, top tools, calls, failures, peak context, first /
  last activity, finished flag, per-call events), the columns (`groupAgents`) and the timeline bins.
  It is memoised on the state, so a scrub never rebuilds it. Examples:
  [`algorithms/session-map-model.md`](algorithms/session-map-model.md).
- Per `t`: `stateAt` (future / running / done), `countersAt` (elapsed, failed, calls, agents
  started / total, cost so far / total), `highlightSet` (top 5 by cost, or agents with failures),
  `orderAgents` (by start or by cost).

## Live poll and refresh

- **Live poll.** While `liveness.live`, `useSessionMapData`'s manifest observer has
  `refetchInterval: SESSION_MAP_POLL_MS` (10 s). A part whose revision changed is re-fetched by
  `useSessionLogParts` (gzip, one part); unchanged parts are not. TanStack does not refetch on an
  interval while the page is hidden, and the poll stops once the session is no longer live.
- **Watermark.** The silent refetch of `useRepositoryData` (the session's end-time watermark moved)
  runs on this tab as on every other: it re-reads only the manifest.
- **Errors:** a failed refetch keeps the last good state and shows "update failed" in the header.
  With no state yet the session-logs error panel is shown.
- **Refresh button:** the pane's Refresh invalidates the manifest, as on every tab.

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

## Layout and panning

- The tab fills the height of the session pane (`h-full`): the header and the timeline stay in
  view, the cards between them are the **canvas** (`data-testid="session-map-canvas"`), which
  takes the remaining height (at least 280 px; on a shorter pane the pane itself scrolls).
- The canvas scrolls both ways (scrollbars, wheel, keyboard) and pans with a mouse drag — the
  shared `useDragScroll` hook (`viewer/hooks/useDragScroll.ts`, also used by Agent Tree). A drag
  starts after 4 px, so a plain click still selects a card; the click that ends a drag is swallowed
  by the hook's `onClickCapture`; a press on a native scrollbar is left to the scrollbar.
- The main card is `sticky left-0` with the canvas width (`100cqw`; the canvas is a size
  container), so it stays in view while the columns pan sideways. Column headers are `sticky top-0`.
- The side panel scrolls on its own next to the canvas.

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
| `session-map-state.ts` | Pure: `SessionMapState`, `emptyMapState`, `NOT_LIVE`, `buildSessionMapState`, `toParseInputs` |
| `session-map-model.ts` | Pure: `toolFamily`, `perCallCosts`, `groupAgents`, `buildTimeline`, `buildSessionMapModel`, `stateAt`, `countersAt`, `highlightSet`, `orderAgents`, `columnRows` |
| `session-map-format.ts` | Cost, elapsed, clock and share formatting |
| `useSessionMapData.ts` | Manifest observer with the live interval, state, parse and model |
| `useSessionMapPlayback.ts` | `t`, following, play / pause, speed, End, Live (DD-18) |
| `useSessionMapSelection.ts` | `smSel` URL param |
| `SessionMapTab.tsx` | Container: layout, the pannable canvas, highlight / order, error states, render mark |
| `SessionMapHeader.tsx` | Badge, first prompt, five counters, Highlight / Order selects, `ZoneLegend` |
| `SessionMapCards.tsx`, `SessionMapAgentCard.tsx` | Main card, group columns, agent cards (cost bar, `MixBar`, top tools, failed badge, context bar) |
| `SessionMapSidePanel.tsx` | Metrics, family / failed chips, call log, `ToolCallDetailModal` |
| `SessionMapTimeline.tsx` | SVG bins, failure ticks, cost line, ticks, marker, scrub, play controls, legend |

Wiring outside the folder: `viewer/tab-ids.ts` (tab row), `session-lenses.ts` (lens promotion),
`session-lazy-tabs.ts` / `session-tabs-lazy-group.ts` (shared lazy chunk), `SessionTabContent.tsx`
(renders the tab behind `AllSessionPartsGate`), `session-parts/useSessionLogParts.ts` (the parts),
`viewer/api.ts` (`SessionLogPartsManifest.liveness` / `serverTime`, `SessionLiveness`).

Server, `server/src/logs/`: `session-log-parts.service.ts` (`buildManifest`: `liveness`,
`serverTime`). Legacy delta route: `session-logs-delta.ts` (pure cursor codec, `classifyDeltaRows`,
`checkGrowth`), `session-logs-delta.service.ts` (`SessionLogsDeltaService.getDelta`, shared
`selectSubagentStats`), `dto/session-logs-delta.dto.ts`, `session-logs-access.ts`,
`workflow-linkage.ts`, `otel/otel-facts.reader.ts` (`computeOtelLiveness`), route
`getSessionLogsDelta` in `repositories.controller.ts`.

User help: `user-docs/session-log.md` § Session Map.
