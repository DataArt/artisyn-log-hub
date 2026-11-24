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
- `Do the analysis and PoCs`
- `Write the implementation plan`
- `Review the plan and fix gaps`

If the first review pass finds real architecture issues and you run a second one, write a separate
`Second review pass` step line for it — so the extra pass is visible, not hidden inside the first.

## What the plan is for

The plan is a short document a human skims to catch a wrong direction before any code is written:
a new piece of infrastructure, a new dependency or a whole new mechanism the requirements do not
justify, where a pattern the project already has would do. It records the architecture-level
decisions and how the work is split into chunks — nothing more. The implementing agent is capable:
told roughly what to do, where, and what the acceptance criteria are, it works out the how itself.
Do not write step-by-step instructions, file-by-file change lists or exact line references.

## IMPORTANT

Only do plan. Do not update or create product code. The one exception is step 2.5: research scripts and PoCs
that find something out are written now, outside product code.

**Discovery belongs to planning, not to implementation.** Anything the task needs to *find out* — an analysis,
survey, measurement, data scan, UI walk-through, comparison or PoC — is done by this skill (step 2.5). The plan's
chunks only apply results that are already known.

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

Return your findings as your final message — compact, no filler prose — with these sections:

- **Requirements summary** — one-paragraph restatement of what's being built
- **Wireframes** — notes on referenced wireframes, or "None referenced"
- **Knowledgebase** — each relevant article: path + the convention/pattern to follow
- **Existing patterns** — the mechanisms, modules and conventions the project already has that this task
  should reuse: file path (plus the symbol name where it helps) + one line on the pattern. The patterns that
  shape the design, not an inventory of every file the change will touch
- **Open gaps** — anything you could not find (e.g. no existing pattern for X) that the plan will need to
  decide on from scratch

---

After the report arrives, Write it verbatim to `research/findings-<N>.md` inside `TASK_DIR` (next free number). This
is an audit archive only — it preserves the research trail for re-planning and "why did the plan choose X"
questions across sessions; nothing downstream reads it, and the plan must not depend on it.

### 2.5 — Do the analysis and PoCs now

Everything the task needs to find out is done here, before the plan is written — never left to an
implementation chunk. That covers:

- an analysis, survey, measurement, data scan or comparison the requirements ask for — also when that analysis
  is itself the task's deliverable (a review, an audit, a decision table, a follow-up list);
- a PoC or spike that checks an assumption the plan relies on (a library does X, an API returns Y, a query is
  fast enough) — follow the project's PoC convention if it has one (e.g. a `poc` skill);
- observing the running app or real data (walk a UI, read a DB, replay a session) to decide what to build;
- any open gap in the research report that only an experiment can settle.

How:

- Do it yourself in this session, or hand self-contained pieces to subagents (in parallel when independent).
  Subagents return results as text and you write the files: Claude Code refuses subagent Writes of `.md` files
  named `report*`, `summary*`, `findings*` or `analysis*`; the main session is not subject to that.
- Save results in `TASK_DIR`: the deliverable document when the analysis is the task (named
  `<topic>-analysis.md` and the like), otherwise `research/<topic>.md`, plus any scripts under `research/`.
  Raw data, screenshots and anything with personal data go to the project's tmp dir, never the task folder.
- Carry the outcome into the plan: conclusions become Architecture decisions, numbers are cited where they are
  used.
- If something cannot be found out now (it needs the user's input, an environment you cannot reach, data that
  does not exist yet), stop and tell the user what is missing — do not write a chunk that does it instead.

Skip this step (with a step line saying so) when the requirements ask for no analysis and the research report
left no question that needs an experiment.

### 3 — Generate the implementation plan

Use the research report as your starting context, and do not treat it as a ceiling on your codebase
knowledge: if a decision depends on something it does not answer — an unclear API shape, a missing pattern, a
KB gap — look it up yourself (Read/Grep/Glob) rather than guessing. Research to decide, not to transcribe: the
plan names modules and areas, and the chunk agents locate the exact code themselves.

Keep the plan short. Write it to `IMPL_PLAN` with these sections, in this order:

