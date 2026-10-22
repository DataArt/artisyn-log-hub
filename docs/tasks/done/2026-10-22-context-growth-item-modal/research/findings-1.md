I read everything needed for the plan and changed no files. Three things matter most. FR-4 cannot work as written, because `turn.toolCalls` drops Read/Edit/Write/MultiEdit/Glob/Skill/Agent calls. `ContextGrowthChart.tsx` is already over the hard 20 KB component limit, so it has to be split. The repo root is never exposed, so FR-15 has nothing to work from.

## Requirements summary
Client only, with no hook or API change. On the Context Growth chart, expanded sub-step rows become clickable and open a "Turn #N · Step k" modal. It lists every tool call of that step in call order as collapsible blocks, with the largest result expanded, and shows the step's assistant text and stop reason. Each call is joined to its result by tool_use id, through a new `toolCallIds: string[]` on `assistantSteps`.

FR-2a fixes an off-by-one in the step delta:
- Row `si` shows `steps[si+1].ctx − steps[si].ctx`.
- The last row shows "—".
- The first row shows a delta, not an absolute "Nk tok".
- Bar, label, tooltip and modal all use this rule.

Tool rendering moves into a shared `ToolCallDetailModal` view, used by the chart modal, the Logs tab (`PromptTurnItem`) and `SubAgentDetail`:
- Header: tool name, status, ≈tokens (`result.length / charsPerToken`).
- Output capped at 60 vh, with the existing truncation, show all and copy. No result shows "Output not captured".
- File tools show path, bytes and tokens from `turn.files`. Agent shows description, prompt and a sub-agent link. Other tools show pretty-printed JSON.

Bash gets a syntax-tree view built on `web-tree-sitter` + `tree-sitter-bash`, loaded lazily:
- The command is shown as an indented script. A leading `cd` becomes a working-dir header and heredocs over 8 lines fold.
- Above it, a Changes / Reads / Runs file summary, with inline scripts listed as "not analysed".
- Formatted / Raw toggle, "Copy original", duration, and interrupted / error badges.
- Paths are shown repo-relative.
- PowerShell or an unparseable command falls back to the raw text.

A new session tab `bash` (`tab=bash&bashCall=<tool_use id>`) is a master-detail list of every Bash call from the main session and its sub-agents, merged by time. Rows carry a sub-agent badge; ↑/↓ moves the selection; there is an empty state. The formatter is an algorithm doc plus a `*.algo.test.ts` with anonymized examples, including a re-parse token-equality invariant.

## Wireframes
All are in `docs/tasks/todo/2026-10-22-context-growth-item-modal/wireframes/`. They are gitignored, as is `bash-format-examples.md`.
- **chart-substep-clickable.svg**
  - Hover state on a sub-step row: light blue, pointer cursor, underlined label, a "details →" hint, and the tooltip is kept.
  - Rows are focusable: Enter opens the modal, Esc closes it, and focus returns to the row.
  - Delta examples: first row "+1k", last row "—", and a tooltip line "+20k tokens · own output + tool results".
  - Turn rows and compaction rows are unchanged.
- **bash-step-modal.svg** (callouts A–H)
  - A, header: badge, ✓ ok / ✗ error / ⏸ interrupted, ⏱ duration, time, step delta, result ≈tokens, description as caption, `timeout` / `run_in_background` chips.
  - B, WORKING DIR.
  - C, FILES (best effort): Changes / Reads / Runs / Inline, empty groups hidden, more than 3 files grouped by directory.
  - D/E, COMMAND: Formatted | Raw toggle, "N lines (was M)", ⧉ Copy original, line numbers, token tint legend (operators/keywords, redirects, strings, variables).
  - F, OUTPUT: "N lines · KB · ≈k tokens", copy, "Show all", and a footnote "showing the first 200 lines / 20 KB". This conflicts with the current `TRUNCATE_AT = 2000` chars.
  - G, folded heredoc blocks. H, close behaviour.
