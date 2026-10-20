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

## Resolving whether a name is a task

Before treating a branch request as `adhoc/`, check whether it is actually a task slug:

- List the task folder directly — `ls docs/tasks/todo/` (and `docs/tasks/done/` if relevant) — and
  look for an exact or prefix match against the name the user gave. Do NOT rely on a `Glob`
  substring pattern like `docs/tasks/todo/*<slug>*`: directory-only matches can silently return no
  results, which looks like "task not found" when the task folder exists.
- If the user's wording already looks like a full task-folder name (e.g. `YYYY-MM-DD-slug`), check
  for that exact folder first before falling back to any fuzzy search.
- Only use `adhoc/<description-slug>` once you've confirmed no matching task folder exists.
- Once the task folder is found, read its `requirements.md` header (`Type:`) to pick `feature/` vs
  `fix/` — `bug` → `fix/`, anything else (`feature`, `chore`, etc.) → `feature/`.

## Rules

- Never commit directly to `main`. Always create/use a feature/fix/adhoc branch first.
- Before creating a new branch, check current branch and status (`git status`, `git branch`) so
  you don't branch off unexpected local changes.
