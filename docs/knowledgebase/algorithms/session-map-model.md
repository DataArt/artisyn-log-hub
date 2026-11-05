---
reviewed: no
reviewer: none
---

# Session Map model: families, per-call cost, grouping, time position

## Purpose

The Session Map tab draws a session tree as cards (the main session, one column per workflow run,
one column for agents the main session spawned directly) over a timeline the user can scrub or
replay. The user reads from it which agent was busy when, what kind of tools it used, which calls
failed and how much each part cost. These rules decide the colour family of a call, how a node's
cost is spread over time, where each agent is placed, what state a card shows at a time position
and what the header counters say.

## Code

- Implementation: `client/src/viewer/pages/repository/session-log/session-map/session-map-model.ts`
  (`toolFamily`, `isFailedCall`, `perCallCosts`, `buildTimeline`, `groupAgents`,
  `buildSessionMapModel`, `stateAt`, `countersAt`, `highlightSet`, `orderAgents`); constants in
  `session-map.constants.ts` (`FAMILIES`, `TIMELINE_BINS`, `TICK_STEPS_MIN`, `MAX_TICKS`,
  `TOP_N_HIGHLIGHT`).
- Twins: none. Prices go through the client `computeCost` (`client/src/viewer/lib/format.ts`,
  which uses `@loghub/pricing`); usage is read by `extractSubagentStats` (`session-log/log-parser.ts`).
- Test: `client/src/viewer/pages/repository/session-log/session-map/session-map-model.algo.test.ts`.

## Rules

### Tool families

A tool name is matched against `FAMILIES` in table order; the first match wins, names are
case-sensitive:

| Family | Tools |
|---|---|
| `explore` | Read, Grep, Glob, LS, WebFetch, WebSearch |
| `edit` | Edit, Write, MultiEdit, NotebookEdit |
| `shell` | Bash, PowerShell, Monitor, BashOutput, KillShell |
| `mcp` | any name starting with `mcp__` |
| `orch` | Skill, Agent, Task, Workflow, ToolSearch, TaskStop, CronCreate, CronDelete |
| `other` | anything else |

A call is **failed** when its status is `error` or `rejected` (not `missing`).

### Per-call cost (`perCallCosts`)

Input: a node's own transcript lines, its priced `total`, the pricing map, a fallback model and
the node's first activity `firstMs`.

1. `total ≤ 0` → no events.
2. Assistant lines are grouped into messages by `message.id` (else `uuid`). A message's timestamp
   is its first line's; its usage is its **last** usage-carrying line; its tool uses are the
   `tool_use` blocks of all its lines.
3. Message weight = `computeCost` of that usage, priced by the line's model or the fallback model;
   no price → 0.
4. `Σweight = 0` → one event `{t: firstMs, cost: total}`.
5. Otherwise each message with weight `w > 0` gets `share = total × w / Σweight` at its timestamp.
   With N `tool_use` blocks the share is split evenly, `share / N` each, tagged with the block id;
   a text-only message keeps its whole share, untagged.

The events of a node always sum to its `total`.

### Node totals (`buildSessionMapModel`)

- The main node's total = Σ message weights of the root transcript (its own tokens).
- An agent's total = `computeCost` of its `subagentStats` row; without a stats row, of the tokens
  in its own transcript.
- Tree total = main + Σ agents. Since every event sits at or before the last activity, the
  cumulative cost at the session end equals the tree total.
- An agent card's label = `agentRowLabel` (see [workflow-agent-rows](workflow-agent-rows.md),
  label rules) of the agent with its `agentDescription` looked up in the parse inputs'
  `agentDescriptions` (by unprefixed agent id): the `.meta.json` description when it has one,
  otherwise the cleaned prompt, otherwise the agent id; then cut to `AGENT_LABEL_MAX` with `…`.

### Timeline (`buildTimeline`)

`TIMELINE_BINS` (120) equal bins over `[start, end]`; each event goes to the bin its time falls
in (the end time to the last bin), and each bin carries the cumulative cost up to its end. The
tick step is the first of `TICK_STEPS_MIN` (5, 10, 30, 60 min) with
`floor(spanMin / step) + 1 ≤ MAX_TICKS` (8); ticks run from `start` in that step up to `end`.

### Grouping (`groupAgents`)

1. **Nested:** an agent whose parent is another agent of the session is nested under it, whatever
   its `workflowRunId`.
