---
name: tracker
description: "ALWAYS use this skill when working with tasks in any way: issues, bugs, task creation or updates, requirements, planning, implementation progress, archiving, and any /adlc-lh:* lifecycle work."
argument-hint: <task description or task id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

The project keeps an embedded task tracker in its task docs directory (`docs/tasks` unless the
project set `paths` in `.claude/repo_config/project-env.json`).

## Constraints

The commands in this skill only read and update task documentation — never change code as part
of executing them.

## Structure

- a **todo** directory — open tasks, one folder per task, plus an `index.md` listing them all
- a **done** directory — completed tasks; read only when explicitly asked
- each task folder is named `<task-id>-<slug>` and holds `requirements.md` (and later
  `impl-plan.md`), where `<task-id>` is a tracker key (`PROJ-123`), a date (`2026-08-11`), or a
  legacy `T-7`
- Task template: `.claude/repo_config/requirements-template.md` (owned by `adlc-lh:scratch`)

Never spell these paths out from memory. Below are the project's open tasks, each with the whole
absolute path of the files it owns, plus both index paths — the only thing that knows where a
given project keeps its task docs.

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" --list --project "${CLAUDE_PROJECT_DIR}"
```

A `TASK:` entry matches a task id when its folder name equals the id or starts with it followed by
`-`; compare case-insensitively and prefer an exact match. Use its `TASK_DIR`, `REQUIREMENTS` and
`IMPL_PLAN` exactly as printed — they are absolute, so they hold whichever directory this session
started in. `TODO_INDEX` and `DONE_INDEX` are there too, and a name on the `ARCHIVED:` line means
that task is already in the done directory.

When nothing matches — a folder can be named without carrying the id, and the block says
`TRUNCATED:` when it listed only part of a large project — resolve the single id via Bash before
concluding anything:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" --task "<task-id>" --project "${CLAUDE_PROJECT_DIR}"
```

Use that same fallback when the block above is empty, shows a `[shell command execution disabled
by policy]` placeholder, or shows the command text instead of its output — a project can disable
skill shell execution.

Its `STATUS` says what it found: `found-in-todo`, `found-in-done` (archived), `ambiguous` with
`CANDIDATE:` lines to choose between, `not-found`, or `error` with an `ERROR` line to show. A task
id contains only letters, digits, dots, hyphens and underscores; if the user's argument has
anything else in it, do not run the command — ask them what they meant.

## Commands

### create task / create bug

1. **Duplicate check:** the block in Structure already lists every open task and names both
   indexes. Scan those task names, and the summaries in `TODO_INDEX` and `DONE_INDEX` (if it
   exists), for tasks with similar names or descriptions. If a near-duplicate is found, show it to
   the user and ask whether to proceed or update the existing task instead.
2. **Knowledgebase enrichment:** if `.claude/repo_config/project-env.json` defines `kbIndexPath`,
   read that knowledgebase index, identify articles relevant to the task's module(s) or domain, and
   read them. If the file or key is missing, skip this step.
3. Invoke the `adlc-lh:scratch` skill — it derives the task id, creates the folder and
   `requirements.md` from the shared template, and updates the index. Pass along what the user gave
   you: a tracker key (`PROJ-123`, optionally followed by their own notes) if the task already lives
   in the project's tracker, otherwise their description as the raw idea. `adlc-lh:scratch` decides
   which mode applies and, in tracker mode, fetches the details itself.
4. Enrich the created `requirements.md` with what you learned in step 2 (more precise requirements
   and acceptance criteria). For a bug, fill in Steps to Reproduce.
5. Confirm to the user with the task id and the full file path.

### add note to <task-id>

1. Take `REQUIREMENTS` from the matching `TASK:` entry in the Structure block; if nothing matches
   there, follow the fallback that section describes.
2. Append the note under the `## Notes` section at the bottom (create the section if missing),
   prefixed with today's date: `**YYYY-MM-DD:** <note>`.

### close / done <task-id>

Invoke the `adlc-lh:archive` skill with the task id — it moves the folder to the done directory,
creates the summary, and updates both indexes.

### update <task-id>

1. Take `REQUIREMENTS` from the matching `TASK:` entry in the Structure block and read that file.
2. **Knowledgebase enrichment:** if `.claude/repo_config/project-env.json` defines `kbIndexPath`,
   read that knowledgebase index and read the articles relevant to the change.
3. Apply the requested change and save the file.

## Progress tracking

Every `/adlc-lh:*` skill reports its progress as plain text in the conversation — there is no
task-list tool. Do not look for `TaskCreate`/`TaskUpdate`/`TodoWrite`.

**Step lines.** Once the invoking skill's clean-context check passes (or immediately, if it has
none — e.g. `archive`), write one short line before starting each step the skill declared — and,
where the skill works through plan chunks itself, before each chunk:

```
→ <step or chunk name> (<n>/<total>)
```

Step lines count the skill's steps; chunk lines count the plan chunks (`<n>/<total chunks>`).
Where the total is revealed only by a later step (plan chunks), omit `/<total>` until it is known.
A skill may append a short detail after the counter (e.g. the names of the checks about to run).

**15-minute status.** Only the skills that say so — `implement-deep`, `post-impl-check`,
`review-deep` — schedule it; each names its own status sources. Other skills that launch a
`Workflow` (e.g. `adlc-lh:check-health`, also when called from inside one of those three) never
schedule a cron of their own. The skill schedules, in the same message as its `Workflow` call, a
recurring status with `CronCreate` (load its schema first with
`ToolSearch("select:CronCreate,CronDelete")`):

