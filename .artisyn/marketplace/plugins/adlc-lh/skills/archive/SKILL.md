---
name: archive
description: "Archive a completed task: move it from the todo directory to the done directory, update both indexes."
argument-hint: <task-id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

You are archiving a completed task.

Task: $ARGUMENTS

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: write one line before
each step below and never report a failed step as done.

This skill's steps:

- `Locate the task folder`
- `Read task context`
- `Ensure the archive directory exists`
- `Move the task folder`
- `Update the todo index`
- `Update the done index`

## Steps

### 1 — Locate the task folder

The argument is a task id — the folder-name prefix of the task: a tracker key (`PROJ-123`), a
date-based id (`2026-08-11-<slug>`), a legacy `T-7`, or the whole folder name. Resolve it with the
bundled resolver:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" --task "<task-id>" --project "${CLAUDE_PROJECT_DIR}"
```

Pass the id exactly as the user typed it. A task id contains only letters, digits, dots, hyphens
and underscores — if the argument has anything else in it (spaces, quotes, `$`, `;`, `|`, backticks),
it is not a task id: do not run the command, stop and ask the user what they meant.

The resolver prints one whole path per line — `TASK_DIR`, `REQUIREMENTS`, `IMPL_PLAN`,
`ARCHIVE_DEST`, `TODO_INDEX`, `DONE_INDEX`, `DONE_DIR`, and the two move commands. **Use those
strings verbatim.** Every path it prints is absolute, so it is correct no matter which directory
this session started in — pass each one to a tool or a shell command exactly as printed, and never
rewrite it as a relative path. Never build a task path yourself out of a directory and a folder
name, and never assume the docs live under `docs/tasks/` — a project can move them, and only the
resolver knows where they are. Repeat any `WARNING` lines it prints in your final report.

Act on `STATUS`:

- `found-in-todo` — continue.
- `ambiguous` — the id matches several task folders (a bare date can cover more than one task).
  Show the `CANDIDATE:` lines and ask the user which one to archive — never archive more than the
  one task you were asked to.
- `found-in-done` — stop: the task is already archived, at `TASK_DIR`.
- `not-found` — stop and tell the user: "No todo folder found for $ARGUMENTS. Is it already
  archived?"
- `error` — the resolver could not run (usually a bad `paths` block in
  `.claude/repo_config/project-env.json`). Show its `ERROR` line and stop.

### 2 — Read task context

Read the following files from the task folder:
- `REQUIREMENTS` — to understand what the task was about
- `IMPL_PLAN` — to understand what was implemented (skip it if the resolver marked it `(MISSING)`)

Extract:
- Task title (from the `# <task-id>: <Title>` heading in requirements.md)
- List of key files mentioned in the implementation plan (files created or modified)
- Any open questions or notes that were resolved during implementation

### 3 — Ensure the archive directory exists

Ensure the `DONE_DIR` directory exists. If it does not, create it.


### 4 — Move the task folder

Move the entire folder from the todo directory to the archive directory by running the command the
resolver already assembled for you, exactly as printed:

- **Linux/macOS (Bash):** `MOVE_COMMAND_BASH`
- **Windows:** `MOVE_COMMAND_POWERSHELL`, via the PowerShell tool

Do not retype the paths — the resolver's are the correct ones for this project.

After moving, verify `ARCHIVE_DEST` exists and `TASK_DIR` is gone.

### 5 — Update the todo index

Read `TODO_INDEX`. Remove the line that references `TASK_FOLDER_NAME`. Save the file.

If the file does not exist or the entry is not found, skip silently (do not error).

### 6 — Update the done index

Read `DONE_INDEX` if it exists. Append a new entry at the end:

```
- [<TASK_FOLDER_NAME>] <Task Title> — archived YYYY-MM-DD
```

If `DONE_INDEX` does not exist, create it with a `# Done Tasks` heading first, then append the entry.


### 7 — Confirm to user

Report back with a confirmation message in this format:

```
Task <TASK_FOLDER_NAME> archived successfully.

Location: <ARCHIVE_DEST>

<TODO_INDEX> updated — entry removed.
<DONE_INDEX> updated — entry appended.
```
