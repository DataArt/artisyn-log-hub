---
type: "Architecture Guide"
title: "Harness Usage Tab"
description: "The session Harness usage tab: element kinds and the transcript blocks they come from, the session tree assembly rules, the usage-count summary, and why the tab bypasses parseSessionLogs and the session_harness_usage table."
tags:
  - client
  - harness
  - session-view
timestamp: "2026-10-14T00:00:00+04:00"
---

# Harness Usage Tab

The session view's **Harness usage** tab: an Explorer-style session tree on the left, and for the
selected node a **usage-count summary** on the right — the fact that a harness element was used,
and how many times, not a chronological event log.

Read this before changing anything under
`client/src/viewer/pages/repository/session-log/harness-usage/`, and before "fixing" the tab to
use `parseSessionLogs` or the `session_harness_usage` table — both were considered and rejected
for reasons that still hold.

## What problem it solves

Harness usage is captured server-side for **every** session, workflow agents included
(`session_harness_usage` rows written from `logs.service.ts` for both `claude` and
`claude-subagent` logs). What was missing was display: the session view only surfaced skills per
**prompt turn of the root transcript** (`PromptTurnSkillsSection`, fed by `log-parser.ts`'s
per-turn `skills`), so a skill loaded by a sub-agent — and every skill loaded by a workflow agent
— had nowhere to appear.

## The five kinds, and where each comes from

Kinds are **whitelisted**, not filtered, and match the repo-level Harness Usage report's kind
vocabulary (`skill | rule | mcp | tool`), plus `workflow`. Only five producers emit rows, nothing
else is inspected, so "ordinary built-in tool calls are structurally covered, not excluded" holds
— this file can never drift out of sync with `server/src/logs/builtin-tools.ts`.

| Kind | Source | `name` |
|---|---|---|
| `skill` | `assistant` → `tool_use` with `name === 'Skill'` | `input.skill` verbatim (already plugin-qualified, e.g. `adlc:review-deep`), fallback `'skill'` |
| `rule` | `attachment` event with `attachment.type === 'nested_memory'` | `normalizeRuleName(displayPath ?? path)` |
| `workflow` | `tool_use` with `name === 'Workflow'` | the `WorkflowRun` matched by `toolUseId` → its `name`, else `input.name`, else `'workflow'` |
| `mcp` | `tool_use` whose name starts with `mcp__` | `name.slice(5).split('__').join(':')` |
| `tool` | every other `tool_use` — built-in tool calls (Read/Bash/Edit/Write/Glob/Grep, ...) **and** sub-agent spawns (`Agent`/`Task`) alike | the raw tool name, verbatim (e.g. `Read`, `Agent`) |
| `skill` (via slash command) | `user` event whose string content is the **new** slash-command shape — see below | the captured `<command-name>`, `/`-stripped (e.g. `adlc:review`, `task-archive`) |

**Slash commands split into two shapes, and only one is tracked — as `skill`, not as a separate
`cmd` kind.** `captureSkillCommandName` in `harness-elements.ts` uses the exact rule
`log-parser.ts`'s `isQualifyingUserEvent` already established: whichever tag comes first in the
content string is the signal.

- `<command-message>` first — a real skill/command invocation with a description. Every ADLC-family
  slash command in this project (`/adlc:review`, `/adlc:implement`, `/task-archive`,
  `/task-plan-deep`, `/claude-api`, ...) is this shape, **whether or not its name is
  plugin-qualified with a `:`** — verified against 25 real production sessions, where the only
  non-plugin-qualified new-shape commands (`task-archive`, `task-plan-deep`,
  `task-post-impl-check`, `task-post-impl-release`, `claude-api`) are all genuine project skills.
  Tracked as a `skill`-kind row, merging with any real `Skill` tool_use of the same name (a session
  that both types `/adlc:review` and later has the assistant call `Skill(adlc:review)` shows one
  row with `count: 2`, not two rows).
- `<command-name>` first, with no leading `<command-message>` — a CLI utility command with no
  description of its own (`/clear`, `/model`, ...). Not tracked at all.

**This is a per-command signal, not a per-CLI-version one.** Confirmed against a real session that
carries both shapes side by side: a leading `/clear` in the old (untracked) shape immediately
followed by `/adlc:review` in the new (tracked) shape. Do not "simplify" this into "old CLI
versions never had skill-mapped commands, so just check the CLI version" — that's not what the
data shows.

**Bug this fixes:** the first cut of the usage-count rework removed slash-command extraction
entirely (per its own "must not display commands" directive), which made `/adlc:review`,
`/adlc:implement` and every other ADLC-family command invisible in the tab even though the Logs
tab's own session list correctly showed them as the session's launching command. The user's
original complaint ("this session used adlc:review skill but I do not see it in harness") is this
exact gap — a slash command that's actually a skill launch is a fact of harness usage no less than
an explicit `Skill` tool_use.

