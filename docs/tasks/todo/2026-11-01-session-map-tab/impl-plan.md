# Implementation plan — 2026-11-01 Session Map Tab (Realtime and Replay)

## TL;DR

- **New API route:** `GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta?cursor=&teamId=`. It is additive and `/logs` is unchanged. It uses an opaque base64url cursor v1 (one entry per `(session, log_type)` row). A stale cursor gets `200 {reload:true}`.
- **Empty poll:** the access check, the session-tree walk, the `logs` row metadata (`updated_at`) and one `otel_session_state` row. It never reads `logs.body`.
- **New server modules:**
  - `session-logs-access.ts` (`resolveSessionLogsAccess`, the `/logs` access chain extracted from the controller).
  - `workflow-linkage.ts` (`resolveWorkflowAgentLinkage`, the BFS extracted from the controller).
  - `session-logs-delta.ts` (pure: `encodeDeltaCursor`, `decodeDeltaCursor`, `classifyDeltaRows`, `checkGrowth`).
  - `session-logs-delta.service.ts` (`SessionLogsDeltaService.getDelta`, plus the shared `selectSubagentStats`).
  - DTO `dto/session-logs-delta.dto.ts`.
  - `/logs` is refactored onto the extracted helpers with no behaviour change.
- **OTEL reader:** `isRecent` becomes exported and gains `computeOtelLiveness(state, now)`. The delta returns only `{live, lastActivityAt}`, no OTEL figures.
- **New client feature folder** `client/src/viewer/pages/repository/session-log/session-map/`:
  - Pure modules: `session-map-delta-merge.ts`, `session-map-model.ts`, `session-map.constants.ts`.
  - Hooks: `useSessionMapData`, which reuses `useOtelLivePoll` unchanged, and `useSessionMapPlayback`.
  - Components: `SessionMapTab`, `SessionMapHeader`, `SessionMapCards`, `SessionMapSidePanel`, `SessionMapTimeline`. All are hand-written SVG/HTML, with no new chart library.
- **New tab `session-map`:** in `tab-ids.ts` (group `overview`), promoted after `agent-tree` in the "What happened" lens, lazy through the shared `session-tabs-lazy-group` chunk, so no new lazy chunk.
- **Client API:** `SessionLogsDeltaData` and `fetchSessionLogsDelta` are added in `api.ts`.
- **Changed behaviour:**
  - `useRepositoryData` holds back its silent watermark refetch of `/logs` while the Map tab is open, and catches up when the user leaves the tab (Design Decision 11).
  - The `SessionDetailPane` refresh button triggers the Map's own poll while the Map tab is open.
  - A new `smSel` URL param holds the selected card.
- **Perf:** `npm run perf` baseline before the change and a comparison after it (Design Decision 23).
- **Three new algorithm docs, each with its table test:**
  - `session-logs-delta.md` (server)
  - `session-map-delta-merge.md` (client)
  - `session-map-model.md` (client)
- **Existing algorithm doc changed:** `session-lens-row.md` rows.
- **Docs:**
  - a new KB article `session-map.md`;
  - updates to `api-reference.md`, `server-endpoint-map.md`, `otel-tabs.md`, `session-log-view.md`, `client-component-map.md` and `index.md`;
  - a "Session Map" section in the user help `user-docs/session-log.md`.
- **DB changes:** none. No hook or ingest change.

## Reference

- Requirements: [requirements.md](requirements.md)
- Wireframes: [replay](wireframes/session-map-replay.svg), [realtime](wireframes/session-map-realtime.svg), [cards](wireframes/session-map-cards.svg)
- PoC: `docs/pocs/2026-11-01-2253-session-map-2d/index.html`
- Research archive: `research/findings-1.md`

## Design Decisions

1. **Route placement.** The delta route lives in `RepositoriesController` (`server/src/logs/repositories.controller.ts`) next to `getSessionLogs` (line 1691). The controller stays thin: it calls `resolveSessionLogsAccess`, then `SessionLogsDeltaService.getDelta`.

2. **Shared access chain.** Lines 1699–1800 of `getSessionLogs` move verbatim into `resolveSessionLogsAccess(db, repositoriesService, user, repoId, sessionId, teamId)` in `server/src/logs/session-logs-access.ts`. This covers the teamId validation, `assertRepoAccess`, `resolveRepoIds`, the artisyn-linked non-deleted session check (404) and the owner / team-owner / restricted / transparent rule (403).
   - It returns `{ repo, sessionRowId, harnessSnapshotId, ownerUserId }`.
   - `/logs` and `/logs/delta` both call it, so the errors are identical by construction.

3. **Shared workflow linkage.** Lines 1975–2011 (the `wfId` → agents BFS, with the `agent-` prefix guard) move into `resolveWorkflowAgentLinkage(workflows, rows)` in `server/src/logs/workflow-linkage.ts`.
   - `rows` is `{subSessionId, parentSessionId, workflowRunId}[]`.
   - The function mutates `agentSessionIds` exactly as today.
   - `/logs` and the delta call it with the same rows.

4. **Cursor v1.** The cursor is `base64url(JSON.stringify({ v: 1, r: [[sid, t, ut, n, fp], …] }))`.
   - `sid` is the internal `sessions.id` (number) and `t` is the log type code: `a` = artisyn, `c` = claude, `s` = claude-subagent.
   - `ut` is `logs.updated_at` as epoch microseconds in base 36. It comes from SQL `floor(extract(epoch from updated_at) * 1000000)::bigint`, because a JS `Date` truncates `timestamptz` µs.
   - `n` is the line count and `fp` is the fingerprint (Design Decision 5).
   - A decode error, an unknown `v`, a non-array `r` or an input longer than `DELTA_CURSOR_MAX_CHARS` (12 000, in `session-logs-delta.ts`) is treated as an empty cursor: the server returns a full snapshot, following the OTEL cursor DD-2 precedent.
   - Every field is compact: `sid` and `ut` are base 36 and `fp` is 12 characters, which comes to about 30 characters per row.
   - When the next cursor would encode longer than `DELTA_CURSOR_MAX_CHARS`, the server returns `cursor: ''`. That is several hundred agents; the limit keeps the URL under Node's 16 KB header limit.
   - The client treats `cursor: ''` as "the next poll is a full snapshot". This degrades gracefully, and no request ever fails with 400.

