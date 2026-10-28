---
reviewed: no
reviewer: none
---

# Tool usefulness signals: did a tool call help the agent?

## Purpose

Call counts and error rates say how often a tool is used, not whether it helped. The Tools/MCP
tab marks each call with up to four heuristic signals read from what the same agent did right
after it: the output was empty, the agent repeated the same call, it fell back to plain text
search, or it opened a file the output pointed to. Summed per tool and operation they show
which tools agents keep retrying or abandoning. The UI labels them as heuristics.

## Code

- Implementation: `server/src/logs/tool-monitoring/tool-call-signals.ts` (`computeSignals`,
  `isEmptyOutput`); constant `SIGNAL_LOOKAHEAD` = 3 in `tool-usage.constants.ts`.
- Caller: `server/src/logs/tool-monitoring/tool-usage-builder.ts` (`buildTreeToolUsage`), which
  builds one ordered `tool_use` list **per tree node** — the root session or one sub-agent, i.e.
  per agent — and passes only that agent's list.
- Twins: none.
- Test: `server/src/logs/tool-monitoring/tool-call-signals.algo.spec.ts` (jest).

## Input and output

`computeSignals(orderedToolUsesPerAgent, index, subject?)` takes one agent's `tool_use`s in
transcript order — each with its transcript tool `name`, the monitored `calls` it carries
(`{tool, operation}`: one for MCP, the recognised ones for Bash / PowerShell, none otherwise),
its `commandWords` (Bash / PowerShell), its `filePath` (Read / Edit) and the `output` the agent
saw (`null` without a result) — and the index of the call's `tool_use`. `subject` picks the call
when the `tool_use` carries several (default: its first call and its output). Returns the
subset of `['empty', 'retried', 'fell_back', 'opened_file']`, in that order.

## Rules

1. **Agent.** Only the subject agent's own `tool_use`s count; another agent's calls (a sub-agent
   running in between) are invisible, whatever their timing.
2. **Window.** The next `SIGNAL_LOOKAHEAD` = 3 `tool_use`s of that agent after the call's own
   `tool_use` (fewer at the end of the transcript).
3. **`empty`.** The call's output is not `null` and either trims to `''` or has a line starting
   (case-insensitive) with `no results`, `no matches`, `not found`, `nothing found` or
   `0 results` (`/^(no (results|matches)|not found|nothing found|0 results)/im`). Window not
   used.
4. **`retried`.** A `tool_use` in the window carries a call with the same tool (case-insensitive,
   without `.exe`) and the same operation.
5. **`fell_back`.** A `tool_use` in the window is `Grep` or `Glob`, or is `Bash` / `PowerShell`
   with a command word (case-insensitive, without `.exe`) `grep`, `rg`, `findstr` or
   `Select-String` — except when that word is the call's own tool.
