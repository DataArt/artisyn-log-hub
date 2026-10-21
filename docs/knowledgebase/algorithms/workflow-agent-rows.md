---
reviewed: 2026-10-21
reviewer: ai+owner
---

# Workflow agent rows: order, numbers and label

## Purpose

A workflow run can spawn 45+ agents. The "Agents (N)" table of a workflow node lists them in the
order they started, numbers them (`1`, `2`, `2.1`) so a nested agent is placed under its parent,
and names each row by its prompt instead of its bare id, so the user can find an agent without
opening every row.

## Code

- Implementation: `client/src/viewer/pages/repository/session-log/workflow-agent-rows.ts`
  (`orderAgentRows`, `agentRowLabel`, `AGENT_LABEL_LIMIT`). The label uses `cleanText` from
  `prompt-turn-helpers.tsx` (with `stripSystemBlocks` / `SYSTEM_BLOCK_RE` from `log-parser.ts`).
- Input producer (not part of the rule): `buildAgentNodesForIds` in `log-parser.ts` emits the
  forest in `agentIds` (`wf.agentSessionIds`) order and sets `startMs` from the agent's own log
  (the smallest string `timestamp` that `Date.parse` accepts; absent when there is none).
- Twins: none. Related, not a twin: `truncateContent` in `charts/chart-data.ts` uses the same
  60-char / 59 + `…` cut on the first line of a turn text. The table row's hover tooltip
  (`title` in `WorkflowAgentsTable.tsx`) is `cleanText(prompt) || agentId` — label rules 1–2
  without the cut.
- Test: `client/src/viewer/pages/repository/session-log/workflow-agent-rows.algo.test.ts`.

## Input and output

- `orderAgentRows(forest)`: `forest` is an array of agent nodes, each with an `agentId`, an
  optional `startMs` (epoch ms; when present it is a finite number — the producer derives it
  with `Date.parse` and drops `NaN`) and `children` (an array of the same nodes). The output is a flat
  array of rows `{node, depth, number}`: `depth` is 0 for a root; `number` is a string.
- `agentRowLabel(node)`: `node` has an `agentId` and a `prompt` string; the output is the label
  string.

## Rules

### Order and numbers