5. **Fingerprint.** The fingerprint is `left(md5((body -> (n-1))::text), 12)`, computed in SQL. The same expression is used when the cursor is issued and when it is checked. It is always a hash, never the raw `uuid`, so artisyn lines without a `uuid` need no special case.
   - An empty body has `n = 0` and `fp = ''`.

6. **Row classification** is the pure function `classifyDeltaRows(cursorRows, currentRows, treeSessionIds)`. `currentRows` is `{sid, t, ut}` metadata only. Each row falls into exactly one bucket:
   - **unchanged:** same `ut`. Body not read.
   - **changed:** different `ut`. Read the slice and check the fingerprint.
   - **new:** in the tree, not in the cursor. Read in full.
   - **stale:** in the cursor but its `sid` is no longer in the tree, or the row is gone. Answer `reload`.

   After reading a changed row, the service applies `checkGrowth(prevN, prevFp, newLen, fpAtPrevN)`:
   - `newLen < prevN` → stale (`reload`).
   - `fpAtPrevN !== prevFp` → stale (`reload`).
   - otherwise → return `body[prevN:]`.

   The empty-poll guarantee ("no `logs.body` read") is that the service reads bodies only for the `changed` and `new` lists, which are empty when nothing moved. That property is pinned in the algorithm doc rows.

7. **Delta SQL per poll.** These run in order after access:
   - (a) `getDescendantSessionIds(db, [sessionRowId])` (`server/src/logs/session-tree.sql.ts:101`), metadata only.
   - (b) Metadata of every tree row, with no body. Shape: `SELECT s.id, s.session_id, s.parent_session_id, s.workflow_run_id, l.log_type, <ut µs> FROM sessions s JOIN logs l ON l.session_id = s.id WHERE …`.
     - The root contributes its `artisyn` and `claude` rows.
     - A descendant contributes only its `claude-subagent` row, the same rule as `/logs` (`repositories.controller.ts:1862-1879`).
     - A descendant's own `claude` row is never selected.
     - A descendant session without a `claude-subagent` row is left out until its row appears; it then shows up as `new`. `/logs` also drops it (`bodyText !== null` filter).
     - These rows are also the linkage input to `resolveWorkflowAgentLinkage` in step (f).
   - (c) Only for changed and new rows: `jsonb_array_length(body)`, the fingerprint at `prevN` and at `len`, and the slice `SELECT e.line FROM jsonb_array_elements(body) WITH ORDINALITY e(line, i) WHERE i > prevN ORDER BY i`.
   - (d) `subagentStats` rows for the new and changed sub-agent sessions only, using the same select and `EXISTS` guard as `/logs` (`repositories.controller.ts:1880-1924`). The select is extracted into a helper in `session-logs-delta.service.ts` and reused by `/logs`.
   - (e) `otel_session_state` by root `sessions.id`.
   - (f) Only when the root `claude` row is changed or new, or when a new descendant session appeared: a full parse of the root `claude` body, then `extractWorkflows` and `resolveWorkflowAgentLinkage`, giving the full `workflows` list. Otherwise `workflows: null`.

   A missing root `claude` row gives 404 `Session logs not found`, as `/logs` does.

   The service is `@Injectable()`. It gets the drizzle `db` injected exactly as `RepositoriesController` does, and has the signature `getDelta(sessionRowId: number, cursor: string | undefined, now: Date)`; the controller passes `new Date()`. From the `resolveSessionLogsAccess` result it uses only `sessionRowId`. The harness snapshot, `rootStats`, the advisor and attribution are not part of the delta.

8. **Response shape** (also in API changes): new lines per known log, full new logs with `sessions` linkage (`sessionId`, `parentSessionId`, `workflowRunId`), `subagentStats`, `workflows | null`, `liveness`, `serverTime`, `cursor`.
   - The delta's sub-agent linkage includes `workflowRunId`, which `/logs` does not expose. The Map needs it to place agents of a still-running workflow run (Design Decision 14).
   - The root session's own lines come back as `rootArtisynLines` and `rootClaudeLines`. The client keeps each list separately and parses `artisyn ++ claude`, as `/logs` does.

9. **Liveness.** `computeOtelLiveness(state, now)` is added to `server/src/logs/otel/otel-facts.reader.ts`, with `isRecent` exported. It returns:
   - `live = isRecent(rtLastAt) || isRecent(chunkLastAt)` within `OTEL_SESSION_ENDED_MS` (`otel-facts.constants.ts:10`, 600 000 ms);
   - `lastActivityAt = max(rtLastAt, chunkLastAt)` as ISO, or `null`;
   - `hasOtel` is false when there is no state row, and then `live` is false.

   `buildOtelSessionStatus` reuses the helper for its `live` field, so the rule stays defined once.

10. **Client polling** reuses `useOtelLivePoll` (`client/src/viewer/pages/repository/otel/useOtelLivePoll.ts`) unchanged:
    - `intervalMs = SESSION_MAP_POLL_MS` (10 000).
    - `isLive = s => s.liveness.live`.
    - `resetKey = repoId|sessionId|teamId|reloadGen`.
    - The poll step returns `{ state: merged, newKeys: EMPTY_OTEL_NEW_KEYS, filled: NO_OTEL_FILLED }`.

    The hook already provides the visible-page and idle-stop (`OTEL_IDLE_STOP_MS`) rules, the catch-up on return and input, `refresh()` and the `ended` indicator.

    **Merge rule:**
    - A poll sent with an empty cursor (`prev === null`, or `prev.cursor === ''`) replaces the state with `mergeSessionMapDelta(emptyMapState, delta)`.
    - Any other poll merges into the previous state.

    **Header refresh:** `SessionMapTab` takes a prop `registerRefresh(fn: (() => void) | null)`, calls it with the hook's `refresh` on mount and with `null` on unmount. `SessionDetailPane` keeps it in a `useRef`. Its refresh button (`SessionDetailPane.tsx:258-275`) normally runs an inline `queryClient.invalidateQueries({queryKey:['session-logs', repoId, sessionId, teamId]})`. While `sessionTab === 'session-map'` and a function is registered, it calls that function instead.

    **Request mapping:** `fetchSessionLogsDelta` omits the `cursor` query parameter when the cursor is `null` or `''`, and sends `encodeURIComponent(cursor)` otherwise.

    **Poll errors:** a failed poll keeps the last good state, and `useOtelLivePoll` exposes `error`.
    - Before any state exists, the tab shows the session-logs error panel (`session-log/session-logs-error.ts`).
    - With state, an error shows a small "update failed" note in the header and polling continues.
    - A 403 or 404 drops the state and shows the error panel; the hook's `enabled` becomes false until `resetKey` changes.

    `SESSION_MAP_POLL_MS` is client-only; no server value has to match it.

    **Parse inputs** (`toParseInputs`):
    - `subagentLogs` keyed by the agentId **without** the `agent-` prefix (`stripAgentPrefix`), the same keying as `useRepositoryData.ts:304-313`;
    - `agentParentMap` from `buildAgentParentMap`;
    - `parseSessionLogs` is called with `{repoConfig, subagentStats, workflows, subagentLogs, pricing, harnessSnapshot: null}`.

    The Map does not use `rootStats`, which holds productivity counters only.

