---
name: implement-deep
description: "Implement a task by reading its impl-plan.md and executing it chunk-by-chunk via a sequential Workflow. Use adlc-lh:implement for small, low-risk changes."
argument-hint: <task-id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

You are the entry point for implementing a task. 

Task: $ARGUMENTS

## Clean-context check

Run this skill only against a clean context. Before step 0, check whether the message that
invoked this skill is the FIRST user message in the current conversation — no prior user prompts,
no earlier `/adlc-lh:*` invocation, no unrelated work already done in this session.

If it is not, STOP immediately — do not run step 0 or take any other action — and tell the user:

> This skill must run on a clean context. Please run `/clear`, then re-invoke `/adlc-lh:implement-deep $ARGUMENTS`.

Only proceed past this point once confirmed this is the first user message of the session.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: create the checklist
below with `TaskCreate`, keep exactly one task `in_progress`, and never mark a failed step
`completed`.

This skill's checklist:

- Phase A (known up front): `Run pre-run health check (if enabled)` · `Locate the
  implementation plan` · `Extract the chunk list`
- Phase B (in the same message that finishes step 2, once the chunks are known): one task per
  chunk (subject = chunk name), then `Verify (health checks + judge)` and `Report chunk and
  verification results`. Remember each created task's id — step 3 hands them to the workflow
  agents, who mark their own task live from inside the workflow.
- After the workflow returns, reconcile: set every chunk/verify task's final status from the
  returned `chunks[]` and `verification` — an agent that died leaves its task `in_progress`
  forever otherwise. On `halted`, leave the halting task `in_progress` and set the later ones
  to `deleted` before asking the user how to proceed.

## Steps

### 0 - pre-run health check (optional, default OFF)

This step is opt-in per project. Read `.claude/repo_config/project-env.json` and look at
`preImplHealthCheck`:

- If the file is missing, the key is absent, or its value is anything other than `true` — **skip
  this step entirely** (do not call `adlc-lh:check-health`) and go straight to step 1. This is the
  default.
- Only if `preImplHealthCheck` is exactly `true`, run the pre-run check below.

When enabled: before any code changes call the `adlc-lh:check-health` skill, argument: finalRun = false

- If all checks pass : briefly report any `fixesApplied`, then continue to step 1.
- If `status` is `"blocked"`: stop — show the user which check(s) are still failing and why (from
  `blockers`, and `docs/BLOCKED.md` if written), and ask whether to keep trying before continuing.

Mention in your final report whether the pre-run check ran or was skipped as disabled.

### 1 — Locate the implementation plan

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

The implementation plan is the file at `IMPL_PLAN`. If it is marked `(MISSING)`, stop and tell the
user: "No implementation plan found for $ARGUMENTS. Run `/adlc-lh:plan-deep $ARGUMENTS` first to
generate one."

### 2 — Extract the chunk list

Read the plan file.

The plan MUST have an `## Implementation Chunks` section. 
If it does not, stop and tell the user: "impl-plan.md for $ARGUMENTS has no Implementation Chunks section. Run `/adlc-lh:plan-deep $ARGUMENTS` to (re)generate the plan." 
Do NOT derive chunks yourself.

### 3 — Run the implementation workflow

Call the `Workflow` tool:

```
Workflow({
  name: 'adlc-lh:implement-deep-wf',
  args: {
    planFile: '<the IMPL_PLAN path from step 1>',
    taskLabel: '$ARGUMENTS',
    chunks: [ { name: '<chunk name>', items: ['<item 1>', '<item 2>', ...], taskId: '<its Phase B task id>' }, ... ],
    verifyTaskId: '<the Verify task id from Phase B>',
  }
})
```

`taskId` and `verifyTaskId` are the session task ids created in Phase B of Progress tracking —
each chunk agent (and the verify runner) updates its own task's status live. They are optional:
if the checklist was not created, omit them and the workflow runs the same.

