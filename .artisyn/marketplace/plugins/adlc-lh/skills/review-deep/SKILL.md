---
name: review-deep
description: "Full, Workflow-backed review of a task for completeness, clarity, and technical detail — parallel dimension analysis. Suggests improvements — does not apply them. Use adlc-lh:review for small, low-risk changes."
argument-hint: <task-id>
---

You are the entry point for reviewing a task requirements file.

Task: $ARGUMENTS

## Clean-context check

Run this skill only against a clean context. Before step 1, check whether the message that
invoked this skill is the FIRST user message in the current conversation — no prior user prompts,
no earlier `/adlc-lh:*` invocation, no unrelated work already done in this session.

If it is not, STOP immediately — do not run step 1 or take any other action — and tell the user:

> This skill must run on a clean context. Please run `/clear`, then re-invoke `/adlc-lh:review-deep $ARGUMENTS`.

Only proceed past this point once confirmed this is the first user message of the session.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: write one line before
each step below and never report a failed step as done.

This skill's steps:

- `Launch the review workflow`
- `Report the workflow's findings`
- `Resolve common-sense Open Questions`
- `Distill the requirements doc`

While the workflow runs, the 15-minute status reads only: elapsed time and a repo-wide
`git status --short` (read-only git only), looking for a changed `requirements.md` under the task
docs directory. The dimension agents edit no files, so the doc changes only near the end of the
run (Open Questions appended, wireframes drawn) — no file changes before then is not a stuck
signal, while any file changed outside the task docs is worth a `⚠ Suspicious:` line.

## Granularity

`.claude/repo_config/project-env.json → granularReview` controls how many agents the workflow
spawns per run:

- `false` (default) — Locate and the answered-Open-Questions integration run as one agent, and each
  review dimension self-filters its own findings in the same pass. Fewer agents, same output.
- `true` — Locate and Integrate run as two separate agents, and each dimension's review and filter
  run as two separate agents (an independent second look at what to keep). More agents, same
  output shape, at higher token cost — use when you want the filter step done by an agent blind to
  how the findings were produced.

## Steps

### 1 — Run the review workflow

Call the `Workflow` tool:

```
Workflow({
  name: 'adlc-lh:review-deep-wf',
  args: { taskLabel: '$ARGUMENTS', pluginRoot: '${CLAUDE_PLUGIN_ROOT}' }
})
```

Both fields are required. `pluginRoot` is how the workflow's Locate step finds the task-path
resolver it runs — a workflow script cannot resolve `${CLAUDE_PLUGIN_ROOT}` itself, only this
skill's text can. Pass it through as the literal value shown above.

This runs entirely in the background and needs no further input from you: it locates the task,
integrates any already-answered `Open Questions`, loads the review dimensions from
`.claude/repo_config/review-dimensions.yaml` (projects can add, remove, or reword dimensions
there without touching any workflow code), analyzes the requirements in parallel across every
dimension from that file (each also checked against the actual code where relevant), then converts
every finding into a plain, self-contained question and appends it to the requirements doc's
existing `## Open Questions` section (skipping anything already covered by an unanswered question
there), and draws SVG wireframes back into the file. The doc never accumulates a separate
analysis/notes section — after a review it should contain only its normal sections (Description,
Functional/Non-Functional Requirements, Acceptance Criteria, Open Questions, Notes), with no
dimension names, "problem → suggestion" pairs, or analysis prose left in it anywhere.

In the same message as the `Workflow` call, schedule the 15-minute status cron (Progress
tracking in `adlc-lh:tracker`).

Do not poll, re-invoke it, or call `ScheduleWakeup` while waiting — that tool is only for `/loop`
and does not apply here. Simply end your turn; the harness notifies you and resumes you
automatically when it completes.

### 2 — Report the result

First thing on completion (any outcome): `CronDelete(PROGRESS_CRON_ID)` if a status cron was
created.

The workflow returns:

```
{
  halted: { reason: 'done' | 'not-found' | 'no-requirements' | 'ambiguous' | 'no-result' | 'no-task-label' | 'invalid-args-json', candidates } | null,
  reqFile, taskSlug,
  openQuestions: { changed, summary },
  dimensions: [ { dimension, suggestions: [ { section, problem, suggestion } ], dropped, droppedItems: [ { section, problem, resolution } ] } ],
  failedDimensions: [ '<label>', ... ],
  writeBack: { openQuestionsAdded, wireframesCreated, summary },
}
```

If `halted` is non-null, stop here and tell the user:
- `"done"` → "Task is done, move it into todo."
- `"not-found"` → "No task found for $ARGUMENTS." Point the user at the task index, whose path the
  workflow reports as `todoIndex`.
- `"no-requirements"` → "No requirements.md found for $ARGUMENTS."
- `"ambiguous"` → the task id matches several task folders (a bare date covers more than one task).
  List `halted.candidates` and ask the user to re-invoke with the full folder name.
- `"invalid-task-label"` → what the user passed is not a task id (a task id is only letters,
  digits, dots, hyphens and underscores). Show `halted.candidates[0]` and ask what they meant.
- `"no-result"` / `"no-task-label"` / `"invalid-args-json"` / `"no-plugin-root"` → the review could
  not run; report that plainly. These mean the workflow never received usable arguments — check
  that step 1 passed both `taskLabel` and `pluginRoot`; do not re-run it with the same arguments.

Otherwise, report:

1. A numbered list of every suggestion, grouped by dimension, from `dimensions[].suggestions`:

   ```
   1. [Completeness] "The list loads quickly" is not verifiable. Replace with a measurable condition, e.g. "List renders within 500 ms for up to 100 items."
   2. [Technical clarity] No API endpoint defined for the delete action. Specify: DELETE /api/v1/repos/:id — what response code and body are returned on success and on 404?
   ```

   If `failedDimensions` is non-empty, note which dimension(s) couldn't be analyzed and were skipped.

   If any dimension has `droppedItems`, list them briefly in the chat report ONLY (never write them into the
   doc), one line each: `[dimension] <problem> → <resolution>` — so the user can veto a wrong drop and promote
   it back to an Open Question.

2. If every dimension returned zero suggestions: "No significant gaps found. Requirements appear complete and clear."

3. `writeBack.summary` — what was recorded into the file and which wireframes were created/updated, so the user knows what changed without having to open the file.

4. Remind the user: "Run `/adlc-lh:review-deep $ARGUMENTS` again after making edits to re-check."

### 3 — Resolve common-sense questions

Review the added Open Questions. Any question whose answer is already dictated by existing requirements, project
guidelines (CLAUDE.md, knowledgebase), or common sense — answer it yourself and integrate the answer into the
document, removing it from Open Questions. Record each such answer as a **one-line decision** under a
"Common sense considerations" section.

State decisions, not the argument that led to them: no "resolved because…" narrative, no restating the question,
no correction history. Leave only genuine judgment calls with real product/scope consequences in Open Questions.

### 4 — Distill

After step 3, spawn a distill subagent using the prompt from
`${CLAUDE_PLUGIN_ROOT}/skills/review-deep/distill-prompt.md`, substituting REQ_FILE with the
requirements file path.

Report the distill outcome to the user (changed or already clean; line counts).
