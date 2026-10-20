---
name: post-impl-check
description: "Run all auto-discovered post-implementation checks for a task, one by one, fully automatically; only pauses if a check hits a hard blocker. Checks named *-no-auto are manual-only and skipped."
argument-hint: <task-id>
---

You are the entry point for running post-implementation checks on a task.

Task: $ARGUMENTS

## Clean-context check

Run this skill only against a clean context. Before step 1, check whether the message that
invoked this skill is the FIRST user message in the current conversation — no prior user prompts,
no earlier `/adlc-lh:*` invocation, no unrelated work already done in this session.

If it is not, STOP immediately — do not run step 1 or take any other action — and tell the user:

> This skill must run on a clean context. Please run `/clear`, then re-invoke `/adlc-lh:post-impl-check $ARGUMENTS`.

Only proceed past this point once confirmed this is the first user message of the session.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: create the checklist
below with `TaskCreate`, keep exactly one task `in_progress`, and never mark a failed step
`completed`.

This skill's checklist:

- Phase A (known up front): `Discover available checks`
- Phase B (in the same message that finishes step 1, once the checks are known): one task per
  discovered check (subject = the check's `name`, description = its `description` + `skill`),
  then `Report the check summary`. Remember each created task's id — step 2 hands them to the
  check agents, who mark their own task live from inside the workflow.
- After the workflow returns, reconcile: set every check task's final status from the returned
  `checks[]`. On `halted`, leave the halting task `in_progress` and set the later ones to
  `deleted` before asking the user how to proceed.

## Steps

### 1 — Discover available checks

Run the following via Bash (from repo root):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/post-impl-check/scripts/discover-checks.js" "${CLAUDE_PROJECT_DIR}"
```

It discovers checks from two places: the ones bundled with this plugin, and any the project
defines for itself in `.claude/skills/post-impl-check-<id>/`. A project-local check whose folder
name matches a bundled one replaces it.

Parse the JSON from stdout. It will have this shape (the script already excludes manual-only
`-no-auto` skills and sorts by id — use the array as-is):

```json
{
  "checks": [
    { "id": "docker-build", "name": "Docker-build Check", "description": "...", "skill": "adlc-lh:post-impl-check-docker-build", "source": "plugin" },
    { "id": "cost-calc", "name": "Cost-calc Check", "description": "...", "skill": "post-impl-check-cost-calc", "source": "project" }
  ]
}
```

`skill` is already in the form the Skill tool needs — plugin checks are namespaced, project-local
ones are not. Pass it through as-is; do not add or strip a prefix.

If the script exits with code 1, or if `checks` is an empty array, stop and tell the user:

> "No post-implementation checks found. Create at least one skill folder matching `.claude/skills/post-impl-check-<id>/` to enable checks."

### 2 — Run the checks workflow

The Phase B task list you just created *is* the display of what will run, in order — do not
print a separate list of checks.

Call the `Workflow` tool:

```
Workflow({
  name: 'adlc-lh:post-impl-check-wf',
  args: {
    taskLabel: '$ARGUMENTS',
    checks: [ { id, name, description, skill, taskId }, ... ],  // the discovered checks array from step 1
  }
})
```

`taskId` is each check's session task id from Phase B of Progress tracking — the check agent
updates its own task's status live. It is optional: if the checklist was not created, omit it
and the workflow runs the same.

Each check runs as its own subagent, one at a time in order, fully automatically — there is
**no pause between checks**, even when a check reports findings. The only thing that stops the
run early is a **hard blocker**: a check that could not be performed at all, or one that found a
problem so fundamental (e.g. the app doesn't build) that running further checks would be
meaningless. In that case the workflow halts immediately and skips every remaining check.

Do not poll, re-invoke the workflow, or call `ScheduleWakeup` while waiting — that tool is only for
`/loop` and does not apply here. Simply end your turn; the harness notifies you and resumes you
automatically when it completes.

### 3 — Wait and report

When the workflow completes, its result is:

```
{
  checks: [
    { check: '<name>', id: '<id>', result: { status, findings, hardBlockerReason, summary } },
    ...
  ],
  halted: { index, reason: 'hard-blocker' | 'no-result' | 'no-checks' | 'invalid-args-json' } | null,
}
```

- If `halted.reason` is `'no-checks'` or `'invalid-args-json'`: no check ever ran — the `args` you
  passed were malformed (not the `{ taskLabel, checks: [...] }` object above). Report that plainly
  and do not re-run the workflow with the same arguments.
- If `halted` is non-null with any other reason: stop and tell the user which check hit the hard blocker, quote its
  `hardBlockerReason`, and that remaining checks were skipped. **Ask the user how to proceed**
  (fix the blocker and resume, skip that check and continue, or stop) — this is the one point
  where you need their decision.
- Otherwise, report a full summary of every check that ran:

```
## Post-Implementation Check Summary

| Check       | Findings | Status |
|-------------|----------|--------|
| Security    | 0        | passed |
| Performance | 2        | passed |
| Indexes     | 1        | passed |

All checks complete.
```

List each finding (severity, description, file) under its check. If there are any findings,
ask the user whether they'd like them fixed now — if so, use the fix-agent approach below.
If no findings were reported across all checks, say so plainly: "All checks passed — no
issues found."

## Fixing reported findings (on request only)

If the user asks you to fix findings from a specific check, spawn an Agent with this prompt —
fill in placeholders:

> You are fixing issues found by the [CHECK_NAME] post-implementation check for task $ARGUMENTS.
>
> Issues to fix:
> [PASTE_FINDINGS_LIST]
>
> Instructions:
> 1. Read each issue carefully.
> 2. Fix the issue in the relevant source file.
> 3. Verify with the build and lint checks from `.claude/repo_config/repo-health-checks.json`
>    (run each check's `command` from its `dir`) — confirm zero errors.
> 4. Report: files modified, issues fixed.
>
> Do NOT make changes unrelated to the listed issues.
