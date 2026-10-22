---
name: review
description: "Lightweight single-session review of a task's requirements. For small, low-risk changes (e.g. move a button) when the user is sure there are no complex implications. Use adlc-lh:review-deep for anything non-trivial."
argument-hint: <task-id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

You are reviewing a task requirements file for a change the user has declared small and simple.
Everything happens inline in this session — no Workflow, no subagents, no dimension fan-out.

Task: $ARGUMENTS

## Clean-context check

Run this skill only against a clean context. Before step 1, check whether the message that
invoked this skill is the FIRST user message in the current conversation — no prior user prompts,
no earlier `/adlc-lh:*` invocation, no unrelated work already done in this session.

If it is not, STOP immediately — do not run step 1 or take any other action — and tell the user:

> This skill must run on a clean context. Please run `/clear`, then re-invoke `/adlc-lh:review $ARGUMENTS`.

Only proceed past this point once confirmed this is the first user message of the session.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: write one line before
each step below and never report a failed step as done.

This skill's steps:

- `Locate the task`
- `Read requirements and verify against the code`
- `Integrate answers and resolve obvious gaps`
- `Tighten the doc`

## Simplicity guard

This skill is only for genuinely small changes: UI tweaks, copy changes, a single well-understood
behavior fix, a config value — roughly one module, no data concerns. File count is a warning, not
a blocker: past the configured threshold (`.claude/repo_config/project-env.json →
simpleTrack.fileCountWarnThreshold`, default 20 files), still proceed, but warn the user in your
report that the task may be too large for the simple track.

None of the following stop the simple track — the user has already judged this task simple, and
that judgment stands. If while reviewing you find the task actually involves any of these, keep
going, but add this exact warning near the top of your report (fill in the concrete reasons):
"Task does not look that simple because <reasons>. I recommend considering the full
`/adlc-lh:review-deep $ARGUMENTS` instead."

- database schema or migration changes
- API contract changes (new/changed endpoints, request/response shapes)
- cross-module impact (client + server + shared all touched non-trivially)
- security, auth, or data-integrity concerns
- anything you cannot fully understand from the requirements plus a quick look at the code

## Steps

### 1 — Locate the task

The project's open tasks, each with the whole absolute path of the files it owns:

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" --list --project "${CLAUDE_PROJECT_DIR}"
```

Find the task in it. The argument is a task id — a tracker key (`PROJ-123`), a date-based id
(`2026-08-11-<slug>`), a legacy `T-7`, or a whole folder name — and a `TASK:` entry matches when
its folder name equals the argument or starts with it followed by `-`. Compare case-insensitively,
and prefer an exact folder-name match over a prefix one.

Take `TASK_DIR`, `REQUIREMENTS` and `IMPL_PLAN` from the matching entry and use those strings
verbatim. They are absolute, so they are correct no matter which directory this session started in
— pass each one to a tool or a shell command exactly as printed. Never build a task path yourself
out of a directory and a folder name, and never assume the docs live under `docs/tasks/` — a
project can move them. Repeat any `WARNING` lines the block printed in your final report.

The name on the matching `TASK:` line is that task's folder name — keep it as `TASK_FOLDER_NAME`.
It is the argument every later `/adlc-lh:*` command should be given, because it names exactly one
task where a bare id may not.

Then:

- **Exactly one match** — continue.
- **More than one match** — a bare date can cover more than one task. Show the matching folder
  names and ask the user which one they mean; never pick for them.
- **The name is on the `ARCHIVED:` line** — stop and tell the user the task is archived.
- **No match** — do not conclude the task does not exist. A task folder can carry a name that does
  not contain the id (the index links them), and the block says `TRUNCATED:` when the project has
  more open tasks than it listed. Resolve that one id directly, via Bash — the only branch here
  that needs a tool call:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" --task "<task-id>" --project "${CLAUDE_PROJECT_DIR}"
  ```

  Pass the id exactly as the user typed it, and only if it contains nothing but letters, digits,
  dots, hyphens and underscores — anything else (spaces, quotes, `$`, `;`, `|`, backticks) is not
  a task id: do not run the command, ask the user what they meant. Act on the `STATUS` it prints —
  `found-in-todo` continue with its paths; `ambiguous` show its `CANDIDATE:` lines and ask;
  `found-in-done` the task is archived; `not-found` stop with "No task found for $ARGUMENTS. Check
  the task index at `TODO_INDEX`."; `error` show its `ERROR` line and stop.

- **`STATUS: error` in the block above** — usually a bad `paths` block in
  `.claude/repo_config/project-env.json`. Show the `ERROR` line and stop.
- **No block at all** — empty, or a `[shell command execution disabled by policy]` placeholder, or
  the command text itself rather than its output. Treat that as no match and use the Bash fallback
  above; a project can disable skill shell execution, and a skill synced from claude.ai never runs
  it.

If `REQUIREMENTS` is marked `(MISSING)`, stop: there is nothing to review.

### 2 — Read and verify against the code

Read the file at `REQUIREMENTS`. Then look at the actual code the task touches (Read/Grep/Glob directly —
enough to confirm the change is well-defined, no deep research):

- Does the described element/behavior actually exist where the requirements say it does?
- Is the change unambiguous — could a developer implement it without asking anything?
- Is every Acceptance Criterion concretely verifiable?
- If the task references a wireframe, does it match the requirement text?

Apply the simplicity guard here: this code check is also how you detect a not-actually-simple task.

### 3 — Integrate answered questions, resolve the obvious, ask the rest

- If `## Open Questions` contains answered questions, integrate the answers into the proper
  sections and remove them from Open Questions.
- Any gap whose answer is dictated by existing requirements, project guidelines (CLAUDE.md,
  knowledgebase), existing code, or common sense — decide it yourself and record it as a one-line
  decision under a `## Common sense considerations` section. State decisions, not the reasoning
  that led to them.
- Only genuine judgment calls with real product/scope consequences go into `## Open Questions`,
  each as a plain, self-contained question.

### 4 — Keep the doc clean

The doc must contain only its normal template sections (Description, Functional/Non-Functional
Requirements, Acceptance Criteria, Common sense considerations, Open Questions, Notes) — no
analysis prose, no "problem → suggestion" pairs, no review narrative. If your edits made it
verbose, tighten it in place (one sentence per decision; no correction history). No separate
distill pass is needed — just leave it clean.

### 5 — Report

Report to the user, in chat:

1. The Simplicity guard warning, if it fired.
2. A short numbered list of issues found and what you did about each (fixed in doc / added as
   Open Question / decided by common sense).
3. If nothing significant: "No significant gaps found. Requirements appear complete and clear."
4. Any remaining Open Questions the user must answer before planning.
5. Next step: `/adlc-lh:plan <TASK_FOLDER_NAME>` (or the full `/adlc-lh:plan-deep` if anything felt
   borderline) — pass the folder name from step 1, not the bare id the user typed, so the next
   skill resolves to exactly one task.
