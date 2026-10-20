# repo_config — project-specific data for the task-management skills

The task-management skills (`adlc-lh:scratch`, `adlc-lh:review*`, `adlc-lh:plan*`, `adlc-lh:implement*`,
`adlc-lh:check-health`, `adlc-lh:workcycle`, `adlc-lh:archive`, post-impl checks) are project-agnostic.
Everything project-specific they need lives in this directory, which is the only thing your
project has to provide. Every file here is optional: skills degrade gracefully (skip the dependent
step, or fall back to a bundled default) when a file or key is missing.

The files shipped with the plugin are working examples, not real config — copy the directory to
`.claude/repo_config/` in your project and replace the example values with yours.

Every default named in this README for `project-env.json` is declared once in the plugin's
`scripts/repo-config.js`, and that is what the skills read — so "absent means 20" is resolved by
code before a skill sees it, not applied from prose. A side effect worth knowing: a key that file
does not recognise is reported back as a `WARNING`, so `appURL` shows up as a typo instead of
silently reading as unset.

## Files

| File | Consumed by | Purpose |
|---|---|---|
| `repo-health-checks.json` | `adlc-lh:check-health`, `adlc-lh:workcycle`, `adlc-lh:implement*`, `adlc-lh:post-impl-check*` | The canonical build/lint/test checks: `command`, `dir`, fix `instructions`, and per check a `group` (concurrency unit — see below), a `finalOnly` flag (skip on iterative passes) and a `timeoutSeconds` (how long the foreground call may take before it is killed and reported as a `timedOut` failure); plus `preCheckSkills`/`postCheckSkills` and free-text `environmentNotes` (shared resources, do-not-restart services, temp-file rules) that every code-touching skill must read and obey. |
| `project-env.json` | `adlc-lh:scratch`, `adlc-lh:plan*`, `adlc-lh:implement*`, `adlc-lh:review*`, `adlc-lh:workcycle` | Project environment facts: `appUrl` (running app for visual checks; absent = skip visual checks), `tmpDir` (where temp files/screenshots go), `credentialsNote` (where to find test credentials — never the credentials themselves), `kbIndexPath` (knowledgebase index; absent = skip KB research), `taskDetailsSkill` (tracker lookup for `adlc-lh:scratch` — see below), `paths` (where the task docs live — see below), `simpleTrack.fileCountWarnThreshold` (simple-track skills warn — not stop — past this many touched files; default 20), `granularReview` (`adlc-lh:review-deep`: `false`/absent = fewer, merged agents per run; `true` = split Locate/Integrate and each dimension's review/filter into separate agents — see that skill's Granularity section), `preImplHealthCheck` (`adlc-lh:implement-deep`: `false`/absent = skip the pre-run health check and start implementing immediately; `true` = run `adlc-lh:check-health` with `finalRun: false` before any code changes). |
| `requirements-template.md` | `adlc-lh:scratch` | Template for a new task's `requirements.md`. If absent, the default bundled with the `adlc-lh:scratch` skill is used. |
| `review-dimensions.yaml` | `adlc-lh:review-deep` | Review dimensions for the full review workflow; projects add/remove/reword dimensions without touching workflow code. |

### `taskDetailsSkill` — where `adlc-lh:scratch` gets a tracked task from

`adlc-lh:scratch` accepts either a raw idea or a key from whatever tracker the project uses. One key
configures that:

```json
"taskDetailsSkill": "jira:get-issue"
```

Name a skill that takes a task key as its argument and returns that task's details (title,
description, acceptance criteria, type, priority, link). Any tracker works — Jira, Linear, GitHub
Issues, an in-house one — because the plugin only knows the skill name, never the tracker. Empty or
absent: no lookup; `adlc-lh:scratch` then only accepts raw ideas, and a bare key gets an error telling
the user to configure this or type the description inline.

Recognizing a key (`PROJ-123`) versus the start of an idea is left to the skill's own judgment —
there is no pattern to configure. Nothing in this plugin executes a regex; the skills are prose read
by a model, so a `keyPattern` here would only look enforced. When the input is genuinely ambiguous
`adlc-lh:scratch` asks you rather than guessing.

