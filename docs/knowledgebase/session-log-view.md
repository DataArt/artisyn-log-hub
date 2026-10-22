---
type: "Architecture Guide"
title: "Session Log View"
description: "Session log view (Logs tab): component architecture, log parser, tool-call core (sections, status, permission attribution), types, the shared tool view, Context Growth steps, the Bash tab, text extraction, and MCP handling."
tags:
  - client
  - logs
timestamp: "2026-10-22T00:00:00+04:00"
---

# Session Log View

## Overview

The session log view is the **Logs tab** inside `RepositoryView`. It replaces a raw JSON dump with a structured
display of Claude Code telemetry data. All parsing is done **client-side** from raw log events returned by
`GET /api/v1/repositories/:repoId/sessions/:sessionId/logs`.

Key files live in `client/src/viewer/pages/repository/session-log/`:

| File | Purpose |
|---|---|
| `types.ts` | All TypeScript types for log events, turns, and summary |
| `log-parser.ts` | `parseSessionLogs()` — parses raw event array into `ParsedSession` |
| `SessionLogView.tsx` | Root container; renders loading/error states, calls parser, renders `SessionContextPanel` + `PromptTurnList` |
| `SessionContextPanel.tsx` | Collapsible context panel at the top — CLAUDE.md files, rules, MCP tools, skills, agents registered in the session; the Files/Rules tables live in `SystemContextFilesTab.tsx` |
| `instruction-files.ts` | Pure helpers for the Files/Rules tabs: `extractInstructionFiles` (`instructions` attachment), `rulesToInstructionFiles` (on-demand `nested_memory`), `mergeInstructionFiles`, `toUserDisplayPath`, `classifyInstructionRole` |
| `PromptTurnList.tsx` | Scrollable list of prompt turns |
| `PromptTurnItem.tsx` | Single turn row (header + metrics + skills + rules + tools + files + images + agent activations + sub-agents + workflows); clicking a tool, file, skill or orphan Agent-call row opens `ToolCallDetailModal` |
| `tool-calls.ts` | Tool-call core: `TOOL_SECTION` / `toolSection`, `FILE_TOOL_NAMES`, `buildToolResultIndex`, `extractRawToolCalls`, `buildAllToolCalls`, `extractPermissionEvents`, `attributePermissionEvents`, `deepEqual` / `deepSubset` — see [Tool calls](#tool-calls-tool-callsts-tool-outcomets) and `algorithms/tool-call-sections.md` |
| `tool-outcome.ts` | `classifyToolOutcome` / `outcomeToStatus` / `REJECTION_MARKERS` — shared by the parser and the Statistics walker; see `algorithms/tool-call-outcome.md` |
| `tool-call-view/` | The shared tool view (`ToolCallView`, `ToolViewProvider` / `useToolView`, `StatusBadge` / `StatusMark`, `ToolOutputBlock`, `BashCommandView`, `tool-bodies.tsx`, `useBashView`) used by the Logs modal, `SubAgentDetail`, the Context Growth step modal and the Bash tab |
| `ToolCallDetailModal.tsx` | Modal shell for one tool call: `Dialog` + `ToolCallView` (header with badges, a body per tool, the output block) |
| `prompt-turn-helpers.tsx` | Extracted helper components: `ToolCallRow`, `FileRow` (status mark, clickable when it has a call), `ImageRow`, `SectionHeader`, summary builders |
| `bash-tab/` | The session Bash tab: `collectBashCalls`, `SessionBashTab`, `BashCallList`, `useBashCallParam` — see [Bash tab](#bash-tab) |
| `SubAgentNode.tsx` | Collapsible sub-agent node for the turn-level Sub-agents section (supports arbitrary nesting depth); trigger + `children` recursion, the body is `SubAgentDetail` |
| `SubAgentDetail.tsx` | Sub-agent detail body of `SubAgentNode` — prompt (200-char collapse), model, tokens + cost tooltip, duration, Skills, Rules, Tools (`ToolCallDetailModal`), Files |
| `WorkflowNode.tsx` | Collapsible workflow run node; shows name pill + status badge + duration; expands to show args (captioned "Args"), stats strip, summary, the "Agents (N)" table (`WorkflowAgentsTable`, not collapsible), and findings |
| `WorkflowAgentsTable.tsx` | Workflow "Agents (N)" table — `#`, Task, Duration, Tokens, Cost; a row click opens `WorkflowAgentModal` (no inline expansion) |
| `workflow-agent-rows.ts` | Pure row logic for the table: `orderAgentRows` (ordering + `N.M` numbering) and `agentRowLabel` — see `algorithms/workflow-agent-rows.md` |
| `WorkflowAgentModal.tsx` | Modal with one workflow agent's session in two tabs: "Logs" (the same `PromptTurnList` as the Logs tab) and "Raw logs" (the same `RawLogsTab` as the Raw Logs tab) |
| `AgentActivationItem.tsx` | Agent activation row inside session log |
| `CallTreeView.tsx` | Call Tree tab — hierarchical token-cost breakdown tree |
| `SessionInfoTab.tsx` | Info tab — session metadata panel with summary stats (prompts, tokens, work time, cost, max context, etc.), computed via the extracted pure function `computeSessionInfoDerived` (`session-info-derive.ts`) so the same derivation also backs the "Session Statistics Export" feature (`session-export-runner.ts`, see `client-component-map.md`); delegates the Tokens & Cost, Workflows, MCP, and Vision sections to the components below |
| `session-info-derive.ts` | `computeSessionInfoDerived(session, parsedLogs, pricing)` — pure, JSON-serializable derivation of every Info tab field; also exports `groupMcpCallsByServer`, used by `SessionInfoMcpSection.tsx` |
| `session-info-primitives.tsx` | Shared `CollapsibleSection`/`InfoRow` components and formatters used across the Info tab sections |
| `SessionInfoTokensCostSection.tsx` | Info tab — Tokens & Cost budget table |
| `SessionInfoWorkflowsSection.tsx` | Info tab — Workflows section (omitted if no workflows ran) |
| `SessionInfoMcpSection.tsx` | Info tab — MCP Usage section |
| `SessionInfoVisionSection.tsx` | Info tab — Vision/image usage section |
| `call-tree/` | Supporting types and hooks for the call tree |

---

## Log Parser (`log-parser.ts`)

### Entry point

```ts
parseSessionLogs(
  raw: Record<string, unknown>[],
  options?: {
    isSubagent?: boolean;
    repoRoot?: string;
    repoConfig?: RepoConfig | null;
    subagentStats?: Record<string, SubagentStatEntry>;
    workflows?: WorkflowRun[]; // NEW — from SessionLogsData.workflows; attached to turns by toolUseId
  }
): ParsedSession
```

`WorkflowRun` is imported from `client/src/models/workflows.ts` — not re-declared in `types.ts`.

- Filters non-object entries (null, strings, numbers) — silently skipped.
- Builds a `uuid → event` index and a `parentUuid → [childUuid[]]` map.
- Assigns 1-based global index to **all** `type=user` events (including non-qualifying ones).
- Identifies *qualifying* user events: `type=user`, `isSidechain` absent or `false`, `isMeta` absent or `false`,
  `toolUseResult.agentId` absent, `message.content` has at least one `type=text` block.
- Builds `PromptTurn[]` for each qualifying event.
- Computes session-level `SessionSummary`.

### Token counting rules (critical — do NOT change without re-reading this)

Token sources and what to include:

| Source | Field | In `turn.tokenBreakdown`? | In `turn.ownTokenBreakdown`? |
|---|---|---|---|
| Main session assistant events | `message.usage` on `type=assistant` | Yes | Yes |
| Sub-agent final result | `toolUseResult.usage` on `type=user` where `toolUseResult.agentId` is set | Yes | **No** |
| Workflow `session_stats` fallback fold | `subagentStats['agent-<id>']`, gated on `workflowAgentIds` | Yes | **No** |
| Sub-agent streaming (per-response) | `data.message.message.usage` on `type=progress, data.type=agent_progress` | **Never** — double-counts sub-agent work | **Never** |

Double-counting was confirmed in 43/83 observed sessions. Excluding `data.message.message.usage` is intentional.

Every `TokenBreakdown` also carries the required TTL split `cacheWrite5m` / `cacheWrite1h`,
accumulated by `splitCacheWrite(usage)` in `log-parser.ts`: from `usage.cache_creation`'s
`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` when that object is present, and entirely
into the **5m** bucket when it is absent (older transcripts). The same fallback applies to the
sub-agent `toolUseResult.usage` fold and the workflow `session_stats` fold, so
`cacheWrite5m + cacheWrite1h === cacheWrite` holds at every level. Both fields are **required**
`number`s, not optional, so the invariant is structurally guaranteed at every construction site —
do not make them optional to avoid touching a call site. Server twin:
`splitCacheCreationTokens()` in `claude-extractor.ts`. See `llm-call-math.md` § 1.

Three more **required** `number`s on `TokenBreakdown` exist, for the same reason — an optional
field is a field some fold site forgets, and a forgotten field reads as a genuine zero:

| Field | Source on a raw `TokenUsage` | Semantics |
|---|---|---|
| `webSearchRequests` | `usage.server_tool_use.web_search_requests` | Billed **per request** at `model_pricing.price_web_search`, not per token. `web_fetch_requests` is not billed and is not counted |
| `inputFast` | `usage.input_tokens` when `usage.speed === 'fast'` | **Subset of** `input`, not extra tokens |
| `outputFast` | `usage.output_tokens` when `usage.speed === 'fast'` | **Subset of** `output`, not extra tokens |

`usage.speed` absent or `'standard'` contributes 0 to both fast fields, and `input` / `output` keep
their existing grand-total meaning — so `fast + standard = input` holds by construction and nothing
that already reads `input` shifts. Cost therefore prices fast mode as a *surcharge* on the total
(`llm-call-math.md` § 1–§ 2), never as a separate term added on top.

**Every fold in the table above must populate all three.** `breakdownFromUsage()` reads them
directly; the sub-agent `toolUseResult.usage` fold gets them from the same `usage` object; the
workflow `session_stats` fold reads them off the `subagentStats` entry, which is why
`GET :repoId/sessions/:sessionId/logs` grew `webSearchRequests` / `inputTokensFast` /
`outputTokensFast` per agent — without those the fold could only write 0 and would
under-report fast and web-search spend for workflow-driven sessions.

### `PromptTurn.ownTokenBreakdown` — scope

`ownTokenBreakdown: TokenBreakdown | null` is produced by `sumOwnAssistantTokenBreakdown(events,
uuidSet)` and sums **only** the turn's own in-scope `type === 'assistant'` events. It deliberately
receives neither the sub-agent `toolUseResult.usage` fold nor the workflow `session_stats` fold, so
it measures the main session's own cache behaviour rather than the whole descendant tree.
`turn.tokenBreakdown` is unchanged and keeps both folds.

It exists to back the per-turn **cache read ratio** chip (`cacheRead / (cacheRead + cacheWrite)`,
`n/a` at a zero denominator — see `llm-call-math.md` § 8). Because it is a strict subset,
a turn containing sub-agent work must yield an `ownTokenBreakdown` strictly smaller than its
`tokenBreakdown`; nested Skills/Tools rows carry no ratio at all. `null` means the turn had no
in-scope assistant events.

### BFS turn boundary rule

`collectTurnUuids` uses a BFS from the qualifying user event's `uuid` through the `parentUuid → children` map,
but stops at UUIDs of **other qualifying user events**. This keeps per-turn token counts from accumulating
across turn boundaries.

**Work time** is computed from timestamps; `turn_duration` events are not read (they show up only
in Raw Logs). A turn's `workTimeMs` is the timestamp of the **last assistant event** in the turn
minus the qualifying user event's timestamp (`null` when the turn has no later assistant event).
The assistant events come from a second, tighter BFS (`workTimeUuidSet`) that also stops at every
other turn-boundary user event — `<command-name>` lines that do not qualify as prompts.
A `<task-notification>` is **not** a boundary: when a turn hands work to a background agent or
workflow, the main thread stops and is later woken by the notification to finish the job; that
continuation belongs to the prompt, so the turn runs from the user pressing Enter to the last
answer before the next prompt. Tokens, context, tool calls and files keep using the wider
per-turn BFS above.
`totalWorkTimeMs` is the sum over turns. The server's `session_stats.work_time_ms`
(`claude-extractor.ts` `computeWorkTime`) follows the same rule without the parent chain: for each
prompt, the latest assistant timestamp after it and not after the next prompt, minus the prompt's
timestamp. Golden session GS-07 (`tests/golden/`) pins that a `<task-notification>` nobody answers
(five minutes after the last prompt) does not extend work time; S-SESS-03 step 6a pins that an
answered one does.

### Sub-agent nesting

Claude Code can spawn agents that themselves spawn further agents (orchestrator → chunk-agent →
research-agent, 3+ levels deep). Manual Playwright verification against a real historical session
 found that neither of the two transcript-content mechanisms below reliably captures nesting
beyond depth 1, because agents run in the background by default: a background-launched agent's
completion notification can arrive *after* its parent's own session/turn has already ended, so the
parent's own persisted transcript never receives it. One real parent agent was found with 8
genuine `Agent` tool_use calls but **zero** matching completions and **zero** `agent_progress`
events anywhere in its own saved log.

- `parseSessionLogs` accepts an optional `subagentLogs?: Map<string, Record<string, unknown>[]>`
  (agentId → that sub-agent's own raw event array; `SessionLogView.tsx` passes the same
  `subagentLogsMap` built from `logsData.subagents` that's also used for per-turn display). When
  present, each sub-agent's own log is parsed once; its uuids/completions are merged into the
  shared `eventIndex`/`completionMap`, and its `agent_progress` events (when present) are indexed
  by the *owning* agentId (`nestedProgressByOwner`) and pulled into each turn's tree via BFS. This
  feeds `buildSubAgentTree` (unchanged — parentToolUseID/parentUuid matching), but is a **defensive
  best-effort path only**: real captured sub-agent transcripts essentially never contain
  `agent_progress` events, so this rarely finds anything beyond what the root's own transcript
  already shows.

Sub-agents with no event having a non-empty `data.prompt` are omitted entirely.
Sub-agents absent from the completion map fall back to `subagentStats` (from `session_stats`, keyed by
`agent-<agentId>`) for `tokens` when available — this happens for Workflow agents whose `toolUseResult` never
carries inline `usage`. Only when neither source has data are `tokens`/`durationMs` left undefined; `durationMs`
has no fallback and is always sourced from `completionMap` only.

The turn-level "main" `tokenBreakdown`'s own `session_stats` fallback fold (`log-parser.ts:1719`,
just after `workflowAgentIds` is built at `log-parser.ts:1541`) is explicitly restricted to agent
ids present in `workflowAgentIds` — a `Set` built once per session parse from
`workflows[].agentSessionIds` (stripped of the `agent-` prefix) — **not** to any agent whose inline
`toolUseResult.usage` happens to be null. Prior to this fix the guard only checked for a missing
`agentId`/`usage`, so a directly-activated, non-workflow `Agent` completion with null inline usage
(common for background-launched agents) was folded into "main" *and* summed again as the turn's
separate "+subagent" addend (`computeTurnDirectAgentCost`, below) — double-counting that agent's
cost in the displayed `main + subagents (+ workflows) = total` line. Restricting the fold to
confirmed workflow members keeps each agent's cost counted exactly once (see `llm-call-math.md` §6).

**Per-turn sub-agent cost rollup (the actually-reliable path):** the union logic lives in
`computeTurnDirectAgentCost(turn, subagentLogsMap, agentParentMap, pricing)` (`log-parser.ts`) —
**not** inline in `PromptTurnItem.tsx` — so it can be shared by two call sites that must stay
consistent: `PromptTurnItem.tsx`'s own `subagentCost` (its displayed "+subagent" addend) and
`SessionLogView.tsx`'s `costPerToken` estimate (see below), which sums it across every turn to
subtract directly-activated-agent cost out of the workflow-only rate's numerator. It unions three
descendant sources per turn-level `agentActivation`, in order of decreasing reliability:

1. **`collectDescendantAgentIdsFromParentMap`** (log-parser.ts) — the DB-authoritative source.
   `SessionLogView.tsx` builds `agentParentMap: Map<agentId, parentAgentId | null>` directly from
   `logsData.subagents[].parentSessionId` (both stripped of any `agent-` prefix) — this field comes
   from `sessions.parent_session_id` via the `/logs` endpoint (added specifically for this; see
   `api-reference.md`'s `SubagentLog.parentSessionId`) and is threaded down through
   `PromptTurnList` to `PromptTurnItem`. Since it reflects the DB linkage (Chunks 1-2's fix), it is
   correct at any depth regardless of what transcript content does or doesn't contain.
2. `collectDescendantAgentIds` — walks each agent's own transcript for `Agent` tool_use +
   `toolUseResult.agentId` completion pairs (kept as a defensive fallback for the case where the
   completion IS present — e.g. a foreground/blocking agent call).
3. The `SubAgentNode` subtree under `turn.subAgents` (agent_progress-derived, when present) — also
   purely defensive.

Each id in the union is priced independently via `extractSubagentStats`/`subagentLogsMap` at its
own model's rate, deduplicated across activations within a turn via a `counted` Set. If
`agentParentMap` is unavailable (e.g. an older cached response), sources 2-3 still apply; if all
three come up empty, the activation's own tokens are used, the simplest fallback.

### Nested `claude -p` runs are separate sessions (not grouped, by decision)

A session (or one of its sub-agents / workflow agents) can start another Claude Code process through
the Bash or PowerShell tool, e.g. `claude -p --allowedTools "Read,Grep,Glob" < prompt.txt`. Such a run
is **not** a sub-agent and is intentionally shown as an ordinary top-level session in the session
list, not nested under the session that launched it.

Why no linkage exists:

- To Claude Code it is a brand-new standalone session: its transcript is a top-level
  `~/.claude/projects/<slug>/<session-id>.jsonl`, not `<parent-session-id>/subagents/<agent-id>.jsonl`,
  and there is no sibling `.meta.json`. The hook therefore uploads it in the `claude` namespace, not
  `claude-subagent`, and `sessions.parent_session_id` stays `NULL` (the server writes that column only
  for `claude-subagent` uploads, `logs.service.ts` `upsert()`).
- The parent's transcript only holds a Bash `tool_use` with the command line, never the child's
  session id, so none of the three sources in "Sub-agent nesting" above can find it.

Recognising one: a top-level session whose first prompt is a templated instruction (for example the
algorithm-doc reviewer prompt from `scripts/algo-docs/review-prompt.md`), with `parent_session_id` and
`workflow_run_id` both `NULL`, whose time span falls inside another session of the same repo and user.
To confirm, grep the suspected parent's transcript directory (including `subagents/**`) for `claude -p`.
Observed example: the five reviewer sessions of 2026-10-20 21:23–21:34 UTC were started by agent
`a841ae90eb294635f` of workflow `wf_12ca9b05-ef4` inside session `5a834865-…` (`/adlc-lh:implement-deep`).

Research (2026-10-21, Claude Code on Windows), kept for the case the decision is revisited:

- In a hook of the nested process, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` are the **child's own**
  values; Claude Code overwrites them, so the parent id is not visible there. Hook input (stdin)
  carries only the child's `session_id`. No documented hook field, env var or registry file holds
  the parent session id of a separately launched CLI process.
- Non-`CLAUDE_*` environment variables **are** inherited. A parent `SessionStart` hook that appends
  `export SOME_VAR=<session_id>` to `$CLAUDE_ENV_FILE` makes the variable visible to the parent's Bash
  tool, and the nested `claude -p`'s hooks read it (verified end to end). Untested: whether the PowerShell
  tool applies `CLAUDE_ENV_FILE` (a `.sh` file), and the link would point at the root session, not the
  workflow agent that ran the command.
- Alternatives considered: walking the OS process tree to the parent `claude` process (per-OS code,
  PID reuse), and a time-window heuristic in the UI (wrong when several sessions run in parallel in
  one repo).

Decision: none of these is implemented. A `claude -p` run is its own session and its cost is **not**
rolled into the launching session's tree (see `session-metrics-scope.md`).

### Exported utility functions

| Function | Purpose |
|---|---|
| `formatDuration(ms)` | `h:mm:ss` string |
| `formatWorkflowDuration(ms)` | `"Xm Ys"` when ≥60 s, `"Xs"` when <60 s — used in workflow badges |
| `formatInt(n)` | `toLocaleString()` |
| `formatTimestamp(ts)` | ISO string → `YYYY-MM-DD HH:mm:ss`; `'—'` if absent |
| `formatBytes(bytes)` | Human-readable file size (B / KB / MB) |
| `formatCompact(n)` | Compact number (K / M suffix) |
| `getPromptText(turn)` | Joins all `type=text` blocks (string content is instead reconstructed from `<command-name>`/`<command-args>` for slash commands) |
| `stripSystemBlocks(text)` | Removes Claude Code system XML blocks from prompt text |

---

## Tool calls (`tool-calls.ts`, `tool-outcome.ts`)

One module decides where a tool call is shown, how it is joined to its result and which call a
permission event belongs to. Nothing else in the client hard-codes tool names for this (the old
`SKIP` set, `fileToolNames` and `name === 'Agent'` checks are gone).

- **`allToolCalls` is the source.** `PromptTurn.allToolCalls` holds every call of the turn in call
  order (stable sort by `startedAt`, calls without a timestamp last), built by
  `buildAllToolCalls(extractRawToolCalls(events, {uuidSet}), buildToolResultIndex(events))`.
  `SubAgentNode.allToolCalls` is the same over the agent's own transcript, deduped by id (fork
  sub-agents repeat their parent's ids). Everything else derives from it:
  - `toolCalls` = section `'tool'`;
  - `files` = section `'file'` (`Read`/`Edit`/`Write`/`MultiEdit`/`Glob`) → `FileAccess`;
  - `skills` = section `'skill'` → `SkillInvocation` (skill content bytes as before);
  - section `'agent'` calls link to `agentActivations` / `subAgents` by `toolUseId`.
  - Chart counts read `allToolCalls` too: `turnToolCallCount` and the heatmap in
    `charts/chart-data.ts` (an image no longer counts on top of the call that returned it);
    the Summary band says "N other tool calls" for `toolCalls`.
- **Sections** (`toolSection(name)`): `TOOL_SECTION` maps the five file tools, `Skill` and
  `Agent`; every other name (Bash, PowerShell, MCP, `NotebookEdit`, the legacy `Task`, new tools)
  is `'tool'`. Rules and examples: `algorithms/tool-call-sections.md`.
- **Result index** (`buildToolResultIndex`): one pass per log, `tool_use_id` → `{content,
  isBinary, isError, timestamp, interrupted, bytes, uuid, denialKind}`; the first result for an id
  wins. `denialKind` is the result line's top-level `toolDenialKind` (`user-rejected`,
  `permission-rule`, `automode-blocked`, `interrupted`). It replaced four per-call linear scans
  and is also used by the Bash tab.
- **Status** (`outcomeToStatus` over `classifyToolOutcome`): no result → `'missing'` ("output not
  captured"); `interrupted`, a `denialKind`, or a rejection marker on an `is_error` result →
  `'rejected'` ("⊘ rejected", "⏸ interrupted" when `interrupted`, tooltip from `denialKind`);
  other `is_error` → `'error'` ("✗ error"); else `'success'`. A marker in a successful result is
  ordinary output. The Statistics walker (`usage/session-usage-derive.ts`) and the server twin
  `server/src/logs/tool-stats.ts` use the same rule. Rules and examples:
  `algorithms/tool-call-outcome.md`.
- **Timing:** `startedAt` = the `tool_use` line's timestamp, `endedAt` = the `tool_result` line's,
  `durationMs` = their difference when both exist and it is ≥ 0.
- **Section rows carry status (DD-21):** `FileAccess`, `SkillInvocation` and `AgentActivation`
  gain `toolUseId`; files and skills also `status`, and files `error` (the result's first line, cut
  to `FILE_ERROR_MAX_CHARS` = 200). A failed or rejected Read gets no `bytes` / `estTokens`.
- **Permission attribution** (`attributePermissionEvents`, once per log — main and each
  sub-agent): artisyn `PermissionRequest` / `PermissionDenied` events (`extractPermissionEvents`)
  set `permissionRequested` / `permissionDenied` on the call they belong to, in any section. An
  event with `tool_use_id` (`PermissionDenied` from hook 2.24.0) takes that call; otherwise the
  same-name calls pending within `PERMISSION_WINDOW_MS` = 2000 are scored by input (equal 3,
  subset 2, no input 1), the best wins and a tie goes to the latest start at or before the
  event. No match → counted in `ParsedSession.unattributedPermissionEvents` (diagnostics only);
  there is no name-only fallback.
- **Steps:** each `AssistantStep` has `toolCallIds` parallel to `toolCallNames` /
  `toolCallSummaries` / `toolCallInputs` (named `tool_use` blocks only; `''` for a block without
  an id), concatenated when consecutive lines of one response are merged. The Context Growth step
  modal looks them up in `turn.allToolCalls`.
- **`ParsedSession.repoRoot`** (display only): the effective repo root of path normalisation when
  non-empty, else the first main event's `cwd`; forward slashes, no trailing slash, `''` when
  unknown. `ToolViewProvider` passes it to the tool views, which show paths repo-relative with
  `toRepoRelative` (`lib/bash-view/display-paths.ts`). Copy actions use the original text.

### Shared tool view (`tool-call-view/`)

- **`ToolViewProvider`** is mounted by `SessionDetailPane` around the whole tab content, so every
  tool view of every tab (Logs, all three `ContextGrowthChart` mounts, Bash) gets
  `{repoRoot, openSubAgent}`. It owns one `WorkflowAgentModal` that `openSubAgent(agentId,
  label?)` opens with the agent's transcript from `subagentLogsMap` (a no-op without one).
  Outside a provider `useToolView()` returns `{repoRoot: ''}`.
- **`ToolCallView`** `{call, charsPerToken, turnFiles?, subAgents?, defaultOpen?}`: header =
  tool badge, `StatusBadge` (status and permission badges), `≈N tok`, and `⏱` duration for
  Bash. Body by tool: `Bash` → `BashCommandView`; `PowerShell` → `BashCommandView` with
  `forceFallback`; section `'file'` → `FileToolBody` (repo-relative path, range, size from
  `turnFiles`, input JSON, "File content is not stored" for Read); `Agent` → `AgentToolBody`
  (description, prompt, "Open sub-agent →"); anything else → `GenericToolBody` (JSON). Output
  always goes through `ToolOutputBlock` (`TRUNCATE_AT` = 20 000 chars, show all / less, copy of
  the full output, `N lines · X KB · ≈Yk tok`).
- **`BashCommandView`**: caption (`description`, `timeout` / background chips) → WORKING DIR →
  FILES (`BashFileSummary`) → COMMAND (Formatted | Raw toggle, "N lines (was M)", "⧉ Copy
  original" = `input.command`, `HighlightedScript` with line numbers, heredoc folds and a colour
  legend) → OUTPUT. `useBashView` lazy-loads the tree-sitter parser (`lib/bash-view/`,
  `import()` + WASM `?url` assets, never in the main bundle) and shows the raw text while loading
  and for unparseable / PowerShell commands. Rules and examples: `algorithms/bash-command-view.md`.

---

## Types (`types.ts`)

Key types:

- `TelemetryEvent` — union of `UserEvent | AssistantEvent | SystemTurnDurationEvent | SystemCompactBoundaryEvent | ProgressAgentEvent | BaseEvent`
- `PromptTurn` — one user prompt with `workTimeMs`, `tokenBreakdown`, `ownTokenBreakdown: TokenBreakdown | null` (main-session assistant events only — see above), `contextTokens`, `contextTokensStart`, `assistantSteps: AssistantStep[]`, `skills`, `files`, `subAgents`, `agentActivations`, `allToolCalls: ToolCallDetail[]` (every call, the source of the derived lists), `toolCalls: ToolCallDetail[]` (section `'tool'` only), `rulesInjected`, `linesChanged`, `workflows?: WorkflowRun[]`
- `ToolCallDetail` — `id?`, `name`, `input`, `section: ToolSection` (`'file' | 'skill' | 'agent' | 'tool'`), `result?`, `status: ToolCallStatus` (`'success' | 'error' | 'rejected' | 'missing'`), `startedAt?`, `endedAt?`, `durationMs?`, `interrupted?: true`, `denialKind?`, `permissionRequested?`, `permissionDenied?`
- `AssistantStep` (exported) — `contextTokens`, `text`, `stopReason`, `timestamp`, and the parallel arrays `toolCallNames` / `toolCallSummaries` / `toolCallInputs` / `toolCallIds` over the step's named `tool_use` blocks
- `TokenBreakdown` — `input`, `output`, `cacheRead`, `cacheWrite`, plus the required TTL split `cacheWrite5m` / `cacheWrite1h` and the required `webSearchRequests` / `inputFast` / `outputFast` (the fast pair are subsets of `input` / `output`, see above)
- `TokenUsage` — the raw on-wire shape; carries the optional `cache_creation?: { ephemeral_5m_input_tokens?, ephemeral_1h_input_tokens? }` object the TTL split reads, plus `server_tool_use?: { web_search_requests?: number }` and `speed?: 'standard' | 'fast'`
- `WorkflowRun` — re-exported from `client/src/models/workflows.ts`; attached to `PromptTurn.workflows` by log parser during post-turn pass
- `SessionSummary` — session-wide aggregates: `promptCount`, `totalTokens`, `tokenBreakdown`, `totalWorkTimeMs`, `maxContextTokens`, `skillsUsed`, `fileStats`, `linesChanged`, `model?`, `claudeMd?`, `deferredTools: string[]` (tool names announced via `deferred_tools_delta` events)
- `FileAccess` — `path`, `tool`, `accessCount` (1-based), `category: string` (free-form, from `resolveFileCategory`/`RepoConfig`; default config yields `'knowledgebase'`, `'docs'`, or fallback `'code'` — not a fixed `'code'|'doc'` union), `globMatchCount?`, `bytes?`, `estTokens?` (both absent unless the Read succeeded), `toolUseId?`, `status?`, `error?` (first result line, ≤ 200 chars, only when status ≠ success)
- `SkillDefinition` — `name`, `description`, `argumentHint?`, `body`, `path`, `bytes`, `source: 'project'|'builtin'|'plugin'`
- `AgentDefinition` — `name`, `description`, `body`, `path`, `bytes`
- `McpServerConfig` — `name`, `command`, `args` (pre-joined string, credentials scrubbed by hook)
- `SkillInvocation` — `name`, `isDuplicate`, `path?`, `bytes?`, `estTokens?`, `definition?: SkillDefinition` (resolved post-parse), `toolUseId?`, `status?` (of the `Skill` call)
- `SubAgentNode` — `agentId`, `prompt`, `model?`, `tokens?`, `durationMs?`, `toolUseID?`, `parentToolUseID?`, `allToolCalls?` (deduped by id; the source of its `toolCalls` / `files` / `skills`), `children: SubAgentNode[]`
- `AgentActivation` — `toolUseId?` (the `Agent` call), `agentId`, `description?`, `prompt`, `resultText?`, `tokens?`, `totalTokens?`, `durationMs?`
- `RuleInjection` — `name`, `path?`, `bytes?`, `estTokens?`
- `ClaudeMdFile` — `path`, `bytes`, `role?: 'claude-md'|'local-md'|'rule'` (classified by parser; absent = `'claude-md'` for old sessions)
- `ClaudeMdContext` — `totalBytes`, `estTokens`, `files: ClaudeMdFile[]`
- `SessionSummary` — additionally carries `skillDefinitions?: Map<string, SkillDefinition>`, `agentDefinitions?: Map<string, AgentDefinition>`, `mcpConfig?: McpServerConfig[]` (all optional; absent for sessions uploaded by hooks that do not emit the definition events)
- `ParsedSession` includes `mcpCalls: Record<string, number>` — map of `mcp__<server>__<tool>` names → invocation count, accumulated from `tool_use` blocks across all assistant events; `repoRoot: string` (display-only repo root, see [Tool calls](#tool-calls-tool-callsts-tool-outcomets)); `unattributedPermissionEvents: number` (diagnostics)

---

## MCP Burden Display

### SessionContextPanel — MCP Servers block

A collapsible "MCP Servers" section is rendered when `summary.deferredTools` is non-empty. It shows:
- Each unique server name extracted from `mcp__<server>__<tool>` strings in `deferredTools`.
- Per-server: tool count and estimated token weight (`toolCount × 150` tokens, shown as `~N tokens`).
- Total estimated token weight for all MCP servers combined.

`deferredTools` is populated by the log parser collecting all `deferred_tools_delta` event payloads.

### ToolCallRow — MCP tool label

There is no `ToolCard` component. Tool rows are rendered by `ToolCallRow` in `prompt-turn-helpers.tsx`, using
two helpers on `call.name`:
- `getOtherToolStyle(name)` gives `mcp__`-prefixed tools a distinct violet badge color (vs. amber for `Bash`,
  sky for `WebFetch`/`WebSearch`, muted for everything else).
- `formatOtherToolName(name)` strips the `mcp__` prefix and rejoins the remaining `__`-separated segments with
  `:`, e.g. `mcp__playwright__browser_click` → `playwright:browser_click`. This is a single combined
  `server:tool` label in one badge — not a separate server-name pill plus a bare tool name.

### SessionInfoTab — MCP Usage section

A collapsible "MCP Usage" section is rendered when `parsedSession.mcpCalls` has at least one entry. It shows:
- Per-server grouping: server name + total calls for that server.
- Per-tool breakdown within each server: tool name + individual call count.

`mcpCalls` is a flat `Record<string, number>` keyed by full tool name (`mcp__server__tool`); the UI groups by the server segment.

---

## Error / loading states (`SessionLogView`)

| Condition | Display |
|---|---|
| `isLoading=true` | Centered spinner |
| `ApiError(403)` | "No access" |
| `ApiError(422)` | "Log data is unavailable for this session." |
| Any other `ApiError` (401, 404, etc.) | "Failed to load session logs. Please try again." |
| Non-`ApiError` | "Failed to load session logs. Please try again." |
| Empty / all-system turns | "No user prompts found in this session." (from `PromptTurnList`) |

---

## Session Summary Stats

Session-level summary metrics are displayed in `SessionInfoTab.tsx` (the Info tab), not as a standalone panel in the log view. Metrics include prompts, total tokens (with breakdown), work time, cost, max context, skills used, and file stats.

`SessionContextPanel.tsx` (rendered at the top of the Logs tab in `SessionLogView.tsx`) shows the session context burden — CLAUDE.md files, rules, registered skills, registered agents, and MCP server configuration. It is collapsible and is distinct from the summary stats panel.

### System Context Files / Rules — sources and merge

`summary.claudeMd` (Files + Rules tabs, the `N files` chip, Session Info, Call Tree, Context Usage)
is the union of three sources, built in `log-parser.ts` with the helpers in `instruction-files.ts`:

1. the harness snapshot's `systemContext` (hook ≥ 2.22.0; the only source for Claude Code versions
   before ~2.1.280);
2. every `attachment.type === "instructions"` line of the Claude log — `files[]` with `path`, `type`
   (`User` / `Project` / `Local`) and `content` — the initial context;
3. the per-turn `nested_memory` injections (`turn.rulesInjected`) — loaded during the session; they
   carry an internal `onDemand: true` that the UI does **not** show (the tabs and modals do not track
   whether a file was loaded — only name/path, type, size and tokens).

Only path, type (`typeLabel` = attachment `type` lowercased; snapshot-only files fall back to the
role: `local-md` → `local`, `user-md` → `user`, else `project`) and UTF-8 size are kept — **file text is never stored or shown**, from any source (the rule `content` the snapshot
carries is dropped; `RuleDetailModal` has no Body tab). User-type paths are rewritten to
`~/.claude/<rest>` at extraction time and are skipped by the repo-root auto-detection and path
normalisation. The merge runs after normalisation, keyed by the path with `\` → `/` lowercased, in
the order snapshot → `instructions` → on-demand (later wins, first-seen order kept); `totalBytes` is
the sum over the merged set. Call Tree and Context Usage skip `onDemand` files because those bytes
are already counted per turn via `rulesInjected`.

---

## Prompt text extraction pipeline

Prompt text in `type=user` events may contain XML-like system blocks injected by Claude Code. The display pipeline strips these before rendering.

> There used to be a separate `<ide_opened_file>` extraction step (`extractIdeOpenedFiles()` / `IdeOpenedFile` in `prompt-turn-helpers.tsx`, `stripIdeContext()` in `session-list-helpers.tsx`) that pulled IDE-opened-file mentions out of the prompt text and rendered them as filename badges. That code no longer exists anywhere in `client/src/` — it was removed with no replacement. IDE-opened-file text is no longer specially extracted or badged; it is only affected by the generic stripping described below.

### Functions (all in `prompt-turn-helpers.tsx` unless noted)

| Function | File | Purpose |
|---|---|---|
| `stripSystemBlocks(text)` | `log-parser.ts` | Removes Claude Code system XML blocks (e.g. `<system>`, `<context>`) from the raw text. Used first in `PromptTurnItem` before any further stripping. |
| `cleanText(text)` | `prompt-turn-helpers.tsx` | Calls `stripSystemBlocks`, then removes all remaining `<tag>` patterns and collapses whitespace. Used for the one-line collapsed preview in `PromptTurnItem`. |

### Rendering in `PromptTurnItem`

1. `stripSystemBlocks(getPromptText(turn))` → `rawText`
2. `cleanText(rawText)` → `displayText` (used for the collapsed one-line preview)
3. If `displayText === ''`, the trigger shows `(system message)` in italic muted text
4. The expanded collapsible body (rendered by `PromptTurnPromptText.tsx`) shows `rawText` verbatim (XML system blocks stripped, but otherwise unstripped — including any raw `<ide_opened_file>` tags, whitespace, etc.)

### Rendering in `SessionItem` (session list)

`session.firstPrompt` is the server-returned first prompt string, truncated directly via `truncate(text, 50)` in `session-list-helpers.tsx` — no stripping or filtering is applied before truncation.

---

## Prompt Turn Item

Each qualifying user event renders:
- Header: `✦` symbol + timestamp (`YYYY-MM-DD HH:mm:ss` or `—`) + work time (with clock icon and tooltip)
- Collapsible prompt text (collapsed by default; no character truncation), rendered by `PromptTurnPromptText.tsx`; expanded body shows raw text after `stripSystemBlocks` only (not `cleanText`)
- Metrics row: token breakdown (Input / Output / cache_r / cache_w / cache_ratio), optional cost, context tokens (each omitted if null)
  - `cache_ratio` is an emerald pill inserted after `cache_w`, computed from
    `turn.ownTokenBreakdown` (main-session assistant events only, see above) — so it can and does
    differ from a ratio derived from the displayed `cache_w`. Hovering opens a `DetailTooltip` with
    Cache read / Cache write — 5m TTL / Cache write — 1h TTL / **Cache write total (denominator)**
    rows, a mono formula line and a footnote stating the main-session-only scope. A zero
    denominator renders a muted slate `n/a` pill, never `0.0%`. Nested Skills/Tools rows carry no
    ratio.
  - Cost format when no extras: `Cost $X.XX` (violet, with `CostBreakdownTooltip`)
  - Cost format when subagents or workflows present: `$main + $subagents + ~$workflows = $total`; subagent in orange, workflow estimate in amber with `~` prefix
  - Workflow cost rate uses `subAgentCost / totalWorkflowTokens` (DB-accurate) when `session.totalCost` is available; falls back to main session average rate otherwise. Passed as `costPerToken` via `SessionLogView → PromptTurnList → PromptTurnItem`. `subAgentCost` here is `sessionTotalCost - mainCost - directAgentCost`, where `directAgentCost` is the sum of `computeTurnDirectAgentCost` across every turn (the same directly-activated-agent cost already shown per-turn as "+subagent") — subtracted so that cost doesn't also leak into the workflow-only rate's numerator.
- Skills section (omitted if empty): skill name + estimated tokens; duplicate occurrences show a `"dup"` text badge in `text-muted-foreground/60`; a failed / rejected `Skill` call shows a red ✗ / amber ⊘ (`StatusMark`); a row with a call is clickable and opens `ToolCallDetailModal`
- Rules section (omitted if empty): rule name + estimated tokens
- Tools section (omitted if empty): tool call rows (`StatusBadge`: status and permission badges); the preview cell (`tool-call-row-preview`) leads with `input.description` when it is a non-empty string, then the remaining input as muted `key=value` text; clicking opens `ToolCallDetailModal`
- Files section (omitted if empty): grouped by category (`'code'` first, then others); Glob entries append `(N)` — the raw `globMatchCount`, no unit word; a failed / rejected call shows a red ✗ / amber ⊘ before the path (`title` = `error`) plus its permission badges; a row with a call (`toolUseId` found in `allToolCalls`) is clickable and opens `ToolCallDetailModal`
- Images section (omitted if empty)
- Agent activations section (omitted if empty): `<AgentActivationItem>` per activation; Agent calls with neither an activation nor a sub-agent node (e.g. "Concurrent subagent limit reached", a background fork) are listed under the Agents header as compact clickable rows (`Agent` badge, description, `StatusBadge`)
- Sub-agents section (omitted if empty): `<SubAgentNode depth={0}>` per root agent
- Workflows section (omitted if `turn.workflows` is empty): purple left-border section; `<WorkflowNode>` per run; turn header also shows `⚡ N workflow(s) · duration` badge in purple when present

### WorkflowNode stats strip

When a `WorkflowRun` is expanded, the stats strip shows: `N agents · M tokens · ~$cost · P tool uses`. The cost is in amber with a `~` prefix (rough estimate). It is computed as `wf.subagentTokens × costPerToken` where `costPerToken` is the DB-accurate rate when available (see Metrics row above). The `N agents` count prefers `agentNodes.length` (the resolved `agentSessionIds` forest, below) over the self-reported `workflow.agentCount` whenever `agentNodes` is non-empty; it falls back to `agentCount` for a running/legacy/unresolvable workflow where `agentSessionIds` is `[]`.

### Workflow "Agents (N)" drill-down

`WorkflowRun.agentSessionIds` (server-resolved, `agent-<id>`-prefixed, full multi-level linkage — a
workflow's direct agents plus their own regular Task-tool sub-agents at any depth) is turned into a
`SubAgentNode[]` forest per workflow and rendered as an "Agents (N)" block inside `WorkflowNode`,
sitting between the Summary and Findings blocks. It is not collapsible: a plain "Agents (N)" caption
followed by a table (`WorkflowAgentsTable.tsx`), shown as soon as the workflow node is open (one
nesting level less than the old Agents collapsible). It is not the `SubAgentNode` tree (the
turn-level Sub-agents section keeps the tree). Omitted entirely when the forest is empty
(running workflow, pre-migration/legacy session, or an unresolvable link) — no error state.

- `PromptTurnItem.tsx` computes this per workflow: `wf.agentSessionIds.map(stripAgentPrefix)` (the
  prefix must be stripped before use — `agentParentMap`/`subagentLogsMap` are bare-id-keyed; the
  maps are keyed by the bare agent id) passed into `buildAgentNodesForIds(ids, agentParentMap,
  subagentLogsMap, subagentStats)`, memoized per `turn.workflows`/`agentParentMap`/
  `subagentLogsMap`/`subagentStats`, and keyed by `wf.toolUseId`.
- `buildAgentNodesForIds(agentIds, agentParentMap, subagentLogsMap, subagentStats?)`
  (`log-parser.ts`) restricts nesting to exactly the given id set — a root is any id whose parent
  (per `agentParentMap`) is absent or falls outside the set. Per-agent prompt comes from
  `firstUserPromptText` on that agent's own transcript (`subagentLogsMap.get(agentId)`), since
  workflow agents have no `Task`/`Agent` tool_use in the root session's transcript to source a
  prompt from the usual way; tokens/model come from `extractSubagentStats` on the same transcript,
  falling back to `subagentStats['agent-'+agentId]` (the `session_stats`-derived totals) when the
  transcript itself carries no inline usage. An id absent from `subagentLogsMap` is skipped.
  Output order is the `agentIds` input order (the server's BFS order); sorting happens only in
  `orderAgentRows` (below).
- **Timing.** `agentLogTimeSpan(logs)` (`log-parser.ts`) scans the same transcript: only records
  whose `timestamp` is a string `Date.parse` accepts count; `startMs` is the minimum and `endMs`
  the maximum. `buildAgentNodesForIds` spreads `startMs` when defined and
  `durationMs = endMs − startMs` when both are — so the agent modal's Duration line now shows
  for workflow agents too.
- `subagentStats` is threaded `SessionLogView.tsx` (`logsData?.subagentStats`) →
  `PromptTurnList.tsx` → `PromptTurnItem.tsx`, alongside the existing `subagentLogsMap`/
  `agentParentMap`/`pricing`/`sessionModel` props. `PromptTurnItem` also passes `subagentLogsMap`
  to `WorkflowNode`, which passes it with `pricing`/`sessionModel` to `WorkflowAgentsTable`.

#### The agents table (`WorkflowAgentsTable.tsx`)

- **Columns:** `#`, Task, Duration, Tokens, Cost. Styling follows `SessionInfoWorkflowsSection`
  (`border-collapse`, uppercase `text-[10px]` muted header, right-aligned mono numeric cells,
  `hover:bg-muted/30` rows); the table is `table-fixed` and capped at `max-w-4xl`.
- **Ordering and numbering:** `orderAgentRows(agentNodes)` (`workflow-agent-rows.ts`, memoized)
  sorts each sibling group stably by `startMs` ascending (nodes without `startMs` last, in input
  order), walks depth-first so a parent is followed by its own children, and numbers rows `1`,
  `2`, `2.1`, `2.1.1`. Nesting is never changed. Full contract and examples:
  [algorithms/workflow-agent-rows.md](algorithms/workflow-agent-rows.md).
- **`#` cell:** a `<button aria-haspopup="dialog" aria-label="Open agent N">` holding the number
  in `font-semibold text-purple-700 dark:text-purple-300` — the keyboard way to open the modal.
- **Task cell:** the label from `agentRowLabel(node)` — `cleanText(node.prompt)`, falling back to
  `agentId` when that is empty, truncated to 59 chars + `…` when longer than 60
  (`AGENT_LABEL_LIMIT`); the cell's `title` is the untruncated cleaned text (or the id). Under it,
  the id line: `truncateAgentId` (12 chars, `prompt-turn-helpers.tsx`) plus a `CopyButton` that
  copies the full bare id. Nested rows are indented 16px per depth level, get a muted `↳ ` prefix
  and an 11px label (12px for roots).
- **Formats:** Duration is `formatDuration(durationMs)` from `log-parser.ts` (`h:mm:ss`, the same
  formatter as the detail's Duration line); Tokens is `formatTokens(input + output + cacheRead +
  cacheWrite)`; Cost is `formatCost(computeCost(tokens, pricing[node.model ?? sessionModel]))`
  (4 decimals). Missing data shows `–`.
- **No inline expansion:** rows never expand in place (an inline detail row inside the already
  nested workflow node was unreadable). A row click or the `#` button sets the table's `openAgent`
  state and opens that agent in `WorkflowAgentModal`. Nested agent rows are always rendered.
- **Test hooks:** each agent row is `<tr data-testid="workflow-agent-row" data-agent-id={bareId}>`.

#### One agent's session (`WorkflowAgentModal.tsx`)

- Props: the `agent` node, the row label, `logs = subagentLogsMap.get(agentId) ?? []`, the whole
  `subagentLogsMap` (so the agent's own sub-agents resolve), `pricing`, `sessionModel`; both tabs
  use `model = agent.model ?? sessionModel`.
- No extra network call and no extra access gate: the logs are the ones the session's `/logs`
  payload already loaded for this viewer.
- Parsing: `parseSessionLogs(logs, { isSubagent: true, pricing, subagentLogs })`, memoized while
  the modal is open; the one result feeds both tabs.
- Layout: `Dialog` with `DialogContent` `max-w-5xl h-[85vh] flex flex-col`; the title shows the
  label and the id in `font-mono text-xs`. Below it, two tabs with local state (a transient modal,
  not page state, so not in the URL), "Logs" by default:
  - **Logs** (`data-testid="workflow-agent-logs"`): the very same `PromptTurnList` the Logs tab
    renders, over the agent's own turns — header, tokens/cost, Skills, Rules, Tools, Files.
  - **Raw logs** (`data-testid="workflow-agent-raw-logs"`): the very same `RawLogsTab` the Raw Logs
    tab renders, with `parsedSession` = that parse, so the records group under `TurnHeader` rows.
- Not to be confused with `AgentDetailModal.tsx`, the System Context panel's agent-definition modal.

### SessionInfoTab cost table

Two indented `↳ 5m TTL` / `↳ 1h TTL` sub-rows (violet band) sit under the **Cache write** row,
each with its own $/M and Cost cells; they always sum back to the row above them. Below the
table, the long-standing `cacheHitRate` row is labelled **"Cached input share"**
(`cacheRead / (input + cacheRead)`, unchanged behaviour including its `0` case) and a separate
**"Cache read ratio"** row (`cache read ÷ (cache read + cache write)`) sits beside it — two
different metrics that were previously easy to confuse. Tooltips in this file are plain HTML
`title=` attributes, not `DetailTooltip`.

The Tokens & Cost table shows a **Sub-agents** row (`session.totalCost - derived.totalCost`) when DB-tracked sub-agent costs exist. A **Workflow agents** rough-estimate row is shown when `workflowSubagentTokens > 0`, unless both `subAgentCost` and `workflowEstimatedCost` are known (non-null) AND `subAgentCost >= workflowEstimatedCost × 0.5` — i.e., it is shown by default (including whenever `subAgentCost` is still `null`, the common case right after workflow agents run but before their JSONL cost is uploaded), and suppressed only once DB-tracked sub-agent cost reaches at least half the rough workflow estimate. The workflow estimate uses `derived.totalCost` (main session only) as the base rate to avoid circularity.

### SessionInfoTab Workflows section

Collapsible section, omitted entirely when the session ran no workflows (`workflowStats === null`, computed by flattening every `turn.workflows[]` across the session). Shows: a "Workflows run" count (with failed/running counts appended when non-zero); a table with one row per `WorkflowRun` — name (⚡ prefixed), status pill (green completed / red failed / blue running), duration, agent count (`agentSessionIds.length` when resolved, else the self-reported `agentCount` — same authority rule as design decision 8 elsewhere), tool uses, tokens — plus a totals row and an "Est. workflow cost" row reusing the same `workflowEstimatedCost` value as the cost table above.

---

## Context Growth steps (`charts/context-usage/`)

The Context Growth chart (`ContextGrowthChart.tsx`; mounted by the Charts tab, the Charts
dashboard and the Summary tab's extended details) composes `TurnBreakdownDialog`,
`ContextGrowthSubStepRow`, `StepDetailsModal`, `step-bars.ts` and `step-label.ts`.

- **Step delta rule** (`stepBars(turn)`): step row `si` before the last has `prior =
  steps[si].contextTokens`, `total = steps[si+1].contextTokens`, `delta = total − prior` — the
  step's own output plus the tool results it brought back. The last row has `delta = null` and
  shows `—` with no growth segment. Negative deltas are kept (`−3k`, zero-width segment).
  `formatStepDelta` prints `Math.round(delta / 1000)` + `k`, with `+` / `−`. The bar, the right
  label, the tooltip line and the modal header all use it. The sum of the deltas equals
  `contextTokens − contextTokensStart` except in compaction turns.
- **Clickable step rows** (`ContextGrowthSubStepRow`): `role="button"`, `tabIndex=0`, hover
  highlight and a "details →" hint; click or Enter / Space opens `StepDetailsModal`. The tooltip
  stays. Single-step turns, turn rows and compaction rows are not clickable.
- **Step modal** (`StepDetailsModal`, a sibling `Dialog` so the chart's expansion and scroll
  survive): title `Turn #N · Step k`, the delta and the time; one collapsible `ToolCallView` per
  `step.toolCallIds` entry looked up in `turn.allToolCalls` (an empty or unknown id renders from
  the step's name and input with status `'missing'`); a single call is expanded, with several the
  largest result is expanded and tagged "largest" and "Expand all / Collapse all" appears; the
  assistant text and `stop: <reason>` come last.

---

## Bash tab

Session tab `bash` (after Logs, always shown; label `Bash` plus a muted count). Files in
`session-log/bash-tab/`; the tab bar is `SessionTabBar.tsx`.

- **Collection** (`collectBashCalls(mainLogs, subagentLogsMap)`): per log — the main transcript,
  then each sub-agent's — `buildAllToolCalls(extractRawToolCalls(events, {skipSidechain}),
  buildToolResultIndex(events))`, where `skipSidechain` is true only for the main transcript (every
  line of a sub-agent transcript is `isSidechain: true`, as in the parser and the server), with the same per-log permission attribution as Logs, filtered to
  `name === 'Bash'`. Rows are deduped by id, stably sorted by `startedAt` (missing last) and
  numbered `n` after sorting. Sub-agent rows carry `agentId` and `agentLabel` (`Agent · <type>`
  from `collectAgentTypes` / `collectSpawnedAgentTypes` in `harness-session-tree.ts`, else
  `Agent <8 chars>`). Pure and WASM-free: `SessionDetailPane` memoises the length for the tab
  count.
- **UI** (`SessionBashTab`, `data-testid="session-bash-tab"`, lazy-loaded): a 340 px `listbox`
  (`BashCallList`, rows `bash-call-row` with `data-call-id`) — `#n`, time, duration, status mark,
  "changes N", a preview (`description`, else the first formatted statement, else the first raw
  line) and a sub-agent badge; ↑ / ↓ move the selection. `useBashViews(rows)` loads the parser
  once; until then there are no chips and previews are raw. The right pane shows the sub-agent
  badge, "Open sub-agent →" (`openSubAgent`) and `ToolCallView`. Empty state: "No Bash commands
  in this session". The list sits beside the details only when the tab is at least 42rem wide
  (container query `@container/bash` + `@2xl/bash:`); below that, e.g. at 1024 px with the sidebar
  and the session list open, it stacks above them at up to 40 % of the height.
- **URL:** the selected call is the `bashCall` search param (`useBashCallParam`,
  `setSearchParams(next, {replace: true})`); a missing or unknown id selects row 1 without
  rewriting the URL.

---

## Special log event fields

- `isMeta=true` on `user` events: injected context (e.g., skill output delivered to model) — excluded from qualifying user event check.
- `attachment` events with `attachment.type=nested_memory`: CLAUDE.md / rule files injected into context — collected as `RuleInjection[]` per turn (with `content.type` as `RuleInjection.type`; a `User` file's path becomes `~/.claude/…`), and also fed into the System Context Files/Rules tabs.
- `attachment` events with `attachment.type=instructions`: the initial instruction files (`files[]` with `path`, `type`, `content`) — feed the System Context Files/Rules tabs (see "System Context Files / Rules — sources and merge").
- The Claude Code 2.1.280 types `atis-latch`, `cost-state` (top-level) and the attachments `prompt_snapshot`, `total_tokens_reminder`, `silent_turn_reminder`, `deferred_tools_record`, `remote_session_change` are not read by the log parser (every loop is gated on its own type) and feed no metric — in particular `cost-state.totalCostUSD` is never a cost source and the tool catalogues in `prompt_snapshot` / `deferred_tools_record` never count as tool usage. In Raw Logs they are collapsed rows with no special renderer (`docs/knowledgebase/raw-logs-renderers.md` § "Types with no special renderer").
- System Context data for the Skills, Agents and MCP tabs is **not** parsed from log lines any more (the Files and Rules tabs additionally read the `instructions` / `nested_memory` attachments — see above). It comes from the `harnessSnapshot` field of the `GET .../logs` response (a `HarnessSnapshot | null`, built server-side from the `harness_snapshots` table — see `docs/knowledgebase/db-tables.md` and the `harness-snapshot` algorithm doc, `docs/knowledgebase/algorithms/harness-snapshot.md`). `parseSessionLogs(raw, { harnessSnapshot })` builds, from that one object: `skillDefinitions` (every snapshot skill except `anthropic-skills:*`), `visibleSkills`/`visibleAgents` (filtered against `registeredSkills`/`registeredAgents`, or all when that set is empty), `agentDefinitions`, `mcpConfig` (`snapshot.mcpServers`) and `claudeMd` (`snapshot.systemContext`). With no snapshot, all of these are empty/`undefined` and the corresponding tabs do not render.
- The old `skill_listing` attachment fallback (reading "Project"/"Built-in" section headers out of the listing `content` to backfill `skillDefinitions`) has been **removed**, along with the parsing of the four synthetic hook events that used to carry this data: `system-context`, `skill-definitions`, `agent-definitions`, `mcp-config`. Sessions uploaded by a hook older than 2.22.0 carry only those old events and no `harnessSnapshot` — they lose their Skills, Agents, MCP, Files and Rules tabs with no fallback and no backfill (an explicit, owner-accepted exception to the usual hook backward-compatibility rule, for this change only). Their raw event lines are unaffected and still render in Raw Logs through the existing renderers (`docs/knowledgebase/raw-logs-renderers.md`).

---

## Session refresh

A refresh button (`<RefreshCw>`) in the session detail header calls:
```ts
queryClient.invalidateQueries({ queryKey: ['session-logs', repoId, selectedSession?.sessionId, teamId] })
```
This re-fetches the log data without a full page reload.
