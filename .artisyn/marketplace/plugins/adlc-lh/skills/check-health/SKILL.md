---
name: check-health
description: "This skill checks project health. Should be activated by user or from workflow"
argument-hint: "finalRun:boolean (default false), mode:workflow|inline (default workflow)"
---

Run the project's health checks (build / lint / tests / etc.) and fix anything that fails. This
skill only *runs and fixes* checks — it does not implement features. It is the single source of
truth for **how** checks are run; no other skill or workflow should restate these rules.

The checks themselves, and the skills to run around them, are declared in
`.claude/repo_config/repo-health-checks.json`.

## Arguments

- `finalRun` (default `false`) — `true` includes `finalOnly` checks and `finalOnly` pre/post skills.
- `mode` (default `workflow`):
  - `workflow` — dispatch to the `adlc-lh:check-health-wf` Workflow, which runs checks in parallel groups
    with one subagent per check. Use this whenever subagents are allowed.
  - `inline` — run the checks yourself, in this session, with no `Workflow` and no subagents. Use
    this from the simple track (`adlc-lh:implement`), which is contractually single-session.

## Steps

1. Read `.claude/repo_config/repo-health-checks.json`. It provides `preCheckSkills`,
   `postCheckSkills`, `environmentNotes`, and the `checks` array.

   `preCheckSkills` and `postCheckSkills` are arrays of objects:
   ```
   { "skillName": "some-skill", "finalOnly": true }
   ```
   `finalOnly` is optional and defaults to `false`/absent. A skill entry runs unconditionally
   unless `finalOnly` is `true`, in which case it only runs when this run is the final run
   (argument value `finalRun: true`) — skip it on iterative runs.
2. **Pre-check skills.** For each entry in `preCheckSkills` whose `finalOnly` is not `true`, or
   whose `finalOnly` is `true` AND this is the final run, invoke that skill by `skillName` (via the
   Skill tool) and follow it. Skip entries that don't meet this condition, and skip the whole step
   if the array is empty.
3. **Run the checks** — follow the section below matching `mode`.
4. If the result's `status` is `"blocked"`: show the user which check(s) are still failing and why
   (from `blockers` / `docs/BLOCKED.md`), and ask whether to keep trying — never loop forever on the
   same error. Also surface anything in `skipped` — those checks did not run at all.
5. **Post-check skills.** For each entry in `postCheckSkills` whose `finalOnly` is not `true`, or
   whose `finalOnly` is `true` AND this is the final run, invoke that skill by `skillName` (via the
   Skill tool) and follow it. Skip entries that don't meet this condition.

## Mode `workflow` (default)

Pass the FULL `checks` array — the workflow decides what to skip via `finalRun`.

```
Workflow({ name: 'adlc-lh:check-health-wf', args: {
  checks: <the full checks array>,
  environmentNotes: <repo-health-checks.json environmentNotes>,
  finalRun: <argument value, false if not specified>,
} })
```

Launch the workflow with **exactly one** `Workflow` tool call — never issue two `Workflow` calls
in the same turn (parallel/duplicate tool-use blocks).

The workflow groups the checks by their `group` field, runs the groups concurrently and each
group's checks in order, and on failure follows that check's `instructions` to fix the root cause
(up to 3 command launches per check, writing anything still unresolved to `docs/BLOCKED.md`). Do
not poll while it runs — end your turn; the harness resumes you on completion.

## Mode `inline`

Run the checks yourself, in this session. Same semantics as the workflow, minus the concurrency:

- Run every check whose `finalOnly` is not `true` (plus the `finalOnly` ones when `finalRun` is
  `true`). Order them by `group`, finishing one group before starting the next, so checks that
  share a resource never overlap.
- A check clearly unrelated to what you changed (judge by its `module`/`dir` vs. the files you
  touched) may be skipped — but you MUST list every skipped check in your report.
- Use each check's `command` exactly as written, executed from its `dir` — never invent variants.
- Run each command in the **foreground, in one Bash call**, with `timeout` set to the check's
  `timeoutSeconds × 1000`. Do NOT background it and do NOT poll for it. Backgrounding a check and
  waiting on it has been measured to cost several extra minutes per check and buys nothing here.
- Judge pass/fail by the **exit code**, not by how the log text reads — several of these tools
  print error-log fixtures, deprecation warnings, or open-handle notices on a fully successful run.
- Launch each command **once**. Re-run only immediately after editing a file to fix a failure, and
  cap it at 3 launches per check. If it is still failing after that, stop and report the blocker —
  never loop forever on the same error.
- Fix the ROOT CAUSE per the check's `instructions`. Never make a failure disappear by deleting,
  skipping, or weakening an assertion.

## Definition of Done

- [ ] Step 3's checks are all green as of the last run.
- [ ] Any check that did not run (skipped, or skipped behind a failure in its group) was named
      explicitly in your report.

## If a check stays red after fixes

- Each check gets at most 3 command launches before it is written to `docs/BLOCKED.md`.
- Never loop forever on the same error — surface the blocker to the user and stop.
