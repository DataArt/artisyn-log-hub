# 2026-10-21: Workflow Session Readability

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-10-21

## Description

The workflow agent list inside a session's Logs tab is hard to scan. Opening a completed
`WorkflowRun`'s "Agents (N)" drill-down (`WorkflowNode` → `buildAgentNodesForIds` →
`SubAgentNode` forest, `client/src/viewer/pages/repository/session-log/SubAgentNode.tsx`) shows
each agent only as a truncated raw UUID (`truncateAgentId`, first 12 characters) with no
execution order and no indication of what that agent was actually asked to do — the prompt text
only appears after expanding the node. A user reviewing a workflow run (example: a `.../logs` tab
with `?tab=logs` for a `review-deep` workflow run with 7 agents) cannot tell, without expanding
every single node, which agent ran first, what task each one handled, or how the run is
structured overall.

Original request, verbatim (Russian):

> сейчас сессии внутри workflow неудобно просматривать
>
> http://localhost:5173/#/repos/40477?session=6fa19b19-1532-4bcd-bd58-c1af51395888&tab=logs
>
> какие элементы использовались видно но что за сессия в каком порядке, какой был промпт и вообще
> задача - не понятно
> надо сделать более удобно и понятно
>
> текущий вид с раскрывающимся списком uuuid внутри workflow неудобен
>
> предложи варианты
>
> и назначения надо как-то более понятно писать - хотя бы по началу промпта

A screenshot of the current view is attached to the original request (`WORKFLOWS` section,
`adlc-lh:review-deep-wf`, expanded, with an `Agents (7)` list of raw truncated ids such as
`a0cd2e5e0dff…`, `a2306a194821…`, `a589b7579c67…`). See `wireframes/agents-table.svg` for the
before/after wireframe of the chosen direction (table, FR-1).

## Functional Requirements

See `wireframes/agents-table.svg` for the before/after wireframe of what follows.

- FR-1: The workflow's "Agents (N)" drill-down is restructured from today's flat, recursively
  collapsible `SubAgentNode` list into a table, columns "#", "Task (prompt start)", "Duration",
  "Tokens", "Cost". A row expands on click to show the same detail content `SubAgentNode` shows
  today (full prompt, model, tool calls, files, skills, rules injected) — only the collapsed row's
  look changes, not what it reveals when opened.
  - The "Task" cell shows the prompt-derived label (FR-2) as its primary line, with the truncated
    raw UUID (`truncateAgentId`) kept as a small secondary mono line underneath, for copy/technical
    lookup — never removed.
  - A nested agent (today's `SubAgentNode.children`) renders as its own row directly below its
    parent, indented and prefixed `↳`, instead of being nested inside a sub-tree.
- FR-2: The label must convey what that agent was actually asked to do, derived at minimum from
  the start of the agent's own prompt text (`SubAgentNodeType.prompt`, already available via
  `firstUserPromptText` on the agent's own transcript) — matching the request's explicit ask
  ("назначения ... хотя бы по началу промпта").
- FR-3: The execution order of agents within the workflow run must be visible without expanding
  any row, as a sequence number in the "#" column (`1`, `2`, ...; a nested child gets a sub-number,
  `N.M`, consistent with its row's indentation from FR-1).
  - The number reflects **actual start order**, not the current `agentSessionIds` array order:
    that array is filled by a BFS discovery walk in `repositories.controller.ts` (direct agents in
    DB row order, then their children level-by-level), which does not track real start time.
    `SubAgentNode` carries no start timestamp today.
  - For each agent, derive `startMs` from the timestamp of the first timestamped record in that
    agent's own transcript (already loaded into `subagentLogsMap` for prompt/stats extraction in
    `buildAgentNodesForIds` — no new parsing pass, no new network request).
  - Sort siblings at each nesting level by `startMs` ascending before numbering. Parent/child
    nesting itself (resolved via `agentParentMap`) is unchanged — sorting only reorders agents
    within the same sibling group, never across levels.
  - An agent with no derivable `startMs` keeps its current (BFS) position and sorts to the end of
    its sibling group — same graceful-degradation standard as AC-2's no-prompt case.
- FR-4: The table must scale to a workflow run with many agents (the example run has 7; some
  observed runs have 45+, see `docs/knowledgebase/harness-usage-tab.md`) without becoming a wall of
  text — truncate the prompt-derived label to a fixed length (single line, ellipsis), consistent
  with how other labels in this view are already truncated.
- FR-5: From an expanded agent row, a "View raw logs" action opens a modal (same pattern as
  `ToolCallDetailModal`) showing that agent's own raw log entries — reusing the existing Kibana-
  style Raw Logs tab renderer (`RawLogsTab` + `raw-logs/*`, see
  `docs/knowledgebase/raw-logs-renderers.md`) scoped to just that agent's own transcript, already
  available in `subagentLogsMap.get(agentId)`. This is a per-agent *raw log viewer*, not navigation
  to a separate session page — the user only needs to see that agent's own log entries, not its
  Info/Charts/other tabs.

## Non-Functional Requirements

- No new network request: the agent list is already prop-driven (`subagentLogsMap`,
  `agentParentMap`, `subagentStats` already passed into `buildAgentNodesForIds`); label, `startMs`
  derivation and FR-5's raw-log view must stay client-side over data already fetched for the Logs
  tab, consistent with the "no extra request" guarantee documented for this area
  (`docs/knowledgebase/harness-usage-tab.md` § "No network cost").

## Common sense considerations

- UI direction: table (FR-1), picked by the user after comparing three drawn mockups (minimal
  list / table / timeline-ribbon — see `wireframes/agents-table.svg` and `open_questions_ru.md`
  Q1). Scales best to 45+ agents; nested agents need one extra bit of row-indent logic that the
  minimal-list option wouldn't have needed, accepted as the trade-off for the table's readability.
- The truncated raw UUID stays visible (small, secondary) rather than being removed — consistent
  with how other technical ids are kept visible elsewhere in this component for copy/lookup (see
  `open_questions_ru.md` Q2).
- Persisting a workflow-script `label`/`phase` per agent (instead of deriving the label from the
  prompt) is out of scope: it requires a server-side schema change, while this task's `Module(s)`
  is `client` and the NFR forbids new server dependencies (see `open_questions_ru.md` Q3).
- The Harness usage tab's left tree (`harness-session-tree.ts`'s `shortId`) is out of scope — this
  task is scoped to the "Agents (N)" drill-down on the Logs tab only, per the Description and the
  original request's screenshot (see `open_questions_ru.md` Q4).
