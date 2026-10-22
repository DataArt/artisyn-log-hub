# Implementation plan: Context Growth Chart — Item Details Modal

## TL;DR

- **Scope:** client feature, plus one server rule change (DD-21b) and one additive hook change (DD-25).
  - Server: a rejection is read from `toolDenialKind`, else from marker text on an `is_error` result.
  - Hook (`2.24.0`): records `tool_use_id` on `PostToolUseFailure` and `PermissionDenied`, and `reason` on `PermissionDenied`.
  - No API or DB change.
- **New npm packages (client):** `web-tree-sitter@0.27.1` and `tree-sitter-bash@0.25.1`, both MIT.
  - Loaded only through `import()` and `?url` WASM assets (210 415 B + 1 358 224 B), never in the main bundle.
  - `vite.config.ts` gets `optimizeDeps.exclude: ['web-tree-sitter']`.
- **New tool-call core** (`session-log/tool-calls.ts`, `session-log/tool-outcome.ts`) replaces the hard-coded `SKIP` / `fileToolNames` / name-only permission matching:
  - `TOOL_SECTION` / `toolSection(name)` classifies every tool.
  - `buildToolResultIndex` is one pass per log and replaces 4 per-call linear scans.
  - `buildAllToolCalls` and `attributePermissionEvents` match by name + input in a time window.
  - `classifyToolOutcome` is shared by Logs and Statistics.
  - Validated on 130 058 real tool calls (`research/findings-2.md`).
- **Data model** (`types.ts`):
  - `PromptTurn.allToolCalls` and `SubAgentNode.allToolCalls`; `toolCalls`, `files` and `skills` derive from them.
  - `ToolCallDetail` gains `section`, `startedAt`/`endedAt`/`durationMs`, `interrupted`, and status `'success' | 'error' | 'rejected' | 'missing'`.
  - `FileAccess`, `SkillInvocation` and `AgentActivation` gain `toolUseId` and `status` (plus `error` on files).
  - `AssistantStep.toolCallIds` and `ParsedSession.repoRoot` are new.
- **User-visible number changes, all corrections:**
  - Gantt / agent `toolCallCount` and heatmap no longer double-count images: −964 on the real sample, +17 Agent calls with no activation.
  - Failed Reads no longer add bytes.
  - 21 calls go `error` → `rejected` and 2 go → `missing`.
  - Permission badges land on the right call.
  - The Summary label "tool calls" becomes "other tool calls".
- **New pure module `client/src/viewer/lib/bash-view/`:**
  - `loadBashParser`, `formatBash`, `liftCd`, `foldHeredocs`, `analyzeBash`, `groupByDir`, `toRepoRelative`, `highlightBash`, `buildBashView`.
  - Syntax highlighting uses `tree-sitter-bash`'s own `highlights.scm` through the `Query` API.
- **UI:**
  - **Chart:** context-growth step delta bug fix (FR-2a) and clickable sub-step rows with a step modal.
  - **Shared `ToolCallView`:** the Logs modal, chart modal, `SubAgentDetail` and Bash tab all use it; `ToolCallDetailModal` becomes a shell.
  - **Logs status:** failed or rejected file, skill and agent calls are visible and clickable in Logs.
  - **Bash tab:** new session tab `bash` with the URL param `bashCall`.
  - **Refactor:** `SessionTabBar.tsx` extracted; `ContextGrowthChart.tsx` split (26 KB, over the 20 KB limit).
  - **Context:** `ToolViewContext` / `ToolViewProvider` (repo root, `openSubAgent`) owns a `WorkflowAgentModal`.
- **Newly exported:** `collectAgentTypes` and `collectSpawnedAgentTypes` from `harness-session-tree.ts`.
- **Tests:**
  - Three new algorithm docs, each with its table test: `bash-command-view` (client), `tool-call-sections` (client), `tool-call-outcome` (client + server twin).
  - New scenario S-SESS-14.
  - Updates to S-SESS-03 step 6 and the screen registry.
  - New S-HOOK-02 step 8a (hook fields).
  - A final manual check on the local production instance (Chunk 15): a real session with sub-agents and a workflow, walked through with Playwright.
- **Docs:**
  - Help `session-log.md` (Bash tab, statuses).
  - KB: `session-log-view.md`, `client-component-map.md`, `client-routing-and-layout.md`, `session-metrics-scope.md`, `hook-system-overview.md`, `hook-api-versioning.md`, `algorithms/README.md`, `index.md`.
  - Hook docs: `hook/README.md`, `INSTALL_HOOK.md`, `HOW_HOOK_WORKS.md`.
  - `docs/qaa-overview` registration of S-SESS-14.

## Reference

Requirements: [requirements.md](requirements.md). PoC: [`docs/pocs/2026-10-22-2035-bash-pretty-format/`](../../../pocs/2026-10-22-2035-bash-pretty-format/README.md) (`bash-view.mjs` 406 lines, `format.mjs`, `verify.mjs`). Research: `research/findings-1.md` (codebase), `research/findings-2.md` (tool-call real-data validation), `research/findings-3.md` (hook payload PoC).

## Design Decisions

### Tool-call data model

- **DD-1 Sections.** `session-log/tool-calls.ts` is the only place that decides where a tool is shown.
  - `TOOL_SECTION: Record<string, ToolSection>` maps:
    - `Read`/`Edit`/`Write`/`MultiEdit`/`Glob` → `'file'`;
    - `Skill` → `'skill'`;
    - `Agent` → `'agent'`.
  - `toolSection(name)` returns the mapped value or `'tool'` (MCP, NotebookEdit, the legacy `Task`, unknown and new tools).
  - `Task` stays `'tool'`, as today, so section contents on old logs do not change. The real sample has 0 `Task` calls.
  - `FILE_TOOL_NAMES: ReadonlySet<FileAccess['tool']>` is derived from the map. The `FileAccess.tool` union in `types.ts:174` stays the type source, and `tool-calls.ts` imports the type, so there is no import cycle.
  - It replaces the `SKIP` set (`log-parser.ts:640`), `fileToolNames` (`~:2246`) and `name === 'Agent'` checks (`:1020`, `:1510`).
  - Nobody else hard-codes these names.
- **DD-1a Everything derives from `allToolCalls`.**
  - `PromptTurn.allToolCalls` holds every call of the turn in call order (stable sort by `startedAt`, as today).
  - **Derived lists:**
    - `toolCalls` = section `'tool'`.
    - `files` = section `'file'` → `FileAccess`.
    - `skills` = section `'skill'` → `SkillInvocation`; the skill content bytes stay as today.
    - Agent calls link to `agentActivations` / `subAgents` by `toolUseId`.
  - `SubAgentNode.allToolCalls` is aggregated the same way (`log-parser.ts:~1445`), deduped by id because fork sub-agents repeat their parent's ids.
  - **Parity:** the prototype showed 0 mismatches against today's `toolCalls`, `files` and `skills` on 14 443 real logs. Do not change their counts, ids or order.
- **DD-2 Result index.**
  - `buildToolResultIndex(events): Map<toolUseId, ToolResultEntry>` is built once per log.
  - `ToolResultEntry` is `{content, isBinary, isError, timestamp?, interrupted, bytes, uuid, denialKind?}`.
  - `denialKind` is the top-level `toolDenialKind` string of the result's user line. Claude Code writes it next to `toolUseResult`, with the values `user-rejected`, `permission-rule`, `automode-blocked` or `interrupted`; in real data there are 96, 17, 1 and 1 of each.
  - The content and binary rules move unchanged from `extractToolResultContent` (`:581`).
  - `interrupted` is `toolUseResult?.interrupted === true` on the result line.
  - It replaces the per-call linear scans in `extractToolResultContent`, `extractToolResultBytes`, `extractGlobCount` and step 1 of `extractSkillContentBytes`.
  - It is exported for the Bash tab.
- **DD-2a Log-level extractors** in `tool-calls.ts`:
  - **`extractRawToolCalls(events, opts: {uuidSet?: Set<string>; skipSidechain?: boolean})`** returns `{id, name, input, timestamp}[]` from assistant `tool_use` blocks.
    - It covers the whole log, or one turn when `uuidSet` is given.
    - It replaces the private `extractToolCallsInTurn` (`log-parser.ts:545`), and the Bash tab uses it.
  - **`extractPermissionEvents(events): PermissionEvent[]`** replaces `extractArtisynPermissionEvents` (`log-parser.ts:696-731`).
    - It covers the whole log with no window.
    - Each event is `{kind: 'request' | 'denied', toolName, toolInput: unknown | null, ts, toolUseId?}`, read from artisyn `hook_event_name`, `tool_name`, `tool_input`, `timestamp` and `tool_use_id`.
- **DD-3 Outcome and status** (algorithm doc `tool-call-outcome.md`, DD-21b).
  - `REJECTION_MARKERS`, `isRejectionText` and `classifyToolOutcome` move from `usage/session-usage-derive.ts:68-100` into `session-log/tool-outcome.ts`. Both the parser and the Statistics walker import them.
  - **New rule:**
    1. A result with `denialKind` is a rejection. `interrupted` sets `interrupted: true`.
    2. Otherwise a rejection marker counts only when `isError === true`. This removes 4 real false positives, where successful Grep/Bash output contained the marker text.
  - `denialKind` covers denials the markers miss, such as "Claude requested permissions to write to …".
  - **Mapping to `ToolCallDetail.status`:**
    - no result → `'missing'`;
    - `interrupted` or rejection → `'rejected'`, with `interrupted: true` when interrupted and `ToolCallDetail.denialKind` copied;
    - `isError` → `'error'`;
    - otherwise `'success'`.
  - **Badges:**
    - `'missing'` → muted "output not captured";
    - `'rejected'` → amber "⊘ rejected", or "⏸ interrupted" when `interrupted`;
    - the badge `title` maps `denialKind`: `user-rejected` → "rejected by the user", `permission-rule` → "blocked by a permission rule", `automode-blocked` → "blocked by auto mode". It is absent when there is no kind.
    - `'error'` → red "✗ error".