**Sub-agent spawns have no kind of their own.** An earlier cut had a standalone `agent` kind for
`Agent`/`Task` calls. It was folded into `tool` — the session tree already shows every spawned
sub-agent as its own node, so a separate "sub-agent spawn" usage-count row would just repeat what
the tree structure already says.

**Built-in tool calls are no longer excluded.** The original design deliberately whitelisted away
Read/Bash/Edit/etc. as "already covered by the Logs, Statistics and Tool Heatmap views". User
feedback asked for exactly the opposite: a `tool` bucket showing which tools were called and how
many times, mirroring the repo-level report's `tool` kind.

**Hook invocations are the one harness element left out.** Neither the session `/logs` payload nor
the transcript carries per-invocation hook records, so surfacing them needs new hook and server
work. Follow-up task, not this one.

## Usage-count summary, not a chronological list

The right pane renders `summarizeHarnessElements(elements)` (in `harness-elements.ts`): elements
are grouped by `(kind, name)` and counted, sorted by the fixed kind order
(`skill, rule, workflow, mcp, tool`), then by count descending, then by name. The table is
`KIND | ELEMENT | COUNT` — no time column, no per-event detail, no source-session column.

`HarnessElement` itself still carries a `tsMs` (parsed from the source event's timestamp) because
the **tree** orders sub-sessions by their earliest activity (`harness-session-tree.ts`'s
`earliestOf`) — but nothing renders it, and elements carry no `detail`/byte-size fields any more.
An earlier cut computed skill-injection byte sizes and rule byte sizes for a `DETAIL` column; that
machinery (`skillInjectedBytes`, `formatBytes`/`formatWorkflowDuration` imports, "repeat load"
tracking) was deleted along with the column it fed, rather than left computing something nothing
displays.

**"Include sub-sessions" sums counts, it does not merge-and-list.** Off (default): the selected
node's own usage counts. On: counts summed over the node plus every descendant (skipping
`workflow-group` nodes — their own list is already the merged union of their members', so
counting them too would double every row). There is no per-row "which session did this come from"
column in either mode — an aggregate count has no single source session to name. The switch is
disabled for a node with no descendants or for a `workflow-group` node, same as before.

## Filter and sort (right pane)

`HarnessElementList.tsx` holds local `kindFilter`/`sortKey`/`sortDesc` state — not URL-backed, same
treatment as the "Include sub-sessions" switch and the repo-level report's own table
(`reports/HarnessUsageTable.tsx`), which this pane's chip/sort styling mirrors:

- **Kind filter chips** (`buildHarnessUsageKindChips` in `harness-elements.ts`): an `All` chip plus
  one per kind, each counted over the **full, unfiltered** row set so a chip's own count never
  moves when a different chip is selected. Clicking one narrows the table to that kind via
  `filterHarnessUsageRows`.