2. **Workflow column:** a top-level agent with a `workflowRunId` goes to column `wf-<id>`.
3. **Direct column:** any other top-level agent goes to `direct`, "Agents spawned by the main
   session".
4. Workflow columns are ordered by start (the earliest `startMs` of all their agents, nested ones
   included; no start last); the direct column comes last and is left out when empty. Top-level
   agents keep input order inside a column.
5. Label of the i-th workflow column (1-based): `<run.name> · run #i`, where the run is the
   `WorkflowRun` whose `wfId` equals the column's `workflowRunId`. Without one the run is still
   running: the column takes the next `running` run without a `wfId` in `toolUseId` order (by
   column order); none left → `workflow run`.

### Card state at time `t` (`stateAt`)

For first activity `f` and last activity `l`:

1. No `f` → `done`.
2. `t < f` → `future`.
3. `f ≤ t ≤ l` → `running`.
4. In realtime at "now" (live and following now) and the node is not finished → `running`.
5. Otherwise `done`.

### Header counters at `t` (`countersAt`)

- cost so far = Σ cost events with time ≤ `t`; total = tree total;
- calls and failed = call events with a time ≤ `t` (a call without a time never counts);
- agents started = agents with `f ≤ t`, of all agents;
- elapsed = `t − sessionStart`, at least 0.

### Highlight and order

- `top`: the `TOP_N_HIGHLIGHT` (5) agents by cost, ties by id; `failed`: agents with at least one
  failed call; `none`: nothing dimmed (`null`).
- Order `start`: by `f` ascending, no `f` last, ties by id. Order `cost`: by cost descending, ties
  by start, then id.

## Edge cases

- Families incl. case and a near-miss MCP prefix: SMM-01. Failed statuses: SMM-02.
- Per-call: N tool_use blocks and a text-only message SMM-03; split lines of one message
  SMM-04; zero weight SMM-05; fallback model SMM-06; zero total SMM-07.
- Stats row vs transcript total, and cumulative cost at the end = tree total: SMM-08, SMM-09.
- Tick step choice: SMM-09 (30 min), SMM-10 (5 min).
- Grouping: workflow and direct columns in start order SMM-11; running runs keyed by
  `workflowRunId` and the unlabelled fallback SMM-12; nesting across a `workflowRunId` SMM-13; no
  agents SMM-14.
- State: future SMM-15, both bounds of running SMM-16 and SMM-17, replay never uses rule 4
  SMM-18, rule 4 SMM-19, finished SMM-20, not at now SMM-21, no activity SMM-22.
- Counters mid-session and at the end: SMM-23, SMM-24.
- Highlight: top 5 SMM-25, ties by id SMM-26, failed SMM-27, none SMM-28.
- Order by start SMM-29, by cost with a tie SMM-30.
- Card label: a description wins over the prompt, an agent without one keeps its prompt: SMM-31.

## Examples

Each row's `input.op` picks the call: `family`, `failed`, `perCall` (times in `lines` and `firstAt`
are ISO; `expected.events` gives each event's `at` as ISO), `timeline` (`nodes` with `costEvents`
in epoch ms), `model` (root claude lines, sub-agents with linkage, `stats` as `{model,
inputTokens}`, the rest 0, an optional `agentDescriptions` map of unprefixed agent id →
description added to the parse inputs; an optional `expected.labels` maps agent id → card label
and is checked only when present), `group`, `state`, `counters` (nodes with `f`, call `events` and
`costEvents`), `highlight`, `order`. `pricing` maps a model to `{in, out}` USD per million tokens;
every other rate is 0. Costs are compared with a 1e-9 tolerance.

Rows (31): [`docs/algorithm-examples/session-map-model.json`](../../algorithm-examples/session-map-model.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Family matched case-insensitively" -> SMM-01.
- "Duplicated message lines weighed twice" -> SMM-04.
- "Agent total from the transcript even with a stats row" -> SMM-08.
- "Card label from the prompt only, description ignored" -> SMM-31 (a = `task a`).
- "Agent nested only when it has no `workflowRunId`" -> SMM-13.
- "Direct column ordered by start like the workflow columns" -> SMM-11.
- "Realtime running clause used in replay" -> SMM-18.
- "Top highlight ties broken by input order" -> SMM-26.

## Where the result is visible

The Session Map tab: card colours and the timeline's family bars, card states (`data-state`),
column order and labels, the header counters (`session-map-counter-*`), the Highlight and Order
selects, and the cumulative cost line.