- **multi-call-and-other-steps.svg**
  - Numbered collapsible call blocks with "Expand all / Collapse" and a "largest" tag.
  - Read block: Path / Range / Size, plus the note "File content is not stored".
  - Error block has a red border. A missing result shows "output not captured" and size "—".
  - Variants: text-only step (stop reason), Agent step ("Open sub-agent agent-xxxx (14 turns, ≈38k tok) →"), generic MCP step (`postgres:query`, INPUT JSON).
- **bash-formatting-examples.svg**: raw / formatted / files for cmd-01, 07, 16, 18 and 34. It also shows the fallback and the three COMMAND header states (default, Raw with "✓ copied original", fallback with no toggle).
- **session-bash-tab.svg**
  - The tab bar shows a count badge ("Bash 10").
  - Left list rows: #, time, duration, "changes N", interrupted badge, preview.
  - Selected row has a blue bar. Sub-agent badge and "Open sub-agent →" sit in the details pane.
  - Empty state.

## Knowledgebase
- `docs/knowledgebase/session-log-view.md`: parser rules. All parsing is client-side from `/logs`.
  - `ToolCallDetailModal` is shared by `PromptTurnItem` and `SubAgentDetail`.
  - Sub-agent maps (`subagentLogsMap`, `agentParentMap`) are keyed by bare id; `stripAgentPrefix` removes the `agent-` prefix.
  - `WorkflowAgentModal` opens one agent's session (Logs + Raw logs tabs) with no extra request. It is the obvious target for "Open sub-agent".
  - This article needs updating: `assistantSteps` fields and the modal description.
