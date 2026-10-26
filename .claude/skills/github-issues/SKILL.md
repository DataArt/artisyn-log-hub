---
name: github-issues
description: "ALWAYS right after adlc-lh:scratch, adlc-lh:review, adlc-lh:review-deep or adlc-lh:archive finishes in this repo (also via adlc-lh:tracker create/close) — mirrors the task folder to a GitHub issue (create/update/close). ALWAYS when the user wants a task from a GitHub issue (GH-42, #42, issue URL) — pass it to /adlc-lh:scratch as GH-42; this skill is scratch's taskDetailsSkill. Without a gh login or Issues write permission it only reminds the user; the task flow keeps working on files."
argument-hint: <GH-42 | #42 | issue URL> | <created|reviewed|archived> <task dir>
allowed-tools: Bash(node .claude/skills/github-issues/gh-issues.js *)
---

This repo's add-on to the generic `adlc-lh` flow: task docs under `docs/tasks/` stay the source of
truth, and each task is mirrored to an issue of this repo's GitHub project. The plugin itself knows
nothing about GitHub — this skill is wired in by `project-env.json → taskDetailsSkill` (lookup) and
by its own trigger (sync after each lifecycle step, see the table in Mode 2).

If the user names an issue as `#42` or a URL, call `/adlc-lh:scratch GH-42 …` — scratch recognises
a key by a prefix bound to a number, so normalise it first.

All GitHub access goes through `gh-issues.js` next to this file (Node, `gh` CLI, no other deps).
Run it from the repo root.

## Mode 1 — lookup (args: an issue reference)

Called by `adlc-lh:scratch` as its `taskDetailsSkill`, with `GH-42`, `#42`, `42` or an issue URL:

```bash
node .claude/skills/github-issues/gh-issues.js fetch <ref>
```

On `GH_STATUS: ok` return its output as the task details: `KEY` is the task id (`GH-42`), `URL` goes
on the `**Tracker:**` line, `TITLE` is the title, the body plus the human comments are the
description. Labels `bug` / `enhancement` imply Type bug / feature. Sync blocks from earlier runs are
already stripped from the body.

## Mode 2 — sync (args: `<event> <task dir>`)

Run after a lifecycle step, with the absolute `TASK_DIR` the step resolved (for `archived`, the
`ARCHIVE_DEST` in the done directory):

| After | Event |
|---|---|
| `adlc-lh:scratch` (also via `adlc-lh:tracker` create task / create bug) | `created` |
| `adlc-lh:review`, `adlc-lh:review-deep` (after its distill step) | `reviewed` |
| `adlc-lh:archive` (also via `adlc-lh:tracker` close / done) | `archived` |

```bash
node .claude/skills/github-issues/gh-issues.js sync <event> "<task dir>"
```

What it does, idempotently:

- finds the issue by the `**Tracker:**` line, a `GH-<n>-` folder name, or (if an earlier run created
  the issue but did not get to write the line back) an `adlc-task`-labelled issue holding this
  folder's sync block; creates one if there is none;
- writes `requirements.md` (minus the H1 and Tracker line) into a sync block
  `<!-- adlc-sync:start task=<folder> --> … <!-- adlc-sync:end -->` in the issue body. Text outside
  the block (the original text of an issue someone opened on GitHub) is never touched. A follow-up
  task under the same key gets its own block in the same issue;
- labels: `adlc-task`, a stage label `adlc:todo` / `adlc:reviewed` / `adlc:done` (only one at a
  time), plus `bug` / `enhancement` from `**Type:**`;
- `created` / `reviewed` reopen a closed issue; `archived` comments and closes it as completed,
  unless another task folder under the same key is still open;
- writes `**Tracker:** GH-<n> <url>` into `requirements.md` if it is not there yet. That is a docs
  edit to the task, which is expected.

Report the `ISSUE` link and `ACTION` in one line of the calling skill's final report.

## When GitHub is not available — never block, just remind

The task flow works on files alone. Never fail or stop the calling skill because of GitHub.

- `GH_STATUS: not-installed` / `not-logged-in` / `no-permission` (exit code 3): the task docs are
  done as usual. Tell the user in one short paragraph that the task was **not** synced to GitHub,
  quote the `HINT:` line, and say that re-running the same `sync` command after fixing it catches
  up (the sync is idempotent). In lookup mode, tell the user the same thing and offer the scratch
  fallback: `/adlc-lh:scratch GH-42 <description>`.
- `GH_STATUS: not-found` in lookup mode: the issue does not exist (or is a PR) — say so and offer to
  treat the input as a raw idea.
- `GH_STATUS: error`: show `MESSAGE`, carry on with the files.

Do not retry in a loop and do not try to fix the user's `gh` login or token yourself.
