---
reviewed: no
reviewer: none
---

# MCP call extraction: one transcript node's `mcp__*` calls as Tools/MCP call records

## Purpose

The Tools/MCP tab shows every MCP call an agent made — which server, which operation, whether it
failed or never got an answer, how long it took and exactly what the agent saw back. MCP calls
need no wrapper: everything is in the Claude Code transcript. This algorithm turns one transcript
(one tree node: the root session or one sub-agent) into the node's MCP call records (DD-10) and
their stored outputs (DD-9).

## Code

- Implementation: `server/src/logs/tool-monitoring/mcp-call-extractor.ts` (`extractMcpCalls`,
  `collectToolUses`, `parseMcpToolName`, `transcriptCallStatus`, `toolResultFullText`).
- Helpers it relies on: `server/src/logs/tool-stats.ts` — `classifyToolOutcome` (see
  [tool-call-outcome](tool-call-outcome.md)) and `resolveToolDuration`;
  `server/src/logs/claude-extractor.ts` — `computeToolResultBytes`, `flattenToolResultText`;
  `server/src/logs/tool-monitoring/tool-calls-log.ts` — `clampUtf8`.
- Caller: `server/src/logs/tool-monitoring/tool-usage-builder.ts` (`buildTreeToolUsage`, the
  per-tree rebuild of DD-8), which also fills `signals` (see
  [tool-usefulness-signals](tool-usefulness-signals.md)).
- Twins: none.
- Test: `server/src/logs/tool-monitoring/mcp-call-extractor.algo.spec.ts` (jest).

## Input and output

`extractMcpCalls(entries, { agentId, agentKind, isSubagentLog })` takes the parsed NDJSON lines of
one `claude` / `claude-subagent` log and returns `{ call, output }[]` in transcript order: `call`
is the DD-10 record, `output` holds `input` (the arguments as JSON) and `agentSaw` (the result
text). `signals` are left empty here.

## Rules

1. **Lines.** In a root log (`isSubagentLog` false) lines with `isSidechain: true` are skipped
   (they belong to a sub-agent, which has its own log); in a sub-agent log every line counts.
2. **Calls.** Every `tool_use` block of an `assistant` line, in transcript order. A `tool_use` id
   seen a second time is skipped whole. Each `tool_use` is joined to the **first** `tool_result`
   with its id in a `user` line.
3. **Name.** Only names `mcp__<server>__<rest>` count. Split the part after `mcp__` on `__`:
   `tool` = the first segment (the server), `operation` = the remaining segments joined with
   `__`. Fewer than two segments, or an empty server or operation → not an MCP call (skipped).
   All other tools (`Read`, `Bash`, …) are skipped.
4. **Status.** No `tool_result` → `no_result`. `is_error: true` → `error` (a failure, and also a
   rejection, which `classifyToolOutcome` calls `unresolved`). Anything else → `ok`.
5. **Duration.** `resolveToolDuration`: the result line's `toolUseResult.durationMs` when
   present, else `toolUseResult.totalDurationMs`, else result-line time − assistant-line time;
   `null` without a result. Rounded to whole ms.
6. **Agent saw.** The result text: string content as is; a block array becomes its blocks joined
   with `\n` — a `text` block by its text, an `image` block as `[image]`, any other block as
   `[<type>]`. Clamped to `CAPTURE_LIMIT_BYTES` = 102400 UTF-8 bytes (hint `truncated`). Without
   a result there is no `agentSaw`.
7. **Bytes.** `outBytes` = `agentSawBytes` = `computeToolResultBytes(content)`: the string length,
   or the sum of the `text` blocks' lengths (UTF-16 code units, images and other blocks 0) — the
   same measure the Sessions tab uses. Without a result `outBytes` = 0 and `agentSawBytes` = null.
   `inBytes` = UTF-8 bytes of the input JSON.
8. **Hints**, in this order: `truncated` (rule 6, or the input JSON clamped), `empty` (the result
   text is empty after trimming), `persisted` (the result text contains `<persisted-output>`:
   Claude Code saved the output to a file).
9. **Identity.** `callId` = `toolUseId` = the `tool_use` id; `ts` = the assistant line's
   timestamp (a line without one takes the last earlier timestamp of the node); `channel` =
   `mcp`, `source` = `transcript`.

## Edge cases

- Plain success: MC-01; two calls with a non-MCP call between them: MC-13.
- `is_error: true`: MC-02. No result at all: MC-03.
- Image and other non-text blocks become placeholders and count 0 bytes: MC-04.
- Extra `__` in the operation part: MC-05.
- Sidechain lines skipped in a root log, kept in a sub-agent log: MC-06, MC-07.
- Not MCP: `Read`, `Bash`, one segment, empty operation: MC-08.
- Whitespace-only result → `empty`: MC-09. Persisted output: MC-10.
- Repeated `tool_use` id, first result wins: MC-11.
- Self-reported duration beats the timestamp delta: MC-12.

