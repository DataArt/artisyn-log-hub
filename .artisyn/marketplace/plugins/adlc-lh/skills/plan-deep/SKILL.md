---
name: plan-deep
description: "Generate a full technical implementation plan from task requirements, with research and review subagents. Use adlc-lh:plan for small, low-risk changes."
argument-hint: <task-id>
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

You are the technical architect generating an implementation plan for a task.

Task: $ARGUMENTS

## Clean-context check

Run this skill only against a clean context. Before step 1, check whether the message that
invoked this skill is the FIRST user message in the current conversation — no prior user prompts,
no earlier `/adlc-lh:*` invocation, no unrelated work already done in this session.

If it is not, STOP immediately — do not run step 1 or take any other action — and tell the user:

> This skill must run on a clean context. Please run `/clear`, then re-invoke `/adlc-lh:plan-deep $ARGUMENTS`.

Only proceed past this point once confirmed this is the first user message of the session.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: write one line before
each step below and never report a failed step as done.

This skill's steps:

- `Locate requirements`
- `Distill check`
- `Research the codebase (subagent)`
- `Archive research findings`
- `Write the implementation plan`
- `Review the plan and fix gaps`

If the first review pass reports issues, write a separate `Second review pass` step line for the
second pass — so the extra pass is visible, not hidden inside the first.

## IMPORTANT

Only do plan. Do not update or create code.

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

Everything below is saved under `TASK_DIR`. Do not read the requirements doc yourself yet; the
subagents in steps 1.5 and 2 read it.

### 1.5 — Distill check (safety net)

`/adlc-lh:review` normally leaves `requirements.md` already distilled. Skip this step entirely when either holds
(check both via cheap shell commands — line count and file mtimes — without reading the file's content):

- the file at `REQUIREMENTS` is under ~150 lines, or
- `notes.md` exists next to it in `TASK_DIR` and is newer than the requirements doc (a distill already ran after the last edit).

Otherwise, spawn a distill subagent with the prompt below, substituting REQ_FILE with
`REQUIREMENTS`. This is a copy of the prompt in
`${CLAUDE_PLUGIN_ROOT}/skills/review-deep/distill-prompt.md` (step 4 there) — if you change the
rules below, update that copy too.

---

You are distilling a task requirements document so it states only the current contract. File: REQ_FILE

- Keep every decision, requirement, constraint, and acceptance criterion — never drop substance.
- One sentence per decision; keep rationale only where a future reader would otherwise re-litigate the choice.
- Remove correction history and dialectic: "an earlier revision said…", "corrected <date>…", "resolved — the
  original claim didn't hold up", and any fact retold in more than one section. State each fact once, in the
  section it belongs to.
- Keep the "Common sense considerations" section as-is — it is already one-line decisions.
- Move evidence trails (experiment write-ups, investigation narratives, review changelogs) into `notes.md` in
  the same folder, leaving at most a one-line pointer in the doc's Notes section. When appending to `notes.md`,
  date-stamp the appended block with today's date and do not re-append content already present in it.
- Leave the Open Questions section untouched.

If the document is already clean, change nothing. Report whether you changed the file, and its line count
before and after.

---

### 2 — Research subagent

Spawn a research subagent with this exact prompt. Substitute TASK_DIR and REQUIREMENTS with the values from
step 1, and KB_INDEX with the `kbIndexPath` value from `.claude/repo_config/project-env.json`
(use the literal word `none` if that file or key is missing). Its report comes back to you
directly — it must not write any file.

---

You are gathering context for a technical implementation plan. Do not write or modify any file.

Task folder: TASK_DIR

1. Read `REQUIREMENTS`.
2. If requirements reference wireframes, review them carefully.
3. If KB_INDEX is `none`, skip this step. Otherwise read the knowledgebase index at KB_INDEX and
   identify and read articles relevant to the task's module(s) or domain.
4. Search the codebase for existing patterns relevant to this task: similar API endpoints, services, controllers,
   or DB models; existing UI components or pages that match the feature area; existing tests that follow the
   project's testing conventions.
5. If a finding involves a numeric or derived value (e.g. a color-space conversion, a computed size, a hash) do
   not eyeball or approximate it — actually compute it and state the exact result. Never write "roughly" or
   "approximately" for a value that can be calculated exactly.

Return your findings as your final message — compact and reference-dense, no filler prose — with these sections:

- **Requirements summary** — one-paragraph restatement of what's being built
- **Wireframes** — notes on referenced wireframes, or "None referenced"
- **Knowledgebase** — each relevant article: path + the convention/pattern to follow
- **Existing patterns** — each relevant file: path:line + one-line description of the pattern to reuse
- **Open gaps** — anything you could not find (e.g. no existing pattern for X) that the plan will need to
  decide on from scratch

---

After the report arrives, Write it verbatim to `research/findings-<N>.md` inside `TASK_DIR` (next free number). This
is an audit archive only — it preserves the research trail for re-planning and "why did the plan choose X"
questions across sessions; nothing downstream reads it, and the plan must not depend on it.

### 3 — Generate the implementation plan

Use the research report as your starting context. Carry the `path:line` references the plan needs into the plan
itself, so it is self-contained — nothing downstream re-reads the research.

**Do not treat the report as a ceiling on your codebase knowledge.** If while writing the plan you hit a question
it doesn't answer — an unclear API shape, a missing pattern, a KB gap — go research it yourself (Read/Grep/Glob)
rather than guessing or leaving it vague.

Write the plan to `IMPL_PLAN` with these sections:

- **TL;DR**: ALWAYS the very first section in the file, before Reference. 4-8 terse bullets giving a
  reviewer the key things to scrutinize without reading the rest — e.g. new services/modules and
  the functions they expose, new npm packages and why, a one-line DB changes summary (new
  tables/columns or "none"), new/changed API endpoints, and any other high-blast-radius change
  (auth, breaking API change, new external integration). Skip a bullet category that doesn't apply
  (e.g. no new libs → no bullet for it) rather than writing "none" for everything. This is a
  navigation aid, not a summary of the whole plan — do not restate Design Decisions or Implementation
  Chunks here.
- **Reference**: link to the requirements doc (the `REQUIREMENTS` file) at the top
- **Design Decisions**: the concrete choices the requirements left open — one sentence per decision, rationale
  only where a future reader would otherwise re-litigate the choice — plus any implementation contract shared by
  multiple chunks (a key/default table, an API shape, a regex), stated once here and referenced from chunk items
- **Files to create/modify**: table — path, purpose, brief note per file
- **API changes**: endpoint, HTTP method, request params, response shape
- **Database changes**: table/collection, columns/fields, types, constraints, migration steps
- **Dependencies**: any new npm packages to add (if none, omit this section)
- **Test coverage plan**: the tests the change needs, under the project's test policy (CLAUDE.md, e.g. a
  "Test policy" section) when it has one — it overrides this default. Prefer extending existing tests over adding
  new ones; for each item name the kind of test the policy allows and the existing file/doc/scenario it extends,
  and never plan a test kind the policy forbids (prose/bullets, not checkboxes — the concrete test-writing action
  items go into chunks)
