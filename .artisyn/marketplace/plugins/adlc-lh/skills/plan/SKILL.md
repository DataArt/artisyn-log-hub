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
`## Progress tracking`. If the file cannot be read, apply the minimum: write one line before
each step below and never report a failed step as done.

This skill's steps:

- `Locate requirements`
- `Read requirements, inspect the code, do any analysis`
- `Write the implementation plan`
- `Self-check the plan`

## IMPORTANT

Only plan. Do not update or create product code.

**Discovery belongs to planning, not to implementation.** Anything the task needs to *find out* — an analysis,
measurement, data or UI check, comparison or small PoC — is done in step 2. The plan's chunks only apply
results that are already known.

## Simplicity guard

None of the following stop the simple track — the user has already judged this task simple, and
that judgment stands. Plain external-surface changes (a new column, a new endpoint, a new config
key) are not a reason on their own. Only two things are: tricky data work (a migration or backfill
that transforms existing data, a data-integrity or consistency risk, concurrent writes to the same
data), or a change that is very large (many modules, or the file-count threshold below). If while
planning you find either, still write the full plan, but add this exact warning near the top of
your report (fill in the concrete reasons): "Task does not look that simple because <reasons>. I recommend considering the full
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

Then look directly at the code the change touches: find the area it lives in and the existing
patterns to follow. If `.claude/repo_config/project-env.json` defines `kbIndexPath`, read that
knowledgebase index and read an article only if it clearly covers the touched area — skip broad
research; if the file or key is missing, skip the knowledgebase entirely. Look enough to decide the
approach — the plan names areas, not exact lines.

If the requirements ask for an analysis, or the plan would rest on an assumption you have not checked (a
library does X, an API returns Y, the data looks like Z), find it out now: check the data, run the query, try
the small PoC (follow the project's PoC convention if it has one, e.g. a `poc` skill). Save what you found in
`TASK_DIR` (`research/<topic>.md`, or the deliverable named `<topic>-analysis.md` when the analysis is the
task) and state the outcome in the plan as an Architecture decision. If you cannot find it out now, stop and tell the
user what is missing — never turn it into a chunk item. A task that needs a real survey or several PoCs is
not simple: say so per the Simplicity guard.

### 3 — Write the plan

Write the plan to `IMPL_PLAN` using the same section format as the full skill, keeping only the
sections that apply (for a simple task most are omitted). Keep it short: the plan states the
decisions and the acceptance criteria, and the implementing agent works out the how — no
files-to-change table, no step-by-step instructions, no exact line references.

- **TL;DR**: ALWAYS the very first section, before Reference. 1-5 terse bullets with the
  architecture-level choices a reviewer must check — new module/service, new dependency, a one-line
  DB change summary, new/changed API endpoints, anything backward-incompatible — and, for a choice
  that is not the obvious one, the simpler alternative rejected in a few words. One bullet is
  mandatory: a one-line summary of the external-surface changes, or "no external surface changes".
  Otherwise skip a category that doesn't apply; for a truly trivial change (e.g. move a button)
  this can be a single bullet like "Pure UI tweak, no external surface changes, no new
  deps/services."
- **Reference**: link to the requirements doc (the `REQUIREMENTS` file)
- **Architecture decisions**: only if the requirements left a real choice open, or chunks share an
  internal contract (a signature, a type shape) — one sentence each, saying which existing project
  pattern is reused or why none fits. External contracts go to External surface, not here
- **External surface**: MANDATORY, never omitted. EVERY change to what the outside world sees or
  what this code depends on outside itself, at contract level (no implementation detail):
  - **API** — each new, changed or removed endpoint: method, path, request params/body, response
    shape, auth/permission
  - **DB** — each new, changed or removed table or column: type, nullability/default,
    constraints/indexes, plus the migration/backfill path
  - **Other** — anything else that is called or that calls this code: external services and
    integrations, the published interface other installed components use, config keys and
    environment variables, CLI flags, file formats, events/messages

  For each item state whether it is backward compatible and, if not, how older clients and
  existing data are handled. When nothing external changes, write "None" explicitly
- **Test coverage plan**: plain bullets, no checkboxes (Implementation Chunks is the only place
  with checkboxes). Follow the project's test policy (CLAUDE.md, e.g. a "Test policy"
  section) when it has one — it overrides this default. Prefer extending existing tests over
  adding new ones; name the kind of test the policy allows and the existing file/doc/scenario it
  extends, and never plan a test kind the policy forbids. For a pure visual tweak "no test
  changes; visual check only" is a valid answer
- **Visual/UX notes**: only if the task has UI changes
- **Implementation Chunks**: mandatory, always the last section. For a simple task this is
  normally a SINGLE chunk with 2–6 checkbox items:

```markdown
## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | <short chunk name> | <count> | — |

### Chunk 1 — <short chunk name>
<one-line goal>
Where: <modules / areas>
- [ ] <acceptance criterion>
- [ ] <acceptance criterion>
```

Chunk rules (same as the full skill): a one-line goal, a `Where:` line naming the modules/areas
touched (approximate is fine), then checkbox items that are acceptance criteria — observable
outcomes that can be checked against the code or the app, not instructions for how to get there.
No discovery items (investigate, analyse, measure, compare, observe, build a PoC) — those were
done in step 2. Use a second chunk only if there is a true dependency ordering (e.g. code first,
then tests). If the plan calls for a new `.md` file, its basename must not start with `report`,
`summary`, `findings` or `analysis` — Claude Code refuses those names to subagents; use
`<topic>-analysis.md` and the like.

Keep this format exactly — `/adlc-lh:implement-deep` (full) must be able to consume this plan too.

### 4 — Self-check (inline, no subagent)

Re-read the plan you just wrote and verify: TL;DR is the first section and its bullets match what's
actually in the plan, including the one-line external-surface summary; the External surface
section is present and complete — every endpoint, table, column, integration, config or other
external change the chunks imply is listed with its contract and a compatibility note, or the
section says "None"; nothing in the plan adds a dependency, a piece of infrastructure or a new mechanism
where an existing project pattern would do; nothing breaks backward compatibility without saying
so; every chunk item is a verifiable acceptance criterion and none is discovery work whose outcome
the plan does not already state; tests/visual verification are accounted for. Fix anything you
find directly.

### 5 — Report

Report back:
- The Simplicity guard warning, if it fired.
- Full path to the saved plan (`IMPL_PLAN`)
- One-line summary of the change and the number of items
- Next step: `/adlc-lh:implement <TASK_FOLDER_NAME>` — the folder name from step 1, not the
  bare id the user typed, so the next skill resolves to exactly one task.