## Examples

Each row is one transcript. `input.calls` are tool calls in order; for call *k* (0-based) the test
emits an `assistant` line with timestamp `2026-10-28T10:00:00.000Z` + *k* × 10 s carrying one
`tool_use` block (`id` = the call's `id`, default `t<k+1>`, `name`, `input`, default `{}`), then —
unless the call says `noResult: true` — a `user` line `resultAfterMs` (default 1000) ms later
carrying one `tool_result` for that id with `content` = the call's `result` and `is_error` = its
`isError` when given; the call's `toolUseResult`, when given, goes on that user line. Both lines
carry `isSidechain: true` when the call says `sidechain`. `input.subagent` (default false) is
`isSubagentLog`. `expected.calls` lists the extracted calls in order; each listed object is a
subset of the call record plus `agentSaw` (the stored output's `agentSaw`, `null` when absent).

```examples
[
  {
    "id": "MC-01",
    "input": {"calls": [{"name": "mcp__github__get_issue", "input": {"number": 42}, "result": "Issue #42: Fix login"}]},
    "expected": {"calls": [{"callId": "t1", "toolUseId": "t1", "channel": "mcp", "tool": "github", "operation": "get_issue", "status": "ok", "hints": [], "ts": "2026-10-28T10:00:00.000Z", "durationMs": 1000, "outBytes": 20, "agentSawBytes": 20, "inBytes": 13, "agentSaw": "Issue #42: Fix login"}]},
    "note": "Rule 3: github / get_issue. Rule 4: a result without is_error -> ok. Rule 5: no toolUseResult -> 10:00:01 - 10:00:00 = 1000 ms. Rule 7: 'Issue #42: Fix login' is 20 characters; input JSON {\"number\":42} is 13 bytes. Rule 8: no hints."
  },
  {
    "id": "MC-02",
    "input": {"calls": [{"name": "mcp__jira__get_issue", "input": {"key": "ABC-1"}, "result": "Issue ABC-1 does not exist", "isError": true}]},
    "expected": {"calls": [{"tool": "jira", "operation": "get_issue", "status": "error", "hints": [], "outBytes": 26, "agentSaw": "Issue ABC-1 does not exist"}]},
    "note": "Rule 4: is_error true -> error. Rule 7: the text is 26 characters."
  },
  {
    "id": "MC-03",
    "input": {"calls": [{"name": "mcp__github__create_pr", "input": {"title": "x"}, "noResult": true}]},
    "expected": {"calls": [{"tool": "github", "operation": "create_pr", "status": "no_result", "hints": [], "durationMs": null, "outBytes": 0, "agentSawBytes": null, "agentSaw": null}]},
    "note": "Rule 4: no tool_result -> no_result. Rule 5: no result -> duration null. Rules 6-7: no agentSaw, outBytes 0, agentSawBytes null. Rule 8: empty needs a result -> no hints."
  },
  {
    "id": "MC-04",
    "input": {"calls": [{"name": "mcp__playwright__browser_take_screenshot", "result": [{"type": "text", "text": "Screenshot taken"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}, {"type": "resource", "resource": {"uri": "file:///shot.png"}}]}]},
    "expected": {"calls": [{"tool": "playwright", "operation": "browser_take_screenshot", "status": "ok", "hints": [], "outBytes": 16, "agentSawBytes": 16, "agentSaw": "Screenshot taken\n[image]\n[resource]"}]},
    "note": "Rule 6: blocks joined with \\n; the image block is [image], the resource block [resource]. Rule 7: only the text block counts: 'Screenshot taken' = 16 characters."
  },
  {
    "id": "MC-05",
    "input": {"calls": [{"name": "mcp__claude_ai_Atlassian__jira__get_issue", "input": {"key": "LH-7"}, "result": "ok"}]},
    "expected": {"calls": [{"tool": "claude_ai_Atlassian", "operation": "jira__get_issue", "status": "ok"}]},
    "note": "Rule 3: after mcp__ the segments are claude_ai_Atlassian, jira, get_issue; the first is the server, the rest joined with __ is the operation."
  },
  {
    "id": "MC-06",
    "input": {"calls": [{"name": "mcp__github__get_issue", "result": "x", "sidechain": true}]},
    "expected": {"calls": []},
    "note": "Rule 1: in a root log a sidechain line belongs to a sub-agent -> skipped, no call."
  },
  {
    "id": "MC-07",
    "input": {"subagent": true, "calls": [{"name": "mcp__github__get_issue", "result": "x", "sidechain": true}]},
    "expected": {"calls": [{"tool": "github", "operation": "get_issue", "status": "ok", "agentSaw": "x"}]},
    "note": "Rule 1: in a sub-agent log every line counts -> the call is kept."
  },
  {
    "id": "MC-08",
    "input": {"calls": [
      {"name": "Read", "input": {"file_path": "/a.md"}, "result": "x"},
      {"name": "Bash", "input": {"command": "ls"}, "result": "x"},
      {"name": "mcp__solo", "result": "x"},
      {"name": "mcp__srv__", "result": "x"}
    ]},
    "expected": {"calls": []},
    "note": "Rule 3: Read and Bash are not MCP; mcp__solo has one segment; mcp__srv__ has an empty operation -> nothing extracted."
  },
  {
    "id": "MC-09",
    "input": {"calls": [{"name": "mcp__search__query", "input": {"q": "zz"}, "result": "   \n"}]},
    "expected": {"calls": [{"status": "ok", "hints": ["empty"], "outBytes": 4, "agentSaw": "   \n"}]},
    "note": "Rule 4: a result without is_error -> ok. Rule 8: the text trims to '' -> empty. Rule 7: 3 spaces + newline = 4."
  },
  {
    "id": "MC-10",
    "input": {"calls": [{"name": "mcp__db__run_query", "result": "<persisted-output>Saved to x.txt</persisted-output>"}]},
    "expected": {"calls": [{"status": "ok", "hints": ["persisted"], "outBytes": 51}]},
    "note": "Rule 8: the text contains <persisted-output> -> persisted. Rule 7: 18 + 14 + 19 = 51 characters."
  },
  {
    "id": "MC-11",
    "input": {"calls": [
      {"id": "dup", "name": "mcp__github__get_issue", "result": "first"},
      {"id": "dup", "name": "mcp__github__list_prs", "result": "second"}
    ]},
    "expected": {"calls": [{"callId": "dup", "operation": "get_issue", "agentSaw": "first"}]},
    "note": "Rule 2: the second tool_use with id dup is skipped whole (no list_prs call), and the first tool_result of dup ('first') wins."
  },
  {
    "id": "MC-12",
    "input": {"calls": [{"name": "mcp__github__get_issue", "result": "x", "resultAfterMs": 5000, "toolUseResult": {"durationMs": 250}}]},
    "expected": {"calls": [{"durationMs": 250}]},
    "note": "Rule 5: toolUseResult.durationMs (250) comes before the 5000 ms timestamp delta."
  },
  {
    "id": "MC-13",
    "input": {"calls": [
      {"name": "mcp__github__get_issue", "result": "a"},
      {"name": "Grep", "input": {"pattern": "x"}, "result": "b"},
      {"name": "mcp__github__get_issue", "result": "c"}
    ]},
    "expected": {"calls": [
      {"callId": "t1", "operation": "get_issue", "ts": "2026-10-28T10:00:00.000Z", "agentSaw": "a"},
      {"callId": "t3", "operation": "get_issue", "ts": "2026-10-28T10:00:20.000Z", "agentSaw": "c"}
    ]},
    "note": "Rules 2-3: the Grep call (k = 1) is skipped; the MCP calls keep transcript order with their own ids t1 and t3 and their assistant times k = 0 -> 10:00:00, k = 2 -> 10:00:20."
  }
]
```

## Mutations

- Operation taken as the last segment only -> MC-05 (`get_issue`); server taken up to the last
  `__` -> MC-05.
- A missing result reported as `error` (the `log-parser.ts` rule) -> MC-03.
- `is_error` ignored -> MC-02.
- Image blocks dropped from the text, or counted in the bytes -> MC-04.
- Sidechain lines read from a root log -> MC-06; dropped from a sub-agent log -> MC-07.
- `mcp__solo` / an empty operation accepted -> MC-08.
- Last `tool_result` of an id wins, or the repeated `tool_use` kept -> MC-11.
- Timestamp delta preferred over the self-reported duration -> MC-12.
- `empty` on untrimmed text -> MC-09.

## Where the result is visible

- Repository → **Tools/MCP** tab: the MCP group of the tree (server → operation, calls, error %),
  the calls table (status, duration, bytes) and the call details ("Parameters", "Agent saw").
- API: `GET /api/v1/repositories/:repoId/tool-monitoring/summary`, `…/tool-monitoring/calls` and
  `…/tool-monitoring/calls/:usageId/:callId`.
- Storage: `session_tool_usage` rows with `channel = 'mcp'` (see
  [../tool-monitoring.md](../tool-monitoring.md)).