- **Visual/UX notes**: layout, spacing, component states — only if the task has UI changes
- **Wireframes**: changes in the wireframes if needed.
- **Implementation Chunks**: the full action-item list, split into sequential chunks — see step 3.5. This is
  always the last section in the file, and it is the ONLY place action items appear.

Omit sections that are not applicable (e.g. no DB change → skip Database changes).

### 3.5 — Implementation Chunks section

This section is mandatory — `/adlc-lh:implement` treats it as the authoritative, ready-to-execute chunk list and
will not re-derive chunks from scratch.

Every action item lives here and ONLY here — items are never listed in another section and then copied.

**Item format:**

- Every action item is a checkbox: `- [ ] <action>`
- **Hard cap: 60 words per item.** The concrete action, file/location, and any value/name it needs — nothing
  else. Instead of inlining large details, reference a plan section or decision by name (e.g. "columns per
  Database changes", "per Design Decision 3"). Rationale, tradeoffs, and "why this over that" belong in Design
  Decisions, never in a checkbox.
- Each item must be implementable without reading requirements.md — if it isn't, the missing fact belongs in the
  item (within the cap), in Design Decisions, or in the plan section the item references.

**Chunking rules:**

- group by module
- group by functionality
- tasks from chunk N+1 depend on tasks from chunk N
- Tightly coupled items stay in the same chunk; files that are edited together (e.g. a service and its module
  registration) stay in the same chunk.
- **4–8 items per chunk.** If a natural group has more than 8 items, split it at a sub-boundary instead of
  exceeding 8.
- Order chunks: Schema → Services → API → Frontend → Tests. Tests are always the last chunk(s).

Format:

```markdown
## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | <short chunk name> | <count> | <one-line dependency/ordering note> |
| 2 | <short chunk name> | <count> | ... |

### Chunk 1 — <short chunk name>
- [ ] <item>
- [ ] <item>

### Chunk 2 — <short chunk name>
- [ ] <item>
...
```

### 4 — Review pass (subagent)

After writing the plan, spawn a review subagent with this exact prompt (substitute FILE_PATH with the actual plan file
path):

---

You are reviewing a technical implementation plan for gaps.

Plan file: FILE_PATH

Check for:

1. Missing files that would obviously be needed
2. API changes without corresponding type/interface definitions
3. DB changes without migration steps
4. Missing test coverage for new API endpoints, or planned tests of a kind the project's test policy (CLAUDE.md)
   does not allow
5. Frontend components referenced but not listed
6. Implementation Chunks section: chunk ordering respects Schema → Services → API → Frontend → Tests, and each
   chunk has 4–8 items
7. Missing constants, configuration parameters.
8. Any chunk item over 60 words, or containing rationale/tradeoff prose instead of a bare action (referencing a
   plan section or decision by name is fine and encouraged)
9. Any chunk item that could not be implemented from the plan alone (its own text plus the sections it
   references) without reading requirements.md
10. TL;DR section is present, is the first section in the file, and its bullets match what the rest of
    the plan actually contains (no new lib/service/DB change mentioned later that's missing from TL;DR,
    and no TL;DR bullet unsupported by the plan body)

Report issues as a numbered list. If no meaningful issues, say "No gaps found."
Do NOT modify the plan file.

---

If the subagent reports issues, fix them in the plan file and run another review pass. Repeat up to 2 total passes (stop
when the subagent says "No gaps found" or after 2 passes, whichever comes first).

### 5 — Return

Report back:
- Full path to the saved plan file (`IMPL_PLAN`)
- Whether step 1.5's distill changed `requirements.md` (and the `notes.md` path, if evidence was moved there)
