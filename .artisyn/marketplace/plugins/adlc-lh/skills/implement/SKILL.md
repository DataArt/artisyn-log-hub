---
name: implement
description: "Implement a small, low-risk task inline in a single session — no Workflow, no subagents. For simple changes (e.g. move a button) when the user is sure there are no complex implications. Use adlc-lh:implement-deep for anything non-trivial."
argument-hint: <task-id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

You are implementing a task the user has declared small and simple. Everything happens inline in
this session: you execute the plan items yourself and run the health checks yourself — no
`Workflow` tool, no subagents, no separate verification/judge agents.

Task: $ARGUMENTS

## Clean-context check

Run this skill only against a clean context. Before step 1, check whether the message that
invoked this skill is the FIRST user message in the current conversation — no prior user prompts,
no earlier `/adlc-lh:*` invocation, no unrelated work already done in this session.

If it is not, STOP immediately — do not run step 1 or take any other action — and tell the user:

> This skill must run on a clean context. Please run `/clear`, then re-invoke `/adlc-lh:implement $ARGUMENTS`.

Only proceed past this point once confirmed this is the first user message of the session.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: write one line before
each step below and never report a failed step as done.

This skill's steps:

- `Locate the plan`
- one line per plan **chunk** as you start it (`→ <chunk name> (<n>/<total chunks>)`) — not per
  item
- `Run health checks`
- `Visual check`
- `Wrap up`

## Project config

All project-specific facts come from `.claude/repo_config/` (see its README):

- `repo-health-checks.json` — the check list and `environmentNotes`
- `project-env.json` — `appUrl`, `tmpDir`, `credentialsNote` (all optional)

Read both at the start. **Read and obey `environmentNotes`** for every command you run — it states
shared resources, services you must not restart, and temp-file rules. If `project-env.json` is
missing, skip the steps that depend on it (noted below).

## Simplicity guard

None of the following stop the simple track — the user has already judged this task simple, and
that judgment stands. If while implementing you discover the change actually requires database
schema/migration changes, API contract changes, non-trivial cross-module rework, or keeps growing
past the plan's scope, keep going, but include this exact warning in your final report (fill in
the concrete reasons): "Task does not look that simple because <reasons>. I recommend considering
the full flow (`/adlc-lh:plan-deep $ARGUMENTS` to re-plan, then `/adlc-lh:implement-deep $ARGUMENTS`) for any
remaining or future work like this."

File count is a warning, not a blocker: if the change grows past the configured threshold
(`project-env.json → simpleTrack.fileCountWarnThreshold`, default 20 files), keep going, but
include a clear warning in your final report that the task exceeded the simple track's intended
size and the full flow may fit better next time.

## Steps

### 1 — Locate the plan

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

If `IMPL_PLAN` is marked `(MISSING)`, stop: "No implementation plan found for $ARGUMENTS. Run
`/adlc-lh:plan $ARGUMENTS` first."

Read the plan at `IMPL_PLAN`. It MUST have an `## Implementation Chunks` section; if it does not, stop and tell
the user to (re)generate the plan. Do NOT derive chunks yourself.

### 2 — Implement, item by item

Work through the chunk items in order, inline in this session. Follow the plan's file list and
design decisions; follow existing code patterns in the touched files. Honor any project skills
whose triggers apply to what you are doing (code conventions, UI changes, browser use) — invoke
them as their descriptions demand; this skill does not name them.

After completing each item, tick its checkbox in the plan file at `IMPL_PLAN` (`- [ ]` → `- [x]`)
right away — the plan file is the record of what is done.

### 3 — Health checks (inline, scoped to what you touched)

Invoke the `adlc-lh:check-health` skill with `finalRun: false, mode: inline`. That mode runs the
checks directly in this session — no `Workflow`, no subagents — so it respects this skill's
single-session contract, and it keeps the rules for *how* checks are run in one place instead of
restating them here.

Report whatever it reports, including any check it skipped as unrelated to your change.

### 4 — Visual check (UI changes only)

Only if the change is visible in the UI AND `project-env.json` defines `appUrl`: verify the change
in the running app at `appUrl`. Obtain test credentials per `credentialsNote`. Save any
screenshots under the configured `tmpDir` (never the project root) and confirm the result matches
the requirements / wireframe. If `appUrl` is not configured, skip this step and say so in the
report.

### 5 — Wrap up

- Confirm every checkbox in the plan file at `IMPL_PLAN` is ticked.
- Append a one-line dated note to the Notes section of the file at `REQUIREMENTS`:
  `<YYYY-MM-DD> — implemented via adlc-lh:implement; checks green.`
- Make sure no background processes you started are still running, and no temp files were left
  outside the configured `tmpDir`.

Report back:
- The Simplicity guard warning, if it fired.
- Task number and slug implemented
- Files created or modified
- Which checks ran and their results (name + pass/fail), and which checks were skipped and why
- Visual check result, if performed
- The file-count warning, if the threshold was exceeded
- Suggest `/adlc-lh:archive <TASK_FOLDER_NAME>` when the user is satisfied — the folder name from
  step 1, not the bare id the user typed.