- No separate "ran in parallel" visual indicator is needed: making the sequence number itself
  reflect real start order (FR-3) is sufficient (see `open_questions_ru.md` Q5/Q6).
- FR-5 reuses the existing `raw-logs/*` renderer subsystem rather than building a second one: it
  already renders an arbitrary `Record<string, unknown>[]` log array (`RawLogsTab`'s `rawLogs`
  prop), so pointing it at a single agent's own log array is a reuse, not a new component.

## Acceptance Criteria

- [ ] Opening a completed `WorkflowRun`'s "Agents (N)" section, without expanding any individual
      agent row, a user can read in the table: a sequence number reflecting real start order
      (FR-3), and a short description of each agent's task derived from its prompt — with the raw
      id still visible as secondary text.
- [ ] A nested agent renders as its own indented row with a `↳` prefix and a sub-number (`N.M`)
      directly below its parent row, not inside a collapsed sub-tree.
- [ ] Clicking a row expands the same detail content `SubAgentNode` shows today (full prompt,
      model, tool calls, files, skills, rules injected).
- [ ] An agent whose own transcript carries no prompt, and/or no derivable `startMs`, still renders
      without crashing or showing an empty label — falls back to the raw id for the label, and to
      its current (BFS) position at the end of its sibling group for ordering.
- [ ] From an expanded agent row, a "View raw logs" action opens a modal listing that agent's own
      raw log entries (timestamp, type, expandable detail — the existing Raw Logs tab renderer),
      with no new network request.
- [ ] The final UI direction chosen (table — see `wireframes/agents-table.svg` and
      `open_questions_ru.md`) is recorded in the implementation plan with the 2-3 alternatives
      considered and why one was picked.

## Notes

<!-- Append timestamped notes here as work progresses -->

- 2026-10-21: FR-5 (per-agent "View raw logs" action, reusing the Raw Logs tab renderer) added
  after the user asked, mid-review, to also be able to view a sub-agent's own raw logs — not just
  the derived prompt/tokens/tool-calls summary `SubAgentNode` already shows.
