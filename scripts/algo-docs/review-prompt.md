# Algorithm doc review prompt

Prompt for the independent AI review of one algorithm doc (process and format:
`docs/knowledgebase/algorithms/README.md`; design: `docs/qaa-overview/14-algorithm-units.md` §4).

How to run it: start a **fresh sub-agent** that did not write the doc (a reviewer that shares the
author's context repeats the author's mistakes), pass it the text below with `<name>` filled in,
and record the result in the doc's front-matter as the README describes. The review is read-only:
the reviewer reports, the author fixes.

---

```
You are an independent reviewer of an algorithm doc and its table-driven unit test. You are NOT
the author. Do not run anything and do not change any file. Write in English. Do not trust the
"expected" values in the doc.

Input: the doc docs/knowledgebase/algorithms/<name>.md and the code and test files named in its
"## Code" section (implementation, twins, test).

Background: the doc's "## Examples" section holds one ```examples block, a JSON array of rows
{id, input, expected, note}. The test loads these rows with scripts/algo-docs/load-examples.cjs
and runs each one against the real code, so the rows ARE the test cases.

Steps:
1. Read ONLY the doc's "Purpose", "Input and output" (if present), "Rules" and "Edge cases"
   sections, plus the prose of "Examples" that describes the input shape. Do not read the rows'
   "expected" or "note" yet.
2. For every row read ONLY "id" and "input". Compute the result yourself from the Rules, showing
   the arithmetic. Then compare with the row's "expected". Mark every difference in a number,
   null vs 0, rounding or band/boundary as MISMATCH with both values. Then read the row's "note":
   mark NOTE-NOT-INDEPENDENT if it says or implies the value was taken from running the code
   instead of derived from the Rules.
3. Read the code. For every rule in the doc find file:line. For every condition and constant in
   the code that the doc does not mention, mark MISSING-IN-DOC. For every constant whose value
   differs between doc and code, mark DOC!=CODE with file:line.
4. Mutations: take the doc's "## Mutations" section. For each mutation name the row id that kills
   it and show by arithmetic why that row's result changes. Then invent at least 3 more plausible
   wrong implementations (off-by-one, swapped or inclusive/exclusive conditions, rounding mode,
   null vs 0, rule order, a twin that was not updated). For each find a killing row or mark HOLE.
5. Boundaries: list every threshold and every <, <=, >, >= comparison in the code. For each check
   that there are rows on both sides (at the boundary and next to it). Also check empty input,
   null vs 0, and a value that arrives from the DB as a string vs a number where relevant. Mark
   each missing pair as HOLE.
6. Check that:
   - the result is visible to a user ("Where the result is visible" names a real screen and
     field, an API field, or a named safe behaviour);
   - the algorithm is understandable: a person can reproduce every row on paper from the Rules
     in about 10 minutes without reading code;
   - the rows do not merely duplicate a scenario (compare with docs/qaa-overview/13-new-test-suite.md
     and tests/scenarios/): each row checks a boundary or rule that no scenario covers;
   - every row earns its place: it kills at least one mutant, or it is explicitly marked in its
     note as a regression test for a named bug.
7. Check the test: it reads the rows through loadExamples('<name>') and contains no numbers of
   its own; every twin listed in "## Code" is tested against the same rows by the same loader.

Output (strictly this shape):
VERDICT: reviewed | needs-changes
MISMATCHES: [row ids with your values and the doc's values, or "none"]
NOTE-NOT-INDEPENDENT: [row ids, or "none"]
HOLES: [mutants and boundaries without a killing row, or "none"]
DOC!=CODE: [list with file:line, or "none"]
MISSING-IN-DOC: [list, or "none"]
UNDERSTANDABLE: yes/no + one sentence
VISIBLE: yes/no + screen/field
DUPLICATES-SCENARIO: [S-xxx ids, or "no"]
TEST-READS-DOC: yes/no + what is wrong
FRONT-MATTER: "reviewed: <YYYY-MM-DD>" and "reviewer: ai" if the verdict is reviewed, otherwise
the list of what must be fixed first

The verdict is "reviewed" only when MISMATCHES, NOTE-NOT-INDEPENDENT, HOLES and DOC!=CODE are all
"none", UNDERSTANDABLE and VISIBLE are "yes", and TEST-READS-DOC is "yes".
```

---

## Recording the result

- `reviewed`: set the doc's front-matter to `reviewed: <date>` and `reviewer: ai`, and add the doc
  to the owner's sign-off list. After the owner signs, change `reviewer` to `ai+owner`.
- `needs-changes`: fix the doc or the code (a mismatch is a defect in one of them; never copy the
  code's output into `expected` to make it go away), then run a new review with a fresh sub-agent.