- **DD-4 Duration (FR-22).**
  - `startedAt` is the `tool_use` line's `timestamp`; `endedAt` is the `tool_result` line's `timestamp`.
  - `durationMs = Date.parse(endedAt) − Date.parse(startedAt)` when both exist and the value is ≥ 0, otherwise absent. Timestamps were present on 100% of real lines.
- **DD-5 Step ids.**
  - In the `assistantSteps` builder (`log-parser.ts:2081`), `toolBlocks` keeps only named `tool_use` blocks. Names, summaries, inputs and the new `toolCallIds` (`b.id ?? ''`) all come from that one array.
  - The merge loop (`:2124`) concatenates `toolCallIds`.
  - The element type becomes `export interface AssistantStep`.
- **DD-6 Repo root (FR-15).**
  - `ParsedSession.repoRoot` is `effectiveRoot` (`log-parser.ts:2831`) when non-empty, else the first main event's `cwd`.
  - It uses forward slashes with no trailing slash, and `''` when unknown.
  - Display only; path normalisation is unchanged.
- **DD-7 View context.**
  - `ToolViewContext` = `{repoRoot, openSubAgent?: (agentId: string, label?: string) => void}`, default `{repoRoot: ''}`.
  - `ToolViewProvider` is mounted in `SessionDetailPane` around the whole tab content, so all three `ContextGrowthChart` mounts get it: `SessionChartsTab`, `ChartsDashboardTab` and the Summary tab's `SummaryExtendedDetails.tsx:306`. So do Logs and the Bash tab. It owns one `WorkflowAgentModal`:
    - logs come from `subagentLogsMap`;
    - `label` is the argument, else `Agent <first 8 chars of id>`;
    - the node is found in the `parsedLogs.turns[].subAgents` tree (recursive via `children`), else `{agentId, prompt: '', children: []}`;
    - it is a no-op when there is no transcript.
- **DD-21 Section rows show status.**
  - **`FileAccess`** gains `toolUseId`, `status` and `error?`. `error?` is the first line of the result, cut to `FILE_ERROR_MAX_CHARS = 200` (exported from `tool-calls.ts`), set when status ≠ success.
  - **Failed or rejected Reads** get no `bytes`/`estTokens`, so the error text is no longer counted as file bytes.
  - **`SkillInvocation`** gains `toolUseId` and `status`.
  - **`AgentActivation`** gains `toolUseId`.
  - **Logs Files section (`FileRow`):** it receives the resolved `call?: ToolCallDetail` (from `allToolCalls` by `toolUseId`).
    - It shows the status mark (red ✗ or amber ⊘) from `file.status` and the permission badges from `call`.
    - When `call` is set, the row is clickable and opens `ToolCallDetailModal` with it.
    - The Skills rows do the same.
  - **Agents section:** Agent calls with no activation and no sub-agent node (for example a "Concurrent subagent limit reached" error, or a fork started in the background) are listed as compact rows. Each row shows the badge, description and status, and opens the modal.
- **DD-21a Counts.**
  - `turnToolCallCount(turn)` (`charts/chart-data.ts:187`) becomes `turn.allToolCalls.length`.
  - The heatmap (`turnToolCounts`, `:198`) counts `allToolCalls` by name, so images are no longer added on top of the call that returned them.
  - `context-data.ts` and `session-summary-derive.ts` keep reading `toolCalls`/`files`, unchanged.
  - The Summary band label (`SummaryExecutiveBand.tsx:235`) reads `N other tool calls`.
- **DD-21b Server twin of the outcome rule.**
  - `server/src/logs/tool-stats.ts` `classifyToolOutcome` gets the same rule.
    - `ToolResultInfo` gains `denialKind?: string`.
    - In `server/src/logs/claude-extractor.ts`, the internal `ToolResultRecord` (`:333-339`) gains `denialKind`. It is filled from the result line's `toolDenialKind` where `toolUseResult` is read (`~:1014`) and stored (`toolResults.set`, `~:1048`), and passed into `classifyToolOutcome` at `~:1151`.
    - `denialKind` → `unresolved`; the markers count only when `isError === true`.
  - Its marker list and `isRejectionText` stay.
  - Both twins are pinned by `algorithms/tool-call-outcome.md`.
  - Existing `session_tool_stats` rows are not recomputed; there are 4 affected calls in 130 k.
- **DD-22 Permission attribution.** `attributePermissionEvents(permEvents, calls)` runs per log, main and each sub-agent.
  - **Event inputs:** artisyn `PermissionRequest`/`PermissionDenied` events with `tool_name`, `tool_input` and `timestamp` (read by `extractPermissionEvents`, DD-2a), plus `tool_use_id`.
    - `PermissionDenied` carries `tool_use_id` from hook 2.24.0 (DD-25).
    - `PermissionRequest` never carries it, because Claude Code does not provide it (PoC). So name + input stays the only join for requests.
  - **Algorithm:**
    1. If the event has `tool_use_id`, take the call with that id.
    2. Otherwise the candidates are the calls with the same name, not yet flagged for this event kind, and pending at `t`: `startedAt − PERMISSION_WINDOW_MS ≤ t ≤ (endedAt ?? +∞) + PERMISSION_WINDOW_MS`, where `PERMISSION_WINDOW_MS = 2000`.
    3. Score each candidate:
       - 3 = deep-equal input;
       - 2 = the call's input is a deep subset of the event's `tool_input`, because the hook adds defaults;
       - 1 = the event's `tool_input` is null (old hooks).
       - Drop score 0.
    4. Pick the highest score; on a tie, the latest `startedAt ≤ t`.
    5. No candidate → unattributed. Never fall back to name only.
  - **Result:**
    - `permissionRequested`/`permissionDenied` are set on the matched `ToolCallDetail` in any section.
    - A user's "no" shows as `'rejected'` (DD-3).
  - `ParsedSession.unattributedPermissionEvents` is a count, for diagnostics only.
- **DD-22a Deep compare.** `deepEqual(a, b)` and `deepSubset(sub, sup)` live in `tool-calls.ts`.
  - They work over JSON values, ignore object key order and compare arrays by position.
  - `deepSubset` requires every key of `sub` to exist in `sup` with a deep-subset value.

### Context growth chart

- **DD-8 Step delta rule (FR-2a).** `stepBars(turn)` returns one `{prior, total, delta}` entry per step.
  - Row `si` before the last: `prior = steps[si].contextTokens`, `total = steps[si+1].contextTokens`, `delta = total − prior`.
  - Last row: `prior = total = steps[last].contextTokens`, `delta = null`, rendered "—" with no blue segment.
  - Negative deltas are signed (`−3k`) with a zero-width segment and no clamp. Labels are `Math.round(delta/1000)` + `k`, with `+` on positive values.
  - Σ of the deltas equals `contextTokens − contextTokensStart` except in compaction turns, whose turn value is `preTokens`.
  - The bar, right label, tooltip line (`+20k tokens · own output + tool results`) and the modal header all use it.
- **DD-9 Sub-step rows.**
  - `role="button"`, `tabIndex=0`, pointer cursor, `hover:bg-blue-50`, an underlined label and a "details →" hint on hover.
  - Click or Enter/Space opens the modal. The tooltip stays.
  - Single-step turns, turn rows and compaction rows are unchanged.
- **DD-10 Step modal (FR-2, FR-3, FR-5).**
  - **Placement:** `selectedStep` state sits beside `selectedTurn`, and the modal is a sibling `Dialog`, so expansion and scroll survive.
  - **Title:** `Turn #N · Step k`, `Δ`, time.
  - **Calls:** one collapsible `ToolCallView` block per `toolCallIds` entry, looked up in `turn.allToolCalls`.
    - An empty or unknown id renders from the step's name and input with status `'missing'`.
    - A single call is expanded; with several, the largest `result.length` is expanded and tagged "largest". "Expand all / Collapse all" appears with more than one call.
  - **Text:** the assistant text and `stop: <reason>` come last. There is no footer.

### Shared tool view and Bash rendering

- **DD-11 Shared tool view (FR-6..FR-9).** `tool-call-view/ToolCallView.tsx` takes the props `{call, charsPerToken, turnFiles?, subAgents?, defaultOpen?}`.
  - **Header:**
    - the tool badge (`formatOtherToolName` / `getOtherToolStyle`);
    - the status badge (DD-3) and permission badges;
    - `≈N tok` (`Math.round(result.length / charsPerToken)`);
    - for Bash, `⏱` duration.
  - **Body by `call.name`:**
    - `Bash` → `BashCommandView`.
    - `PowerShell` → `BashCommandView` with `forceFallback`.
    - Section `'file'` → `FileToolBody`: Path (repo-relative), Range (`offset`/`limit`), Size from `turnFiles` (same `toolUseId`), the input JSON, and for Read the note "File content is not stored".
    - `Agent` → `AgentToolBody`: description, prompt, and "Open sub-agent →" when `openSubAgent` is set and a `subAgents` node has `toolUseID === call.id`.
    - Anything else → `GenericToolBody` (pretty JSON).
  - **Output:** always `ToolOutputBlock`.
  - **Modal shell:** `ToolCallDetailModal` = `Dialog` + `ToolCallView`, with the props `{call, onClose, charsPerToken?, turnFiles?, subAgents?}`. The default for `charsPerToken` is `BYTES_PER_TOKEN`.
- **DD-12 Output block (FR-8).**
  - `TRUNCATE_AT = 20000` chars (raised from 2000).
  - "show all (N chars)" / "show less", and copy of the full original.
  - `<pre>` keeps whitespace, `max-h-[60vh] overflow-auto`, header `N lines · X KB · ≈Yk tok`.
  - Display goes through `toRepoRelative`. No result → "Output not captured".
  - Footnote: "showing the first 20,000 of N chars". It applies everywhere the block is used.