11. **Watermark poll.** `useRepositoryData` gets a `suspendSilentLogsRefetch` flag, true while `sessionTab === 'session-map'`.
    - While the flag is true, the effect at `useRepositoryData.ts:193-212` skips the invalidate. `seenEndTimeRef` stays at the old value. The flag is added to that effect's dependency list (`[selectedSession, currentWatermark, queryClient, repoId, teamId, suspendSilentLogsRefetch]`), so leaving the tab re-runs the effect and refetches `/logs` once.
    - The `seenEndTimeRef` update effect (lines 239-248) also skips while the flag is true, so the old watermark is kept.
    - Reason: this keeps the realtime Map from re-downloading the whole payload on every hook upload.

12. **Reload signal.** On `{reload:true}`, `useSessionMapData`:
    - bumps `reloadGen`, so `resetKey` changes and an empty-cursor call is made;
    - keeps "following now" if it was set, and otherwise clamps the time position to the new end;
    - calls `queryClient.invalidateQueries({queryKey:['session-logs', repoId, sessionId, teamId]})`.

13. **Tool families** (one shared table, `session-map.constants.ts`). Families are matched by tool name in table order.

    | family | label | tools | colour |
    |---|---|---|---|
    | `explore` | Read · Grep · Glob | `Read`, `Grep`, `Glob`, `LS`, `WebFetch`, `WebSearch` | `#0ea5e9` |
    | `edit` | Edit · Write | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `#10b981` |
    | `shell` | Bash · PowerShell | `Bash`, `PowerShell`, `Monitor`, `BashOutput`, `KillShell` | `#f59e0b` |
    | `mcp` | MCP | name starts with `mcp__` | `#8b5cf6` |
    | `orch` | Skill · Agent · Workflow | `Skill`, `Agent`, `Task`, `Workflow`, `ToolSearch`, `TaskStop`, `CronCreate`, `CronDelete` | `#ec4899` |
    | `other` | other | anything else | `#94a3b8` |

    - A failed call is one with status `error` or `rejected` (`classifyToolOutcome`, `tool-outcome.ts:58`). It is shown in red `#ef4444`.
    - The cumulative cost line is blue `#2563eb`.
    - The context bar uses the fixed colour `#64748b`.
    - The cost bar uses `zoneColor(value, maxAgentCost)` (`analytics/HorizontalBarChart.tsx:152`) with the exported `ZoneLegend` (`analytics/ChangeSurfaceChartParts.tsx:58`). Both are imported, not copied.

14. **Grouping.** An agent is a `claude-subagent` session whose id starts with `agent-`. Each agent is placed by these rules:
    - **Nested:** an agent whose `parentSessionId` is another agent is nested under that parent, whatever its `workflowRunId`. This also covers a Workflow run inside a sub-agent.
    - **Workflow column:** an agent whose parent is the root (or `null`) and whose `workflowRunId` is set goes to the column of the `WorkflowRun` whose `wfId === workflowRunId`.
      - If no run has that `wfId`, the run is still running (`wfId` null). The agent gets a column keyed by `workflowRunId`, labelled from the k-th `running` `WorkflowRun` in `toolUseId` order, where k is the rank of that column by earliest agent start. If there are not enough running runs, the label is "workflow run".
    - **Direct column:** an agent with no `workflowRunId` goes to "Agents spawned by the main session".

    Column details:
    - Workflow columns are ordered by start = their earliest agent `startMs`. The direct column is always last.
    - Run label: `<run.name> · run #<index>`, where the index is the 1-based position among all workflow columns in start order.
    - Agent labels come from `agentRowLabel` (`session-log/workflow-agent-rows.ts`), truncated to 60 characters with `…`.
    - The direct column's header shows no duration.
    - When there are no agents, the area shows "No groups".

15. **Per-call cost** (the algorithm doc `session-map-model.md`).
    - Message weight = `computeCost` of that assistant message's own `usage` over all token categories. Rows are deduplicated by `message.id` as the parser does.
    - Agent priced total = `computeCost` of its `subagentStats` row through `@loghub/pricing`. Without a stats row, the transcript-derived `SubAgentNode.tokens` cost is used.
    - Each message's share = `total × weight / Σweight`, placed at the message timestamp. A message with N `tool_use` blocks splits its share evenly over them, and a text-only message keeps its share at its own timestamp.
    - When `Σweight = 0`, the whole total sits at the agent's first timestamp.
    - The root's own total is its own tokens, priced the same way.
    - The cumulative line therefore ends at Σ of the nodes, which is the tree cost.

16. **Time-position states** (`session-map-model.md`). For an agent with first activity `f` and last activity `l` (from `agentLogTimeSpan`), and a time position `t`:
    - **future:** `t < f`.
    - **running:** `f ≤ t ≤ l`. At "now" in realtime it is also running when `t ≥ f`, the session is `live`, and the agent is not finished.
    - **finished** means the parent's `AgentActivation` for it has `endMs`, or, for a workflow agent, its run `status !== 'running'`.
    - **done:** otherwise.
    - Replay never uses the "not finished" clause.
    - The main card uses the same rule with `f` and `l` of the root stream.
    - Header counters at `t`: cost so far = Σ per-call cost with timestamp ≤ `t`; agents started = count with `f ≤ t`; calls and failed calls with timestamp ≤ `t`; elapsed = `t − sessionStart`.