- `cron`: four minutes 15 apart, offset from the current minute so it does not land on :00/:30 —
  e.g. started at 10:07 → `"22,37,52,7 * * * *"`.
- `recurring: true`.
- `prompt`: `"[adlc-lh progress] Write the 15-minute status of the running <skill name> workflow
  for <TASK> (see Progress tracking in the adlc-lh:tracker skill and the skill's own status
  sources). Do not start, stop or change anything."`, where `<TASK>` is the task folder name, or
  the task id the skill was invoked with if the folder is not resolved yet.

Remember the returned job id as `PROGRESS_CRON_ID`. If `CronCreate` is unavailable or fails, say
so in one line and carry on — the status is a convenience, never a blocker. Then end your turn.

Each time the cron prompt fires (only while the session is idle), reply with a status of **3–4
sentences** built only from read-only sources — never touch code, task docs or the workflow while
doing it: how long the workflow has been running, what it is working on now and what changed since
the previous status (from the sources the skill names), and whether it looks to be progressing or
stuck — just flag it, do not intervene. Judge "stuck" only by the signal the skill names; where
the skill says no file changes are expected, their absence is not a stuck signal.

Every status ends with a **sanity check** — step back and ask whether anything you saw is
implausible: a result too fast or too clean for the work it claims (a gigabyte DB import done in
one second, a test suite "passing" with zero tests run, an implementation chunk finished with no
file changes), files changed far outside the task's scope, deleted or emptied files, a sudden huge diff,
or a blocker that keeps reappearing. If something looks suspicious, add one sentence prefixed
`⚠ Suspicious:` naming what and why; otherwise add `Sanity check: nothing suspicious.` Only flag
it — do not intervene. If the workflow has already finished when the prompt
fires, do not write a status — `CronDelete` the job and process the completion notification. On
completion (any outcome), `CronDelete(PROGRESS_CRON_ID)` before anything else.

Rules:

- Never report a step as done when it failed, was blocked, or was only partly done — say so and
  name the blocker.
- These lines are a progress display, not a work queue. Do not add steps the skill does not
  perform, and do not let another skill in context (`adlc-lh:check-health`, a `taskDetailsSkill`,
  a post-impl check, `adlc-lh:workcycle`) add step lines of its own.
- A step the skill legitimately skips (config disabled, no UI change, no tracker) gets a line
  saying "skipped, because …".
- Workflow agents do not report progress to the session; their results are reported once the
  workflow returns.

## The `/adlc-lh:*` skill family

This skill is the entry point into a larger family of `/adlc-lh:*` skills that carry a task through
its full lifecycle. After completing any command above (or any `/adlc-lh:*` skill), always tell the
user which `/adlc-lh:*` command(s) make sense next — don't assume they already know the flow.
Every skill in the family declares its own steps and follows the Progress tracking rules
above.

Unified workflow:
- `/adlc-lh:scratch <idea>` or `/adlc-lh:scratch <TASK-KEY>` — create the task folder with requirements.md
- `/adlc-lh:review <task-id>` — review requirements for completeness
- `/adlc-lh:plan <task-id>` — generate impl-plan.md
- `/adlc-lh:implement <task-id>` — implement plan chunk-by-chunk
- `/adlc-lh:post-impl-check <task-id>` — run auto-discovered post-impl checks
- `/adlc-lh:archive <task-id>` — move to done/, create summary
- `adlc-lh:workcycle` — the full work cycle around any code change (see CLAUDE.md "Work cycle")
- `adlc-lh:check-health` — the build/lint/test check loop (invoked by `adlc-lh:workcycle`)

`/adlc-lh:review`, `/adlc-lh:plan`, and `/adlc-lh:implement` are the default track — same doc conventions
(<task-id>-slug/requirements.md, impl-plan.md), but run entirely inline in one session (no Workflow, no
subagents). Use ONLY when the user is sure the change is small/mid size and has no complex
implications (e.g. move a button; add CRUD page; etc). The user's judgment that a task is simple
stands: if a variant finds DB/API/cross-module concerns, or the file count grows past the
configured threshold (`project-env.json → simpleTrack.fileCountWarnThreshold`, default 20), it does
not stop or escalate — it keeps going and adds a warning to its report recommending the deep skill.

Deep-track variants — same doc conventions, but run via Workflow with subagents (research, review,
parallel dimension analysis, sequential chunk implementation with verification). Use for anything
non-trivial:
- `/adlc-lh:review-deep <task-id>` — full review with parallel dimension analysis
- `/adlc-lh:plan-deep <task-id>` — full plan with research + review subagents
- `/adlc-lh:implement-deep <task-id>` — implement plan chunk-by-chunk via a sequential Workflow

Project-specific data for these skills (commands, paths, thresholds, templates) lives in
`.claude/repo_config/` — see its README. The skills themselves are project-agnostic.

**Context hygiene:** `adlc-lh:review`(`-deep`), `adlc-lh:plan`(`-deep`),
`adlc-lh:implement`(`-deep`), and `adlc-lh:post-impl-check` each enforce this themselves via a
Clean-context check: they refuse to proceed if the invoking message isn't the first user turn in
the conversation, and tell you to run `/clear` and re-invoke instead. Run `/clear` before each of
them. `adlc-lh:scratch` is the exception: it runs at any point of a session, so the "create task"
command above invokes it directly, without asking for `/clear`.
