# Research findings 1 — 2026-10-21-workflow-session-readability

## Requirements summary
In the Logs tab, the workflow's "Agents (N)" drill-down (`WorkflowNode` → `buildAgentNodesForIds` → `SubAgentNode` forest) becomes a table. Columns are `#`, `Task (prompt start)`, `Duration`, `Tokens`, `Cost`.
- **Task cell:** a single-line label taken from the start of the agent's own prompt, truncated with an ellipsis. The truncated id (`truncateAgentId`) stays underneath as a small mono line. If there is no prompt, the label falls back to the id.
- **Nested agents:** each one is its own indented `↳` row directly below its parent, numbered `N.M` (deeper: `N.M.K`).
- **Numbering (FR-3):** siblings are sorted by `startMs` ascending, where `startMs` is the first timestamped record in the agent's own transcript. Agents without one keep their BFS order at the end of their sibling group. Parent/child nesting via `agentParentMap` does not change.
- **Expanded row:** shows exactly what `SubAgentNode` shows today, plus a "View raw logs" action (FR-5). It opens a modal like `ToolCallDetailModal` that reuses `RawLogsTab` on `subagentLogsMap.get(agentId)`.
- Client only. No new request, no server change.

**Answers in `open_questions_ru.md` (all filled in; treat as user input):**
- **Q1:** option (b), the table, picked by the user over the minimal list and the timeline. The plan must record all three and why (b) won.
- **Q2:** keep the id as secondary small mono text.
- **Q3:** no `label`/`phase` from the workflow script; the label comes only from the prompt.
- **Q4:** the Harness usage tree (`harness-session-tree.ts` `shortId`) is out of scope.
- **Q5:** no separate parallelism indicator.
- **Q6:** compute the real start order from `startMs`, falling back to BFS order.

## Wireframes
`wireframes/agents-table.svg` shows Today vs After (variant B).
- **Header row:** `#` is right-aligned, then `TASK (PROMPT START)`. `DURATION`, `TOKENS` and `COST` are right-aligned mono columns, with sample values `00:42`, `12.3K`, `$0.04`.
- **Rows:** the number is in purple (`#7e22ce`, bold). The task text is 12px. Under it, the id is shown as 8 characters plus `…`, then a copy icon `⧉`, in `#9ca3af` at 10px. The wireframe shows 8 characters but `truncateAgentId` keeps 12; the plan has to pick one.
- **Nested row `3.1`:** smaller 11px text, `↳` prefix, indented to x=110 instead of 80. It is drawn without an id line, but the Q1 answer says the id is added to every row.
- **Footnote:** an expanded row shows the full prompt, model, tool calls, files, skills and a "🔍 View raw logs" action.
- **Notes box:** repeats FR-3 ordering, the fallbacks and no-new-request.
- The wireframe's sample formats do not match the existing helpers: `00:42` is not `formatDuration` (`h:mm:ss`), and `$0.04` is not `formatCost` (`$X.XXXX`). See Open gaps.

## Knowledgebase
- `docs/knowledgebase/session-log-view.md`:
  - § "Workflow 'Agents (N)' drill-down" (L427-453) defines the contract: strip the `agent-` prefix, memoize per `turn.workflows`, an id missing from `subagentLogsMap` is skipped, a root is any id whose parent is outside the set, and the section is omitted when the forest is empty.
  - § "Prompt text extraction pipeline" (L372-390): build the label with `cleanText(stripSystemBlocks(...))`.
  - § "WorkflowNode stats strip" (L423-425): the agent count comes from `agentNodes.length`.
  - The file table (L32-33) and the drill-down section must be updated afterwards.
- `docs/knowledgebase/raw-logs-renderers.md`: `RawLogsTab` takes any `rawLogs` array. It filters out `type:'artisyn'` and sorts with `sortRawLogs`; rows expand through `RawLogsExpandedView`. Reuse it as is; no new renderer.
- `docs/knowledgebase/harness-usage-tab.md` § "No network cost" (L211-218): the tab is prop-driven with no query of its own. Its e2e checks this by counting only `/sessions/<id>/logs` requests. § L220-232: `buildAgentNodesForIds` already runs `parseSessionLogs(..., {isSubagent:true})` per agent and spreads optional fields conditionally, so existing consumers keep their shape.
- `docs/knowledgebase/client-component-map.md` L289-291: the `SubAgentNode.tsx` / `WorkflowNode.tsx` entries must be updated, and any new component added (rule in `.claude/rules/client.md`).
- `docs/knowledgebase/llm-call-math.md` / `algorithms/cost-formula.md`: cost goes through `computeCost(tokens, pricing[model ?? sessionModel])`, as `SubAgentNode` already does.
- `docs/knowledgebase/algorithms/README.md`: there is no existing algorithm doc for agent ordering or labels. An algorithm test is only allowed together with a new doc, which needs `reviewed`/`reviewer` front-matter, an AI review and owner sign-off.
- `.claude/rules/client.md`: aim for components under 10 KB; the post-impl check forces a split above 20 KB. Paths shown must be repo-relative.