1. **Sibling sort.** Each sibling group (the roots, then each node's `children`) is sorted on its
   own, stably:
   - nodes with a `startMs` come first, ascending by `startMs`;
   - nodes with the same `startMs` keep their input order;
   - nodes without a `startMs` come after all nodes with one, in their input order (a missing
     `startMs` is not 0).
2. **Depth-first walk.** A row is followed directly by the rows of its own sorted children (and
   theirs, recursively), then by its next sibling.
3. **Numbers.** A root's `number` is its 1-based position among the sorted roots (`"1"`, `"2"`).
   A child's `number` is its parent's `number`, then `.`, then its 1-based position among its
   sorted siblings (`"2.1"`, `"2.1.1"`). `depth` is 0 for a root and the parent's depth + 1 for a
   child.
4. **Nesting is kept.** A node is reordered only within its own sibling group; it never moves to
   another parent or level.
5. An empty forest gives no rows.

Implementation note, not part of the contract and not pinned by the rows: the sort works on a
copy, so the caller's arrays (React props) are never changed.

### Label

1. `text` = `cleanText(prompt)`: remove every system block (`<local-command-caveat>`,
   `<system-reminder>`, `<command-name>`, `<command-message>`, `<command-args>`,
   `<local-command-stdout>`, `<ide_opened_file>`, each with its content up to the matching
   closing tag), replace every remaining `<...>` tag with a space, collapse each run of
   whitespace (newlines included) to one space, and trim. Only these steps are part of this
   contract; finer details of the shared `cleanText` / `SYSTEM_BLOCK_RE` helpers (tag-name case,
   an open tag with attributes, an unclosed or nested block, `<>`) are those helpers' own
   behaviour and are not pinned here.
2. If `text` is empty, `text` = `agentId`.
3. If `text` is longer than `AGENT_LABEL_LIMIT` = 60 characters, the label is its first
   `AGENT_LABEL_LIMIT - 1` = 59 characters followed by `…` (60 characters in total). Otherwise the
   label is `text` unchanged. The cut applies to the `agentId` fallback of rule 2 as well.

## Edge cases

- Roots out of start order: AO-01. Equal `startMs`: AO-02.
- Roots without `startMs`, mixed with timed ones: AO-03.
- Children sorted within their group and placed right after their parent: AO-04.
- Three levels (grandchild `N.M.K`, depth 2): AO-05.
- Empty forest: AO-06.
- A child that starts before its parent's later sibling stays under its parent: AO-07.
- `startMs` 0 is a real start time, not a missing one: AO-08.
- Two parents with children, each numbering its own from 1: AO-09.
- Tags, a system block and extra whitespace: AL-02 (a plain prompt kept as-is is covered by
  scenario S-SESS-03). A tag between two letters: AL-07. A tag at the start, so the final trim
  matters: AL-09.
- Length boundary: exactly 60 characters AL-03, 61 characters AL-04.
- Empty prompt: AL-05. A prompt that is only a system block: AL-06. A fallback `agentId` longer
  than 60 characters is cut too: AL-08.

## Examples

Two kinds of rows.

- **Order rows** have `input.forest`: an array of `{"id": string, "startMs"?: number,
  "children"?: [...]}`. The test turns each into an agent node with `agentId` = `id`, an empty
  `prompt`, `children` = the mapped `children` (none = empty) and `startMs` only when the row
  gives one. `expected.rows` is the output as `{"id", "number", "depth"}` per row, in output
  order.
- **Label rows** have `input.label`: `{"agentId": string, "prompt": string}`; `expected.label` is
  the label.

```examples
[
  {
    "id": "AO-01",
    "input": {"forest": [
      {"id": "a", "startMs": 300},
      {"id": "b", "startMs": 100},
      {"id": "c", "startMs": 200}
    ]},
    "expected": {"rows": [
      {"id": "b", "number": "1", "depth": 0},
      {"id": "c", "number": "2", "depth": 0},
      {"id": "a", "number": "3", "depth": 0}
    ]},
    "note": "Rule 1: ascending startMs 100 (b), 200 (c), 300 (a). Rule 3: numbers are the sorted positions 1, 2, 3. Numbering by input index would give b=2, c=3, a=1."
  },
  {
    "id": "AO-02",
    "input": {"forest": [
      {"id": "b", "startMs": 100},
      {"id": "a", "startMs": 100},
      {"id": "c", "startMs": 50}
    ]},
    "expected": {"rows": [
      {"id": "c", "number": "1", "depth": 0},
      {"id": "b", "number": "2", "depth": 0},
      {"id": "a", "number": "3", "depth": 0}
    ]},
    "note": "Rule 1: c (50) first; b and a tie at 100 and keep input order b, a (not alphabetical). Breaking the tie by agentId would give a before b; an unstable sort may too."
  },
  {
    "id": "AO-03",
    "input": {"forest": [
      {"id": "c"},
      {"id": "b", "startMs": 200},
      {"id": "a"},
      {"id": "d", "startMs": 100}
    ]},
    "expected": {"rows": [
      {"id": "d", "number": "1", "depth": 0},
      {"id": "b", "number": "2", "depth": 0},
      {"id": "c", "number": "3", "depth": 0},
      {"id": "a", "number": "4", "depth": 0}
    ]},
    "note": "Rule 1: timed nodes first, ascending: d (100), b (200); then the untimed c, a in input order (not alphabetical). Treating a missing startMs as 0 would put c, a first; ordering the untimed nodes by agentId would give a before c."
  },
  {
    "id": "AO-04",
    "input": {"forest": [
      {"id": "p", "startMs": 100, "children": [
        {"id": "p1", "startMs": 300},
        {"id": "p2", "startMs": 200}
      ]},
      {"id": "q", "startMs": 200}
    ]},
    "expected": {"rows": [
      {"id": "p", "number": "1", "depth": 0},
      {"id": "p2", "number": "1.1", "depth": 1},
      {"id": "p1", "number": "1.2", "depth": 1},
      {"id": "q", "number": "2", "depth": 0}
    ]},
    "note": "Roots: p (100) = 1, q (200) = 2. p's children sorted on their own: p2 (200) = 1.1, p1 (300) = 1.2, depth 1. Rule 2 puts them right after p and before q. Appending children after all roots would give p, q, p2, p1."
  },
  {
    "id": "AO-05",
    "input": {"forest": [
      {"id": "r", "startMs": 100, "children": [
        {"id": "s", "startMs": 200, "children": [
          {"id": "t", "startMs": 300}
        ]}
      ]}
    ]},
    "expected": {"rows": [
      {"id": "r", "number": "1", "depth": 0},
      {"id": "s", "number": "1.1", "depth": 1},
      {"id": "t", "number": "1.1.1", "depth": 2}
    ]},
    "note": "Rule 3 applied twice: r = 1 (depth 0), its only child s = 1 + .1 = 1.1 (depth 1), s's only child t = 1.1 + .1 = 1.1.1 (depth 2)."
  },
  {
    "id": "AO-06",
    "input": {"forest": []},
    "expected": {"rows": []},
    "note": "Rule 5: no nodes, no rows."
  },
  {
    "id": "AO-07",
    "input": {"forest": [
      {"id": "p", "startMs": 100, "children": [
        {"id": "pc", "startMs": 50}
      ]},
      {"id": "q", "startMs": 80}
    ]},
    "expected": {"rows": [
      {"id": "q", "number": "1", "depth": 0},
      {"id": "p", "number": "2", "depth": 0},
      {"id": "pc", "number": "2.1", "depth": 1}
    ]},
    "note": "Rule 1 per group: roots q (80) = 1, p (100) = 2; pc is p's only child = 2.1 (rule 4: it stays under p although its 50 is the earliest of all). One global sort across levels would put pc (50) first."
  },
  {
    "id": "AO-08",
    "input": {"forest": [
      {"id": "x", "startMs": 50},
      {"id": "y", "startMs": 0}
    ]},
    "expected": {"rows": [
      {"id": "y", "number": "1", "depth": 0},
      {"id": "x", "number": "2", "depth": 0}
    ]},
    "note": "Rule 1: startMs 0 is a real start time, not a missing one: y (0) < x (50), so y = 1, x = 2. A truthiness check (0 read as 'no startMs') would push y to the end: x, y."
  },
  {
    "id": "AO-09",
    "input": {"forest": [
      {"id": "p", "startMs": 100, "children": [
        {"id": "p1", "startMs": 110},
        {"id": "p2", "startMs": 120}
      ]},
      {"id": "q", "startMs": 200, "children": [
        {"id": "q1", "startMs": 210},
        {"id": "q2", "startMs": 220}
      ]}
    ]},
    "expected": {"rows": [
      {"id": "p", "number": "1", "depth": 0},
      {"id": "p1", "number": "1.1", "depth": 1},
      {"id": "p2", "number": "1.2", "depth": 1},
      {"id": "q", "number": "2", "depth": 0},
      {"id": "q1", "number": "2.1", "depth": 1},
      {"id": "q2", "number": "2.2", "depth": 1}
    ]},
    "note": "Rule 3: each parent numbers its own children from 1. p = 1 has 1.1, 1.2; q = 2 has 2.1, 2.2. One counter shared by all children of a depth would give q's children 2.3, 2.4."
  },
  {
    "id": "AL-02",
    "input": {"label": {"agentId": "agent-a1", "prompt": "<system-reminder>ignore me</system-reminder>\n  Add   a <b>billing</b>\nsection  "}},
    "expected": {"label": "Add a billing section"},
    "note": "Label rule 1: the system-reminder block and its text go; <b> and </b> become spaces; the runs of spaces and newlines collapse to single spaces; trimmed: 'Add a billing section' (21 characters)."
  },
  {
    "id": "AL-03",
    "input": {"label": {"agentId": "agent-a1", "prompt": "012345678901234567890123456789012345678901234567890123456789"}},
    "expected": {"label": "012345678901234567890123456789012345678901234567890123456789"},
    "note": "Label rule 3: the prompt is '0123456789' six times = 60 characters, not longer than 60, so it is kept whole. Cutting at >= 60 would give 59 characters + '…'."
  },
  {
    "id": "AL-04",
    "input": {"label": {"agentId": "agent-a1", "prompt": "012345678901234567890123456789012345678901234567890123456789A"}},
    "expected": {"label": "01234567890123456789012345678901234567890123456789012345678…"},
    "note": "Label rule 3: 61 characters > 60, so the first 59 ('0123456789' five times + '012345678') are kept and '…' is added: 60 characters in total."
  },
  {
    "id": "AL-05",
    "input": {"label": {"agentId": "agent-a1b2c3", "prompt": ""}},
    "expected": {"label": "agent-a1b2c3"},
    "note": "Label rule 2: the empty prompt cleans to empty, so the label is the agentId (12 characters, not cut)."
  },
  {
    "id": "AL-06",
    "input": {"label": {"agentId": "agent-a1b2c3", "prompt": "<system-reminder>only context</system-reminder>"}},
    "expected": {"label": "agent-a1b2c3"},
    "note": "Label rule 1 removes the whole system block, leaving an empty text; rule 2 falls back to the agentId. Checking the raw prompt for emptiness instead of the cleaned text would give an empty label."
  },
  {
    "id": "AL-07",
    "input": {"label": {"agentId": "agent-a1", "prompt": "foo<br>bar"}},
    "expected": {"label": "foo bar"},
    "note": "Label rule 1: the tag <br> sits between two letters and is replaced by a space, giving 'foo bar' (7 characters). Removing tags with an empty string instead of a space would give 'foobar'."
  },
  {
    "id": "AL-09",
    "input": {"label": {"agentId": "agent-a1", "prompt": "<b>Fix</b> bug"}},
    "expected": {"label": "Fix bug"},
    "note": "Label rule 1: the tags become spaces, giving ' Fix  bug'; the whitespace runs collapse to ' Fix bug' and the final trim gives 'Fix bug'. Without the final trim (after the tag step) the label would keep its leading space: ' Fix bug'."
  },
  {
    "id": "AL-08",
    "input": {"label": {"agentId": "agent-0123456789012345678901234567890123456789012345678901234567", "prompt": ""}},
    "expected": {"label": "agent-01234567890123456789012345678901234567890123456789012…"},
    "note": "Label rules 2 and 3: the empty prompt falls back to the agentId, which is 'agent-' (6) + 58 digits = 64 characters > 60, so it is cut to its first 59 characters ('agent-' + 53 digits '0123456789'×5 + '012') followed by '…'. Cutting only the cleaned prompt and never the fallback would return the whole 64-character id."
  }
]
```

## Mutations

- Ties and untimed nodes ordered by `agentId` instead of input order -> AO-02 (a before b) and
  AO-03 (a before c).
- An unstable sort -> AO-02 (a before b), but only when the unstable sort happens to swap the tie;
  the kill is not guaranteed. `Array.prototype.sort` is stable on every supported engine, so
  dropping the input-index tiebreak is an equivalent mutant there.
- A missing `startMs` treated as 0 -> AO-03 (c, a first).
- A `startMs` of 0 treated as missing (truthiness check) -> AO-08 (x, y).
- Tags removed with an empty string instead of a space -> AL-07 (`foobar`).
- One child counter per depth instead of per parent -> AO-09 (q's children 2.3, 2.4).
- The cut skipped for the `agentId` fallback -> AL-08 (the whole 64-character id).
- No final trim after the tag step -> AL-09 (`' Fix bug'`).
- One global sort across all levels -> AO-07 (pc first).
- Numbers from the input index instead of the sorted position -> AO-01 (b = 2, c = 3, a = 1).
- Children appended after all roots instead of right after their parent -> AO-04 (p, q, p2, p1).
- Truncation at `>=` 60 instead of `>` 60 -> AL-03.
- No fallback when the prompt cleans to empty (only the raw prompt checked) -> AL-06.

## Where the result is visible

Session pane → Logs tab → a prompt turn with a workflow → `⚡ <workflow>` → "Agents (N)": the
`#` column (rule order and numbers) and the Task column label of each agent row
(`WorkflowAgentsTable`), and the title of `WorkflowAgentModal` — the dialog with the agent's
"Logs" and "Raw logs" tabs that opens when a row (or its `#` button) is clicked.