### `group` — the concurrency unit for health checks

`adlc-lh:check-health` runs different `group`s **concurrently** and the checks inside one group **in
order**. A group is therefore a claim on a shared mutable resource: every check that touches the
same one belongs in the same group.

Getting this wrong is not a style issue — it produces flaky checks. A worked example from the
project these skills grew up in: `npm run build` there rewrites the static assets the watch-mode
dev backend reloads on, so a build overlapping an e2e run knocks the backend out mid-suite. That
is why its `build`, `server-unit`, `e2e-fast` and `e2e-full` checks all share one `app` group,
while the lint and unit-test checks — which only read sources — sit in a separate `static` group
and run alongside them.

The rule of thumb: a check belongs in a group with every other check that writes to, restarts, or
depends on the same thing (a real database, a running dev server, a build output).

Two consequences worth knowing:

- If one check in a group fails and cannot be fixed, the later checks **in that group** are skipped
  (they are ordered behind it for a reason). They come back in the result's `skipped` list — other
  groups are unaffected and run to completion.
- A check with no `group` falls into a shared `_default` group, i.e. fully serial. That keeps a
  config written before this field existed behaving exactly as it did.

A project's `CLAUDE.md` may also keep its own human-readable summary of some of these values, for
ad-hoc work that doesn't go through a task skill (this is project-specific — not every consuming
project will do this). Where it does, keeping the two in sync isn't left to a documentation
convention: it's an enforced step in `adlc-lh:workcycle`'s Definition of Done, checked on every
code-touching work cycle, including edits to this directory's files.

### `paths` — where the task docs live

The task docs default to `docs/tasks`. A project that keeps its documentation somewhere else says
so here:

```json
"paths": {
  "tasksRoot": "documentation/work-items"
}
```

That one key is enough: the todo directory, the done directory and both `index.md` files are
derived from it. Override any of them individually when the derived value is wrong:

| Key | Default |
|---|---|
| `tasksRoot` | `docs/tasks` |
| `todoDir` | `<tasksRoot>/todo` |
| `doneDir` | `<tasksRoot>/done` |
| `todoIndex` | `<todoDir>/index.md` |
| `doneIndex` | `<doneDir>/index.md` |
| `requirementsFile` | `requirements.md` (name inside a task folder) |
| `implPlanFile` | `impl-plan.md` (name inside a task folder) |

Every value is a path relative to the repo root. Absolute paths, drive letters and `..` segments
are rejected outright — a config file that can redirect writes anywhere on disk is a different
thing from a config file that moves a folder.

None of the skills ever join these values together. `scripts/repo-config.js` owns the defaults and
the validation, `scripts/adlc-task.js` turns a task id into finished paths, and the skills use what
it prints verbatim:

```bash
node "<plugin-root>/scripts/adlc-task.js" --task PROJ-123 --project "<repo-root>"
```

That script is also the only thing that matches a task id against folder names, so changing `paths`
needs no edit anywhere else. Moving an existing project's task docs is therefore two steps: move
the directory, then set `tasksRoot`.

Values are relative to the project root, but what the resolver prints is absolute, so it stays
correct in a session Claude Code started in a subdirectory. The project root is the nearest
directory above the starting point holding `.claude/repo_config`, or the git root if there is none
— so a monorepo package with its own `repo_config` keeps its own task docs.

## Conventions that are NOT configurable

The *shape* of the task docs is the skills' own contract and is the same in every project: one
folder per task named `<task-id>-<slug>`, holding `requirements.md` and `impl-plan.md`; an
`index.md` listing the open tasks; archived tasks in the done directory. Only the location of that
tree is configurable, through `paths` above.

`<task-id>` is the tracker key (`PROJ-123`) when the task came from a tracker, and today's date
(`2026-08-11`) when it came from a raw idea. Which of the two you get is decided by the argument you
pass `adlc-lh:scratch`, not by config. Neither form needs a shared counter, which is the point: two
people scratching a task at the same time on different branches cannot land on the same folder name.
Folders from the older `T-N` scheme are still resolved by every skill — leave them as they are.
