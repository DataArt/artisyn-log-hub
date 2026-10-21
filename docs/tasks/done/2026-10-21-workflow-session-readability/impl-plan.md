# Implementation plan — 2026-10-21-workflow-session-readability

## TL;DR

- Client only: no server, API or DB change, no new npm package, no new network request.
- The workflow "Agents (N)" drill-down in `WorkflowNode` becomes a new `WorkflowAgentsTable` with the columns `#`, Task, Duration, Tokens and Cost. The expanded row renders a new `SubAgentDetail`, which is extracted from `SubAgentNode`. The turn-level "Sub-agents" section keeps using `SubAgentNode` and looks the same.
- New pure module `workflow-agent-rows.ts`:
  - `orderAgentRows(forest)` sorts siblings by `startMs` and returns flattened rows with numbers like `1`, `2.1`.
  - `agentRowLabel(node)` builds the prompt-derived label.
- `log-parser.ts`:
  - new exported `agentLogTimeSpan(logs)`;
  - `buildAgentNodesForIds` now also sets `startMs` and `durationMs` on each workflow agent node;
  - `SubAgentNode` (type, `types.ts`) gains `startMs?`.
- New `AgentRawLogsModal` (FR-5) reuses `RawLogsTab` as is, on the agent's log array, which already sits in `subagentLogsMap`. It also passes the agent's own parsed session, so the records are grouped under a `TurnHeader`, the same way as in the Raw Logs tab. `WorkflowNode` gets a new `subagentLogsMap` prop.
- `truncateAgentId` and `AGENT_ID_LIMIT` move from `SubAgentNode.tsx` to `prompt-turn-helpers.tsx` as exports.
- New algorithm doc `docs/knowledgebase/algorithms/workflow-agent-rows.md` (ordering, numbering and label) and its vitest table test `workflow-agent-rows.algo.test.ts`. It needs an AI review and owner sign-off (front-matter starts `reviewed: no`).
- Doc updates in the KB: `session-log-view.md`, `client-component-map.md`, `raw-logs-renderers.md`, `index.md` and `algorithms/README.md`. Scenario design: S-SESS-03 in `docs/qaa-overview/scenarios/03-session-view-reports-golden.md`.
- Tests:
  - new step 8b in scenario `tests/scenarios/view/s-sess-03.spec.ts` (GS-05);
  - the locator in legacy `@core` e2e `tests/e2e/session-log-view.spec.ts:623-628` is updated, because the agent row is no longer a button named after the bare id.

## Reference

Requirements: [requirements.md](requirements.md) (answers: [open_questions_ru.md](open_questions_ru.md)). Wireframe:
[wireframes/agents-table.svg](wireframes/agents-table.svg). Research archive: `research/findings-1.md`.

All client paths below are relative to `client/src/viewer/pages/repository/session-log/` unless stated otherwise.

## Design Decisions

**DD-1: UI direction is the table.** Three directions were drawn and compared (requirements AC-6, `open_questions_ru.md` Q1):
- **(a) Minimal list:** a number, the prompt label and the id on one line. It was the simplest, but stays a wall of text at 45+ agents, and Duration, Tokens and Cost are invisible without expanding a row.
- **(b) Table:** columns `#`, Task, Duration, Tokens and Cost. **Chosen by the user.** It scans best at 45+ agents. Its only cost is the extra row-indent logic for nested agents.
- **(c) Timeline ribbon:** shows parallelism. It duplicates the Charts tab Timeline, and Q5 says parallelism needs no separate indicator.

**DD-2: Scope of the table.** Only `WorkflowNode` gets it. The turn-level "Sub-agents" section (`PromptTurnItem.tsx:233-250`) keeps the `SubAgentNode` tree. The Harness usage tree is out of scope (Q4).

