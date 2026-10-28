---
reviewed: no
reviewer: none
---

# Tool output format: shape detection, table re-alignment and agent-seen lines

## Purpose

The details pane of the Tools/MCP tab shows a CLI tool's full captured output next to what the
agent actually received. To make that output readable it decides what shape the text has (JSON
is shown as a tree, a table whose columns the terminal width broke can be re-aligned into a
grid), and it marks with an amber bar the lines of the full output that reached the agent, so a
user sees at a glance what the agent missed.

## Code

- Implementation: `client/src/viewer/pages/repository/tools/output-format.ts`
  (`detectOutputFormat`, `realignTable`, `markAgentSeenLines`, `splitOutputLines`, `stripAnsi`),
  used by `ToolOutputView.tsx`.
- Twins: none.
- Test: `client/src/viewer/pages/repository/tools/output-format.algo.test.ts` (vitest).

## Rules

### Lines and escape sequences

1. **Lines.** A text is split on `\n` or `\r\n`. A trailing newline does not add an empty last
   line; an empty text has no lines.
2. **Escape sequences.** Terminal escape sequences (CSI `ESC [ … final`, OSC `ESC ] … BEL` or
   `ESC ] … ESC \`, and the two-byte `ESC <char>` forms) are removed before any rule below looks
   at the text. They never count as characters or columns.

### Format detection (`detectOutputFormat`)

3. **Empty.** A text that is empty after removing escapes and trimming whitespace is `plain`.
4. **JSON.** The trimmed text starts with `{` and ends with `}`, or starts with `[` and ends with
   `]`, and `JSON.parse` accepts it → `json`.
5. For the table checks the text is reduced to its **non-empty lines** (escape sequences removed,
   trailing whitespace removed, blank lines dropped, at most the first 200 lines). The checks run
   in this order and the first that holds wins.
6. **Pipe table.** A *rule line* is one made only of spaces, `|`, `+`, `:`, `=` and `-`, holding
   at least one `-` or `=`. After dropping rule lines at least 2 rows remain, every row contains
   `|`, and every row splits into the same number of cells (2 to 40) — a row's cells are the text
   between `|` after removing one leading and one trailing `|` → `pipe-table`.
7. **TSV.** At least 2 lines, and every line splits on the tab character into the same number of
   cells (2 to 40) → `tsv`.
8. **Fixed-width table.** At least 2 lines and no tab. A character position is *used* when at
   least one line has a non-space character there. Columns are the maximal runs of used
   positions; a *gutter* is a run of unused positions between two columns. The text is
   `fixed-width-table` when it has 2 to 40 columns, at least one gutter is 2 or more positions
   wide, and the first line (the header) has non-space text inside every column.
9. Otherwise → `plain`.

### Re-alignment (`realignTable`)

10. For `pipe-table`, `tsv` and `fixed-width-table` the non-empty lines (escapes and trailing
    whitespace removed) become cells: pipe rows split as in rule 6 (rule lines dropped), TSV
    lines split on tabs, fixed-width lines cut at the column spans of rule 8 (the last column
    takes the rest of the line). Every cell is trimmed. The first row is `headers`, the rest are
    `rows`, each padded with `""` to the header's width.
10a. **TSV without a header.** A TSV's first row is the header only when every one of its cells
    is non-empty and holds no digit. Otherwise (`gh issue list` piped prints `51\tCLOSED\t…`
    with no header row) `headers` is `[]` and every line is a row. A header-less TSV whose first
    row happens to hold no digit is still read as having a header.
11. `json` and `plain` give no table: `headers: []`, `rows: []`.

### Agent-seen lines (`markAgentSeenLines`)

12. Both texts are split into lines (rule 1); each line is compared with escapes and trailing
    whitespace removed. Either side empty → no marks.
13. The lines of the agent's text are walked in order with a cursor into the full output
    (starting at 0). Each agent line is matched to the **first equal full-output line at or after
    the cursor**; on a match its index is marked and the cursor moves past it.
14. An agent line with no such match is skipped (a marker the agent harness inserted, such as
    `... [N lines truncated] ...`), except the **last** agent line: when it is non-empty and the
    full-output line at the cursor starts with it, that line is marked (the output was cut
    mid-line).
15. The result is the marked indexes in ascending order (they always are, because the cursor only
    moves forward).

## Edge cases

- JSON object / multi-line array: OF-01, OF-02. Braces that do not parse: OF-03. JSON inside
  colour codes: OF-13.
- Markdown pipe table with a rule line: OF-04. A ragged pipe row: OF-05. Blank lines inside a
  pipe table: OF-14.
- TSV: OF-06. One tab-separated line is not a table: OF-12. A header-less TSV (`gh`): OF-17. A
  first row with an empty cell: OF-18.
- Fixed-width table: OF-07. Gutters of one space only: OF-08. A blank last column: OF-15. A
  header that leaves a column unnamed: OF-16.
- ANSI-coloured table: OF-09.
- Plain prose: OF-10. Whitespace only: OF-11.
- Agent saw the head: AS-01. Head + marker + tail: AS-02. Cut mid-line: AS-03. Escapes and
  trailing whitespace ignored: AS-04. Repeated lines matched in order: AS-05. Empty agent text:
  AS-06. No common line: AS-07. Trailing newline adds no line: AS-08. A marker as the last line
  is not a prefix: AS-09.

## Examples

Two row kinds.

- **Detection rows** (`OF-*`): `input.lines` is an array of strings joined with `\n` into the
  output text (a final `""` element gives a trailing newline). `expected.format` is
  `detectOutputFormat(text)`; when `expected.headers` / `expected.rows` are given they are
  `realignTable(text, format)` for the detected format.
- **Agent-seen rows** (`AS-*`): `input.full` and `input.agentSaw` are arrays of strings, each
  joined with `\n`. `expected.seen` is `markAgentSeenLines(full, agentSaw)`.

`\u001b` in a string is the ESC character.

```examples
[
  {
    "id": "OF-01",
    "input": {"lines": ["{\"a\": 1, \"b\": [1, 2]}"]},
    "expected": {"format": "json", "headers": [], "rows": []},
    "note": "Rule 4: starts with { ends with }, parses -> json. Rule 11: json gives no table."
  },
  {
    "id": "OF-02",
    "input": {"lines": ["[", "  {\"id\": 1},", "  {\"id\": 2}", "]"]},
    "expected": {"format": "json"},
    "note": "Rule 4: trimmed text starts with [ and ends with ], the four lines parse as one array -> json."
  },
  {
    "id": "OF-03",
    "input": {"lines": ["{not json}"]},
    "expected": {"format": "plain"},
    "note": "Rule 4: braces but JSON.parse fails. Rule 5: one non-empty line, so rules 6-8 (all need >= 2) fail -> plain."
  },
  {
    "id": "OF-04",
    "input": {"lines": ["| name | calls |", "|------|------:|", "| zz   | 3     |", "| find | 12    |"]},
    "expected": {"format": "pipe-table", "headers": ["name", "calls"], "rows": [["zz", "3"], ["find", "12"]]},
    "note": "Rule 6: line 2 is only | - : -> rule line, dropped; 3 rows remain, each splits into 2 cells -> pipe-table. Rule 10: cells trimmed, first row is the header."
  },
  {
    "id": "OF-05",
    "input": {"lines": ["a | b | c", "1 | 2"]},
    "expected": {"format": "plain"},
    "note": "Rule 6: 3 cells vs 2 cells -> not a pipe table. Rule 7: no tab -> 1 cell. Rule 8: used positions 0,2,4,6,8; every gutter is 1 wide -> not fixed-width. -> plain."
  },
  {
    "id": "OF-06",
    "input": {"lines": ["id\tname\tstatus", "1\tzz\tok", "2\tfind\terror"]},
    "expected": {"format": "tsv", "headers": ["id", "name", "status"], "rows": [["1", "zz", "ok"], ["2", "find", "error"]]},
    "note": "Rule 6: no | -> the header has 1 cell, not a pipe table. Rule 7: 3 lines, each 3 tab cells -> tsv. Rule 10: split on tabs."
  },
  {
    "id": "OF-07",
    "input": {"lines": ["NAME    CALLS  ERRORS", "zz      3      0", "find    12     4"]},
    "expected": {"format": "fixed-width-table", "headers": ["NAME", "CALLS", "ERRORS"], "rows": [["zz", "3", "0"], ["find", "12", "4"]]},
    "note": "Rule 8: used positions 0-3, 8-12, 15-20 -> 3 columns; gutters 4-7 (4 wide) and 13-14 (2 wide); header has NAME, CALLS, ERRORS in each -> fixed-width. Rule 10: line 2 cut at [0,4) [8,13) [15,end) -> zz, 3, 0."
  },
  {
    "id": "OF-08",
    "input": {"lines": ["a b", "c d"]},
    "expected": {"format": "plain"},
    "note": "Rule 8: columns at 0 and 2, the only gutter (position 1) is 1 wide < 2 -> not fixed-width; rules 6, 7 fail (no | and no tab) -> plain."
  },
  {
    "id": "OF-09",
    "input": {"lines": ["\u001b[1mNAME\u001b[0m    CALLS", "\u001b[32mzz\u001b[0m      3"]},
    "expected": {"format": "fixed-width-table", "headers": ["NAME", "CALLS"], "rows": [["zz", "3"]]},
    "note": "Rule 2: escapes removed first -> 'NAME    CALLS' and 'zz      3'. Rule 8: columns 0-3 and 8-12, gutter 4-7 (4 wide), header names both -> fixed-width. Rule 10: zz, 3. With escapes counted, the columns would shift."
  },
  {
    "id": "OF-10",
    "input": {"lines": ["Build finished", "no errors"]},
    "expected": {"format": "plain", "headers": [], "rows": []},
    "note": "Rule 8: position 5 is a space in line 1 but 'r' in line 2, position 2 is 'i' in line 1 -> positions 0-13 all used, one column -> not a table -> plain. Rule 11: no table."
  },
  {
    "id": "OF-11",
    "input": {"lines": ["   ", "  "]},
    "expected": {"format": "plain"},
    "note": "Rule 3: only whitespace -> empty after trimming -> plain."
  },
  {
    "id": "OF-12",
    "input": {"lines": ["a\tb"]},
    "expected": {"format": "plain"},
    "note": "Rule 7: TSV needs at least 2 lines; rule 8 also needs 2 and forbids tabs -> plain."
  },
  {
    "id": "OF-13",
    "input": {"lines": ["\u001b[32m{\"ok\": true}\u001b[0m"]},
    "expected": {"format": "json"},
    "note": "Rule 2 then rule 4: without the colour codes the text is {\"ok\": true}, which parses -> json."
  },
  {
    "id": "OF-14",
    "input": {"lines": ["| a | b |", "", "| 1 | 2 |"]},
    "expected": {"format": "pipe-table", "headers": ["a", "b"], "rows": [["1", "2"]]},
    "note": "Rule 5: the blank line is dropped. Rule 6: 2 rows of 2 cells -> pipe-table. Rule 10: blank line dropped too."
  },
  {
    "id": "OF-15",
    "input": {"lines": ["NAME  STATUS", "zz"]},
    "expected": {"format": "fixed-width-table", "headers": ["NAME", "STATUS"], "rows": [["zz", ""]]},
    "note": "Rule 8: columns 0-3 and 6-11 (only line 1 reaches them), gutter 4-5 is 2 wide, header names both -> fixed-width. Rule 10: line 2 cut at [0,4) -> zz, the last column from 6 is empty -> ''."
  },
  {
    "id": "OF-16",
    "input": {"lines": ["ID  NOTE", "1   ok      x"]},
    "expected": {"format": "plain"},
    "note": "Rule 8: used positions 0-1 (ID / 1), 4-7 (NOTE / ok), 12 (x) -> 3 columns with gutters 2-3 and 8-11, but the header has nothing at position 12 -> the third column is unnamed -> not fixed-width -> plain."
  },
  {
    "id": "OF-17",
    "input": {"lines": ["51\tCLOSED\tUpdate deps\tadlc-task\t2026-10-28T15:28:06Z", "44\tCLOSED\tOKF tab\tenhancement\t2026-10-28T15:27:58Z"]},
    "expected": {"format": "tsv", "headers": [], "rows": [["51", "CLOSED", "Update deps", "adlc-task", "2026-10-28T15:28:06Z"], ["44", "CLOSED", "OKF tab", "enhancement", "2026-10-28T15:27:58Z"]]},
    "note": "Rule 7: 2 lines, 5 tab cells each -> tsv. Rule 10a: the first row's 51 holds a digit -> no header, both lines are rows (gh issue list piped)."
  },
  {
    "id": "OF-18",
    "input": {"lines": ["name\t\tstatus", "zz\tx\tok"]},
    "expected": {"format": "tsv", "headers": [], "rows": [["name", "", "status"], ["zz", "x", "ok"]]},
    "note": "Rule 7: 2 lines, 3 tab cells each -> tsv. Rule 10a: the first row's second cell is empty -> not a header, both lines are rows."
  },
  {
    "id": "AS-01",
    "input": {"full": ["l1", "l2", "l3", "l4"], "agentSaw": ["l1", "l2"]},
    "expected": {"seen": [0, 1]},
    "note": "Rule 13: l1 matches index 0 (cursor 1), l2 matches index 1 -> [0, 1]."
  },
  {
    "id": "AS-02",
    "input": {"full": ["a", "b", "c", "d", "e"], "agentSaw": ["a", "b", "... [2 lines truncated] ...", "e"]},
    "expected": {"seen": [0, 1, 4]},
    "note": "Rule 13: a -> 0, b -> 1 (cursor 2). Rule 14: the marker has no equal line and is not last -> skipped. e -> first e at or after 2 is index 4 -> [0, 1, 4]."
  },
  {
    "id": "AS-03",
    "input": {"full": ["alpha", "bravo", "charlie"], "agentSaw": ["alpha", "bra"]},
    "expected": {"seen": [0, 1]},
    "note": "Rule 13: alpha -> 0 (cursor 1). Rule 14: 'bra' has no equal line, but it is the last agent line and 'bravo' at the cursor starts with it -> 1."
  },
  {
    "id": "AS-04",
    "input": {"full": ["\u001b[31mERR\u001b[0m  ", "ok"], "agentSaw": ["ERR", "ok"]},
    "expected": {"seen": [0, 1]},
    "note": "Rule 12: the full line 0 compares as 'ERR' (escapes and trailing spaces removed) -> ERR -> 0, ok -> 1."
  },
  {
    "id": "AS-05",
    "input": {"full": ["x", "x", "y", "x"], "agentSaw": ["x", "y", "x"]},
    "expected": {"seen": [0, 2, 3]},
    "note": "Rule 13: x -> first x at or after 0 = 0 (cursor 1); y -> 2 (cursor 3); x -> first x at or after 3 = 3, not 1 -> [0, 2, 3]."
  },
  {
    "id": "AS-06",
    "input": {"full": ["a", "b"], "agentSaw": [""]},
    "expected": {"seen": []},
    "note": "Rule 1: an empty text has no lines. Rule 12: one side empty -> []."
  },
  {
    "id": "AS-07",
    "input": {"full": ["a"], "agentSaw": ["zzz"]},
    "expected": {"seen": []},
    "note": "Rule 13: no equal line. Rule 14: zzz is last but 'a' does not start with 'zzz' -> nothing marked."
  },
  {
    "id": "AS-08",
    "input": {"full": ["a", "b", ""], "agentSaw": ["a", "b", ""]},
    "expected": {"seen": [0, 1]},
    "note": "Rule 1: 'a\\nb\\n' splits into 2 lines on both sides (the trailing newline adds none) -> a -> 0, b -> 1. Keeping an empty third line would add index 2."
  },
  {
    "id": "AS-09",
    "input": {"full": ["one", "two", "three"], "agentSaw": ["one", "[output truncated]"]},
    "expected": {"seen": [0]},
    "note": "Rule 13: one -> 0 (cursor 1). Rule 14: the marker is last but 'two' does not start with it -> skipped -> [0]."
  }
]
```

## Mutations

- Escape sequences not removed before column detection -> OF-09 (columns shift, plain).
- TSV checked before the pipe table, or the fixed-width check run first -> OF-06 / OF-07 still
  pass, but a gutter of 1 accepted -> OF-05, OF-08 (would be fixed-width).
- Header-names-every-column check dropped -> OF-16 (fixed-width instead of plain).
- Blank lines kept for detection -> OF-14 (the empty line has no `|`, not a pipe table).
- Matching each agent line to its first occurrence anywhere instead of after the cursor -> AS-05
  (`[0, 2, 0]`).
- No prefix match for a last line cut mid-line -> AS-03 (`[0]`).
- Trailing newline producing an empty last line -> AS-08 (`[0, 1, 2]`).

## Where the result is visible

- Repository → **Tools/MCP** tab → a call's details → Output → **Terminal** view: the JSON tree
  for `json`, the "Re-align table" grid for the three table formats, and the amber left bar
  (`data-agent-seen="true"`) on the lines the agent received.