- **DD-13 Bash view (FR-10..FR-15, FR-22).** `BashCommandView` takes the props `{call, charsPerToken, forceFallback?}` and uses `useBashView(command, forceFallback)`, which returns `{state: 'loading' | 'ready' | 'fallback', view?}`. Top to bottom:
  1. Caption (`description`), with `timeout` / `run_in_background` chips.
  2. WORKING DIR, when a `cd` was lifted.
  3. FILES: Changes / Reads / Runs / Inline. Empty groups are hidden; a group with more than 3 entries is grouped by directory.
  4. COMMAND:
     - a Formatted | Raw toggle and "N lines (was M)";
     - "⧉ Copy original" (copies `input.command`, then "✓ copied original" for 2 s);
     - line numbers, heredoc fold toggles, and syntax highlighting (DD-15a) with a legend.
  5. OUTPUT: the output block (DD-12).

  States:
  - **Loading:** shows the raw text.
  - **Fallback** (`ok:false` or PowerShell): raw text, `whitespace-pre-wrap`, no toggle, no banner, no FILES and no highlighting.
  - **Display:** text goes through `toRepoRelative(text, useToolView().repoRoot)`.
- **DD-14 Lazy parser (FR-16).**
  - `lib/bash-view/bash-parser.ts` exports `loadBashParser({runtimeWasm, languageWasm}): Promise<BashParser>`.
    - It calls `await import('web-tree-sitter')`, then `Parser.init({locateFile: () => runtimeWasm})`, then `Language.load(languageWasm)`.
    - The promise is cached.
    - `BashParser` is `{parse(src): Tree; highlight(text, querySource): QueryCapture[]}`, with one `Query` cached per source.
  - The other modules use `import type` only.
  - `browser-parser.ts`:
    - imports both `.wasm` files with `?url` and `highlights.scm?raw`;
    - exports `getBrowserBashParser()` and `HIGHLIGHT_QUERY`;
    - is reachable only through `import()` from `useBashView`.
  - `.wasm` is already precompressed and served as `application/wasm`, and the CSP allows `'wasm-unsafe-eval'`.
  - `client/vite.config.ts` gets `optimizeDeps: {exclude: ['web-tree-sitter']}`.
  - In node (the test), the paths come from `createRequire(import.meta.url).resolve(...)`.
  - Never add `tree-sitter-bash` to `trustedDependencies`.
- **DD-15 Formatter and analyser** (algorithm doc `bash-command-view.md`, ported from the PoC):
  - **`formatBash(parser, src): {ok, script}`** follows PoC `bash-view.mjs:33-200` and README "Approach" §1. Only whitespace changes:
    - a newline between statements, with `&` kept;
    - a break after `&&`/`||`/`|`/`|&` past 80 columns, the operator at the line end and the continuation indented;
    - loop, `if`, `{}` and `()` bodies indented, and a long `for` list one word per line;
    - everything else verbatim.
    - `WIDTH = 80`, `IND = '  '`. `ok = false` when the root `hasError`, and then `script = src`.
  - **`liftCd(parser, src, script): {workDir | null, script}`.**
  - **`foldHeredocs(parser, src, script): {script, folded: [{n, head, body, lines}]}`.**
    - It folds bodies with more than `HEREDOC_INLINE_MAX = 8` lines.
    - The marker line is `# ▼ block n: L lines, shown below`.
  - **`analyzeBash(parser, src): {workDir, changes, reads, runs, inline, unresolved}`** follows PoC `bash-view.mjs:210-394` and README §2, with the tables at `:210-213`:
    - redirects `>`/`>>`/`&>` → changes, `<` → reads;
    - read and write command tables; others → runs;
    - literal `VAR=` and `for` words are substituted;
    - `cd` is tracked outside pipelines, and subshells get a copy;
    - non-literals go to `unresolved`;
    - inline entries are `"inline <cmd> script, N lines — not analysed"`.
  - **`groupByDir(paths)`** is used only when there are more than `GROUP_BY_DIR_ABOVE = 3` paths, a constant exported from `bash-analyze.ts`.
  - **`toRepoRelative(text, root)`:**
    - It matches `root`, its backslash form and, for `X:/` roots, the msys form `/x/…`, case-insensitively.
    - `root` + `/` or `\` becomes `''`; a bare `root` before end, whitespace, a quote, `;`, `)` or `&` becomes `.`.
    - An empty root returns the text unchanged.
  - **`buildBashView(parser, command, root)`** returns `{ok, workDir, script, rawDisplay, folded, lineCount, rawLineCount, files, firstStatement}`, with display strings relativised.
- **DD-15a Syntax highlighting (FR-13a).**
  - `highlightBash(parser, text, querySource): HighlightSegment[]` returns `{start, end, kind}` segments, sorted, non-overlapping, plain text omitted.
  - The query is `tree-sitter-bash/queries/highlights.scm` plus `(file_redirect) @redirect`.
  - Capture → kind:
    - `@keyword` / `@operator` → `keyword`;
    - `@redirect` / `@number` → `redirect`;
    - `@string` → `string`;
    - `@property` / `@embedded` → `variable`;
    - `@function` → `command`;
    - `@constant` → `flag`;
    - `@comment` → `comment`.
  - Overlaps are painted from the largest node to the smallest, so inner captures win.
  - The highlighted text is the displayed text, re-parsed; this is valid because of the NFR-1 invariant. Fold markers become comments, and expanded folded bodies are one `string` segment.
  - Classes (light theme): `keyword` `text-purple-700`, `redirect` `text-orange-700`, `string` `text-green-700`, `variable` `text-sky-700`, `command` `text-blue-700 font-medium`, `flag` `text-slate-600`, `comment` `text-slate-400 italic`.
  - The legend lists keyword/operator, redirect, string and variable.
- **DD-16 `bash-command-view` examples.**
  - **Format rows (10):** input `{command, root?}`; `expected` is a subset of `{ok, workDir, script, changes, reads, runs, inline, folded}`. They are anonymised (`/work/acme-app`, `C:\work\acme-app`) and cover:
    - a long `&&` chain;
    - `for`;
    - a lifted `cd`;
    - `VAR=` substitution;
    - a subshell `cd`;
    - heredoc into `node`, folded at more than 8 lines;
    - `sed -i` / `rm` / `cp` / `tee`;
    - `grep` after the pattern;
    - a Windows root;
    - unparseable input.
  - **Highlight rows (3):** input `{command, highlight: true}`, with `expected.highlights: [kind, text][]`:
    - `for f in *.ts; do echo "$f"; done`;
    - `rm -rf dist > out.log 2>&1`;
    - `X=1 node -e 'x' # note`.
  - **Token invariant (NFR-1):** checked on every `ok` row.
  - **Local samples:** the test never reads the gitignored `bash-format-examples.md`.
- **DD-16a `tool-call-sections` examples** (client, `tool-calls.ts`).
  - Input is `{calls: [{id, name, input, result?, isError?, ts, endTs?}], perms?: [{kind, tool_name, tool_input, ts, tool_use_id?}]}`.
  - `expected` covers `{sections: {id: section}, flags: {id: 'requested' | 'denied'}, unattributed}`.
  - About 10 rows:
    - each section, plus an unknown MCP tool and `Task`;
    - two Bash calls with the 2nd requested (exact match);
    - a hook-added default (subset match);
    - an event with a null input (time only);
    - an event outside every window (unattributed);
    - an event that carries `tool_use_id`.
- **DD-16b `tool-call-outcome` examples** (client `tool-outcome.ts`, server `tool-stats.ts`).
  - Input is `{result: null | {isError, text, interrupted?, denialKind?}}`; `expected` is `{outcome}`, and on the client also `{status}`.
  - 10 rows:
    - no result;
    - success;
    - `is_error` failure;
    - rejection text with `is_error`;
    - rejection text without `is_error` (success);
    - interrupted (`interrupted: true`, no `denialKind`) → server `unresolved`, client `rejected` with the interrupted flag;
    - curly-apostrophe marker;
    - "permission denied" command output (failure);
    - `denialKind: permission-rule` with text "Claude requested permissions to write to …" (no marker matches) → rejected;
    - `denialKind: interrupted` → server `unresolved`, client `rejected` and interrupted.
  - The client `status` column follows DD-3. The server only has `outcome` (`success` / `failure` / `unresolved`), and its test ignores `status`.

### Session Bash tab

- **DD-17 Collection.** `bash-tab/collect-bash-calls.ts` exports `collectBashCalls(mainLogs, subagentLogsMap): BashCallRow[]`.
  - `BashCallRow = ToolCallDetail & {id: string; n: number; agentId: string | null; agentLabel: string | null}`. It is built per log with `buildAllToolCalls(extractRawToolCalls(events, {skipSidechain: true}), buildToolResultIndex(events))` (main transcript, then each sub-agent) and filtered to `name === 'Bash'`.
  - Rows are deduped by id, sorted by `startedAt` (missing last, stable) and numbered after sorting.
  - Labels come from `collectAgentTypes` / `collectSpawnedAgentTypes` (`harness-session-tree.ts:123,143`, newly exported) as `Agent · <type>`, else `Agent <8 chars>`.
- **DD-18 Bash tab UI (FR-17..FR-21).** `SessionBashTab` takes the props `{mainLogs, subagentLogsMap, pricing?, sessionModel?}` and computes `charsPerToken = resolveCharsPerToken(...)`. The root has `data-testid="session-bash-tab"`.
  - **Left list:** `w-[340px]`, `role="listbox"`, `tabIndex=0`, ↑/↓ move the selection with `scrollIntoView`. Each row (`bash-call-row`, `data-call-id`) shows:
    - `#n`, time, duration;
    - a status mark;
    - "changes N" (> 0 only);
    - a preview: `description`, else `firstStatement`, else the first raw line;
    - a sub-agent badge.
  - **Selection:** the selected row gets a 3 px `#3b82f6` bar.
  - **Right pane:** sub-agent badge, "Open sub-agent →" (`openSubAgent(agentId, agentLabel)`), then `ToolCallView`.
  - **Parser:** `useBashViews(rows)` loads the parser once. Before that there are no chips and previews are raw.
  - **Empty state:** "No Bash commands in this session".
