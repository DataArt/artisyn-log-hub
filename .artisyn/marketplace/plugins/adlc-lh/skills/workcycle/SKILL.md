---
name: workcycle
description: "ALWAYS follow this skill whenever you make any change to the code — it is the work cycle: health-check loop, definition of done, visual checks, and cleanup before declaring the work done."
---

You changed (or are about to change) code. This skill defines the cycle every code change goes
through before the work may be declared done. It does not implement features — it wraps the
checking, verification, and cleanup around whatever change you are making.

All project specifics come from `.claude/repo_config/` (see its README):
`repo-health-checks.json` (checks + `environmentNotes`) and `project-env.json` (`appUrl`,
`tmpDir`). **Read and obey `environmentNotes`** for every command you run — shared resources,
services you must not restart, temp-file rules.

## The cycle

### 1 — Iterate

While actively changing code, after each meaningful change run the health checks by invoking the
`adlc-lh:check-health` skill with `finalRun: false`. Fix what fails (root cause, never weakened
assertions) before piling more changes on top.

Honor any project skills whose triggers apply to what you are doing (code conventions, UI
changes, browser use, post-server-change tests) — invoke them as their descriptions demand; this
skill does not name them.

### 2 — Visual check (UI changes only)

If the change is visible in the UI and `project-env.json` defines `appUrl`, verify the change in
the running app at `appUrl` before declaring done. Save screenshots under the configured `tmpDir`,
never the project root.

### 3 — Final verification

Before declaring the work cycle done, invoke `adlc-lh:check-health` with `finalRun: true` — this
includes the final-only (slow/full-suite) checks and final-only pre/post skills.

If it reports `blocked`, surface the blockers to the user and stop — never loop forever on the
same error, and never declare the work done with a red check.

### 4 — Definition of Done

All must hold before you report the work as complete:

- [ ] The final `adlc-lh:check-health` run (step 3) is fully green.
- [ ] UI changes were visually verified (step 2), or no UI was touched / no `appUrl` configured
      (say which).
- [ ] No background processes you started are still running unattended.
- [ ] No temporary files were left outside the configured `tmpDir`; nothing stray in the project
      root.
- [ ] If working a task: its `impl-plan.md` checkboxes reflect what was actually done.
- [ ] If this session changed `.claude/repo_config/project-env.json` or
      `repo-health-checks.json`, and this project has a CLAUDE.md that restates any of the changed
      values (check it), CLAUDE.md was updated to match — or confirmed it doesn't restate them.

Report results faithfully: name the checks that ran and their status; if anything was skipped,
say so explicitly.