**DD-3: Detail body is extracted, not duplicated.** Today it lives in `SubAgentNode.tsx:75-203`: the prompt with its 200-char collapse, model, token strip with `CostBreakdownTooltip`, duration, Skills, Rules, Tools with `ToolCallDetailModal`, and Files.
- It moves to `SubAgentDetail.tsx` with the props `agent`, `pricing?`, `sessionModel?` and `onViewRawLogs?: () => void`.
- `SubAgentNode` keeps its trigger and the `children` recursion, and renders `<SubAgentDetail>` inside `CollapsibleContent`. Its output is unchanged.
- The "View raw logs" button appears only when `onViewRawLogs` is passed, which only the table does.

**DD-4: `startMs`, `endMs` and `durationMs` derivation.** This is `agentLogTimeSpan(logs: Record<string, unknown>[]): { startMs?: number; endMs?: number }` in `log-parser.ts`.
- **Which records count:** only records whose `timestamp` is a string that `Date.parse` accepts (not `NaN`); all other records are ignored.
- **Values:** `startMs` is the minimum of those timestamps and `endMs` the maximum. For a transcript in order, the minimum is the first timestamped record (FR-3).
- **On the node:** `buildAgentNodesForIds` spreads `startMs` when it is defined. It spreads `durationMs = endMs − startMs` when both are defined. Both use the existing conditional-spread style at `log-parser.ts:1415-1425`.
- **Cost:** no extra parse pass. The function scans the same `logs` array that is already in hand at `log-parser.ts:1370`.
- **Where duration shows:** the Duration column. As a side effect, the existing Duration line in the expanded detail now shows for workflow agents too.