- **DD-19 URL.**
  - `bashCall` is handled through `useSearchParams` and `setSearchParams(next, {replace: true})` (`reports/ReportsPanel.tsx:36-92`).
  - A missing or unknown id selects row 1 without rewriting the URL.
- **DD-20 Tab bar.**
  - Data-driven `SessionTabBar.tsx` replaces `SessionDetailPane.tsx:244-305`, keeping ids, labels, order, conditional tabs and `tabTestId`.
  - Bash comes after Logs and is always visible. Its label is `Bash` plus a muted count, where the count is the memoised `collectBashCalls(...).length` and needs no WASM.

### Hook

- **DD-25 Hook: record call identity where Claude Code provides it** (PoC on Claude Code 2.1.280, `research/findings-3.md`).
  - **What the payloads carry:**
    - `PostToolUseFailure` carries `tool_use_id`, `error`, `is_interrupt` and `duration_ms`.
    - `PermissionDenied` carries `tool_use_id` and `reason`, and fires only for auto-mode classifier denials.
    - `PermissionRequest` has no id and no other join key.
  - **`hook/.claude/telemetry_tool/lifecycle-hook.js:105-115`:**
    - `PostToolUseFailure` adds `event.tool_use_id = input.tool_use_id || null`.
    - `PermissionDenied` (split from the shared `PermissionRequest` case) adds `event.tool_use_id` and `event.reason = input.reason || null`.
    - `PermissionRequest` is unchanged.
    - The change is additive. Old Claude Code versions give `null`, and old hooks simply lack the fields; the client handles both (DD-22).
  - **Server impact:** none. Both server readers of artisyn `tool_use_id` filter to `PostToolUse`, so the new ids on other events are not mistaken for edit records:
    - `extractEditResultRecords` (`server/src/logs/artisyn-extractor.ts:617`);
    - `server/src/logs/change-surface/changed-paths.sql.ts:162`, which also requires `edit_result`.
  - **Version and propagation:**
    - Bump `hook/.claude/telemetry_tool/version.json` to `2.24.0` (MINOR, a new telemetry field).
    - Run `npm run build:hooks-installer`.
    - Refresh `.artisyn/marketplace/plugins/log-hub-hooks/` (copy `lifecycle-hook.js` and `version.json` into `scripts/`, and bump `.claude-plugin/plugin.json` `version`) per `.claude/rules/hook.md`.
    - Run the `update-install-instructions` skill.
  - **Not done:** a `PreToolUse` hook to cache ids for `PermissionRequest`. It would spawn a node process on every tool call, and name + input matching already attributes requests correctly (41 / 43 real events, the other 2 rightly unattributed).
  - **Denials with no permission event:** deny rules, `dontAsk` and `-p` without a prompt host fire no permission event. They are read from the transcript's `toolDenialKind` (DD-2, DD-3).

## Files to create/modify

### Tool-call core and parser

| Path | Purpose | Note |
|---|---|---|
| `client/src/viewer/pages/repository/session-log/tool-calls.ts` | `TOOL_SECTION`, `toolSection`, `FILE_TOOL_NAMES`, `buildToolResultIndex`, `buildAllToolCalls`, `attributePermissionEvents`, `deepEqual`, `deepSubset` | DD-1, DD-2, DD-22 |
| `client/src/viewer/pages/repository/session-log/tool-outcome.ts` | `REJECTION_MARKERS`, `isRejectionText`, `classifyToolOutcome`, `outcomeToStatus` | DD-3 |
| `client/src/viewer/pages/repository/session-log/tool-calls.algo.test.ts` | table test for `tool-call-sections` | DD-16a |
| `client/src/viewer/pages/repository/session-log/tool-outcome.algo.test.ts` | table test for `tool-call-outcome` (client) | DD-16b |
| `client/src/viewer/pages/repository/session-log/usage/session-usage-derive.ts` | import the outcome rule from `tool-outcome.ts` | DD-3 |
| `client/src/viewer/pages/repository/session-log/types.ts` | `AssistantStep`, `ToolCallDetail`, `FileAccess`, `SkillInvocation`, `AgentActivation`, `PromptTurn.allToolCalls`, `SubAgentNode.allToolCalls`, `ParsedSession.repoRoot`/`unattributedPermissionEvents` | DD-1..DD-6, DD-21, DD-22 |
| `client/src/viewer/pages/repository/session-log/log-parser.ts` | derive the sections from `allToolCalls`; remove `SKIP`/`fileToolNames`/linear scans; steps; root; permissions | DD-1a..DD-6, DD-21, DD-22 |
| `client/src/viewer/pages/repository/session-log/charts/chart-data.ts` | `turnToolCallCount`, heatmap from `allToolCalls` | DD-21a |
| `client/src/viewer/pages/repository/session-log/summary/SummaryExecutiveBand.tsx` | "other tool calls" | DD-21a |
| `server/src/logs/tool-stats.ts` | rejection gated on `isError` | DD-21b |
| `server/src/logs/tool-stats.algo.spec.ts` | table test for `tool-call-outcome` (server) | DD-16b |
| `server/src/logs/claude-extractor.ts` | `ToolResultRecord.denialKind` from `toolDenialKind`, passed into `classifyToolOutcome` | DD-21b |
| `hook/.claude/telemetry_tool/lifecycle-hook.js` | `tool_use_id` on `PostToolUseFailure` / `PermissionDenied`, `reason` on `PermissionDenied` | DD-25 |
| `hook/.claude/telemetry_tool/version.json` | `2.24.0` | DD-25 |
| `.artisyn/marketplace/plugins/log-hub-hooks/scripts/lifecycle-hook.js`, `scripts/version.json`, `.claude-plugin/plugin.json` | dogfooded install refresh | `.claude/rules/hook.md` |
| `hook/INSTALL_HOOK.md`, `hook/HOW_HOOK_WORKS.md` | event field docs, via the `update-install-instructions` skill | DD-25 |
| `hook/README.md` | `:23`: the permission events now also record `tool_use_id` / `reason` | DD-25 |
| `docs/knowledgebase/hook-system-overview.md`, `docs/knowledgebase/hook-api-versioning.md` | the event fields (`~:552`) and a 2.24.0 additive-field note | DD-25 |

### bash-view library

| Path | Purpose | Note |
|---|---|---|
| `client/package.json`, `client/bun.lock` | `web-tree-sitter` 0.27.1, `tree-sitter-bash` 0.25.1 | `bun add` |
| `client/vite.config.ts` | `optimizeDeps.exclude` | DD-14 |
| `client/src/viewer/lib/bash-view/bash-parser.ts` | `loadBashParser`, `BashParser` | DD-14 |
| `client/src/viewer/lib/bash-view/browser-parser.ts` | `?url` WASM, `?raw` query, `getBrowserBashParser`, `HIGHLIGHT_QUERY` | lazy only |
| `client/src/viewer/lib/bash-view/bash-format.ts` | `formatBash`, `liftCd`, `foldHeredocs` | DD-15 |
| `client/src/viewer/lib/bash-view/bash-analyze.ts` | `analyzeBash`, `groupByDir` | DD-15 |
| `client/src/viewer/lib/bash-view/display-paths.ts` | `toRepoRelative` | DD-15 |
| `client/src/viewer/lib/bash-view/bash-highlight.ts` | `highlightBash`, kind → class map | DD-15a |
| `client/src/viewer/lib/bash-view/bash-view.ts` | `buildBashView`, `BashView` | DD-15 |
| `client/src/viewer/lib/bash-view/bash-view.algo.test.ts` | table test, highlight rows, token invariant | DD-16 |

### UI

Paths are relative to `client/src/viewer/pages/repository/session-log/` unless absolute.

| Path | Purpose | Note |
|---|---|---|
| `tool-call-view/ToolViewContext.tsx` | context, provider, `useToolView` | DD-7 |
| `tool-call-view/ToolCallView.tsx` | header and body dispatch | DD-11 |
| `tool-call-view/ToolOutputBlock.tsx` | output block | DD-12 |
| `tool-call-view/tool-bodies.tsx` | `FileToolBody`, `AgentToolBody`, `GenericToolBody` | DD-11 |
| `tool-call-view/BashCommandView.tsx` | Bash body | DD-13 |
| `tool-call-view/BashFileSummary.tsx` | FILES | DD-13 |
| `tool-call-view/HighlightedScript.tsx` | highlighted `<pre>`, gutter, legend | DD-15a |
| `tool-call-view/useBashView.ts` | `useBashView`, `useBashViews` | DD-14 |
| `tool-call-view/StatusBadge.tsx` | one status and permission badge renderer for every row and header | DD-3 |
| `ToolCallDetailModal.tsx` | shell over `ToolCallView` | DD-11 |
| `prompt-turn-helpers.tsx` | `ToolCallRow` and `FileRow` use `StatusBadge`; `FileRow` clickable | DD-21 |
| `PromptTurnFilesSection.tsx` | passes `onOpenCall` to `FileRow` | DD-21 |
| `PromptTurnItem.tsx` | modal props; files, skills and agents rows open calls; orphan Agent-call rows | DD-21 |
| `SubAgentDetail.tsx` | modal props; files and tools open calls | DD-21 |
| `charts/context-usage/step-bars.ts` | `stepBars`, `formatStepDelta` | DD-8 |
| `charts/context-usage/step-label.ts` | `stepLabel`, `fullToolDetail` | moved |
| `charts/context-usage/ContextGrowthSubStepRow.tsx` | clickable sub-step row | DD-9 |
| `charts/context-usage/StepDetailsModal.tsx` | step modal | DD-10 |
| `charts/context-usage/TurnBreakdownDialog.tsx` | turn dialog, moved unchanged | |
| `charts/context-usage/ContextGrowthChart.tsx` | composes the pieces | under 20 KB |
| `bash-tab/collect-bash-calls.ts` | `collectBashCalls` | DD-17 |
| `bash-tab/SessionBashTab.tsx`, `bash-tab/BashCallList.tsx`, `bash-tab/useBashCallParam.ts` | the tab | DD-18, DD-19 |
| `harness-usage/harness-session-tree.ts` | export the two collectors | DD-17 |
| `client/src/viewer/tab-ids.ts` | `'bash'` after `'logs'` | |
| `client/src/viewer/pages/repository/SessionTabBar.tsx` | extracted tab bar | DD-20 |
| `client/src/viewer/pages/repository/SessionDetailPane.tsx` | tab bar, lazy Bash tab, provider, count | |