6. **`opened_file`.** The output is not `null` or `''`, and a `Read` or `Edit` in the window has a
   `file_path` whose basename (after the last `/` or `\`) appears in the output as a substring.

## Edge cases

- `empty`: empty string SG-01, a "No results" line further down SG-02, a non-matching line
  SG-03, no result at all SG-04.
- `retried`: SG-05; last place of the window SG-06; just outside SG-07; other operation SG-08.
- `fell_back`: Grep tool SG-09, Bash `rg` SG-10, PowerShell `Select-String` SG-11, the call's own
  tool is no fallback SG-12.
- `opened_file`: Windows path basename SG-13; `Write` does not count SG-14.
- Other agent ignored: SG-15; the window is counted in the agent's own calls SG-16.
- Several signals at once and their order: SG-17. A chosen call of a multi-call Bash
  `tool_use`: SG-18.

## Examples

`input.uses` is the transcript's `tool_use`s in order, across agents: `agent` (default `root`),
`name`, `calls` (default `[]`), `commandWords` (default `[]`), `filePath` (default `null`) and
`output` (`null` = no result). `input.index` is the call's position in `input.uses`; the test
keeps only the `uses` of that call's agent (rule 1, as the builder does per node) and passes the
call's position in that list. `input.subject`, when given, is passed as `subject`.
`expected.signals` is the exact result.

```examples
[
  {
    "id": "SG-01",
    "input": {"index": 0, "uses": [{"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": ""}]},
    "expected": {"signals": ["empty"]},
    "note": "Rule 3: '' trims to '' -> empty. Rule 2: nothing follows."
  },
  {
    "id": "SG-02",
    "input": {"index": 0, "uses": [{"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "Searching repo...\nNo results found for 'zz'"}]},
    "expected": {"signals": ["empty"]},
    "note": "Rule 3: the second line starts with 'No results' (case-insensitive, any line) -> empty."
  },
  {
    "id": "SG-03",
    "input": {"index": 0, "uses": [{"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "Found 0 results"}]},
    "expected": {"signals": []},
    "note": "Rule 3: the line starts with 'Found', not with '0 results' -> not empty."
  },
  {
    "id": "SG-04",
    "input": {"index": 0, "uses": [{"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": null}]},
    "expected": {"signals": []},
    "note": "Rule 3: no result (null) is not empty output."
  },
  {
    "id": "SG-05",
    "input": {"index": 0, "uses": [
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "x"},
      {"name": "Read", "filePath": "/repo/a.ts", "output": "y"},
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "z"}
    ]},
    "expected": {"signals": ["retried"]},
    "note": "Rule 4: the 2nd next tool_use is github / get_issue again -> retried. Rule 6: 'a.ts' is not in 'x' -> no opened_file."
  },
  {
    "id": "SG-06",
    "input": {"index": 0, "uses": [
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "x"},
      {"name": "Read", "filePath": "/repo/a.ts", "output": "y"},
      {"name": "Read", "filePath": "/repo/b.ts", "output": "y"},
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "z"}
    ]},
    "expected": {"signals": ["retried"]},
    "note": "Rule 2: the window is uses 1, 2, 3; the repeat is the 3rd -> inside -> retried."
  },
  {
    "id": "SG-07",
    "input": {"index": 0, "uses": [
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "x"},
      {"name": "Read", "filePath": "/repo/a.ts", "output": "y"},
      {"name": "Read", "filePath": "/repo/b.ts", "output": "y"},
      {"name": "Read", "filePath": "/repo/c.ts", "output": "y"},
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "z"}
    ]},
    "expected": {"signals": []},
    "note": "Rule 2: the window is uses 1-3 (three Reads); the repeat is the 4th next -> outside -> nothing."
  },
  {
    "id": "SG-08",
    "input": {"index": 0, "uses": [
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "x"},
      {"name": "mcp__github__list_prs", "calls": [{"tool": "github", "operation": "list_prs"}], "output": "z"}
    ]},
    "expected": {"signals": []},
    "note": "Rule 4: same tool but operation list_prs != get_issue -> not retried."
  },
  {
    "id": "SG-09",
    "input": {"index": 0, "uses": [
      {"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "nothing useful"},
      {"name": "Grep", "output": "src/a.ts:1: zz"}
    ]},
    "expected": {"signals": ["fell_back"]},
    "note": "Rule 5: a Grep tool_use in the window -> fell_back. Rule 3: 'nothing useful' does not start with 'nothing found' -> not empty."
  },
  {
    "id": "SG-10",
    "input": {"index": 0, "uses": [
      {"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "x"},
      {"name": "Bash", "commandWords": ["cd", "rg"], "output": "y"}
    ]},
    "expected": {"signals": ["fell_back"]},
    "note": "Rule 5: a Bash tool_use whose command words include rg -> fell_back."
  },
  {
    "id": "SG-11",
    "input": {"index": 0, "uses": [
      {"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "x"},
      {"name": "PowerShell", "commandWords": ["Get-Content", "Select-String"], "output": "y"}
    ]},
    "expected": {"signals": ["fell_back"]},
    "note": "Rule 5: PowerShell with Select-String (case-insensitive) -> fell_back."
  },
  {
    "id": "SG-12",
    "input": {"index": 0, "uses": [
      {"name": "Bash", "calls": [{"tool": "rg", "operation": "TODO"}], "commandWords": ["rg"], "output": "x"},
      {"name": "Bash", "calls": [{"tool": "rg", "operation": "FIXME"}], "commandWords": ["rg"], "output": "y"}
    ]},
    "expected": {"signals": []},
    "note": "Rule 5: rg is the call's own tool -> not a fallback. Rule 4: operation FIXME != TODO -> not retried."
  },
  {
    "id": "SG-13",
    "input": {"index": 0, "uses": [
      {"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "src/app/main.ts:12: TODO"},
      {"name": "Read", "filePath": "D:\\repo\\src\\app\\main.ts", "output": "..."}
    ]},
    "expected": {"signals": ["opened_file"]},
    "note": "Rule 6: the basename after the last \\ is main.ts, which appears in the output -> opened_file."
  },
  {
    "id": "SG-14",
    "input": {"index": 0, "uses": [
      {"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "src/app/main.ts:12: TODO"},
      {"name": "Write", "filePath": "/repo/src/app/main.ts", "output": "ok"}
    ]},
    "expected": {"signals": []},
    "note": "Rule 6: only Read / Edit count; a Write of main.ts does not -> nothing."
  },
  {
    "id": "SG-15",
    "input": {"index": 0, "uses": [
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "x"},
      {"agent": "a1", "name": "Grep", "output": "y"},
      {"agent": "a1", "name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "z"},
      {"name": "Read", "filePath": "/repo/x.md", "output": "w"}
    ]},
    "expected": {"signals": []},
    "note": "Rule 1: the root's own list is [get_issue, Read]; the sub-agent a1's Grep and repeated get_issue are invisible -> no fell_back, no retried; 'x.md' is not in 'x' -> no opened_file."
  },
  {
    "id": "SG-16",
    "input": {"index": 0, "uses": [
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "x"},
      {"agent": "a1", "name": "Bash", "commandWords": ["ls"], "output": "y"},
      {"agent": "a1", "name": "Bash", "commandWords": ["ls"], "output": "y"},
      {"agent": "a1", "name": "Bash", "commandWords": ["ls"], "output": "y"},
      {"name": "mcp__github__get_issue", "calls": [{"tool": "github", "operation": "get_issue"}], "output": "z"}
    ]},
    "expected": {"signals": ["retried"]},
    "note": "Rules 1-2: in the root's own list the repeat is the 1st next call (the three a1 calls do not use up the window) -> retried."
  },
  {
    "id": "SG-17",
    "input": {"index": 0, "uses": [
      {"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "No matches"},
      {"name": "mcp__search__query", "calls": [{"tool": "search", "operation": "query"}], "output": "No matches"},
      {"name": "Glob", "output": "a.ts"}
    ]},
    "expected": {"signals": ["empty", "retried", "fell_back"]},
    "note": "Rule 3: 'No matches' -> empty. Rule 4: the next call repeats search / query -> retried. Rule 5: Glob in the window -> fell_back. Listed in the fixed order."
  },
  {
    "id": "SG-18",
    "input": {"index": 0, "subject": {"tool": "find", "operation": ".", "output": "find: not found"}, "uses": [
      {"name": "Bash", "calls": [{"tool": "zz", "operation": "build"}, {"tool": "find", "operation": "."}], "commandWords": ["zz", "find"], "output": "build ok"},
      {"name": "Bash", "calls": [{"tool": "find", "operation": "."}], "commandWords": ["find"], "output": "x"}
    ]},
    "expected": {"signals": ["retried"]},
    "note": "The subject is the find call with its own output. Rule 3: 'find: not found' does not start with 'not found' -> not empty. Rule 4: the next tool_use carries find / '.' -> retried."
  }
]
```

## Mutations

- Window of 4, or unbounded -> SG-07; window of 2 -> SG-06.
- Calls of other agents counted -> SG-15 (fell_back, retried); window counted over all agents
  -> SG-16.
- `empty` pattern anchored to the whole output instead of any line -> SG-02; unanchored -> SG-03,
  SG-18.
- No result treated as empty -> SG-04.
- Operation ignored for `retried` -> SG-08, SG-12.
- The call's own tool counted as a fallback -> SG-12.
- Full path compared instead of the basename, or `/`-only split -> SG-13; `Write` counted -> SG-14.
- First call of the `tool_use` used instead of `subject` -> SG-18 (zz / build has no repeat).

## Where the result is visible

- Repository → **Tools/MCP** tab: the "retried %" column of the tree, the signal chips in the
  calls table and call details (labelled as heuristics).
- Storage: `session_tool_usage.calls[].signals` and the `empty` / `retried` / `fellBack` /
  `openedFile` counters of `session_tool_usage.aggregates` (DD-11).