**DD-5: Ordering and numbering contract** (`orderAgentRows`, the algorithm doc `workflow-agent-rows`):
1. At each sibling group (the roots, then each node's `children`), sort stably:
   - nodes with a `startMs` come first, ascending by `startMs`;
   - ties keep their input order;
   - nodes without a `startMs` follow, in their input order.

   "Input order" is the order `buildAgentNodesForIds` emits, which is the `agentIds` (that is, `wf.agentSessionIds`) order at `log-parser.ts:1428-1440`. The server fills that array with a BFS walk.
2. Walk depth-first: a parent row is followed directly by its own sorted children before the next sibling.
3. Numbering:
   - a root row's `number` is its 1-based position among the sorted roots (`"1"`, `"2"`);
   - a child's number is the parent's number + `.` + its 1-based position among its sorted siblings (`"2.1"`, `"2.1.1"`);
   - `depth` is 0 for roots and parent depth + 1 for children.
4. Nesting is never changed: nodes are reordered only inside their own sibling group.
5. The input arrays are not mutated; `orderAgentRows` copies before sorting.
6. Return type: `AgentRow = { node: SubAgentNode; depth: number; number: string }`. An empty forest gives `[]`.

`buildAgentNodesForIds` keeps its input-order output. Sorting lives only in `orderAgentRows`, which the table calls inside a `useMemo`.

**DD-6: Label (FR-2, FR-4).** This is `agentRowLabel(node: SubAgentNode): string`, with `AGENT_LABEL_LIMIT = 60` in `workflow-agent-rows.ts`.
- **Text:** `cleanText(node.prompt)`, from `prompt-turn-helpers.tsx:24`. It strips system blocks and tags and collapses whitespace.
- **Fallback:** when the text is empty, use `node.agentId` (AC-4).
- **Truncation:** when longer than 60 characters, use `text.slice(0, 59) + '…'`. That is the same rule and the same 60 as `charts/chart-data.ts:168-173` `truncateContent` and `ActiveSessionsView`.
- **Display:** the cell also gets the CSS `truncate` class. Its `title` is the untruncated cleaned text, or `agentId` when the label fell back to it.

**DD-7: Id line.** `truncateAgentId` and `AGENT_ID_LIMIT = 12` move out of `SubAgentNode.tsx:32-36`.
- They become exports of `prompt-turn-helpers.tsx`, which both `SubAgentNode` and the table import.
- The table shows the 12-char id; the wireframe's 8 characters are illustrative.
- Next to the id sits `CopyButton` from `raw-logs/primitives.tsx:28`. It copies the full bare id and already calls `stopPropagation`.

**DD-8: Column formats.**
- **Duration:** `formatDuration(durationMs)` from `log-parser.ts:2959` (`h:mm:ss`, e.g. `0:00:18`). That is the formatter the expanded detail's Duration line already uses (`SubAgentNode.tsx:149-156`), so the column and the detail show the same value; the wireframe's `00:42` is illustrative. Do not use the other `formatDuration` in `lib/format.ts`. With no `durationMs`, show `–`.
- **Tokens:** `formatTokens(input + output + cacheRead + cacheWrite)` (`lib/format.ts:110`). With no `tokens`, show `–`.
- **Cost:** `formatCost(computeCost(tokens, pricing[model ?? sessionModel]))` (`lib/format.ts:105`, `$0.0080`), the same 4-decimal format as the rest of this view; the wireframe's `$0.04` is illustrative. With no tokens or no price entry, `formatCost(undefined)` gives `–`.
- **Number column:** `#7e22ce`-family purple, i.e. the Tailwind classes `font-semibold text-purple-700 dark:text-purple-300`.

**DD-9: Table markup and test hooks.**
- **Table styling:** copied from `SessionInfoWorkflowsSection.tsx:42-112`: `border-collapse`, a header in `text-xs text-muted-foreground`, numeric cells right-aligned in `font-mono`, and rows with `hover:bg-muted/30 cursor-pointer`.
- **Row attributes:** each row `<tr>` has `data-testid="workflow-agent-row"` and `data-agent-id={agentId}` (bare). Clicking it toggles the row's id in a `Set<string>` of expanded ids.
- **Keyboard access:** the `#` cell holds a `<button type="button" aria-expanded={open} aria-label={`Toggle agent ${number}`}>` wrapping the chevron and the number. Its `onClick` calls `stopPropagation` and does the same toggle, so the row can be focused and opened with Enter or Space as `CollapsibleTrigger` allows today.
- **Task cell, in order:**
  - `paddingLeft = depth * 16` px, plus a `↳ ` prefix when `depth > 0`;
  - the label at 12px (`text-xs`), or 11px (`text-[11px]`) for a nested row;
  - under it, the id line (`font-mono text-[10px] text-muted-foreground`) with the `CopyButton`.
- **Expanded row:** a `<tr data-testid="workflow-agent-detail"><td colSpan={5}>` that renders `<SubAgentDetail agent onViewRawLogs pricing sessionModel/>`. It is inserted directly after its own row and before that row's child rows.
- **Child rows:** always rendered, whether or not the parent row is expanded. The table is flat: expanding a row reveals only that agent's detail, never its children (AC-2).

**DD-10: FR-5 log source and access.**
- **Data flow:** `PromptTurnItem` passes its existing `subagentLogsMap` prop into `WorkflowNode`, which passes it into `WorkflowAgentsTable`. `onViewRawLogs` sets the table's `rawLogsAgent` state to that row's node (`useState<SubAgentNode | null>(null)`). The modal renders when it is non-null, with `agentId = node.agentId`, `label = agentRowLabel(node)` and `logs = subagentLogsMap.get(node.agentId) ?? []`. `onClose` sets it back to `null`.
- **Access:** no extra `canSeeRawLogs` gate. The table only renders when the Logs payload (the same `/logs` response) already loaded these logs for this viewer.
- **Button:** `<button type="button">🔍 View raw logs</button>`, styled `text-xs text-muted-foreground hover:text-foreground underline`, placed under the prompt in `SubAgentDetail`.

**DD-11: Raw-logs modal layout.** `AgentRawLogsModal.tsx`, props `{ agentId: string; label: string; logs: Record<string, unknown>[]; pricing?: ModelPricingMap; model?: string; onClose: () => void }`. `model` is `node.model ?? sessionModel`.
- **Dialog:** the same `Dialog open onOpenChange` pattern as `ToolCallDetailModal.tsx:31-37`. `DialogContent` uses `max-w-5xl h-[80vh] flex flex-col overflow-hidden`.
- **Title:** `DialogTitle` shows the label, then the id in `font-mono text-xs`.
- **Body:** `<div className="flex-1 min-h-0">` wrapping `<RawLogsTab rawLogs={logs} isLoading={false} parsedSession={parsed} pricing={pricing} sessionModel={model} />`.
- **One component for both views:** the modal renders the same `RawLogsTab` component that the Raw Logs tab renders (`SessionDetailPane.tsx:450-456`), with the same four props. Do not copy, fork or wrap it in a modal-specific variant; `AgentRawLogsModal` adds only the `Dialog` shell and the `parseSessionLogs` call.
- **Parsing:** `parsed = useMemo(() => parseSessionLogs(logs, { isSubagent: true, pricing }), [logs, pricing])`. It is the same call `buildAgentNodesForIds` makes (`log-parser.ts:1407`), but it runs only while the modal is open, so the node shape stays unchanged.
- **Grouping:** the records are grouped under a `TurnHeader` row, as in the Raw Logs tab (`SessionDetailPane.tsx:450-456`). That row shows `Turn #1`, the work time, the tokens, the cost and the prompt. A workflow agent always has one turn, so one header sits above all of its records.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `types.ts` | `SubAgentNode` type | Add `/** Epoch ms of the agent's first timestamped transcript record. */ startMs?: number;` after `durationMs` (L206). |
| `log-parser.ts` | Time span and node fields | New exported `agentLogTimeSpan` (DD-4). `buildAgentNodesForIds` (L1358-1443) spreads `startMs` and `durationMs`, and its doc comment is updated. |
| `prompt-turn-helpers.tsx` | Shared id helper | Export `AGENT_ID_LIMIT` and `truncateAgentId` (moved from `SubAgentNode.tsx`). |
| `SubAgentDetail.tsx` (new) | Expanded detail body | Extracted per DD-3, plus the optional "View raw logs" button (DD-10). |
| `SubAgentNode.tsx` | Turn-level sub-agent tree | Uses `SubAgentDetail` and the imported `truncateAgentId`; same output. |
| `workflow-agent-rows.ts` (new) | Pure row logic | `AgentRow`, `orderAgentRows` (DD-5), `AGENT_LABEL_LIMIT`, `agentRowLabel` (DD-6). |
| `workflow-agent-rows.algo.test.ts` (new) | Algorithm table test | Loads the `workflow-agent-rows` examples (vitest pattern in `docs/knowledgebase/algorithms/README.md`). |
| `WorkflowAgentsTable.tsx` (new) | The agents table | DD-8 and DD-9; owns the expanded set and the modal state. |
| `AgentRawLogsModal.tsx` (new) | FR-5 modal | DD-11. |
| `WorkflowNode.tsx` | Workflow node | New prop `subagentLogsMap?`; the L187-199 `SubAgentNode` map is replaced by `<WorkflowAgentsTable>`; the `SubAgentNode` import is dropped. |
| `PromptTurnItem.tsx` | Turn | Passes `subagentLogsMap` to `WorkflowNode` (L260-271). |
| `docs/knowledgebase/algorithms/workflow-agent-rows.md` (new) | Algorithm doc | Ordering, numbering and label (DD-5, DD-6). Format per `algorithms/README.md`; examples per Test coverage plan. |
| `docs/knowledgebase/algorithms/README.md` | Docs index | Add the `workflow-agent-rows` row. |
| `docs/knowledgebase/session-log-view.md` | KB | File table (L32-33) and § "Workflow 'Agents (N)' drill-down" (L427-453): the table, ordering, label, timing, raw-logs modal. |
| `docs/knowledgebase/client-component-map.md` | KB | Update the `SubAgentNode`/`WorkflowNode` entries (L290-291); add the three new components and `workflow-agent-rows.ts`. |
| `docs/knowledgebase/raw-logs-renderers.md` | KB | Note the second consumer, `AgentRawLogsModal`. |
| `docs/knowledgebase/index.md` | KB index | Add an `algorithms/workflow-agent-rows.md` entry (algorithm docs are listed individually, e.g. L44). |
| `tests/scenarios/view/s-sess-03.spec.ts` | Scenario | New step 8b (Test coverage plan); header comment's Data line mentions GS-05 workflow agents. |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` | Scenario design | S-SESS-03 (L353-372): add GS-05 to Data, plus the step and its checks. |
| `tests/e2e/session-log-view.spec.ts` | Legacy `@core` e2e | Update the existing locator at L623-628 only (no new spec). |

## Test coverage plan

Under the CLAUDE.md test policy there are exactly two kinds here. There is no contract test, because no route changes.

**Algorithm (new doc together with a new test).** `docs/knowledgebase/algorithms/workflow-agent-rows.md`, with `client/src/viewer/pages/repository/session-log/workflow-agent-rows.algo.test.ts`.
- **Examples input shape:** `{"forest": [{"id": string, "startMs"?: number, "children"?: [...] }]}`.
- **Expected:** `{"rows": [{"id", "number", "depth"}]}`.
- **Test mapping:** each input node becomes `{ agentId: id, prompt: '', children: (children ?? []).map(recurse) }`, plus `startMs` only when the row defines it (a missing `startMs` must stay absent, never `0`). The test compares `orderAgentRows(...).map(r => ({ id: r.node.agentId, number: r.number, depth: r.depth }))` with `expected.rows`.
- **Rows (ids `AO-01`…):**
  - AO-01 roots out of order are sorted ascending;
  - AO-02 a `startMs` tie keeps input order;
  - AO-03 a root without `startMs` goes to the end, and two such roots keep their input order;
  - AO-04 children are sorted only within their group and numbered `N.M` directly after their parent;
  - AO-05 a grandchild is numbered `N.M.K` with depth 2;
  - AO-06 an empty forest gives `[]`;
  - AO-07 an early-starting child does not move ahead of its parent's siblings.
- **Label rows (same doc, its own "Label" rules subsection = DD-6):**
  - **Input shape:** `{"label": {"agentId": string, "prompt": string}}`, expected `{"label": string}`.
  - **Test dispatch:** a row with `input.label` calls `agentRowLabel({ agentId, prompt, children: [] })`; a row with `input.forest` calls `orderAgentRows`.
  - **Rows:**
    - AL-01 a short prompt is returned as is;
    - AL-02 tags and system blocks are stripped and whitespace collapsed;
    - AL-03 a 60-char prompt is not truncated;
    - AL-04 a 61-char prompt becomes 59 chars + `…`;
    - AL-05 an empty prompt falls back to `agentId` (AC-4);
    - AL-06 a prompt that cleans to empty (only a system block) falls back to `agentId`.
- **Mutations to list:**
  - an unstable sort → AO-02;
  - undefined treated as 0 → AO-03;
  - a global sort across levels → AO-07;
  - numbering by input index instead of sorted index → AO-01;
  - children appended after all roots → AO-04;
  - truncation at `>=` 60 instead of `>` 60 → AL-03;
  - no fallback for a prompt that cleans to empty → AL-06.

**Nested-row rendering (AC-2): algorithm coverage only.** No golden fixture has a nested agent inside a workflow; GS-02 nests under the Task tool. So the `N.M` numbers, the depth and the placement directly below the parent are pinned by AO-04, AO-05 and AO-07. The `↳` prefix, the indent and the 11px label (DD-9) are checked only in the workcycle visual check, on a real nested workflow run in the dev app. Extending a golden fixture for this is out of scope.

**Finding data for the visual check:**
1. Start with the session from the requirements: `#/repos/40477?session=6fa19b19-1532-4bcd-bd58-c1af51395888&tab=logs`. To see it, identify as the repo owner via "Edit email" (`CLAUDE.local.md`).
2. If it has no nested workflow agent, look one up read-only with `mcp__postgres__query`: a workflow-agent session whose `parent_session_id` is another `agent-*` session of the same workflow run.
3. If none exists, record the nested part of the check as skipped in the final report.

**Scenario: new step 8b in `tests/scenarios/view/s-sess-03.spec.ts`.** It runs after step 8a and stays on GS-05 Logs. The step:
1. Before acting, it sets a `page.on('request')` counter for `/api/` requests.
2. It clicks `⚡ ResearchWorkflow`, then `Agents (2)`.
3. **The `workflow-agent-row` locator has 2 rows**, with these values (data from `tests/golden/gs-05-skills-rules-mcp-workflow/subagents/workflows/wf-gs05/*.jsonl`):

   | Row (`data-agent-id`) | Label | Duration | Tokens | Cost |
   |---|---|---|---|---|
   | ends with `gs05w1` | `Add a billing section to src/report.ts` | `0:00:18` (10:02:52→10:03:10) | `4.0K` (2000+600+1000+400) | `$0.0080` |
   | ends with `gs05w2` | `Review the billing flow in depth` | `0:00:23` (10:02:52→10:03:15) | `2.5K` (800+150+800+150+400+200) | `$0.0045` |

   The costs are `expected.json` 0.008 and 0.0045.
4. **Numbers and id line:** the `#` cells are `{1, 2}` as a set. Both agents start at 10:02:52.000Z, so they tie and keep input order (the order itself is pinned by AO-02, not by the scenario). Each row shows the first 12 characters of its id followed by `…`.
5. **Row expansion:** clicking the W1 row shows `workflow-agent-detail` containing `Model:` and `claude-haiku-4-5`.
6. **Modal:** clicking `View raw logs` opens a dialog with the label. It contains `Turn #1` (the `TurnHeader` row), and `dialog.locator('tbody tr.cursor-pointer')` has count 4: W1's 4 records, header row excluded. It also contains `Billing section added.` in a row summary or after expanding the last row. Pressing Escape closes it.
7. **No network cost:** the `/api/` request counter is unchanged (NFR).

Run while iterating: `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03"`.

**Legacy e2e (existing check `e2e-fast`, a locator update only, not a new test).** `tests/e2e/session-log-view.spec.ts:623-628` currently clicks `getByRole('button', { name: <bare id>, exact: true })`. It is replaced by `page.locator('[data-testid="workflow-agent-row"][data-agent-id="<bare id>"]').click()`. The prompt is now also the row label, so the L629 assertion becomes `page.getByTestId('workflow-agent-detail').getByText(WORKFLOW_AGENT_PROMPT)` (visible).

## Visual/UX notes

- **Placement:** the table sits where the "Agents (N)" collapsible content is today (`WorkflowNode.tsx:187-199`), inside the dashed left border. The collapsible trigger itself does not change.
- **Width:** the table is `w-auto max-w-4xl` with `table-fixed`, so it is not stretched across wide screens (`.claude/rules/client.md` spacing rule). Column widths:
  - `#`: `w-10`, right-aligned;
  - Task: flexible, `min-w-0`, the label in a `truncate` block;
  - Duration: `w-20`, right-aligned mono;
  - Tokens: `w-20`, right-aligned mono;
  - Cost: `w-24`, right-aligned mono.
- **Header:** uppercase `text-[10px] tracking-wider text-muted-foreground`, as in the wireframe.
- **States:**
  - **Collapsed:** the row shows a `ChevronRight` before the number.
  - **Expanded:** the chevron rotates 90°, and the detail row has a `bg-muted/20` background.
  - **Hover:** `bg-muted/30`.
- **Nested row:** `↳` in `text-muted-foreground`, an indent of 16px per depth level, label at 11px.
- **Dark mode:** the existing Tailwind tokens and `dark:` purple variant only; no hard-coded hex.

## Wireframes

No change: `wireframes/agents-table.svg` stays as drawn. It differs from the plan in three places, and the plan wins:
- the id length: 12, not 8 (DD-7);
- the duration and cost formats: DD-8;
- the nested row gets the id line too (FR-1).

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Parser: agent timing | 4 | Data layer; everything below reads `startMs`/`durationMs`. |
| 2 | Row logic and algorithm doc | 5 | Pure module + its doc-driven test; needs chunk 1 types. |
| 3 | Detail extraction | 4 | Shared detail body + raw-logs modal; independent of chunk 2 but before chunk 4. |
| 4 | Table and wiring | 5 | Needs chunks 2–3. |
| 5 | KB docs | 5 | After code is final. |
| 6 | Tests | 6 | Last; scenario step, legacy locator, visual check, verification. |

### Chunk 1 — Parser: agent timing
- [ ] In `types.ts`, add `startMs?: number` with an "Epoch ms of the agent's first timestamped transcript record" doc comment to `SubAgentNode`, right after `durationMs`.
- [ ] In `log-parser.ts`, add exported `agentLogTimeSpan(logs)` near `firstUserPromptText`, per Design Decision DD-4. It takes the min and max of string `timestamp` values that `Date.parse` accepts.
- [ ] In `buildAgentNodesForIds`, call `agentLogTimeSpan(logs)` and conditionally spread `startMs` and `durationMs = endMs − startMs` into the node, per DD-4.
- [ ] Update the `buildAgentNodesForIds` doc comment: timing now comes from the agent's own log, and output order stays the `agentIds` input order (sorting is in `orderAgentRows`).

### Chunk 2 — Row logic and algorithm doc
- [ ] In `prompt-turn-helpers.tsx`, export `AGENT_ID_LIMIT = 12` and `truncateAgentId`, moved verbatim from `SubAgentNode.tsx:32-36`; make `SubAgentNode.tsx` import them.
- [ ] Create `workflow-agent-rows.ts` exporting the `AgentRow` type and `orderAgentRows(forest)`, per DD-5 (stable, non-mutating, depth-first, string numbers).
- [ ] In `workflow-agent-rows.ts`, export `AGENT_LABEL_LIMIT = 60` and `agentRowLabel(node)`, per DD-6.
- [ ] Create `docs/knowledgebase/algorithms/workflow-agent-rows.md` in the README format, with front-matter `reviewed: no` and `reviewer: none`. Its Rules section is DD-5 plus a Label subsection (DD-6), and its examples AO-01…AO-07, AL-01…AL-06 and Mutations are as listed in the Test coverage plan. Add its row to `algorithms/README.md`.
- [ ] Create `workflow-agent-rows.algo.test.ts` (the vitest `createRequire` loader pattern from `algorithms/README.md`), with the mapping from Test coverage plan. Run client `bun run test`, then the separate AI review with `scripts/algo-docs/review-prompt.md`.

### Chunk 3 — Detail extraction
- [ ] Create `SubAgentDetail.tsx` holding the body from `SubAgentNode.tsx:75-203` (prompt collapse, model, tokens and cost tooltip, duration, Skills, Rules, Tools and modal, Files), with props per DD-3. Do not include the children recursion.
- [ ] In `SubAgentDetail.tsx`, render the "🔍 View raw logs" button under the prompt only when `onViewRawLogs` is set, per DD-10. Its `onClick` calls `stopPropagation`.
- [ ] Rewrite `SubAgentNode.tsx` as its trigger, then `<SubAgentDetail>`, then the existing `children` recursion inside `CollapsibleContent`. Rendered output must be the same as today.
- [ ] Create `AgentRawLogsModal.tsx` per DD-11 (memoized `parseSessionLogs` → `parsedSession`), reusing `RawLogsTab` from `./RawLogsTab` and `Dialog`, `DialogContent`, `DialogHeader` and `DialogTitle` from `../../../ui/dialog`.

### Chunk 4 — Table and wiring
- [ ] Create `WorkflowAgentsTable.tsx`. Props: `agentNodes`, `subagentLogsMap?`, `pricing?`, `sessionModel?`. It computes `useMemo(() => orderAgentRows(agentNodes), [agentNodes])` and renders header and rows per DD-8, DD-9 and Visual/UX notes.
- [ ] In `WorkflowAgentsTable.tsx`, keep an expanded-ids `Set<string>`. The row click and the `#`-cell toggle button (keyboard access) both toggle it. An expanded row renders the `workflow-agent-detail` row with `<SubAgentDetail onViewRawLogs>`. All per DD-9.
- [ ] In `WorkflowAgentsTable.tsx`, add `rawLogsAgent` state as `SubAgentNode | null` and render `AgentRawLogsModal` when it is set, passing `pricing` and `model = node.model ?? sessionModel`, per DD-10 and DD-11.
- [ ] In `WorkflowNode.tsx`, add the optional prop `subagentLogsMap?: Map<string, Record<string, unknown>[]>`. Replace the L187-199 `SubAgentNode` map with `<WorkflowAgentsTable>` and remove the unused `SubAgentNode` import.
- [ ] In `PromptTurnItem.tsx` (L260-271), pass `subagentLogsMap={subagentLogsMap}` to `WorkflowNode`. Then run the fast set (lint, both typechecks, `bun run test`).

### Chunk 5 — KB docs
- [ ] In `docs/knowledgebase/session-log-view.md`, update the file table (L32-33) with `WorkflowAgentsTable`, `SubAgentDetail`, `AgentRawLogsModal` and `workflow-agent-rows.ts`.
- [ ] In `session-log-view.md` § "Workflow 'Agents (N)' drill-down" (L427-453), describe the table, DD-4 timing, DD-5 ordering (link `algorithms/workflow-agent-rows.md`), DD-6 label, DD-8 formats and the DD-10/DD-11 raw-logs modal.
- [ ] In `docs/knowledgebase/client-component-map.md`, update the `SubAgentNode.tsx` and `WorkflowNode.tsx` entries (L290-291), and add rows for `WorkflowAgentsTable.tsx`, `SubAgentDetail.tsx`, `AgentRawLogsModal.tsx` and `workflow-agent-rows.ts`.
- [ ] In `docs/knowledgebase/raw-logs-renderers.md`, add `AgentRawLogsModal` as a second `RawLogsTab` consumer: one agent's log array plus that agent's own `parseSessionLogs(..., { isSubagent: true })` result as `parsedSession`, which gives one `TurnHeader`.
- [ ] In `docs/knowledgebase/index.md`, next to the other algorithm entries (e.g. L44 `harness-snapshot`), add `* [Workflow Agent Rows Algorithm](algorithms/workflow-agent-rows.md) - Read before touching the "#" numbering in the workflow Agents table`.

### Chunk 6 — Tests
- [ ] In `tests/scenarios/view/s-sess-03.spec.ts`, add step `8b. GS-05 workflow Agents table: …` after step 8a, covering items 1–3 of the scenario step in Test coverage plan (request counter, opening the workflow, the 2-row value table).
- [ ] In the same step 8b, cover items 4–7: `#` set `{1,2}` and 12-char id lines, W1 row expansion showing `claude-haiku-4-5`, the View raw logs dialog with 4 rows, Escape closes it, and the request counter is unchanged.
- [ ] Update the S-SESS-03 header comment's Data line in the spec, and S-SESS-03 in `docs/qaa-overview/scenarios/03-session-view-reports-golden.md` (L353-372): GS-05 in Data, plus the new step and its checks.
- [ ] In `tests/e2e/session-log-view.spec.ts:623-628`, replace the `getByRole('button', { name: <bare id> })` click with the `workflow-agent-row`/`data-agent-id` locator, and scope the L629 prompt assertion to `workflow-agent-detail`. Both per Test coverage plan.
- [ ] Visual check (`use-playwright` skill, dev app) of a real workflow run with a nested agent. Confirm the `↳` prefix, the 16px indent, the 11px label, the `N.M` number directly below the parent, and keyboard toggling through the `#` button. See Test coverage plan "Nested-row rendering".
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03"`, then the full final set per `adlc-lh:workcycle`.