17. **Timeline.** It has 120 equal bins between the session start and `max(sessionEnd, serverTime when live)`.
    - Ticks every 5 / 10 / 30 / 60 min, whichever first gives at most 8 ticks.
    - Rendered in SVG (one `<rect>` per family segment, a red tick per bin with failures, one `<path>` for the cumulative cost). The PoC's canvas is not used.
    - Clicking or dragging sets `t` and stops "following now".
    - Bins are memoised on the model and are not rebuilt on a scrub.

18. **Playback** (`useSessionMapPlayback`).
    - Speeds `[1, 10, 60, 300]`, default `60`. A `requestAnimationFrame` loop advances `t` by `dtReal × speed` and stops at the end.
    - **End** sets `t = end`.
    - In realtime, `following = true` pins `t` to `serverTime + (Date.now() − receivedAt)`, updated once per second. Any scrub sets `following = false`, and **Live** sets it back to true.
    - Header badge: "LIVE · following now", "LIVE · paused at HH:MM", "Replay · finished session", or "Updates paused" while hidden or idle (`indicator` `hidden` / `idle`).

19. **Re-render budget.** Building the model is memoised on the merged state only. States, counters and the side-panel filter are derived per `t` in O(agents + calls). Cards are `React.memo` keyed by agent id with a primitive `state` prop.
    - The visual check measures `performance.mark('session-map:render-start')` against a `useEffect` end mark at ≤ 100 ms.

20. **Side panel and modal.**
    - Selecting a card stores `selectedId` (`main`, `group:<key>` or the agent id) in the `smSel` URL param through `useSearchParams` with `replace`. The tab itself already lives in the URL.
    - `SessionMapTab` deletes `smSel` on unmount, so leaving the tab or switching session clears it. An `smSel` naming an unknown node is ignored.
    - Chips: `all`, then each family present, then `failed`.
    - Clicking a log row sets `t` to the call's `startedAt`. The `⤢` icon opens `ToolCallDetailModal` (`session-log/ToolCallDetailModal.tsx:23`) with the same props `SubAgentDetail.tsx` passes.
    - The panel's Model row uses the agent's `subagentStats.model`. Peak context is shown against `pricing[model]?.contextLength`, or `n/a` when unknown.

21. **Labels and UI text** are English, and the tab label is "Session Map". Icons come from `lucide-react`, popovers from `HoverPopover`. Light theme only.

22a. **Header content.**
    - The first prompt is `selectedSession.firstPrompt` (`client/src/models/repositories.ts:134`), passed down from `SessionDetailPane`, cut to one line with CSS ellipsis and the full text in `title`.
    - The five counters, in order:
      1. elapsed `H h M min`;
      2. failed calls (red when > 0);
      3. calls;
      4. agents `started / total`;
      5. cost `so far / total` (`$0.00`).

22b. **Test ids.** Every scenario-visible element carries a `data-testid`:

    | Element | `data-testid` |
    |---|---|
    | tab root | `session-map` |
    | header badge | `session-map-badge` (text holds `LIVE` or `Replay`) |
    | each counter | `session-map-counter-<elapsed\|failed\|calls\|agents\|cost>` |
    | main card | `session-map-main` |
    | column | `session-map-group-<key>`, with `-header` for its header |
    | agent card | `session-map-agent-<agentId>`, carrying `data-state="future\|running\|done"` and `data-dimmed` |
    | side panel | `session-map-panel` |
    | chip | `session-map-chip-<family\|all\|failed>` |
    | call row | `session-map-call`, with `data-tool-use-id` |
    | open-call button | `session-map-call-open` |
    | timeline | `session-map-timeline` |
    | position marker | `session-map-marker`, with `data-t` epoch ms |
    | Live button | `session-map-live` |
    | Play button | `session-map-play` |

22. **Constants table** (all in `session-map.constants.ts` unless noted).

    | Constant | Value |
    |---|---|
    | `SESSION_MAP_POLL_MS` | `10_000` |
    | `FOLLOW_TICK_MS` | `1_000` |
    | `TIMELINE_BINS` | `120` |
    | `TICK_STEPS_MIN` | `[5, 10, 30, 60]` |
    | `MAX_TICKS` | `8` |
    | `PLAYBACK_SPEEDS` | `[1, 10, 60, 300]` |
    | `DEFAULT_SPEED` | `60` |
    | `TOP_N_HIGHLIGHT` | `5` |
    | `AGENT_LABEL_MAX` | `60` |
    | `RENDER_BUDGET_MS` | `100` |
    | `FAMILIES` | the table of Design Decision 13 |
    | `FAILED_COLOR` | `#ef4444` |
    | `COST_LINE_COLOR` | `#2563eb` |
    | `CONTEXT_BAR_COLOR` | `#64748b` |
    | `MAIN_CARD_MAX_W` | `720` |
    | `COLUMN_W` | `260` |
    | `COLUMN_GAP` | `16` |
    | `COLUMN_SCROLL_AFTER` | `16` (cards) |
    | `PANEL_W` | `360` |
    | `TIMELINE_H` | `140` |
    | `NEST_INDENT` | `16` |
    | `DELTA_CURSOR_MAX_CHARS` | `12_000` (server, `session-logs-delta.ts`) |

23. **Perf baseline.** `.claude/rules/server.md` requires `npm run perf` (from `server/`) after server changes, with no metric degrading by more than 20 %.
    - The baseline is a run on the unchanged code before Chunk 1.
    - The comparison run comes after Chunk 3.
    - The `/logs` refactor must not move the `/logs` perf cases.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `server/src/logs/session-logs-access.ts` | new: `resolveSessionLogsAccess` | Design Decision 2 |