- `docs/knowledgebase/algorithms/README.md`: doc format.
  - Required sections: Purpose, Code, Rules, Edge cases, Examples (exactly one ```examples JSON block of `{id,input,expected,note}`), Mutations, Where visible.
  - Front-matter `reviewed: no / reviewer: none`, then an AI review via `scripts/algo-docs/review-prompt.md`.
  - The client test uses `createRequire(import.meta.url)('../../../../scripts/algo-docs/load-examples.cjs')`.
  - The new doc needs a row in the README table.
  - `scripts/__tests__/algo-docs.test.js` loads every doc, so a malformed doc fails `npm run test:scripts`.
- `docs/knowledgebase/test/client-unit-tests.md`: only `*.algo.test.ts` files are allowed. Vitest runs with `environment: 'node'`, so the WASM must load from a node_modules path in tests and from a `?url` asset in the browser.
- `docs/knowledgebase/token-byte-ratio.md`: estimate with `resolveCharsPerToken(pricing, model)`, falling back to `BYTES_PER_TOKEN = 3.5` (`log-parser.ts:41,53`). Never apply it to API usage numbers.
- `docs/knowledgebase/client-component-map.md` (lines 165, 281, 291, 352) and `client-routing-and-layout.md:90`: update after adding the tab and components. Heavy tabs are `lazy()` in `SessionDetailPane`.
- `docs/knowledgebase/ui-principles.md`: light-only colour scheme, `#3b82f6` for bars, tooltips use `variant="light"`.
- `docs/knowledgebase/test/scenarios.md` and `tests/scenarios/README.md`: scenario conventions.
- `docs/knowledgebase/static-asset-serving.md`: `.wasm` is already precompressed (`client/scripts/precompress.cjs:37`) and served as `application/wasm` (`server/src/common/precompressed-static.ts:62`). The CSP already allows `'wasm-unsafe-eval'` and `connect-src 'self'` (`server/src/common/security-headers.ts:19`).

## Existing patterns
**Chart:** `client/src/viewer/pages/repository/session-log/charts/context-usage/ContextGrowthChart.tsx`, 26 386 bytes, 678 lines.
- `:143` `fullToolDetail` builds the flattened tooltip text.
- `:195-197` state: `hoveredIdx` / `selectedTurn` / `expandedTurns`. The modal must sit beside these so expansion and scroll survive (FR-5).
- `:359` `hasSubSteps = steps.length > 1`.
- `:451-622` sub-step rows. `:454-470` is the buggy delta. `:472-495` builds the step label. `:507-546` the tooltip. `:549-553` the row (no click, no focus). `:610-612` the first-row "Nk tok" label and the `Math.max(0, deltaK)` clamp.
- `:642-675` turn dialog using `Dialog` / `DialogContent` from `@/ui/dialog`, plus the "Raw text is not stored" footer.
- Used in three places: `charts/ChartsDashboardTab.tsx:164`, `SessionChartsTab.tsx:186`, and `summary/SummaryExtendedDetails.tsx:306`. The last one is on the non-lazy Summary tab, so the formatter must load via `import()`.

**Parser:** `client/src/viewer/pages/repository/session-log/log-parser.ts`.
- `:2081-2121` builds `assistantSteps`. Here `toolCallNames` filters out blocks without a name, but `toolCallSummaries` / `toolCallInputs` do not, so the indexes can drift. `toolCallIds` goes here.
- `:2124-2139` merges consecutive steps with equal `contextTokens`; ids must be concatenated there too.
- `:2369` the turn push.
- `:545` `extractToolCallsInTurn` keeps the id, name, input and assistant `timestamp`.
- `:581` `extractToolResultContent` searches all events by `tool_use_id`, but drops the result timestamp and `toolUseResult`.
- `:629` `buildToolCallDetails`:
  - `:640` `SKIP` excludes Skill, Agent, Read, Edit, Write, MultiEdit and Glob.
  - It sorts by timestamp.
  - A missing result becomes `status: 'error'`.
  - Permission flags are matched by tool name.
- `:86` `normaliseClientPath(abs, repoRoot)`.
- `:2831` `effectiveRoot` is auto-detected (shortest CLAUDE.md path, or a common prefix) but not exported.
- `:168` `sumCtxTokens`. `:136` `summarizeToolCall`.

**Types:** `session-log/types.ts`.
- `:161` `ToolCallDetail {id?, name, input, result?, status, permission*}` has no timestamps and no interrupted flag.
- `:307-315` the inline `assistantSteps` element type. Extract it to a named type.
- `:386` `ParsedSession` has no `repoRoot`.

**Tool views:**
- `session-log/ToolCallDetailModal.tsx:18` has `TRUNCATE_AT = 2000`. `:22` uses `useCopyToClipboard(call.result)`. `:56-64` shows the status badges. `:74-76` prints the input as `JSON.stringify`. Split this into a reusable body and a modal shell.
- `session-log/prompt-turn-helpers.tsx:360` `ToolCallRow` (`estTok = result.length / charsPerToken`). `getOtherToolStyle` / `formatOtherToolName` give the badge colours and the `mcp__a__b` → `a:b` label.
- Call sites: `PromptTurnItem.tsx:279` and `SubAgentDetail.tsx:182`, each with `selectedCall` state. Neither passes `turn.files`, `charsPerToken` or a repo root to the modal yet.

**Outcome and duration:** `session-log/usage/session-usage-derive.ts`.
- `:87` `classifyToolOutcome`. `:101` `resolveToolDuration`, which prefers `toolUseResult.durationMs`, then `totalDurationMs`, then the result-minus-tool_use timestamp delta.
- `:530-537` reads `toolUseResult.interrupted`.
- `:355` `walkTranscript` and `:679` `deriveSessionUsage(main, subagentLogs[])` walk the main and sub-agent transcripts; sidechain lines are skipped in main. This is the pattern for gathering Bash calls across the tree.

**Sub-agent naming:** `session-log/harness-usage/harness-session-tree.ts`.
- `:125` `collectAgentTypes` reads artisyn `SubagentStart.agent_type`.
- `:145` `collectSpawnedAgentTypes` falls back to `subagent_type` / `description` paired through `toolUseResult.agentId`.
- `:263` builds the label `Agent · <type>`.
- `charts/subagent-sessions.ts` gives an alternative label, "Agent N" or "<workflow>:Agent N".

**Tabs:**
- `client/src/viewer/tab-ids.ts:11` `SESSION_TABS`.
- `useRepositoryViewState.ts:29` `parseSessionTab`.
- `SessionDetailPane.tsx`: `:40-60` lazy tab imports; `:244-305` tab buttons (`tabTestId('session', id)`); `:372-469` content switch. This file is 17 934 bytes.
- URL sub-param precedent: `reports/ReportsPanel.tsx:36-92` (`report` param, `setSearchParams(next, {replace:true})`) and `useRepositorySettingsTabState.ts:24-35`.

**Help doc:** `client/public/help/session-log.md` is the docRef target in the tour registry.

**Scenarios:**
- `tests/scenarios/view/s-sess-03.spec.ts:132-146`, step 6, clicks Logs → turn 2 Tools → Bash and asserts `"command": "rm -rf build"` (JSON input), `Result`, and a `copy` button. It will break when the Bash view lands, so extend it there for AC-5 / AC-6.
- `tests/scenarios/tours/screen-registry.ts`: `:581-660` `SESSION_TAB_ROWS` (needs a `session.bash` row) and `:692-694` `CHART_ROWS` (`context-growth` expects `growth-row`).
- `tours/tour-10-registry.spec.ts:29-50` meta-checks `SESSION_TABS` against registry rows, so adding `bash` without a row fails it.
- `tours/tour-05-session-detail.spec.ts:103-112` covers the Charts sub-tabs.
- Fixtures:
  - `tests/scenarios/helpers/prompt-session.ts:53` `promptSessionBodies` and `:193` `uploadSubagent` build custom uploads, as S-SESS-03 step 6a does.
  - Golden sessions in `tests/golden/`:
    - GS-07 has Bash `npm test` / `ls /root` (errors), `rm -rf build` (denied) and `echo ok`.
    - GS-01 has 2 Bash calls.
    - GS-02 has a sub-agent tree with only one Bash call, at the root.
  - Helpers live in `tests/scenarios/helpers/session-view.ts` (`openSession`, `logTurns`, `uploadGoldenRepo`).

**PoC:** `docs/pocs/2026-10-22-2035-bash-pretty-format/bash-view.mjs`.
- Exports `init` (`:19`; `Parser.init()` + `Language.load(wasm path)`), `parse` (`:27`), `format` (`:201`, returns `{ok, script}`), `analyze` (`:264`, returns `{root, written, read, runs, scripts, unresolved}`) and `liftCd` (`:395`).
- Constants: `WIDTH=80`, `IND='  '`, and command tables at `:210-213`.
- `format.mjs` adds `fileList` (more than 3 → grouped by directory) and `foldHeredocs` (`HEREDOC_INLINE_MAX = 8`).
- `verify.mjs` holds the token-equality and idempotency checks.
- Dependencies: `web-tree-sitter` 0.27.1 (MIT, `web-tree-sitter.wasm` 210 415 B) and `tree-sitter-bash` 0.25.1 (MIT, `tree-sitter-bash.wasm` 1 358 224 B). `tree-sitter-bash` has an `"install": "node-gyp-build"` script and native prebuilds.

## Open gaps
1. **FR-4 vs `SKIP`.** `turn.toolCalls` omits Read/Edit/Write/MultiEdit/Glob/Skill/Agent (`log-parser.ts:640`), so results for file tools and Agent cannot be found in `turn.toolCalls` by id. The plan must choose: an unfiltered per-turn list, an id → result map on the turn, or removing the filter. Removing it changes the Logs Tools section, `buildToolsSummary` and the `context-data.ts:78` slices.
2. **"Output not captured" vs status.** `buildToolCallDetails` sets `status: 'error'` when no result is found, which conflicts with FR-8's muted state and the wireframe's "output not captured" with no error badge. A distinct "missing" state is needed, and S-SESS-03 currently asserts on the error behaviour.
3. **Duration and interrupted (FR-22).** `ToolCallDetail` has no tool_use / result timestamps and no `toolUseResult`; they must be added. Also decide whether `resolveToolDuration`'s preference for self-reported `durationMs` is acceptable, since FR-22 says "timestamps".
4. **Repo root (FR-15).** No caller passes `repoRoot`, and `effectiveRoot` is computed but not exposed on `ParsedSession`. A Bash-only session with no Read files or CLAUDE.md path may detect no root at all. The plan needs a source: expose `effectiveRoot`, use the transcript's per-line `cwd`, or both. It must also cover sub-agent transcripts and the Bash tab, which work from raw logs.
5. **Component size.** `ContextGrowthChart.tsx` (26 386 B) is already over the hard 20 KB limit and must be split as part of this work (sub-step row, step modal, delta helper). `SessionDetailPane.tsx` (17 934 B) will grow past the 10 KB soft limit too.
6. **FR-2a edge cases.**
   - The turn's `contextTokens` is overridden by `compact_boundary.preTokens` (`log-parser.ts` ~2060-2076). In a compaction turn, Σ step deltas ≠ `contextTokens − contextTokensStart`.
   - Rounding each step to k can make the rounded sum differ from the turn's rounded delta.
   - Negative mid-turn deltas are clamped today by `Math.max(0, …)`; decide display.
   - `toolCallNames` filters unnamed blocks while summaries / inputs / ids do not, so their indexes can drift.
   - Single-step turns render no sub-step rows (`steps.length > 1`), so their calls stay unreachable from the chart.
7. **Lazy WASM and Vite.** The repo has no `import()` of a WASM library to copy; React.lazy (e.g. for `@react-pdf`) is the only lazy-loading pattern. The plan must decide:
   - `?url` imports for both `.wasm` files and `Parser.init({ locateFile })`.
   - A split between browser init and node init for the vitest algo test.
   - How to keep it out of the main bundle, given the Summary tab embeds the chart non-lazily.
   - How to check AC-9 (bundle inspection, or a network assertion in a scenario).
   - Whether bun runs `tree-sitter-bash`'s `node-gyp-build` install script (only the `.wasm` is needed) and whether the npm license and dependency check passes.
8. **Algorithm doc.** None exists for this. Name, IDs, anonymized inputs (the PoC samples contain local paths) and the token-sequence invariant check (re-parse inside the test) all need designing. The test must not depend on the gitignored `bash-format-examples.md`. AC-4 refers to that file, but the anonymized doc table has to be the checked source.
9. **Bash tab data.**
   - No existing helper extracts Bash calls with their tool_use / result timestamps across main and sub-agent transcripts; `deriveSessionUsage` / `walkTranscript` is the closest model.
   - "Link to that sub-agent" has no URL target; the nearest is opening `WorkflowAgentModal` for the agent id.
   - The tab-bar count badge in the wireframe has no precedent in `SessionDetailPane`.
   - The `bash` tab also needs a row in the screen registry and an entry in the help doc.
10. **Scenario fixtures.**
    - No golden session has a multi-step turn with a ~20k-token Bash output followed by a small Read (AC-2a).
    - No golden session has an interrupted Bash call (AC-12) or sub-agent Bash calls (AC-10a).
    - "38 Bash calls" (AC-10) refers to the user's local session.
    - The plan needs either a new golden fixture or a custom upload built with `promptSessionBodies` / `uploadSubagent`. The likely home is an extension of S-SESS-03 (Logs and chart) or the tour registry (Bash tab), not a new scenario file unless justified.
11. **Truncation unit.** The wireframe says "first 200 lines / 20 KB" but the existing code cuts at 2000 chars, and FR-8 says to reuse the existing truncation. Pick one.
12. **Token tint.** The wireframe's syntax colouring (operators/keywords, redirects, strings, variables) is not in the FRs and has no existing highlighter. Decide whether it is in scope.