- **TL;DR**: ALWAYS the very first section in the file. 3-8 terse bullets with the architecture-level choices a
  reviewer must check — this is the part the user actually reads. Cover what applies: new modules/services, new
  dependencies and why, a one-line DB change summary, new or changed API endpoints, anything else with a high
  blast radius (auth, a breaking or backward-incompatible change, a new external integration, a new piece of
  infrastructure or a new mechanism). For every choice that is not the obvious one, add in a few words the
  simpler alternative that was rejected and why. One bullet is mandatory: a one-line summary of the
  external-surface changes (details in External surface), or "no external surface changes". Otherwise skip a
  category that does not apply rather than writing "none" for each; when the change only reuses existing
  patterns, one bullet saying so is enough.
- **Reference**: link to the requirements doc (the `REQUIREMENTS` file).
- **Architecture decisions**: the technical choices too small for TL;DR, one sentence each — which existing
  project pattern is reused, or why none fits and something new is introduced. Do not repeat TL;DR bullets
  here. Rationale only where a reader would otherwise re-litigate the choice. Then the internal contracts
  shared between chunks, each stated once and briefly: function/service signatures, shared type shapes,
  internal keys. API, DB and every other external contract is not repeated here — it lives in External
  surface, and chunks refer to it there.
- **External surface**: MANDATORY, never omitted. EVERY change to what the outside world sees or what this
  code depends on outside itself, at contract level — what the contract is, not how it is implemented:
  - **API** — each new, changed or removed endpoint: method, path, request params/body, response shape,
    auth/permission.
  - **DB** — each new, changed or removed table or column: type, nullability/default, constraints/indexes,
    plus the migration/backfill path.
  - **Other** — anything else that is called or that calls this code: external services and integrations, the
    published interface other installed components use (a client/agent protocol and the like), config keys
    and environment variables, CLI flags, file formats, events/messages.

  For each item state whether it is backward compatible and, if it is not, how older clients and existing
  data are handled. When nothing external changes, write "None" explicitly, so the reviewer sees it was
  considered. This is the one part of the plan that is complete rather than brief: an item missing here is a
  contract nobody reviewed.
- **Test coverage plan**: a few plain bullets (no checkboxes — Implementation Chunks is the only place with
  checkboxes) — the tests the change needs under the project's test policy (CLAUDE.md,
  e.g. a "Test policy" section) when it has one; it overrides this default. Prefer extending existing tests
  over adding new ones; name the kind of test the policy allows and the existing file/doc/scenario it extends,
  and never plan a test kind the policy forbids.
- **Visual/UX notes**: layout, component states, wireframe changes — only if the task has UI changes.
- **Implementation Chunks**: how the work is grouped — see step 3.5. Always the last section in the file.

Omit sections that do not apply — except TL;DR, External surface and Implementation Chunks, which are always
present. Do not add a files-to-change table, a per-file change list or exact line
references — the implementing agent finds the code. One naming rule does belong in the plan: if it calls for a
new `.md` file, its basename must not start with `report`, `summary`, `findings` or `analysis` (any case) —
Claude Code refuses such Writes to subagents, so a chunk agent could not create it. Put the topic first
(`<topic>-analysis.md`).

### 3.5 — Implementation Chunks section

This section is mandatory — `/adlc-lh:implement` and `/adlc-lh:implement-deep` treat it as the authoritative
chunk list and will not re-derive chunks from scratch. Each chunk runs in a fresh agent context, and a final
check verifies every checkbox item against the code.

**A chunk is:**

