---
name: git-branching
description: "ALWAYS use this skill if the user asks to do any modifying git operations (branch, commit, merge, etc)."
---

## Branch naming

- `feature/<task>` — new functionality, tied to a task.
- `fix/<task>` — bug fix, tied to a task.
- `adhoc/<description-slug>` — the user asks to change something ad hoc, with no task behind it.

`<task>` is ALWAYS the task slug (in fact task folder name under `docs/tasks/todo`)  from `adlc-lh:tracker`

`<description-slug>` is a short kebab-case description of the change.

## Rules

- Never commit directly to `main`. Always create/use a feature/fix/adhoc branch first.
- Before creating a new branch, check current branch and status (`git status`, `git branch`) so
  you don't branch off unexpected local changes.