| `server/src/logs/workflow-linkage.ts` | new: `resolveWorkflowAgentLinkage` | Design Decision 3 |
| `server/src/logs/session-logs-delta.ts` | new, pure: cursor codec, `classifyDeltaRows`, `checkGrowth` | Design Decisions 4–6 |
| `server/src/logs/session-logs-delta.algo.spec.ts` | new: table test of the doc's examples | test kind 1 |
| `server/src/logs/session-logs-delta.service.ts` | new: `SessionLogsDeltaService.getDelta`, shared `selectSubagentStats` | Design Decisions 7–8 |
| `server/src/logs/dto/session-logs-delta.dto.ts` | new: response interfaces | API changes |
| `server/src/logs/repositories.controller.ts` | `getSessionLogs` uses the extracted helpers; new `getSessionLogsDelta` route | no `/logs` behaviour change |
| `server/src/logs/logs.module.ts` | register `SessionLogsDeltaService` | |
| `server/src/logs/otel/otel-facts.reader.ts` | export `isRecent`, add `computeOtelLiveness`, reuse in `buildOtelSessionStatus` | Design Decision 9 |
| `server/test/contract/registry/f17-sessions.ts` | `F17-session-logs-delta*` rows | test kind 2 |
| `client/src/viewer/api.ts` | `SessionLogsDeltaData` type, `fetchSessionLogsDelta` | next to `fetchSessionLogs` (line 1625) |
| `client/src/viewer/tab-ids.ts` | `session-map` in `SESSION_TABS` and `TAB_REGISTRY` | group `overview`, no `visible` |
| `client/src/viewer/pages/repository/session-lenses.ts` | promote `session-map` after `agent-tree` | |
| `client/src/viewer/pages/repository/session-lazy-tabs.ts` | `SessionMapTab` lazy export | shared `loadTabs()` |
| `client/src/viewer/pages/repository/session-tabs-lazy-group.ts` | re-export `SessionMapTab` | |
| `client/src/viewer/pages/repository/SessionDetailPane.tsx` | render the tab; route refresh to the Map while it is open | |
| `client/src/viewer/pages/repository/useRepositoryData.ts` | `suspendSilentLogsRefetch` flag | Design Decision 11 |
| `client/src/viewer/pages/repository/RepositoryView.tsx` | pass the flag (`sessionTab === 'session-map'`) to `useRepositoryData` | |
| `client/src/viewer/pages/repository/session-log/session-map/session-map.constants.ts` | poll ms, families, colours, bins, speeds | Design Decisions 13, 17, 18 |
| `…/session-map/session-map-delta-merge.ts` | pure: `emptyMapState`, `mergeSessionMapDelta`, `toParseInputs` | |
| `…/session-map/session-map-delta-merge.algo.test.ts` | table test | test kind 1 |
| `…/session-map/session-map-model.ts` | pure: `toolFamily`, `perCallCosts`, `groupAgents`, `buildSessionMapModel`, `stateAt`, `countersAt`, `highlightSet`, `orderAgents` | Design Decisions 14–16 |
| `…/session-map/session-map-model.algo.test.ts` | table test | test kind 1 |
| `…/session-map/useSessionMapData.ts` | delta poll, merge, reload, parse | Design Decisions 10, 12 |
| `…/session-map/useSessionMapPlayback.ts` | `t`, following, play, speed | Design Decision 18 |
| `…/session-map/SessionMapTab.tsx` | container: layout, selection, URL param | |
| `…/session-map/SessionMapHeader.tsx` | badge, first prompt, counters, Highlight / Order, `ZoneLegend` | |
| `…/session-map/SessionMapCards.tsx` | `MainCard`, `GroupColumn`, `AgentCard`, `MixBar` | split if > 10 KB |
| `…/session-map/SessionMapSidePanel.tsx` | metrics, chips, call log, modal | |
| `…/session-map/SessionMapTimeline.tsx` | SVG bins, failures, cost line, scrub, play controls | |
| `docs/knowledgebase/algorithms/session-logs-delta.md` | new algorithm doc | |
| `docs/knowledgebase/algorithms/session-map-delta-merge.md` | new algorithm doc | |
| `docs/knowledgebase/algorithms/session-map-model.md` | new algorithm doc | |
| `docs/knowledgebase/algorithms/session-lens-row.md` | `session-map` in what-happened promoted (line 45) and in the `overview` group | examples row |
| `docs/knowledgebase/session-map.md` | new KB article: data flow, delta, model, polling | |
| `docs/knowledgebase/index.md` | index the new KB and algorithm docs | |
| `docs/knowledgebase/api-reference.md`, `server-endpoint-map.md` | delta route rows next to `/logs` (`api-reference.md:624,2706`, `server-endpoint-map.md:347,494-497`) | |
| `docs/knowledgebase/session-log-view.md`, `client-component-map.md` | tab entry and folder `session-log/session-map/` | |
| `user-docs/session-log.md` | "Session Map" section and tab table row | offline help |
| `tests/scenarios/tours/screen-registry.ts`, `tests/scenarios/tours/tour-05-session-detail.spec.ts` | session-map row and tab id | `tour-10` requires it |
| `tests/scenarios/view/s-sess-03.spec.ts`, `s-sess-04.spec.ts`, `s-otel-01.spec.ts` | new steps | test kind 3 |

## API changes

`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs/delta`

- **Query:** `cursor` (optional, opaque base64url string; over `DELTA_CURSOR_MAX_CHARS` it is treated as empty, per Design Decision 4) and `teamId` (optional positive integer, same validation as `/logs`).
- **Errors:** identical to `/logs`: 400 for a bad `teamId`, 403 without access, 404 when the session or its root claude log is missing.
- **Response 200:**

```ts
// server/src/logs/dto/session-logs-delta.dto.ts; mirrored in client/src/viewer/api.ts as SessionLogsDeltaData
type SessionLogsDeltaResponse =
  | { reload: true; serverTime: string }
  | {
      reload: false;
      /** Root session's new artisyn lines (body[n:]) — full body when the row is new. */
      rootArtisynLines: Record<string, unknown>[];
      /** Root session's new claude lines. */
      rootClaudeLines: Record<string, unknown>[];
      /** Sub-agent logs that grew: new lines only. */
      subagentAppends: { sessionId: string; lines: Record<string, unknown>[] }[];
      /** Sub-agent sessions/logs not in the cursor: full lines plus linkage. */
      newSubagents: {
        sessionId: string;
        parentSessionId: string | null;
        workflowRunId: string | null;
        logs: Record<string, unknown>[];
      }[];
      /** Full SubagentStats rows (same fields + EXISTS guard as /logs) of every new/changed sub-agent. */
      subagentStats: Record<string, SubagentStats>;
      /** Full recomputed list (same shape/agentSessionIds as /logs) or null = unchanged. */
      workflows: WorkflowRun[] | null;
      liveness: { hasOtel: boolean; live: boolean; lastActivityAt: string | null };
      serverTime: string;
      cursor: string;
    };
```