- a one-line goal — what exists or works once the chunk is done;
- a `Where:` line — the modules/areas it touches. Approximate is fine ("the orders service and its API
  controller"); list individual files only when that is the shortest way to say it;
- 2–6 checkbox items, `- [ ] <outcome>`. Each item is an **acceptance criterion** — an observable outcome that
  can be checked against the code or the running app — not an instruction for how to get there. Say what must
  be true, refer to a contract by name ("per External surface", "per Architecture decisions") instead of
  repeating it, and leave the how to the implementing agent.

**No discovery items.** An item never asks to investigate, analyse, survey, measure, compare, decide, observe
the app or data, or build a PoC — step 2.5 did that. Applying known results and verification (tests pass, a
visual check of the change) are fine.

**Chunking rules:**

- **One chunk = one area of the code.** An agent works best when it reads only the part of the codebase its
  chunk changes; a chunk should sit in one module/package/layer and be doable without studying the code
  another chunk owns. Things that are edited together stay in the same chunk.
- **Ordered by dependency.** Chunk N+1 builds on chunk N — typically schema → services → API → frontend →
  tests, with the chunk(s) that add or extend tests last.
- **Pin the seams in the plan, not in the code.** A later chunk sees an earlier one only as its name and its
  list of changed files. Any interface a later chunk consumes from an earlier one — signatures, type shapes,
  table and column names, event or config keys — is stated in the plan (External surface for external
  contracts, Architecture decisions for internal ones), so the later agent
  builds against the plan instead of reverse-engineering the earlier chunk's code.
- **Granular, not fragmented.** Split so that each chunk is a reviewable unit of change; if a chunk needs more
  than 6 acceptance criteria, split it at a sub-boundary. Do not create a chunk for a trivial edit that
  belongs with its neighbour.

Keep this format exactly — the chunk names and checkbox items are extracted from it:

```markdown
## Implementation Chunks

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | <short chunk name> | <count> | <one-line dependency/ordering note> |
| 2 | <short chunk name> | <count> | ... |

### Chunk 1 — <short chunk name>
<one-line goal>
Where: <modules / areas>
- [ ] <acceptance criterion>
- [ ] <acceptance criterion>

### Chunk 2 — <short chunk name>
<one-line goal>
Where: <modules / areas>
- [ ] <acceptance criterion>
...
```

### 4 — Review pass (subagent)

After writing the plan, spawn a review subagent with this exact prompt (substitute FILE_PATH with the plan file
path and REQ_FILE with `REQUIREMENTS`):

---

You are doing a sanity review of the architecture in an implementation plan. The plan is deliberately short:
it states decisions and acceptance criteria, not implementation steps. Do not ask for more detail, exact file
lists or line references — the implementing agent works those out. Look for a wrong direction, not for
missing minutiae. The one exception is the "External surface" section: that one must be complete.

Plan file: FILE_PATH
Requirements: REQ_FILE

Read both, then the project's CLAUDE.md and the knowledgebase articles and code the plan's decisions rest on —
enough to judge whether the project already has a pattern for what the plan introduces.

Check for:

1. Over-engineering: anything the plan builds that the requirements do not ask for, or a solution noticeably
   heavier than the problem.
2. New infrastructure, a new dependency or a new mechanism (a storage, a service, a library, a background
   process, a protocol, a framework-level technique) that the requirements do not justify — especially where
   the project already has a pattern that would do. Name the existing pattern.
3. Decisions that ignore or contradict existing project patterns, the knowledgebase or the rules in CLAUDE.md.
4. Backward-compatibility risk: a change to an API, a stored format, a schema or a client-facing contract
   that would break older installed versions or existing data, with no compatibility path stated — or a
   schema change with no migration/backfill path stated.
5. External surface: the section is present (or says "None" explicitly) and complete. Every endpoint, table,
   column, integration, published interface, config key/env var, CLI flag, file format or event change that
   the requirements, the decisions or the chunks imply is listed there with its contract and a
   backward-compatibility note. A change that is implied but not listed, a contract too vague to build or
   review against, a missing compatibility note, or "None" where the chunks plainly change something
   external is an issue.
6. Chunks: each stays in one area of the code, the order follows dependencies, the granularity is sensible
   (neither one giant chunk nor a pile of trivial ones), and every interface a later chunk consumes from an
   earlier one is stated in the plan rather than left to be discovered in the code.
7. Chunk items are acceptance criteria that can be verified, and none is discovery work (an analysis, survey,
   measurement, comparison, UI/data walk-through or PoC whose outcome the plan does not already state).
8. Tests: the test plan fits the project's test policy (CLAUDE.md) — no forbidden kind of test, and no changed
   behaviour left without one of the allowed kinds.
9. TL;DR is the first section and matches the body: it carries the one-line external-surface summary (or "no
   external surface changes"), no new module, dependency, DB or API change appears later but is missing from
   it, and no TL;DR bullet is unsupported by the body.

Report issues as a numbered list, most serious first, and mark each one `ARCHITECTURE` (items 1-5: a wrong or
unjustified direction, or a missing or incomplete External surface) or `MINOR` (everything else). If there are no meaningful issues, say so in one line and list nothing.
Do NOT modify the plan file.

---

Fix what the review reports in the plan file. When an `ARCHITECTURE` issue is a real judgment call rather than
a clear mistake, keep your decision if you can defend it, state the rejected alternative in TL;DR, and mention
the disagreement in your final report.

Run a second review pass only if the first one reported `ARCHITECTURE` issues and you changed the plan because
of them. Never more than 2 passes.

### 5 — Return

Report back:
- Full path to the saved plan file (`IMPL_PLAN`)
- Whether step 1.5's distill changed `requirements.md` (and the `notes.md` path, if evidence was moved there)