### Docs and tests

| Path | Purpose |
|---|---|
| `docs/knowledgebase/algorithms/bash-command-view.md`, `tool-call-sections.md`, `tool-call-outcome.md`, `README.md` | three new algorithm docs and README rows |
| `client/public/help/session-log.md` | Bash tab, statuses, clickable steps and rows |
| `docs/knowledgebase/session-log-view.md`, `client-component-map.md`, `client-routing-and-layout.md`, `session-metrics-scope.md`, `index.md` | KB |
| `tests/scenarios/view/s-sess-03.spec.ts`, `tests/scenarios/tours/screen-registry.ts` | updates |
| `tests/scenarios/hook/s-hook-02.spec.ts` | new step 8a: the hook records `tool_use_id` / `reason` |
| `tests/scenarios/view/s-sess-14.spec.ts` | new scenario |
| `docs/qaa-overview/scenarios/03-session-view-reports-golden.md`, `docs/qaa-overview/13-new-test-suite.md`, `docs/knowledgebase/test/scenarios.md` | S-SESS-14 registration |

## Dependencies

- `web-tree-sitter` 0.27.1 (MIT): the WASM runtime and the `Parser`/`Language`/`Query` API.
- `tree-sitter-bash` 0.25.1 (MIT): only `tree-sitter-bash.wasm` and `queries/highlights.scm` are used, and its native deps are never built.

## Test coverage plan

The policy allows only algorithm, contract and scenario tests. There is no route change, so there is no contract row.

- **Algorithm, new: `bash-command-view.md`** with `lib/bash-view/bash-view.algo.test.ts` (vitest). It covers FR-10, FR-10a, FR-11, FR-13a, FR-14, FR-15 and the NFR-1 invariant.
- **Algorithm, new: `tool-call-sections.md`** with `session-log/tool-calls.algo.test.ts` (vitest). It covers the sections and permission attribution (DD-1, DD-22).
- **Algorithm, new: `tool-call-outcome.md`** with `session-log/tool-outcome.algo.test.ts` (vitest) and its server twin `server/src/logs/tool-stats.algo.spec.ts` (jest, `npm run test` in `server/`).
- New test files are allowed because each comes with a new doc. `npm run test:scripts` validates the doc format.
- **Scenario, existing: S-SESS-03 step 6.** GS-07 `rm -rf build` now shows the Bash view (COMMAND `rm -rf build`, Changes `build`, Copy original, toggle) and the "⊘ rejected" badge instead of "✗ error", and the header comment is updated. Covers AC-5.
- **Scenario, existing:** check that S-SESS-01 step 6 and S-SESS-04 step 8 still pass. They assert "N tool calls" on the Statistics tab, whose counts change only for marker false positives (none in the golden data).
- **Scenario, existing:** the screen registry gets a `session.bash` row.
- **Scenario, new: S-SESS-14**, `@mode-a @mode-c`. It is justified because no spec covers Context Growth (S-CHART-02 has no spec) and the Bash tab is new. It covers:
  - AC-1, AC-2, AC-2a, AC-3, AC-6 to AC-13;
  - the tool-call ACs (AC-14 to AC-16): a failed Edit in Files, a permission request on the 3rd of three main Bash calls, an orphan Agent call.
- **AC-17** is covered by S-SESS-03 step 6 ("⊘ rejected") and by the `tool-call-outcome` row "rejection text without `is_error` → success".
- **Scenario, existing: S-HOOK-02, new step 8a**, next to step 8, which already feeds `lifecycle-hook.js` a `PostToolUse` payload. It checks that `PostToolUseFailure` and `PermissionDenied` payloads with `tool_use_id` produce telemetry records with `tool_use_id` (plus `reason` for PermissionDenied), and that without it the field is `null`. Covers AC-18.
- **AC-4** is met by the 10 anonymised `bash-command-view` rows, which are shaped after the samples in `bash-format-examples.md`. That file is gitignored and holds real local paths, so no test reads it. A manual check stays possible: run PoC `node format.mjs` and compare.
- **Not tested automatically:** real Claude Code payloads. That is what the PoC was for (`research/findings-3.md`).
- **Manual, on the local production instance (Chunk 15, after the final health run):** redeploy, record one real session with sub-agents, a workflow, multi-line Bash, a failing Edit and a rule-denied Bash, then walk it with Playwright. This checks real data end to end: layout, modals, statuses and numbers that agree across tabs. It is a visual check, not a test file.

## Visual/UX notes

- **Chart rows:** `hover:bg-blue-50 cursor-pointer`, an underlined label, `details →` in `text-primary` on hover, `focus-visible:ring-2 ring-primary/40`; the right label reads `+20k` / `−3k` / `—`.
- **Step modal:** `max-w-3xl max-h-[85vh]`, a scrollable body, bordered call blocks (`border-red-300` on error, `border-amber-300` on rejected), and a header of `#n`, badge, summary, status, `≈tok`, chevron.
- **Bash view:** 10 px uppercase section labels; a gutter in `select-none text-muted-foreground/60`; a fold marker button "▸ block n: L lines".
- **Badges (`StatusBadge`):** `✓ ok` green, `✗ error` red, `⊘ rejected` amber, `⏸ interrupted` amber, `output not captured` grey, `⚠ requested` / `⚠ denied` yellow (as today). Durations use `formatDuration`.
- **Files and Skills rows:**
  - A failed row gets a red ✗ before the path and `title={error}`; a rejected row gets an amber ⊘.
  - Rows that have a call get `cursor-pointer hover:bg-muted/40`. Clicking opens the modal.
  - The tooltip stays.
- **Orphan Agent rows:** under the Agents header, `Agent` badge, description, `StatusBadge`; clickable.
- **Bash tab:** full height, independent scroll, a centred muted empty state, light theme.

### S-SESS-14 fixture

One prompt, `cwd: "/work/ss14-<runId>"` on every line, model `claude-sonnet-4-6`. The ctx values are `cache_read_input_tokens`.

| Step | `tool_use` blocks | ctx | Results |
|---|---|---|---|
| a1 | Bash `cd /work/ss14-<runId> && npm test 2>&1 \| tail -5; rm -rf /work/ss14-<runId>/dist`, Agent A (`subagent_type: "Explore"`) | 10 000 | Bash 70 000 chars (20 000 tok at 3.5); Agent A result with `toolUseResult.agentId` = sub-agent A |
| a2 | Read `src/app.ts`, Grep, Edit `src/app.ts` (fails: `is_error`, "String to replace not found"), Agent B (`subagent_type: "code-reviewer"`) | 30 000 | small; Agent B result with `toolUseResult.agentId` = sub-agent B |
| a3 | Bash `npm run build` (interrupted), PowerShell `Get-ChildItem`, Bash `for x in; do` (unparseable) | 31 000 | 2 000 / 100 / 50 chars |
| a4 | Agent (`description: "lint"`) whose result is `is_error` "Concurrent subagent limit reached", plus text | 31 500 | — |
| a5 | text only, `end_turn` | 32 000 | — |

- **Results:**
  - The a3 Bash results come 1 500 ms after their `tool_use`.
  - The interrupted result carries `toolUseResult: {interrupted: true}`, `toolDenialKind: "interrupted"` and `is_error: true` with "[Request interrupted by user for tool use]".