- **Client:** `SubagentStats` and `WorkflowRun` are the existing types (`client/src/viewer/api.ts:1394`, `client/src/models/workflows.ts`); no new fields.
- **Server:** `WorkflowRun` is imported from `server/src/logs/workflow-extractor.ts:32`. The server has no named `SubagentStats` type, so the DTO defines `SubagentStatsRow = Awaited<ReturnType<typeof selectSubagentStats>>[number]` without its `sessionId` key, which is exactly the fields `/logs` returns.

## Test coverage plan

Only the three kinds the policy allows (CLAUDE.md → Test policy):

1. **Algorithm, server** (`docs/knowledgebase/algorithms/session-logs-delta.md` + `server/src/logs/session-logs-delta.algo.spec.ts`). Rows cover:
   - cursor encode and decode round trip;
   - bad base64, unknown `v` → empty cursor;
   - classification: unchanged, changed, new, and stale because a sid left the tree;
   - `checkGrowth`: grown, shorter (stale), replaced last line (stale), same length with the same fingerprint (no lines);
   - an all-unchanged input yields empty `changed` and `new` lists, which is the empty-poll no-body guarantee.
2. **Algorithm, client** (`session-map-delta-merge.md` + `session-map-delta-merge.algo.test.ts`). Rows cover:
   - append to the root artisyn and claude lists;
   - append to a sub-agent;
   - a new sub-agent with linkage;
   - stats overwrite per key;
   - `workflows: null` keeps the previous list;
   - the cursor and liveness are replaced;
   - no line is duplicated;
   - an empty-cursor delta replaces the state;
   - `toParseInputs`: `main` is `artisyn ++ claude`, `subagentLogs` keys have the `agent-` prefix stripped, `agentParentMap` comes from linkage, and the `workflowRunId` map.
3. **Algorithm, client** (`session-map-model.md` + `session-map-model.algo.test.ts`). Rows cover:
   - the tool family table;
   - per-call cost split: N tool_use blocks, a text-only message, zero weight, no stats row;
   - the cumulative total equals the tree total;
   - grouping: workflow column, running run keyed by `workflowRunId`, nested agent, direct column, column order;
   - `stateAt` future / running / done, and running at "now" while live and unfinished;
   - `countersAt`;
   - `highlightSet` failed and top 5;
   - `orderAgents` by start and by cost.
4. **Algorithm, client** (existing `docs/knowledgebase/algorithms/session-lens-row.md`, picked up by `session-lenses.algo.test.ts`): update the rows for `what-happened` promoted and `overview` membership.
5. **API contract** (`server/test/contract/registry/f17-sessions.ts`):
   - `F17-session-logs-delta`: owner, empty cursor, `rootClaudeLines` = the claude body.
   - `F17-session-logs-delta-subagents`: s02 with an empty cursor, `newSubagents` linkage.
   - `F17-session-logs-delta-outsider`: 403.
   - `F17-session-logs-delta-bad-cursor`: a garbage cursor is a full snapshot, 200.
6. **Scenario steps** (extend existing specs, no new spec file):
   - `s-sess-04.spec.ts` (GS-02 delegator, three levels):
     - the Map tab renders;
     - main card own / tree cost equals the Info tab;
     - a nested agent sits under its parent;
     - every agent appears once;
     - clicking a card opens the panel; the chips filter; clicking a call moves the timeline marker; `⤢` opens the same modal as Logs;
     - the replay end state equals the totals.
   - `s-sess-03.spec.ts` (GS-05 workflow run W1/W2):
     - one workflow column plus the direct column, in start order;
     - group header totals equal the sum of their agents;
     - "top 5" and "with failed" dimming; order by cost.
   - `s-otel-01.spec.ts` (live OTEL):
     - API: delta with an empty cursor, then the hook re-uploads with more lines, then a cursor call returns exactly the new lines; an unchanged call returns no lines and `workflows: null`; a shortened body returns `reload:true`.
     - UI: the session with fresh `rt_last_at` opens "LIVE" and a new upload appears without refresh; aging the state past `OTEL_SESSION_ENDED_MS` switches to Replay.
     - A session without OTEL opens in Replay.
   - `tests/scenarios/tours/screen-registry.ts` and `tour-05-session-detail.spec.ts`: the session-map row and tab id (`tour-10-registry.spec.ts` enforces it).
7. **NFR ≤ 100 ms** is checked in the visual check (performance marks, Design Decision 19) on the PoC session, not by an automated test.

## Visual/UX notes

- **Layout** (top to bottom):
  - header strip (badge, first prompt, five counters);
  - control row (Highlight select, Order select, `ZoneLegend`);
  - main card centred, at most 720 px wide;
  - a horizontally scrolling row of columns (fixed width 260 px, gap 16 px, each column scrolls vertically past 16 cards);
  - right side panel 360 px, shown while a card is selected;
  - bottom timeline 140 px high, with play controls and the family legend.
- No full-width row has two elements more than ~1 000 px apart; the control row is left-aligned.
- **Card states** (wireframe `session-map-cards.svg`):
  - future: `opacity: .35`, dashed border;
  - running: a "running" pill and a growing duration `N min…`;
  - done: normal;
  - selected: `border-blue-600`, 2 px;
  - dimmed by highlight: `opacity: .3`.
- Nested agents are indented 16 px with a left guide line.
- The realtime placeholder column ("new workflow run appears here…") is not drawn. A new column simply appears on the next delta.
- **Empty and error states:**
  - "No groups" when there are no agents;
  - `LazyFallback` while loading;
  - an API error uses the session-logs error panel (`session-log/session-logs-error.ts`).
- `n/a` is shown when the model's context window is unknown.

## Wireframes

