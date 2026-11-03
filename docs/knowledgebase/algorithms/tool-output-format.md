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

Rows (27): [`docs/algorithm-examples/tool-output-format.json`](../../algorithm-examples/tool-output-format.json) — test data for the table test; the rules above are enough to understand the algorithm.

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