## Existing patterns
**Components in `client/src/viewer/pages/repository/session-log/`**
- `SubAgentNode.tsx:31-36`: `PROMPT_PREVIEW_LIMIT=200`, `AGENT_ID_LIMIT=12`, and a module-private `truncateAgentId`. It must be exported or moved to share it.
- `SubAgentNode.tsx:75-213`: the detail body (prompt with its own collapse, model, token strip with `CostBreakdownTooltip`, duration, Skills/Rules/Tools/Files sections, `ToolCallDetailModal`). This is what the expanded row must render. It recurses into `children` at L205, which the table has to stop doing.
- **Sharing constraint:** `SubAgentNode` is also used by the turn-level "Sub-agents" section (`PromptTurnItem.tsx:233-250`). The table must apply only to `WorkflowNode`, so the detail body should be extracted into a shared component. The file is 8,634 B.
- `WorkflowNode.tsx:175-201`: the "Agents (N)" collapsible to replace; it maps `<SubAgentNode depth={0}>`. File is 9,354 B, so the table should live in a new file.
- `PromptTurnItem.tsx:92-112`: the `workflowAgentNodes` memo calling `buildAgentNodesForIds(wf.agentSessionIds.map(stripAgentPrefix), agentParentMap, subagentLogsMap, subagentStats, pricing)`. `subagentLogsMap` is already in scope here (it is passed to `AgentActivationItem` at L222) but is not passed to `WorkflowNode`. FR-5 needs it, or the agent's logs attached to the node. File is 10,002 B.
- `SessionInfoWorkflowsSection.tsx:42-112`: the table style to copy (`border-collapse`, `text-xs text-muted-foreground` header, right-aligned `font-mono` numbers, `hover:bg-muted/30` rows).
- `ToolCallDetailModal.tsx:31-37`: the modal pattern (`Dialog open onOpenChange` → `onClose`, `DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden"`, from `../../../ui/dialog`).
- `RawLogsTab.tsx:14-20, 77-79`: props are `rawLogs`, `isLoading`, and optional `parsedSession`/`pricing`/`sessionModel`. `parsedSession` adds `TurnHeader` rows, so leave it out or pass the agent's own parse. The root is `overflow-y-auto h-full` with a `table-fixed` table and `w-40`/`w-44` columns, so the modal needs a fixed height and a wider `max-w-*`.
- `raw-logs/primitives.tsx:28`: `CopyButton({text})` for the `⧉` next to the id. There is also `hooks/useCopyToClipboard` (used in `ToolCallDetailModal.tsx:9`).

**Parser and helpers**
- `log-parser.ts:1312-1341`: `firstUserPromptText`, private. It skips `isMeta`, `toolUseResult.agentId`, `<command-name>` and `<task-notification>`. This is the label source; the label is `agent.prompt` after `cleanText`.
- `log-parser.ts:1358-1443`: `buildAgentNodesForIds`. Roots and children are pushed in input (BFS) order at L1428-1440. This is where to add `startMs`: `logs` is already in hand at L1370, so no new pass is needed. It sets **no `durationMs`** for workflow agents.
- `types.ts:201-222`: the `SubAgentNode` type has no `startMs`. `AgentActivation` (L193-196) already has the `startMs?`/`endMs?` naming with "Epoch ms" doc comments; reuse that naming.
- `log-parser.ts:2959-2993`: `formatDuration` (`h:mm:ss`), `formatWorkflowDuration` (`Xm Ys`), `formatCompact` (K/M with 1 decimal). `lib/format.ts:105-115` has `formatCost` (`$X.XXXX`, en dash when absent) and `formatTokens` (same K/M rule).
- `log-parser.ts:1544`: `stripAgentPrefix`.
- `prompt-turn-helpers.tsx:24`: `cleanText`, which strips system blocks and tags and collapses whitespace.
- `charts/chart-data.ts:168-173`: `truncateContent(content, max=60)`, first line plus `…`, private. `session-list/session-list-helpers.tsx:62`: private `truncate` (50 in the list, 60 in `ActiveSessionsView`). These are the existing label-truncation precedents for FR-4.
- `charts/chart-data.ts:282-297, 379-388`: `logTimeSpan`, the existing duration derivation for workflow agents in Charts. Start is the earliest qualifying-turn timestamp, end is the max of turn start plus `workTimeMs`. It is a ready precedent for the missing Duration column.
- `charts/chart-data.ts:447-497`: `buildWorkflowAgentNodes`, a twin of the restricted-nesting rule. It is not affected unless ordering is shared.

**Server (read-only reference)**
- `server/src/logs/repositories.controller.ts:2037-2072`: the BFS that fills `wf.agentSessionIds` (direct agents in DB row order, then children). No change needed.

