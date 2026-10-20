---
name: plan
description: "Generate a minimal implementation plan for a small, low-risk task in a single session. For simple changes (e.g. move a button) when the user is sure there are no complex implications. Use adlc-lh:plan-deep for anything non-trivial."
argument-hint: <task-id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

You are generating a lightweight implementation plan for a change the user has declared small and
simple. Everything happens inline in this session — no research subagent, no review subagent, no
findings archive.

Task: $ARGUMENTS

## Clean-context check

Run this skill only against a clean context. Before step 1, check whether the message that
invoked this skill is the FIRST user message in the current conversation — no prior user prompts,
no earlier `/adlc-lh:*` invocation, no unrelated work already done in this session.

If it is not, STOP immediately — do not run step 1 or take any other action — and tell the user:

> This skill must run on a clean context. Please run `/clear`, then re-invoke `/adlc-lh:plan $ARGUMENTS`.

Only proceed past this point once confirmed this is the first user message of the session.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: create the checklist
below with `TaskCreate`, keep exactly one task `in_progress`, and never mark a failed step
`completed`.

This skill's checklist:

- `Locate requirements`
- `Read requirements and inspect the code`
- `Write the implementation plan`
- `Self-check the plan`

## IMPORTANT

Only plan. Do not update or create code.

## Simplicity guard

None of the following stop the simple track — the user has already judged this task simple, and
that judgment stands. If while planning you discover the task involves database schema/migration
changes, API contract changes, non-trivial cross-module impact, or new dependencies, still write
the full plan, but add this exact warning near the top of your report (fill in the concrete
reasons): "Task does not look that simple because <reasons>. I recommend considering the full
`/adlc-lh:plan-deep $ARGUMENTS` instead."

File count is a warning, not a blocker: if the change touches more files than the configured
threshold (`.claude/repo_config/project-env.json → simpleTrack.fileCountWarnThreshold`, default
20), still write the plan, but clearly warn the user in your report that the task is larger than
the simple track is meant for and suggest considering the full `/adlc-lh:plan-deep`.

## Steps

### 1 — Locate requirements

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

If `REQUIREMENTS` is marked `(MISSING)`, stop: the task has no requirements doc to plan from.

`IMPL_PLAN` is where the plan is saved — that file may not exist yet, which is expected.

### 2 — Read requirements and inspect the code yourself

Read the file at `REQUIREMENTS` (and any referenced wireframes). If there are unanswered Open Questions
that block the plan, stop and ask the user to answer them first.

Then look directly at the code the change touches: find the exact files, components, and existing
patterns to follow. If `.claude/repo_config/project-env.json` defines `kbIndexPath`, read that
knowledgebase index and read an article only if it clearly covers the touched area — skip broad
research; if the file or key is missing, skip the knowledgebase entirely. Carry exact `path:line`
references into the plan so it is self-contained.

### 3 — Write the plan

Write the plan to `IMPL_PLAN` using the same section format as the full skill, keeping only the
sections that apply (for a simple task most are omitted):

- **TL;DR**: ALWAYS the very first section, before Reference. 2-6 terse bullets flagging anything a
  reviewer must not miss — new service/module + functions it exposes, new npm packages, a one-line
  DB changes summary, new/changed API endpoints. Skip a bullet category that doesn't apply; for a
  truly trivial change (e.g. move a button) this can be a single bullet like "Pure UI tweak, no
  new deps/services/DB/API changes."
- **Reference**: link to the requirements doc (the `REQUIREMENTS` file) at the top
- **Design Decisions**: only if the requirements left a real choice open — one sentence each
- **Files to create/modify**: table — path, purpose, brief note per file
- **Test coverage plan**: follow the project's test policy (CLAUDE.md, e.g. a "Test policy"
  section) when it has one — it overrides this default. Prefer extending existing tests over
  adding new ones; for each item name the kind of test the policy allows and the existing
  file/doc/scenario it extends, and never plan a test kind the policy forbids. For a pure visual
  tweak "no test changes; visual check only" is a valid answer
- **Visual/UX notes**: only if the task has UI changes
- **Implementation Chunks**: mandatory, always the last section, the ONLY place action items
  appear. For a simple task this is normally a SINGLE chunk with 2–6 checkbox items:

```markdown
## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | <short chunk name> | <count> | — |

### Chunk 1 — <short chunk name>
- [ ] <item>
- [ ] <item>
```

Item rules (same as the full skill): every item is a checkbox, hard cap 60 words, states the
concrete action + file/location + any value it needs, no rationale prose, and must be
implementable without reading requirements.md. Use a second chunk only if there is a true
dependency ordering (e.g. code first, then tests).

Keep this format exactly — `/adlc-lh:implement-deep` (full) must be able to consume this plan too.

### 4 — Self-check (inline, no subagent)

Re-read the plan you just wrote and verify: TL;DR is the first section and its bullets match what's
actually in the plan, every touched file appears in the Files table, every chunk item is
self-contained and under 60 words, and tests/visual verification are accounted for. Fix anything
you find directly.

### 5 — Report

Report back:
- The Simplicity guard warning, if it fired.
- Full path to the saved plan (`IMPL_PLAN`)
- One-line summary of the change and the number of items
- Next step: `/adlc-lh:implement <TASK_FOLDER_NAME>` — the folder name from step 1, not the
  bare id the user typed, so the next skill resolves to exactly one task.
