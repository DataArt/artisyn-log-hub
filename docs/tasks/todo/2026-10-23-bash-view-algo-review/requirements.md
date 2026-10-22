# 2026-10-23: Bash-View Algorithm Doc — Close Round-6 Review Findings

**Status:** todo
**Priority:** low
**Type:** feature
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-10-23

## Description

bash-command-view algo doc: close the remaining round-6 AI review findings and get
reviewed/reviewer: ai. The doc `docs/knowledgebase/algorithms/bash-command-view.md`
(`client/src/viewer/lib/bash-view/*`) went through 6 AI review rounds in task
2026-10-22-context-growth-item-modal; round 6 found no mismatches but left:

HOLES —
1. a `cd` inside a pipeline must not set the analysis root R: add row
   `cd /x | true; cat /x/a.txt` → reads `["/x/a.txt"]` (bash-analyze.ts ~221 vs 229);
2. rule 2.2: a broken `&&` list whose pipeline operand fits at its own indent must keep it on one
   line (bash-format.ts 110-131);
3. fold numbering counts only folded bodies: a 2-line heredoc before a 9-line one →
   `# ▼ block 1` (bash-format.ts 307);
4. rule 5.6 compare before relativisation: `cat a.txt; cd /w; rm /w/a.txt` → changes `["a.txt"]`,
   reads `["a.txt"]` (bash-analyze.ts 183, 453).

MISSING-IN-DOC — the pipeline-cd rule reaches nested statements (`(cd a && cat b) | wc` reads
`b`); `read VAR` / `unset VAR` do not forget a variable (known limit); a trailing comment moves to
its own line (bash-format.ts 67-73); block numbers count only folded bodies; liftCd can drop a
redirect written before the name (`> f cd /x`, bash-format.ts 276-289).

Then one fresh review via `scripts/algo-docs/review-prompt.md`; set `reviewed`/`reviewer: ai` if it
passes.

## Functional Requirements

- FR-1: The examples block of `bash-command-view.md` gets rows that kill the four round-6 holes
  (pipeline `cd` and R, nested chain that fits at its indent, fold numbering after a short heredoc,
  read/change comparison before relativisation), each `expected` derived by hand from the Rules.
- FR-2: The doc's Rules state the five MISSING-IN-DOC behaviours, as rules or as named known
  limits. Where a behaviour is judged a bug (e.g. liftCd dropping a redirect), the code is fixed
  and the rule describes the fixed behaviour.
- FR-3: A fresh, independent AI review runs on the doc; on verdict `reviewed` the front-matter
  becomes `reviewed: <date>` / `reviewer: ai`.

## Acceptance Criteria

- [ ] Each of the four new rows fails against a mutant implementing the hole it targets and passes
      on the real code (`bun run test` in `client/`).
- [ ] The five MISSING-IN-DOC items are each named in the Rules (or a Known limits list) of
      `bash-command-view.md`.
- [ ] A fresh review via `scripts/algo-docs/review-prompt.md` returns `VERDICT: reviewed`, and the
      doc's front-matter is `reviewed: <date>` / `reviewer: ai`.
- [ ] `bun run test`, `bun run typecheck`, `bun run lint` (client) and `npm run test:scripts` pass.

## Notes

<!-- Append timestamped notes here as work progresses -->
