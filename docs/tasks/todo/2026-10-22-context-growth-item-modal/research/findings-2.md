# Research 2 — tool-call classification, result index, permission attribution (2026-10-22)

Real-data validation of a replacement for `SKIP` / `fileToolNames` / name-only permission matching in
`client/src/viewer/pages/repository/session-log/log-parser.ts`. Scripts and raw outputs (local only):
the session scratchpad `toolcalls/` folder (`stats.mjs`, `perm*.mjs`, `proto.mjs`, `parser*.mjs`).

## Why the current code is crude

- No written justification: nothing in the KB, done/todo tasks or code comments. `git log -S` puts `SKIP` and name-only permission matching in the single "Initial public release" commit.
- Only implied intent: the `PromptTurnItem.tsx:155` comment `{/* Tool calls (Bash, MCP, WebFetch, etc.) */}`. Tools is "other tools"; file tools, Skill and Agent have their own sections.
- Other code deliberately avoids it: `server/src/logs/claude-extractor.ts:965-967` and `usage/session-usage-derive.ts:17-20` say so. `server/src/logs/tool-stats.ts:86-88` calls the client's "missing result = error" rule wrong.
- Name-only permission matching is forced by the hook. PermissionRequest/PermissionDenied carry only `tool_name` + `tool_input` (`lifecycle-hook.js:111-115`), and PostToolUseFailure has no id either.
- Server twins:
  - No server number has to equal `turn.toolCalls.length`. `session_tool_stats`, Active Sessions `toolCalls`, `/analytics/tools`, harness usage and the client Statistics tab all count every `tool_use`.
  - The Summary band's "N tool calls" (`session-summary-derive.ts:284`) is a different number (SKIP-filtered, main session only).
  - The server ignores permission events and finds rejections from result text (`REJECTION_MARKERS`).
  - `turn-walk.ts:45` `FILE_TOOL_NAMES` lacks MultiEdit although its comment says it mirrors the client.
- Tests that pin behaviour: S-SESS-03 step 6 (GS-07) expects a denied Bash in Tools with "✗ error". S-SESS-03 step 7 pins Files rows (`×2`, category groups). No golden fixture has Permission* events.

## Real-data findings

Sources:
- Transcripts: all 563 main + 13,880 sub-agent/workflow transcripts in `~/.claude/projects` (727k lines, 130,058 `tool_use`).
- Hook telemetry: 2,006 files from 21 `.artisyn/ai_work_dir/telemetry` dirs.
- Local prod DB: read-only, 0 PermissionDenied and 3 Permission events in total.
- Golden fixtures: 8 main + 5 sub-agent logs.

| Check | Result |
|---|---|
| `tool_use` without id/name/input; duplicate id within one file; result without a `tool_use` | 0 / 0 / 0 |
| `tool_use` with no `tool_result` | 2, the last lines of a log |
| Same id in several files | 26 ids, all fork sub-agents copying their parent's history (5 shared main ↔ sub-agent) |
| Sidechain lines in main files | 0 |
| Tool names | Bash 59,676 · Read 31,209 · Write 8,760 · Edit 6,984 · StructuredOutput 6,912 · Grep 4,879 · MCP 5,430 (29 names) · Skill 629 · Agent 563 · Glob 357 |
| Legacy names (Task, MultiEdit, NotebookEdit, TodoWrite, LS) | all 0 |
| Error results | Read 741 (guardrail "BLOCKED", token limit, missing file), Write 112, Edit 65 ("String to replace not found"), Glob 1, Skill 1, Agent 9 ("Concurrent subagent limit reached", "Fork is not available inside a forked worker") |
| Timestamps | on 100% of `tool_use` and `tool_result` lines; 1 negative duration; p50 208 ms, p99 39.6 s, max 3.4 h (user wait) |
| `toolUseResult` | present on 43,858 / 130,056 result lines (workflow transcripts lack it) |
| `toolUseResult.interrupted` | key on 21,084 (Bash only), never `true` |
| Rejection text in results | 21 calls with "The user doesn't want to proceed…" and `is_error: true`; 4 false positives (Grep/Bash output with the marker, `is_error` false) |
| Permission events | 205 PermissionRequest (AskUserQuestion 197, Bash 7, ExitPlanMode 1), 0 PermissionDenied |
| Permission events with a surviving transcript | 43 (35 sessions) |
| Permission `tool_input` vs `tool_use.input` | exact deep-equal 41/43 · 1 differs only by a hook-added default (`questions[0].multiSelect:false`) · 1 is a system "safeguards" question with no `tool_use` |
| Permission event timing | 138–591 ms after its `tool_use` line, always before the result |
| Current parser on these 43 | all 3 Bash requests land on the wrong call (an earlier Bash 52 s / 293 s before, or a sub-agent's request on a main-session Bash) |
| Join via PostToolUse `tool_use_id` | not viable: 4 / 205 joined (AskUserQuestion PostToolUse input carries the answers; only 74,815 / 154,746 PostToolUse events have an id) |
| Name+input matching for PostToolUseFailure | unique 1,207 / 1,274 |

## Prototype results

`proto.mjs` runs the real parser (esbuild bundle plus an instrumented copy that exposes each turn's raw calls) next to the new design:
- Coverage: 14,443 logs, 25,739 turns, 130,017 calls, 0 parse failures.
- Every call lands in exactly one section. No duplicate ids within a turn, no call in two turns.
- 0 mismatches against today's `toolCalls` (counts, ids, order), `files` (tool, path, order) and `skills`.
- Golden fixtures: 447 = 447 calls, full parity. The one GS-07 status goes error → rejected.
- `turnToolCallCount`: 130,964 → 130,017, which is −964 images (counted on top of the Read/screenshot call that returned them) plus 17 Agent calls with no activation.
- Permissions: 41 / 43 attributed (40 exact, 1 subset). 2 correctly unattributed (one belongs to a sub-agent, one has no `tool_use`). 5 call flags differ from the current parser, all corrections.
- Result index: 34 ms total to build across all 14,443 logs.

## Risks noted

1. S-SESS-03 step 6 changes ("rejected" instead of "✗ error"). The `is_error` gating differs from the server's `isRejectionText`.
2. The permission sample is small: 43 events, 7 of them Bash, 0 PermissionDenied.
3. 57 sub-agent-log calls fall outside every turn (an existing segmentation gap) and stay out of `allToolCalls`.
4. Fork sub-agents repeat their parent's `tool_use` ids, so cross-log aggregation must dedupe by id.
5. Failed Reads add their error text to `bytes`.
6. Summary "tool calls" vs Statistics "tool calls" mismatch.
7. NotebookEdit and `turn-walk.ts`'s missing MultiEdit are left as follow-ups (0 real calls).