- **Artisyn body:** gets one `PermissionRequest` with `tool_name: "Bash"` and the a3 unparseable call's exact input, 300 ms after its `tool_use`. Today's name-only matching would flag the first Bash of the turn (a1's).
- **Sub-agents:** transcripts A and B (uploaded with `uploadSubagent`), each with one Bash call, timed between a1 and a3.
  - Agents A and B have sub-agent nodes, so they are not orphan rows. Only "lint" (a4) is orphaned.
- **Second session:** a minimal one with no Bash calls, for the empty state.

### Local production session (Chunk 15)

- **Run:** one `claude -p` session from the repo root.
  - Model sonnet, `--max-turns` about 30, an explicit `--permission-mode`, and `--settings '{"permissions":{"deny":["Bash(rm:*)"]}}'`.
- **Prompt:** asks for read-only work only:
  - two `Agent` sub-agents (Explore) that read code;
  - one small workflow, requested explicitly;
  - multi-line Bash: `cd <abs repo path> && …`, a `for` loop, and a heredoc into `node`;
  - an `Edit` of a string that does not exist, so the call fails;
  - `rm -f tmp/does-not-exist`, which the deny rule blocks (`toolDenialKind: permission-rule`).
- **Expected in the UI:**
  - a Files row with ✗ (the Edit);
  - a Bash row "⊘ rejected", titled "blocked by a permission rule";
  - Bash tab rows from the main session and the sub-agents;
  - a workflow in the Agents views.

### Bash readability checklist (Chunk 15)

The Bash view must read like a short script, not a wall of text. Each item is pass/fail.

1. **Structure:**
   - one statement per line;
   - loop, `if`, `{}` and `()` bodies indented consistently by 2 spaces;
   - no line broken in the middle of a word or string;
   - long `&&` / `|` chains break after the operator, with the continuation indented.
2. **Noise removed:**
   - the leading `cd <abs path>` becomes the WORKING DIR header and the repo root is shown relative;
   - heredocs over 8 lines are folded behind a marker;
   - inline `node -e` / `python -` scripts are not analysed in FILES, only noted as "inline … not analysed".
3. **FILES:**
   - short and correct for the command: Changes / Reads / Runs, no duplicates, no empty groups;
   - more than 3 files grouped by directory;
   - nothing invented from non-bash code.
4. **Highlighting:**
   - keywords/operators, strings, variables and redirects are distinguishable, and the legend is visible;
   - plain command words stay neutral, so the screen is not a rainbow;
   - fallback text (unparseable or PowerShell) is plain.
5. **Hierarchy:**
   - top to bottom: caption (`description`) → WORKING DIR → FILES → COMMAND → OUTPUT, each with its small uppercase label;
   - the output block is visibly separate, height-capped and scrolls on its own;
   - the command is never pushed out of view by the output.
6. **Width:**
   - there is no page-level horizontal scroll;
   - an unbreakable long token (a URL, a hash, a base64 blob) scrolls inside the `<pre>` or wraps there, not across the page;
   - the line-number gutter stays aligned.
7. **Controls:**
   - the Formatted | Raw toggle shows its state clearly;
   - Raw shows the original layout;
   - "Copy original" puts exactly `input.command` on the clipboard (verified via `navigator.clipboard.readText()` in Playwright), and "✓ copied original" appears.
8. **Bash tab list:**
   - each row is one readable line: `#n`, time, duration, status, changes chip, and a preview (`description`, else the first statement);
   - the selected row is obvious;
   - the details pane has no horizontal page scroll.
9. **Better than raw:** for each checked command, the formatted view is clearly easier to read than Raw.
   - Any case where it is worse is a defect, for example an odd break, lost meaning or a misleading FILES entry.
   - Record the command anonymised, fix it, and add it as a new row in `algorithms/bash-command-view.md`.

### Expected values in S-SESS-14

- Turn delta: 32 000 − 10 000 = 22 000.
- Step deltas: a1 +20k, a2 +1k, a3 +1k (31 500 − 31 000 = 500, which rounds to `+1k`), a4 +1k (500, rounds to `+1k`), a5 "—".
  - Raw sum: 20 000 + 1 000 + 500 + 500 = 22 000.
- Bash tab rows: 3 main + 2 sub-agent = 5.
- Files: `src/app.ts` Read (ok) and `src/app.ts` Edit (✗, title "String to replace not found").

## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | Dependencies, config and types | 8 | foundation |
| 2 | Tool-call core modules | 8 | needs chunk 1 |
| 3 | Log parser on `allToolCalls` | 8 | needs chunk 2 |
| 4 | Server twin of the outcome rule | 4 | needs chunk 2 (shared doc rule) |
| 5 | Hook: call identity on failure/denial events | 6 | independent; before the tests |
| 6 | bash-view library | 8 | needs chunk 1 only |
| 7 | Shared tool view | 8 | needs chunks 3 and 6 |
| 8 | Logs wiring, tab bar and provider | 8 | needs chunk 7 |
| 9 | Context Growth chart split and step modal | 7 | needs chunks 3 and 7 |
| 10 | Session Bash tab | 6 | needs chunks 3–8 |
| 11 | Help, KB and algorithm docs | 8 | after the code |
| 12 | Tests: algorithm tests and existing scenarios | 8 | tests |
| 13 | Tests: S-SESS-14 fixture and chart steps | 5 | tests |
| 14 | Tests: S-SESS-14 Logs, Bash tab, registration, S-HOOK-02 | 6 | tests |
| 15 | Local production check with a real session | 8 | last; after the final health run is green |

### Chunk 1 — Dependencies, config and types
- [ ] From `client/`, run `bun add web-tree-sitter@0.27.1 tree-sitter-bash@0.25.1` (exact versions). Do not add either to `trustedDependencies` (DD-14).
- [ ] In `client/vite.config.ts`, add `optimizeDeps: { exclude: ['web-tree-sitter'] }`, merged into any existing `optimizeDeps` (DD-14).
- [ ] In `session-log/types.ts`, extract `export interface AssistantStep` from the inline `assistantSteps` type, add `toolCallIds: string[]`, and use it in `PromptTurn` (DD-5).
- [ ] In `types.ts`, add `export type ToolSection = 'file' | 'skill' | 'agent' | 'tool'`. To `ToolCallDetail`, add `section`, `startedAt?`, `endedAt?`, `durationMs?`, `interrupted?: true`, and widen `status` to `'success' | 'error' | 'rejected' | 'missing'` (DD-1, DD-3, DD-4).
- [ ] In `types.ts`, add `allToolCalls: ToolCallDetail[]` to `PromptTurn` and `allToolCalls?: ToolCallDetail[]` to `SubAgentNode`, each with a doc comment naming them the source of the derived sections (DD-1a).
- [ ] In `types.ts`, add `toolUseId?`, `status?` and `error?` to `FileAccess`; `toolUseId?` and `status?` to `SkillInvocation`; and `toolUseId?` to `AgentActivation` (DD-21).
- [ ] In `types.ts`, add `repoRoot: string` and `unattributedPermissionEvents: number` to `ParsedSession`, with doc comments per DD-6 and DD-22.
- [ ] Run `bun run typecheck` in `client/` and list the errors for chunk 3. Do not silence them.

### Chunk 2 — Tool-call core modules
- [ ] Create `session-log/tool-outcome.ts`. Move `REJECTION_MARKERS`, `MAX_RESULT_TEXT_SCAN`, `isRejectionText` and `classifyToolOutcome` from `usage/session-usage-derive.ts:68-100`, add `denialKind` to its result info type, gate rejection on `isError === true` (DD-3), add `outcomeToStatus(result)` per the DD-3 mapping, and re-import them in `session-usage-derive.ts`.
- [ ] In `usage/session-usage-derive.ts`'s result map (`~:505-540`), read the result line's `toolDenialKind` and pass it as `denialKind` into `classifyToolOutcome`, so that Statistics follows DD-3.
- [ ] Create `session-log/tool-calls.ts` with `TOOL_SECTION`, `toolSection(name)`, `FILE_TOOL_NAMES`, `PERMISSION_WINDOW_MS` and `FILE_ERROR_MAX_CHARS` per DD-1/DD-21/DD-22, plus `deepEqual` and `deepSubset` per DD-22a.
- [ ] In `tool-calls.ts`, add `buildToolResultIndex(events)` per DD-2. Move the content and binary rules from `log-parser.ts:581-627` unchanged, and add `timestamp`, `interrupted`, `bytes`, `uuid` and `denialKind` (the line's `toolDenialKind`).
- [ ] In `tool-calls.ts`, add `buildAllToolCalls(rawCalls, index): ToolCallDetail[]`: `section`, status via `outcomeToStatus`, `startedAt`/`endedAt`/`durationMs` (DD-4), `interrupted`, and `result` as today. Keep the stable sort by `startedAt`.
- [ ] In `tool-calls.ts`, add `extractRawToolCalls(events, {uuidSet?, skipSidechain?})` per DD-2a, moving the body of `extractToolCallsInTurn` (`log-parser.ts:545`). Delete the old function and switch its call site.
- [ ] In `tool-calls.ts`, add `PermissionEvent` and `extractPermissionEvents(events)` per DD-2a, replacing `extractArtisynPermissionEvents` (`log-parser.ts:696-731`): whole log, no window, with `toolInput` and `toolUseId`.
- [ ] In `tool-calls.ts`, add `attributePermissionEvents(permEvents, calls): {unattributed: number}`, which mutates the flags per the DD-22 algorithm (id first, `PERMISSION_WINDOW_MS`, scores 3/2/1, tie-break, no name-only fallback). Run `bun run typecheck` and `bun run lint`.

### Chunk 3 — Log parser on `allToolCalls`
- [ ] In `log-parser.ts`, build `buildToolResultIndex` once per `parseSessionLogs` call. Replace `extractToolResultContent`, `extractToolResultBytes`, `extractGlobCount` and step 1 of `extractSkillContentBytes` with index lookups, then delete the dead functions and `buildToolCallDetails` (DD-2).
- [ ] At the turn builder (`log-parser.ts:~2196-2310`), compute `allToolCalls = buildAllToolCalls(extractRawToolCalls(events, {uuidSet}), index)` and `toolCalls = allToolCalls.filter(c => c.section === 'tool')`. Delete `SKIP`, and add `allToolCalls: []` to the empty-turn literal (`~:1995`).
- [ ] Build `files` from `allToolCalls` with section `'file'`, replacing `fileToolNames` (`:2248`). Set `toolUseId`, `status` and `error` (DD-21), and skip `bytes`/`estTokens` when status ≠ `'success'`. Keep the path, category, accessCount and Glob count rules.
- [ ] Build `skills` from `allToolCalls` with section `'skill'`, adding `toolUseId` and `status`. In `extractAgentActivations` (`:1008`) and `findDirectChildAgentIds` (`:1501`), use `toolSection(name) === 'agent'` and set `AgentActivation.toolUseId`.
- [ ] Replace the name-only permission matching: call `attributePermissionEvents(extractPermissionEvents(events), allToolCallsOfLog)` once per parsed log after the turns are built. Sum `unattributed` into `ParsedSession.unattributedPermissionEvents` (DD-22).
- [ ] In the sub-agent node builder (`log-parser.ts:~1440-1465`), add `allToolCalls` (flat-mapped from `parsed.turns`, deduped by id) and keep `toolCalls`/`files`/`skills` derived as today (DD-1a).
- [ ] In the `assistantSteps` builder (`:2081-2139`), apply DD-5 (named blocks only, `toolCallIds`, merge concat). Compute `repoRoot` per DD-6 and return it with `unattributedPermissionEvents` on `ParsedSession`.
- [ ] Run `bun run typecheck`, `bun run lint` and `bun run test` in `client/`, and fix the fallout (`'rejected'`/`'missing'` branches, the new required fields) without casts.

### Chunk 4 — Server twin of the outcome rule
- [ ] In `server/src/logs/tool-stats.ts`, change `classifyToolOutcome` so that `isRejectionText` makes a call `'unresolved'` only when `result.isError === true`. Update its doc comment (DD-21b).
- [ ] In `server/src/logs/tool-stats.ts`, add `denialKind?: string` to `ToolResultInfo`. Add `denialKind` to `ToolResultRecord` in `claude-extractor.ts` (`:333-339`), fill it where `toolUseResult` is read (`~:1014`) and stored (`~:1048`), and pass it at `~:1151`. Treat it as `unresolved` (DD-21b).
- [ ] Grep `server/src` for other `isRejectionText` callers and apply the same gating where an `isError` is available, or note why not in the doc comment.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm run test` and `npm run perf` in `server/` (`.claude/rules/server.md`).

### Chunk 5 — Hook: call identity on failure/denial events
- [ ] In `hook/.claude/telemetry_tool/lifecycle-hook.js`, add `event.tool_use_id = input.tool_use_id || null` to the `PostToolUseFailure` case. Split `PermissionDenied` out of the shared case and add `tool_use_id` and `event.reason = input.reason || null` there. Update the comments (DD-25).
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to `2.24.0`, then run `npm run build:hooks-installer` at the root.
- [ ] Refresh the dogfooded install: copy `lifecycle-hook.js` and `version.json` into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`, and set `.claude-plugin/plugin.json` `version` to `2.24.0` (`.claude/rules/hook.md`).
- [ ] Run the `update-install-instructions` skill so that `hook/INSTALL_HOOK.md` / `HOW_HOOK_WORKS.md` list the new fields.
- [ ] Update `hook/README.md:23`, `docs/knowledgebase/hook-system-overview.md` (~`:552`, event fields) and `docs/knowledgebase/hook-api-versioning.md` (a 2.24.0 additive-field note: `tool_use_id` on PostToolUseFailure/PermissionDenied, `reason` on PermissionDenied).
- [ ] In `hook/`, run `npm run lint:fix`, `npm run lint` and `npm test`.

### Chunk 6 — bash-view library
- [ ] Create `lib/bash-view/bash-parser.ts`: `loadBashParser({runtimeWasm, languageWasm})`, a cached promise over `import('web-tree-sitter')`, and the `BashParser` type `{parse, highlight}` with a per-source cached `Query` (DD-14, DD-15a).
- [ ] Create `lib/bash-view/browser-parser.ts`, which imports both `.wasm` files with `?url` and `highlights.scm?raw` and exports `getBrowserBashParser()` and `HIGHLIGHT_QUERY` (the raw text plus `\n(file_redirect) @redirect`). Never import it statically (DD-14).
- [ ] Create `lib/bash-view/bash-format.ts`: port `format`, `liftCd` and `foldHeredocs` from the PoC `bash-view.mjs` / `format.mjs` to TypeScript, with `parser` as the first argument and type-only `web-tree-sitter` imports (DD-15).
- [ ] Create `lib/bash-view/bash-analyze.ts`: port `analyze` (PoC `bash-view.mjs:210-394`) as `analyzeBash`, and `fileList` as `groupByDir` (DD-15).
- [ ] Create `lib/bash-view/display-paths.ts` with `toRepoRelative(text, root)` per DD-15.
- [ ] Create `lib/bash-view/bash-highlight.ts` with `HighlightSegment`, `highlightBash(parser, text, querySource)` and the exported kind → class map, per DD-15a.
- [ ] Create `lib/bash-view/bash-view.ts` with `BashView` and `buildBashView(parser, command, root)` per DD-15, including `firstStatement`, `lineCount` and `rawLineCount`.
- [ ] Run `bun run typecheck` and `bun run lint`. Grep that only `bash-parser.ts` and `browser-parser.ts` import `web-tree-sitter` as a value.

### Chunk 7 — Shared tool view
- [ ] Create `tool-call-view/ToolViewContext.tsx` with the context, `useToolView()` and `ToolViewProvider({repoRoot, parsedLogs, subagentLogsMap, pricing, sessionModel, children})`, which owns one `WorkflowAgentModal` (DD-7).
- [ ] Create `tool-call-view/StatusBadge.tsx`, rendering the status and permission badges per DD-3 and Visual/UX notes. It replaces the inline badge code in `ToolCallDetailModal.tsx:46-65` and `prompt-turn-helpers.tsx:~395-415`.
- [ ] Create `tool-call-view/ToolOutputBlock.tsx` per DD-12 (`TRUNCATE_AT = 20000`, show all/less, copy original, `max-h-[60vh]`, header, relativised display, "Output not captured").
- [ ] Create `tool-call-view/useBashView.ts`: `useBashView(command, forceFallback)` (lazy `import()` of `browser-parser`, skipped when `forceFallback`) and `useBashViews(rows)` (one load, `Map<id, BashView>`) (DD-13, DD-14).
- [ ] Create `tool-call-view/HighlightedScript.tsx` (props `{text, segments, lineNumbers}`: `<pre>`, gutter, a span per segment, legend) and `tool-call-view/BashFileSummary.tsx` (FILES groups, `groupByDir` when there are more than 3) (DD-13, DD-15a).
- [ ] Create `tool-call-view/BashCommandView.tsx` per DD-13: caption and chips, WORKING DIR, FILES, COMMAND (toggle, counts, Copy original, `HighlightedScript` with `highlightBash` segments, fold toggles), fallback, then `ToolOutputBlock`.
- [ ] Create `tool-call-view/tool-bodies.tsx` with `FileToolBody`, `AgentToolBody` and `GenericToolBody` per DD-11, each ending in `ToolOutputBlock`.
- [ ] Create `tool-call-view/ToolCallView.tsx` per DD-11 (`StatusBadge`, `≈tok`, duration, dispatch by section and name). Rewrite `ToolCallDetailModal.tsx` as `Dialog` + `ToolCallView` with the props `{call, onClose, charsPerToken?, turnFiles?, subAgents?}`.

### Chunk 8 — Logs wiring, tab bar and provider
- [ ] In `prompt-turn-helpers.tsx`, make `ToolCallRow` use `StatusBadge`. Give `FileRow` optional `call?: ToolCallDetail` and `onOpen` props: the ✗/⊘ mark from `file.status` with `title={file.error}`, permission badges from `call`, and clickable when `call` is set (DD-21).
- [ ] In `PromptTurnFilesSection.tsx`, accept `calls: ToolCallDetail[]` and `onOpenCall(call)`. Resolve each file's `toolUseId` in `calls`, and pass `call` and `onOpen` to its `FileRow`.
- [ ] In `PromptTurnItem.tsx`, open `ToolCallDetailModal` (with `charsPerToken`, `turnFiles={turn.files}` and `subAgents={turn.subAgents}`) from Tools, Files and Skills rows by `toolUseId` via `turn.allToolCalls`.
- [ ] In `PromptTurnItem.tsx`'s Agents section (`:211`), list `turn.allToolCalls` with section `'agent'` whose id matches no activation `toolUseId` and no sub-agent `toolUseID` as compact clickable rows per DD-21. Show the section when either list is non-empty.
- [ ] In `SubAgentDetail.tsx`, pass `charsPerToken`, `turnFiles={agent.files}` and `subAgents={agent.children}` to the modal (`:182`). Make its Files rows open calls from `agent.allToolCalls`.
- [ ] Add `'bash'` after `'logs'` in `tab-ids.ts` `SESSION_TABS`, with a comment. `parseSessionTab` (`useRepositoryViewState.ts:30`) already validates against it.
- [ ] Create `client/src/viewer/pages/repository/SessionTabBar.tsx`, a data-driven bar replacing `SessionDetailPane.tsx:244-305` (same ids, labels, order, conditions and `tabTestId`), adding the `bash` entry after Logs with a `bashCount` prop (DD-20).
- [ ] In `SessionDetailPane.tsx`, render `SessionTabBar` and wrap the tab content in `ToolViewProvider` (`repoRoot={parsedLogs?.repoRoot ?? ''}`, `parsedLogs`, `subagentLogsMap`, pricing, session model) (DD-7). Run `bun run typecheck` and `bun run lint`.

### Chunk 9 — Context Growth chart split and step modal
- [ ] Create `charts/context-usage/step-bars.ts` with `stepBars(turn)` and `formatStepDelta(delta)` (`+20k` / `−3k` / `—`) (DD-8).
- [ ] Create `charts/context-usage/step-label.ts` by moving `fullToolDetail` (`ContextGrowthChart.tsx:143`) and the step-label logic (`:472-495`) into `stepLabel(step, si, count)`.
- [ ] Create `charts/context-usage/TurnBreakdownDialog.tsx` by moving the turn dialog (`ContextGrowthChart.tsx:642-675`) unchanged.
- [ ] Create `charts/context-usage/ContextGrowthSubStepRow.tsx` from `:497-620`: `stepBars` geometry and labels, the tooltip delta line, role/tabIndex/hover, Enter/Space/click → `onOpen(si)` (DD-9), and `data-testid="growth-step-row"`.
- [ ] Create `charts/context-usage/StepDetailsModal.tsx` per DD-10, with `data-testid="step-details-modal"` and `"step-call-block"`.
- [ ] In `ContextGrowthChart.tsx`, compose the pieces, add `selectedStep` beside `selectedTurn`, and pass `charsPerToken`. Confirm it is under 20 KB.
- [ ] In `charts/chart-data.ts`, change `turnToolCallCount` (`:187`) to `turn.allToolCalls.length` and make `turnToolCounts` (`:198`) count `allToolCalls` by name. Change `summary/SummaryExecutiveBand.tsx:235` to `` `${formatInt(derived.toolCalls)} other tool calls` `` (DD-21a). Run `bun run typecheck` and `bun run lint`.

### Chunk 10 — Session Bash tab
- [ ] In `harness-usage/harness-session-tree.ts`, export `collectAgentTypes` and `collectSpawnedAgentTypes` (`:123,143`) unchanged.
- [ ] Create `bash-tab/collect-bash-calls.ts` with `BashCallRow` and `collectBashCalls(mainLogs, subagentLogsMap)` per DD-17: per log, `buildAllToolCalls(extractRawToolCalls(events, {skipSidechain: true}), buildToolResultIndex(events))`.
- [ ] Create `bash-tab/useBashCallParam.ts` (`[selectedId, select]` over `bashCall`, per DD-19).
- [ ] Create `bash-tab/BashCallList.tsx` (listbox, ↑/↓, `scrollIntoView`, rows per DD-18, `bash-call-row`, `data-call-id`).
- [ ] Create `bash-tab/SessionBashTab.tsx` per DD-18: memoised rows, `views = useBashViews(rows)` passed to the list, the empty state, and a details pane with the sub-agent badge, "Open sub-agent →" and `ToolCallView`.
- [ ] In `SessionDetailPane.tsx`, add a lazy `SessionBashTab`, a `tab === 'bash'` case (`mainLogs`, `subagentLogsMap`, pricing, model) and the memoised `bashCount` for `SessionTabBar` (DD-20).

### Chunk 11 — Help, KB and algorithm docs
- [ ] Create `docs/knowledgebase/algorithms/bash-command-view.md` per `algorithms/README.md` (`reviewed: no`, `reviewer: none`; Purpose, Code, Rules from DD-15/DD-15a, Edge cases, Examples per DD-16, Mutations, Where visible).
- [ ] Create `docs/knowledgebase/algorithms/tool-call-sections.md` (Rules from DD-1, DD-22, DD-22a; Examples per DD-16a; Code `session-log/tool-calls.ts`).
- [ ] Create `docs/knowledgebase/algorithms/tool-call-outcome.md` (Rules from DD-3; Examples per DD-16b; Code: client `tool-outcome.ts`, twin server `tool-stats.ts`).
- [ ] Add the three rows to the `algorithms/README.md` table, and to `docs/knowledgebase/index.md` if algorithm docs are listed there. Run the AI review via `scripts/algo-docs/review-prompt.md` and set `reviewed`/`reviewer: ai`.
- [ ] In `client/public/help/session-log.md`, add `### Bash` under `## Tabs`. Document the call statuses (error / rejected / interrupted / output not captured), clickable Files/Skills/Agents rows and clickable Context Growth step rows.
- [ ] Update `docs/knowledgebase/session-log-view.md`: `allToolCalls` and the derived sections, `tool-calls.ts`/`tool-outcome.ts`, statuses, the result index, permission attribution, `toolCallIds`, `repoRoot`, `ToolCallView`, the step delta rule and the Bash tab.
- [ ] Update `docs/knowledgebase/session-metrics-scope.md:425-427` (the client no longer counts rejected or unresolved calls as failures) and its note on `countEditInputPatchLines` crediting (`:278-279`) for the new outcome rule (DD-3, DD-21b).
- [ ] Update `docs/knowledgebase/client-component-map.md` (`:165,281,287,289,291,352` plus new rows for `tool-call-view/*`, `bash-tab/*`, `SessionTabBar`, chart pieces and `lib/bash-view/*`) and `client-routing-and-layout.md:90` (`bash` tab, `bashCall`).

### Chunk 12 — Tests: algorithm tests and existing scenarios
- [ ] Create `lib/bash-view/bash-view.algo.test.ts` following `lib/change-surface-ui.algo.test.ts`: load the `bash-command-view` rows, build the parser in `beforeAll` from `createRequire(import.meta.url).resolve` WASM paths, and assert a subset match of `buildBashView` (DD-16).
- [ ] In the same test, assert the highlight rows (`highlightBash` → `[kind, text]`, with the query read from `fs` plus the `@redirect` line), and the NFR-1 token invariant on every `ok` row.
- [ ] Create `session-log/tool-calls.algo.test.ts` over the `tool-call-sections` rows: run `buildAllToolCalls` and `attributePermissionEvents` and compare sections, flags and the unattributed count (DD-16a).
- [ ] Create `session-log/tool-outcome.algo.test.ts` (client) and `server/src/logs/tool-stats.algo.spec.ts` (server, following `claude-extractor.algo.spec.ts`) over the `tool-call-outcome` rows; the server test skips `status` (DD-16b).
- [ ] Run `bun run test` in `client/`, `npm run test` in `server/` and `npm run test:scripts` at the root.
- [ ] Update `tests/scenarios/view/s-sess-03.spec.ts` step 6 and its header comment per the Test coverage plan (the Bash view and "⊘ rejected"). Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-03"`.
- [ ] Add a `session.bash` row after `session.logs` in `tests/scenarios/tours/screen-registry.ts` `SESSION_TAB_ROWS`: `query: ${SESSION_QUERY}&tab=bash`, `expectTestId: 'session-bash-tab'`, docRef `SESSION_DOC` heading `Bash`.
- [ ] Run `npm run typecheck:tests`, then `npm run test:scenarios -- --mode a --only scenarios --grep "@TOUR-05|@TOUR-10|@S-SESS-01|@S-SESS-04"`.

### Chunk 13 — Tests: S-SESS-14 fixture and chart steps
- [ ] Create `tests/scenarios/view/s-sess-14.spec.ts` (`@S-SESS-14 … @mode-a @mode-c`) with an S-SESS-03-style header comment. Build the fixture per Visual/UX notes → "S-SESS-14 fixture" and upload it as S-SESS-03 step 6a does, plus the sub-agent uploads, the PermissionRequest line and the empty session.
- [ ] Step "chart": collect `.wasm` request URLs from page start. On Charts → Context Growth, expand the turn. Assert no `.wasm` request yet, step labels `+20k`, `+1k`, `+1k`, `+1k`, `—`, and a pointer cursor (AC-1, AC-2a).
- [ ] Step "step modal": click the `+20k` row. Assert that `step-details-modal` shows the Bash command, a `show all (70[,.\u00a0]?000 chars)` button and highlighted tokens (a `text-purple-700` span), and that a `tree-sitter-bash` `.wasm` request was made (AC-2, AC-9, AC-13).
- [ ] Step "paths and close": assert there is no `/work/ss14-` text and that Changes lists `dist` (AC-7). Record `scrollTop`, press Escape, and assert the turn is still expanded and `scrollTop` is unchanged (AC-8).
- [ ] Step "multi-call": open the a3 row and assert 3 `step-call-block`s (Bash, PowerShell, Bash) with the first expanded. Assert that PowerShell and the unparseable command show raw text with no toggle, `⏸ interrupted` and a `⏱` duration on the first, and `⚠ requested` only on the third (AC-3, AC-6, AC-12, AC-15).

### Chunk 14 — Tests: S-SESS-14 Logs, Bash tab, registration, S-HOOK-02
- [ ] Step "logs statuses": on Logs, assert that the Files `src/app.ts` Edit row shows ✗ and that clicking it opens the modal with "String to replace not found". Assert that the Agents section lists the "lint" Agent call with ✗ (AC-14, AC-16).
- [ ] Step "bash tab list": open `tab=bash`. Assert 5 `bash-call-row`s in time order, with the two sub-agent rows badged `Agent · <type>` (AC-10, AC-10a).
- [ ] Step "bash tab URL": press ↓ and assert `bashCall` changes; reload and assert the same row is selected; an unknown `bashCall` selects row 1; the empty session shows "No Bash commands in this session" (AC-11).
- [ ] Add S-SESS-14 to the table and as a section in `docs/qaa-overview/scenarios/03-session-view-reports-golden.md`, add a row in `docs/qaa-overview/13-new-test-suite.md` after S-SESS-13, and mention it in `docs/knowledgebase/test/scenarios.md`.
- [ ] In `tests/scenarios/hook/s-hook-02.spec.ts`, add step 8a after step 8, using the same harness: feed `PostToolUseFailure` and `PermissionDenied` payloads with and without `tool_use_id`, and assert that the telemetry records carry `tool_use_id` / `reason` or `null` (DD-25).
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-SESS-14|@S-HOOK-02"`, then `--mode c`.

### Chunk 15 — Local production check with a real session
- [ ] After the final health run (`finalRun: true`) is green, redeploy the developer's local production instance from the working tree. Follow the developer's own deployment notes, which are outside the repo: keep the previous image for rollback, build, and recreate only the app container. Confirm `/health/version` shows the new build.
- [ ] Confirm that the hook which reports to that instance from this repo is the refreshed 2.24.0 dogfooded install (Chunk 5). Record `git status --short` as the baseline.
- [ ] From the repo root, run one `claude -p` session per Visual/UX notes → "Local production session".
- [ ] Afterwards, check that `git status --short` equals the baseline. Wait for the Stop-hook upload, then find the session in the instance's UI after identifying as the repository owner's email.
- [ ] With Playwright (`use-playwright` skill), at 1440×900 and at 1024×768, open every session tab:
  - Summary;
  - Info;
  - Logs: open every Tools, Files, Skills and Agents row type, plus an orphan or failed agent row if present;
  - Bash: list, ↑/↓, reload with `bashCall`, "Open sub-agent →";
  - Charts → Context Growth: expand turns and open the step modals, including a multi-call step;
  - Statistics;
  - Harness usage.
- [ ] For each view, check:
  - no horizontal overflow, clipped badges or overlapping text;
  - the Bash view passes Visual/UX notes → "Bash readability checklist" for at least 5 real commands of the session: the shortest, the longest, one with a loop, one with a heredoc, and the rejected one. Check both in the step modal and in the Bash tab, at both widths;
  - FILES, WORKING DIR and output show no absolute repo-root path;
  - the failed Edit shows ✗ and the denied `rm` shows ⊘ rejected ("blocked by a permission rule");
  - the workflow agents open in `WorkflowAgentModal`;
  - no console errors.
- [ ] Check that the numbers agree:
  - the Bash tab count equals the Statistics Bash calls (tree);
  - the step deltas of each expanded turn add up to its turn delta (outside compaction turns);
  - Summary "other tool calls" equals the sum of the turns' Tools rows;
  - every modal's `≈tok` equals `result chars / charsPerToken`, checked on two calls.
- [ ] Save the screenshots under the repo `tmp/` folder (gitignored, never the root).
  - If every check passes, leave the new build running on the local production instance. Do not roll back, and keep the previous image tag for a manual rollback.
  - Otherwise fix the defect with the normal work cycle and redeploy, or roll back to the previous image if it cannot be fixed now.
  - Report the outcome with the screenshot paths.
