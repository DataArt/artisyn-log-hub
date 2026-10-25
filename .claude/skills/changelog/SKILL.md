---
name: changelog
description: "ALWAYS when a change is finished and ready to push, or the user explicitly asks to push — write (or re-check) a short summary entry in docs/changelog/<timestamp>-<task-slug>.md before pushing."
---

`docs/changelog/` is a flat, human-readable log of what changed in the application — one short
file per task/change. It is a summary for someone skimming history, not documentation.
Each release shows the entries added since the previous release as "What's new" at the top of its
release notes, and ships them as its `CHANGES.md` asset
(`scripts/ci/release-notes.js`, see `docs/knowledgebase/release-pipeline.md`), so the `# ` title
and the text are what release readers see.

## When

- You have finished a change and are about to push (or about to tell the user it is ready to push).
- The user explicitly says "push" (in any wording/language).

Do it **before** the push, so the entry goes into the same push as the change.

## File name

`docs/changelog/<timestamp>-<task-slug>.md`

- `<timestamp>` — `YYYY-MM-DD-HHmm`, local time when the entry is first created
  (e.g. `2026-10-22-1430`). Sortable by name.
- `<task-slug>` — the task slug from `adlc-lh:tracker` (the task folder name **without** its
  leading date), or, for an ad-hoc change with no task, the same kebab-case
  `<description-slug>` used for the `adhoc/` branch (see `git-branching`).

## Content

English (see `## Documentation language` in `CLAUDE.md`). No details, no file lists, no
implementation notes — just what changed for the application, so a reader understands it at a
glance. A compact change = one sentence. A larger one = a few short sentences or bullets at most.

```markdown
# <Human-readable title>

<One sentence — or a few short bullets — saying what changed in the app.>
```

## If an entry for this task already exists

Before creating a file, look in `docs/changelog/` for an existing file with the same
`<task-slug>` (any timestamp) — e.g. the task was finished and logged, then the user asked for
more changes on it.

- Do **not** create a second file for the same task.
- Re-read the existing entry against everything that was done since: if the summary is still
  accurate in substance (follow-up fixes, polish, review tweaks), leave it as is.
- If the substance changed (new behaviour added, scope changed, something described there was
  dropped), rewrite the summary in place. Keep the original file name/timestamp.

Mention in your reply to the user whether the changelog entry was created, updated or left unchanged.