This runs in the background. Do not poll, re-invoke it, or call `ScheduleWakeup` while waiting —
that tool is only for `/loop` and does not apply here. The harness notifies you and resumes you
automatically when it completes.

#### Progress summary every 15 minutes

In the same message as the `Workflow` call, schedule a recurring progress summary with
`CronCreate` (load its schema first with `ToolSearch("select:CronCreate,CronDelete")`):

- `cron`: four minutes 15 apart, offset from the current minute so it does not land on :00/:30 —
  e.g. started at 10:07 → `"22,37,52,7 * * * *"`.
- `recurring: true`.
- `prompt`: `"[implement-deep progress] Summarize what is happening inside the running
  implement-deep workflow for <TASK_FOLDER_NAME> (see the 'Progress summary every 15 minutes'
  section of the adlc-lh:implement-deep skill). Do not start, stop or change anything."`

Remember the returned job id as `PROGRESS_CRON_ID`. If `CronCreate` is unavailable or fails, say so
in one line and carry on without it — the summary is a convenience, never a blocker.

Then end your turn. Each time the cron prompt fires (only while the session is idle), reply with a
**short** summary (5–10 lines) built only from read-only sources — never touch code, tasks or the
workflow while doing it:

- Elapsed time since the workflow started.
- Chunk progress from `TaskList` (the chunk agents mark their own tasks live): which chunks are
  `completed`, which one is `in_progress` now, how many remain; whether Verify has started.
- What the current chunk is touching: `git status --short` and `git diff --stat` (read-only git
  only), compared with the previous summary — new/changed files since then.
- Any new entry in `docs/BLOCKED.md`.
- A one-line read: progressing normally / looks stuck (no new file changes and the same chunk
  `in_progress` across two summaries) — just flag it, do not intervene.

If the workflow has already finished when the prompt fires, do not summarize — `CronDelete` the
job and wait for (or process) the completion notification.

### 4 — Wait and report

First thing on completion (any outcome, including `halted`): `CronDelete(PROGRESS_CRON_ID)` if a
progress cron was created, so no summaries fire after the run is over.

When the workflow completes, its result is:

```
{
  chunks: [{ chunk: '<name>', result: { status, filesChanged, blockers, summary } }, ...],
  halted: { index, reason: 'blocked' | 'no-result' | 'no-chunks' | 'invalid-chunk-shape' | 'invalid-args-json' } | null,
  verification: { status, checks: [{ name, status }], fixesApplied, blockers, judgeVerdict: 'ok' | 'not_ok', judgeReasoning, judgeConcerns } | null,
}
```

`verification` comes from a runner agent that invokes the `adlc-lh:check-health` skill (`finalRun: true`,
so it includes the full e2e suite) plus a second judge agent that independently double-checks that
self-report. `verification.status` is already downgraded to `"blocked"` if the judge disagreed —
report `judgeReasoning`/`judgeConcerns` alongside it when that happens.

`invalid-chunk-shape` / `invalid-args-json` mean the workflow never started any chunk — the
`chunks` array passed in was malformed (a chunk missing `name`/`items`, or unparsable JSON).
Report this as a setup problem, not a task failure: tell the user which chunk index was invalid
and that no work was attempted.

Use it, plus `docs/BLOCKED.md` (if written), to report back:
- Whether the step 0 pre-run health check ran or was skipped (disabled by `preImplHealthCheck`)
- Task number and slug implemented
- Chunks completed vs. total (if `halted` is non-null, say clearly which chunk stopped progress
  and why, quoting its `blockers`, and that later chunks were skipped — do not report the task
  as done)
- Files created or modified (collected from each chunk's `filesChanged`)
- Any blockers encountered (from chunk results, `verification.blockers`, and `docs/BLOCKED.md` if written)
- Final check results per `verification.checks` (name + status for each), and the judge's verdict —
  if `judgeVerdict` is `"not_ok"`, say so explicitly and quote `judgeReasoning`/`judgeConcerns`, even
  if the runner's own self-reported `status` was `"ok"`