No changes needed. One exception: the realtime wireframe's placeholder column is decorative only and is not implemented (see Visual/UX notes).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Server extraction | 6 | Perf baseline first; pure refactor of `/logs`, no behaviour change |
| 2 | Server delta core | 5 | Depends on 1 |
| 3 | Server delta route and API docs | 4 | Depends on 2 |
| 4 | Client data layer | 4 | Depends on 3 (API shape) |
| 5 | Client map model | 4 | Depends on 4 (state type) |
| 6 | Client tab wiring and hooks | 7 | Depends on 4–5 |
| 7 | Client UI components | 6 | Depends on 6 |
| 8 | KB and user help | 5 | Depends on 7 |
| 9 | Tests: algorithm docs and table tests | 6 | Pins chunks 2, 4, 5 and 6 |
| 10 | Tests: contract and scenarios | 8 | Last |

### Chunk 1 — Server extraction
- [ ] Run `npm run perf` from `server/` on the unchanged code and save its output under `tmp/` as the baseline (Design Decision 23).
- [ ] Create `server/src/logs/session-logs-access.ts` exporting `resolveSessionLogsAccess` with the logic of `repositories.controller.ts:1699-1800`, per Design Decision 2.
- [ ] Create `server/src/logs/workflow-linkage.ts` exporting `resolveWorkflowAgentLinkage(workflows, rows)` with the logic of `repositories.controller.ts:1975-2011`, per Design Decision 3.
- [ ] Create `server/src/logs/session-logs-delta.service.ts` with an exported `selectSubagentStats(db, sessionRowIds)` holding the select and `EXISTS` guard of `repositories.controller.ts:1880-1924`.
- [ ] Refactor `getSessionLogs` to call `resolveSessionLogsAccess`, `selectSubagentStats` and `resolveWorkflowAgentLinkage`, keeping the response identical.
- [ ] In `server/src/logs/otel/otel-facts.reader.ts`, export `isRecent` and add `computeOtelLiveness(state, now)` per Design Decision 9; make `buildOtelSessionStatus` use it for `live`.

### Chunk 2 — Server delta core
- [ ] Create `server/src/logs/session-logs-delta.ts` with `DELTA_CURSOR_MAX_CHARS`, `encodeDeltaCursor` and `decodeDeltaCursor` per Design Decision 4. Invalid or oversized input decodes to an empty cursor, and an oversized result encodes to `''`.
- [ ] Add `classifyDeltaRows(cursorRows, currentRows, treeSessionIds)` and `checkGrowth(prevN, prevFp, newLen, fpAtPrevN)` to `session-logs-delta.ts` per Design Decision 6.
- [ ] Create `server/src/logs/dto/session-logs-delta.dto.ts` with `SessionLogsDeltaResponse` per API changes.
- [ ] In `session-logs-delta.service.ts`, add the injectable `SessionLogsDeltaService.getDelta(sessionRowId, cursor, now)`. It runs SQL steps (a)–(f) of Design Decision 7 and builds the response per Design Decision 8.
- [ ] Register `SessionLogsDeltaService` in `server/src/logs/logs.module.ts` providers.

### Chunk 3 — Server delta route and API docs
- [ ] Add `@Get(':repoId/sessions/:sessionId/logs/delta')` `getSessionLogsDelta` to `RepositoriesController`. It takes query `cursor` (optional string) and `teamId`, calls `resolveSessionLogsAccess`, then `getDelta(access.sessionRowId, cursor, new Date())`, and returns JSON.
- [ ] Add the delta route to `docs/knowledgebase/api-reference.md` (next to lines 624 and 2706) with the response shape from API changes.
- [ ] Add the delta route rows to `docs/knowledgebase/server-endpoint-map.md` (next to lines 347 and 494-497).
- [ ] Run `npm run perf` from `server/` and compare it with the Chunk 1 baseline. Stop and ask the user if any metric degrades by more than 20 %.

### Chunk 4 — Client data layer
- [ ] In `client/src/viewer/api.ts`, add the `SessionLogsDeltaData` type (mirror of API changes) and `fetchSessionLogsDelta(repoId, sessionId, cursor, teamId, signal)` right after `fetchSessionLogs` (line 1625). Follow the `signal` / `readApiError` style of `fetchSessionOtel` (`api.ts:932-947`) and the request mapping of Design Decision 10.
- [ ] Create `session-log/session-map/session-map.constants.ts` with every client constant of Design Decision 22 and the family table of Design Decision 13.
- [ ] Create `session-map-delta-merge.ts`. `SessionMapState` holds root artisyn and claude lines, sub-agents with linkage, stats, workflows, cursor, liveness, serverTime and receivedAt. Export `emptyMapState` and `mergeSessionMapDelta(prev, delta)` per Test coverage plan item 2 and the merge rule of Design Decision 10.
- [ ] Add `toParseInputs(state)` to `session-map-delta-merge.ts`, returning `main` (`artisyn ++ claude`), `subagentLogs`, `agentParentMap`, `subagentStats`, `workflows` and a `workflowRunId` map, keyed per Design Decision 10 "Parse inputs".

### Chunk 5 — Client map model
- [ ] Create `session-map-model.ts` with `toolFamily(name)` (Design Decision 13) and `perCallCosts(...)` (Design Decision 15, via `computeCost` and `@loghub/pricing`).
- [ ] Add `groupAgents(...)` to `session-map-model.ts`: columns, labels, column order and nesting per Design Decision 14.
- [ ] Add `buildSessionMapModel(parsed, inputs, pricing)`. It returns a main node and agent nodes (cost, share, family counts, top tools, calls, failures, peak context, `f`/`l`, finished flag, per-call events) placed by `groupAgents`, plus the timeline bins and ticks (Design Decision 17).
- [ ] Add `stateAt(node, t, {live, atNow})`, `countersAt(model, t)`, `highlightSet(model, mode)` (top `TOP_N_HIGHLIGHT` by cost, or agents with failures) and `orderAgents(agents, 'start'|'cost')` per Design Decision 16.