- **Sortable `Element`/`Count` column headers** (`sortHarnessUsageRows`): click to sort by that
  column, click again to flip direction; default is `count` descending (busiest first, matching the
  report's own default). Ties break by the fixed kind order, so re-sorting never visibly reshuffles
  a tie.
- The `Kind` column itself is not sortable — with the kind filter chips already narrowing to one
  kind, a kind sort would be redundant.
- Both controls act only on the currently selected node's `HarnessUsageSummaryRow[]` (already
  computed by the tab shell's `summaryRows` memo) — no re-walk, no re-fetch, same no-extra-request
  guarantee as everything else in this tab.

## Why it does NOT use `parseSessionLogs`

Running the full parser over every sub-agent transcript would break the tab's perf requirement on
a deep workflow fan-out (dozens of agent sessions). So `harness-elements.ts` walks the raw NDJSON
once per session and stamps each element with its own event's timestamp — needed for tree
ordering, not for display.

## Why it does NOT use the `session_harness_usage` table

That table is aggregated per session, mirrors the repo-level report's kind set, and can't see a
single session's sub-agent tree the way this tab's per-session drill-down needs. The transcripts
can. The repo-level Harness Usage report is the aggregated repo/period view and keeps that
table.

## Tree assembly rules

All in `harness-session-tree.ts` — **unchanged** by the usage-count rework above; these rules are
about the left-pane tree, not the right-pane display. Each of these is a rule someone will
otherwise re-break:

1. **Null-parent agents attach under the root.** `SessionLogsData.subagents[].parentSessionId` is
   documented as `null` for a depth-1 agent whose parent row predates parent linkage, and
   `buildChildrenByParentMap` drops falsy parents. Any agent whose parent is `null`, or whose
   parent id is not itself a node, goes directly under the root node — a legacy agent must never
   vanish from the tree.

2. **Workflow membership is derived client-side, from `agentSessionIds`.** `/logs` never emits
   `workflow_run_id` on `subagents[]` (the column is selected server-side and then dropped), so
   membership is read from `WorkflowRun.agentSessionIds`, which the server already resolves by
   `workflow_run_id` plus a `parent_session_id` BFS. **Every id in `agentSessionIds` keeps its
   `agent-` prefix** — the server's BFS only admits prefixed ids — while `agentParentMap` and
   `subagentLogsMap` are keyed stripped. Every read goes through `stripAgentPrefix`. Without it the
   member set matches nothing and no group node is ever produced.

3. **Direct members** of a run are members whose parent is *not* itself in the member set — the
   same "root-in-set" rule `buildAgentNodesForIds` uses. Those become the group node's children;
   their own descendants stay nested beneath them. A run with an empty/absent `agentSessionIds`
   (still running, or a legacy session) creates **no** group node and its agents render as
   ordinary siblings — degradation, not error. An agent claimed by two runs goes to the first.

4. **A group node is not a session.** Its own element list is the merged union of every member's
   (own counts still sum correctly under the "sum over subtree" rule above), which is why it is
   excluded from `totalElements` and why *Include sub-sessions* is disabled on it — aggregating its
   subtree would double every row.

5. **Sidechain agents get their own nodes, merged when an uploaded transcript exists.**
   `log-parser.ts` deliberately discards `isSidechain === true` events from main-session parsing,
   so this tab runs its own `splitSidechainGroups` pass. A group whose resolved agent id already
   has a node (a separately uploaded `claude-subagent` transcript) has its elements **appended to
   that node** — never a second node, never a double count. Otherwise it becomes a
   `sidechain:<anchor8>` node under the session that owns the anchor event.

6. **`isSidechain: true` does NOT mean "a nested agent" — a group needs an anchor that exists in
   the same transcript.** This one cost a real bug and is the easiest to re-break. Verified against
   the live DB: a separately uploaded `claude-subagent` log is `isSidechain: true` on **every**
   line, with its chain root at `parentUuid: null` (the flag describes the line's place in the
   CLI's own conversation, not a sub-agent relationship). An earlier version bucketed any sidechain
   chain into a group, which on a real 45-agent workflow run produced a phantom `sidechain:` child
   holding all 28 of an agent's elements while that agent's own node badged `0` — the exact
   attribution failure this tab was built to fix. So `findAnchor` returns an anchor only when the
   first non-sidechain ancestor is an event **present in this transcript**; a chain that dangles
   into the parent's log, or has no parent at all, is the session's own content and stays in
   `mainEvents`.

7. **Own counts are own counts.** The tree badge is always the node's own **raw element occurrence
   count** (built-in tool calls included), unchanged by the switch — a badge that changed meaning
   with a right-pane control would make sibling nodes incomparable. This is a different number from
   the right pane's distinct-row count: a session that calls `Read` five times badges `5` there but
   shows one `TOOL · Read` row with `count: 5` in the summary.

8. **Ordering.** Elements sort by timestamp ascending, with `(nodeOrder, seq)` as the tiebreak, so
   an element whose event carried no parsable timestamp still appears (last) rather than being
   dropped — this ordering feeds tree child placement, not the (unordered-by-time) usage-count
   table. Tree children are ordered by their subtree's earliest timestamp, then by label;
   `nodeOrder` is assigned by a pre-order walk once that ordering is settled.

## No network cost

The tab is fully prop-driven and issues **no query of its own**. `SessionDetailPane` already holds
`mainLogs`, `subagentLogsMap`, `agentParentMap` and `workflows`; the tab runs one `useMemo` over
them. Selecting a node and flipping the switch are pure re-selections of that memo — no re-walk, no
re-parse, no fetch. `tests/e2e/harness-usage-tab.spec.ts` asserts exactly that, counting only
`/sessions/<id>/logs` and `/change-surface` requests (the session view also runs two independent
15 s session-list polls, so a blanket `/api/v1/` counter would fail on timing alone).

## Related: the Logs tab's sub-agent Skills/Rules sections

The same gap, smaller half. `buildAgentNodesForIds` already runs
`parseSessionLogs(logs, { isSubagent: true })` per uploaded sub-agent transcript and flattens
`toolCalls`/`files` onto the node; `t.skills` and `t.rulesInjected` come from the very same per-turn
block and were simply dropped. They are now flattened too (optional, spread-conditionally, so no
existing `SubAgentNode` consumer changes shape) and rendered by `SubAgentNode.tsx` through the
unchanged `PromptTurnSkillsSection`/`PromptTurnRulesSection`, which return `null` for an empty
list. **Untouched by the usage-count rework** — this is a separate feature sharing the same gap.

`buildSubAgentTree` is deliberately left alone: it builds nodes from `agent_progress` events, which
carry only prompt/model/usage and no tool content — that path shows no Tools section today either,
for the same reason.