**Raw-logs visibility**
- `SessionDetailPane.tsx:122-125`: `canSeeRawLogs` is the owner, or a team view whose logs query succeeded. Whether FR-5's action follows the same gate is for the plan to decide (see Open gaps).

**Tests to extend (test policy: scenario steps only)**
- **Scenario:** `tests/scenarios/view/s-sess-03.spec.ts` already uploads GS-05 and opens its Logs tab (step 8, L157). This is the natural place for a new step: open `⚡ ResearchWorkflow` → `Agents (2)`, then check the labels, `#` numbers, the id line, row expansion and the raw-logs modal. The run command is `--mode a --grep "@S-SESS-03"`.
- S-SESS-06 (`docs/qaa-overview/scenarios/03-session-view-reports-golden.md:418-436`) is the designed home for "Agents (2)", but no spec file exists for it.
- **Golden data computed for GS-05**, from `tests/golden/gs-05-skills-rules-mcp-workflow/subagents/workflows/wf-gs05/*.jsonl`:

| Agent | Prompt | Tokens (in / out / total) | `formatTokens` | Cost (`expected.json`) | Time span |
|---|---|---|---|---|---|
| W1 | "Add a billing section to src/report.ts" | 3,000 / 1,000 / 4,000 | `4.0K` | 0.008 → `$0.0080` | 10:02:52 → 10:03:10 = 18,000 ms |
| W2 | "Review the billing flow in depth" | 2,000 / 500 / 2,500 | `2.5K` | 0.0045 → `$0.0045` | 10:02:52 → 10:03:15 = 23,000 ms |

  - W1 and W2 both start at exactly 10:02:52.000Z, so `startMs` ties. Sorting must be stable, and GS-05 cannot show start order differing from BFS order (see Open gaps).
  - Durations: `formatDuration` gives `0:00:18` / `0:00:23`; `formatWorkflowDuration` gives `18s` / `23s`. The same values come from the `logTimeSpan` work-time rule.
- **No contract test:** no route changes.
- **Legacy e2e that will break:** `tests/e2e/session-log-view.spec.ts:606-632` (`@core`, the `e2e-fast` final check) clicks `getByRole('button', {name: <bare agent id>, exact: true})` and then expects the prompt. The new row's accessible name or role changes, so this existing locator must be updated (not a new spec). L690 (`getByText('Agents (1)')`) is unaffected.

## Open gaps
1. **Duration has no data source.** `buildAgentNodesForIds` never sets `durationMs`; it only comes from `completionMap` on the Task-tool path. The plan must derive it, for example last timestamp minus `startMs` from the same log, or reuse the `logTimeSpan` rule. It must also pick a formatter, because the wireframe's `00:42` matches none of the existing helpers.
2. **Cost and token format.** The wireframe shows `$0.04` and `12.3K`. The existing helpers give `formatCost` → `$0.0400` and `formatTokens`/`formatCompact` → `12.3K`. Which tokens make up "Tokens" (input+output, or all four including cache) needs deciding.
3. **Label truncation length.** There is no single constant: 50, 60 and 200 are all in use. A first-line rule (as in `truncateContent`) vs. whitespace-collapsed `cleanText` also needs choosing.
4. **Id width.** The wireframe shows 8 characters; `truncateAgentId` keeps 12. Decide whether to keep 12, and whether to add the copy button.
5. **Defining `startMs`.** "First timestamped record" (FR-3) differs from Charts' `logTimeSpan` (first qualifying prompt). Also undecided: how to read a non-string or unparseable timestamp (`session-time-span.md` rule 1 accepts only strings that `Date.parse` accepts), and that ties keep BFS order.
6. **Where sorting and numbering live.** Options are inside `buildAgentNodesForIds` (which also reorders anything else using it — today only `WorkflowNode`) or a separate pure function. It also needs a flatten-to-rows step producing `{node, depth, number}`. Also open: whether to write a new algorithm doc plus a `*.algo.test.ts`, or rely only on the scenario.
7. **Getting logs to FR-5.** Either pass `subagentLogsMap` into `WorkflowNode`, or put the agent's raw log array on the node. Also undecided: whether the action is gated by `canSeeRawLogs`. In practice anyone seeing the Logs tab already has the same `/logs` payload, but the Raw Logs tab carries an "Only visible to you" lock hint.
8. **GS-05 cannot test ordering.** Its two agents start at the same instant. To show FR-3 in a scenario, the plan could shift one GS-05 agent's timestamps so W2 starts before W1. That requires re-checking `expected.json` and `tests/golden/check-arithmetic.mjs` (not confirmed whether they read sub-agent timestamps). Otherwise, accept that only labels and numbering are checked.
9. **No golden fixture has a nested agent inside a workflow** (`N.M` row). GS-02 nests under the Task tool, not a workflow. The nested-row look cannot be checked by scenario without extending a fixture.
10. **Modal layout.** `RawLogsTab` assumes it fills its parent's height; the modal needs a fixed-height wrapper and a wider dialog than `max-w-2xl`.