### Chunk 6 — Client tab wiring and hooks
- [ ] In `client/src/viewer/tab-ids.ts`, add `session-map` to `SESSION_TABS` and a `TAB_REGISTRY` row: label "Session Map", group `overview`, a description, synonyms `map, agents map, live, replay`, no `visible`.
- [ ] In `session-lenses.ts`, insert `'session-map'` after `'agent-tree'` in `what-happened.promoted`.
- [ ] Add a lazy `SessionMapTab` to `session-lazy-tabs.ts` via `loadTabs()`, and re-export it from `session-tabs-lazy-group.ts`.
- [ ] Create `session-map/useSessionMapData.ts` per Design Decisions 10 and 12: `useOtelLivePoll` with a delta poll step, `mergeSessionMapDelta`, reload handling, then `parseSessionLogs` and `buildSessionMapModel`, memoised on the merged state.
- [ ] Create `session-map/useSessionMapPlayback.ts` per Design Decision 18, exposing `t`, `following`, `playing`, `speed`, `setT`, `play`, `pause`, `setSpeed`, `goLive` and `goEnd`.
- [ ] In `useRepositoryData.ts`, add the `suspendSilentLogsRefetch` option per Design Decision 11, covering both effects and the dependency list. Pass `sessionTab === 'session-map'` from `RepositoryView.tsx`.
- [ ] In `SessionDetailPane.tsx`, render `<SessionMapTab repoId sessionId teamId firstPrompt pricing repoConfig registerRefresh />` in a `Suspense` for `session-map`, and wire the refresh button per Design Decision 10 "Header refresh".

### Chunk 7 — Client UI components
- [ ] Create `SessionMapTab.tsx`: layout per Visual/UX notes, selection in the `smSel` URL param (Design Decision 20), highlight and order state, `registerRefresh`, and poll-error states (Design Decision 10). It wires the data and playback hooks to the children. Put the test ids of Design Decision 22b on every component in this chunk.
- [ ] Create `SessionMapHeader.tsx`: the badge (Design Decision 18), the first prompt and five `countersAt` counters (Design Decision 22a), the Highlight and Order selects, and `ZoneLegend`.
- [ ] Create `SessionMapCards.tsx` with `MainCard`, `GroupColumn` (header totals) and `AgentCard`. `AgentCard` shows the zone cost bar, `MixBar`, top tools, failed badge, fixed-colour context bar and duration, with states per Visual/UX notes. Add nesting indent and `React.memo`; split the file if it exceeds 10 KB.
- [ ] Create `SessionMapSidePanel.tsx`: metric rows, family and failed chips, the call log (clicking a row sets `t`), and the `⤢` button opening `ToolCallDetailModal` per Design Decision 20.
- [ ] Create `SessionMapTimeline.tsx` per Design Decision 17: SVG stacked bins, failure ticks, cumulative cost path, time ticks, position marker, click-and-drag scrub, Play / Pause, speed buttons, End, Live and the family legend.
- [ ] Add a `performance.mark` / `measure` pair named `session-map:render` in `SessionMapTab` per Design Decision 19.

### Chunk 8 — KB and user help
- [ ] Write `docs/knowledgebase/session-map.md`: data flow (delta → merge → parse → model), polling and reload, watermark suspension, the families table and the file list. Add it to `docs/knowledgebase/index.md`.
- [ ] Add the Session Map tab and the `session-log/session-map/` folder to `docs/knowledgebase/session-log-view.md` (tabs section) and `docs/knowledgebase/client-component-map.md`.
- [ ] Add the delta route to `docs/knowledgebase/otel-tabs.md` §Realtime states as a second consumer of `computeOtelLiveness`.
- [ ] Add a "Session Map" section and a row in the tab table (line 12) to `user-docs/session-log.md`: realtime vs replay, controls, cards, timeline, and that liveness requires OTEL.
- [ ] Run `npm run build:help` and confirm the new section appears in `client/public/help/`.

### Chunk 9 — Tests: algorithm docs and table tests
- [ ] Write `docs/knowledgebase/algorithms/session-logs-delta.md` (format per `algorithms/README.md`) with the example rows of Test coverage plan item 1.
- [ ] Create `server/src/logs/session-logs-delta.algo.spec.ts`, the table test over that doc's examples block (copy the harness of `server/src/logs/session-list-flags.algo.spec.ts`).
- [ ] Write `docs/knowledgebase/algorithms/session-map-delta-merge.md` with the rows of Test coverage plan item 2, and create `session-map-delta-merge.algo.test.ts` reading it (harness from `session-log/workflow-agent-rows.algo.test.ts`).
- [ ] Write `docs/knowledgebase/algorithms/session-map-model.md` with the rows of Test coverage plan item 3, and create `session-map-model.algo.test.ts` reading it.
- [ ] Update `docs/knowledgebase/algorithms/session-lens-row.md`: `session-map` in the what-happened promoted list (line 45), in the `overview` group, and in the examples rows.
- [ ] Add the three new algorithm docs to `docs/knowledgebase/index.md`. Run `npm run test` (server, `server/`), `bun run test` (client, `client/`) and `npm run test:scripts`, and fix any failures.

### Chunk 10 — Tests: contract and scenarios
- [ ] Add the rows `F17-session-logs-delta`, `-subagents`, `-outsider` and `-bad-cursor` to `server/test/contract/registry/f17-sessions.ts`, per Test coverage plan item 5.
- [ ] Add a `session-map` row to `tests/scenarios/tours/screen-registry.ts` (`id`, `query`, `tab`, `title`, `expectTestId: 'session-map'`, `docRef` to the user-docs anchor), and add the tab id to the list in `tour-05-session-detail.spec.ts:99`.
- [ ] Extend `tests/scenarios/view/s-sess-04.spec.ts` with the Map steps of Test coverage plan item 6 (GS-02).
- [ ] Extend `tests/scenarios/view/s-sess-03.spec.ts` with the Map steps of Test coverage plan item 6 (GS-05).
- [ ] Extend `tests/scenarios/view/s-otel-01.spec.ts` with the delta API steps of Test coverage plan item 6: grown, unchanged, and shortened → reload.
- [ ] Extend `s-otel-01.spec.ts` with the UI steps: LIVE mode with a new upload shown without a refresh, the ended state switching to Replay, and a no-OTEL session in Replay.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios,contract --grep "@S-SESS-04|@S-SESS-03|@S-OTEL-01"` and fix the failures.
- [ ] Re-check that the delta entries in `docs/knowledgebase/api-reference.md` and `server-endpoint-map.md` match the final controller and DTO.
