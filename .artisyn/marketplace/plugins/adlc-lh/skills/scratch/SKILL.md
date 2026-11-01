---
name: scratch
description: "Create a new task folder from a raw idea or from a tracker task key (Jira etc.). Creates the task folder <task-id>-<slug>/ with requirements.md in the project's todo directory. Given a key that is already scratched plus a description, creates a follow-up task under the same key."
argument-hint: <raw idea description> | <TASK-KEY> [extra notes / follow-up description]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" *)
---

You are creating a new task folder, either from a raw idea or from a task that already lives in the
project's tracker.

Input: $ARGUMENTS

## No clean-context check

Unlike `review`, `plan`, `implement` and `post-impl-check`, this skill runs at any point of a
session, including after unrelated work or another `/adlc-lh:*` command — never ask for `/clear`.
It only records an idea in a new task folder; the context the idea came from is useful material
for the requirements doc, not noise.

## Progress tracking

Follow the Progress tracking rules of the `adlc-lh:tracker` skill. If they are not already in
context, read them: `${CLAUDE_PLUGIN_ROOT}/skills/tracker/SKILL.md`, section
`## Progress tracking`. If the file cannot be read, apply the minimum: write one line before
each step below and never report a failed step as done.

This skill's steps:

- `Resolve the idea source (config, mode, tracker lookup)` — steps 1–3
- `Derive task id, slug and title` — steps 4–6
- `Claim the task folder` — step 7
- `Write the requirements doc` — step 8
- `Update the task index` — step 9

The final report is the turn's closing message, not a task.

## Task ids

The task folder is named `<task-id>-<slug>` and lives in the project's todo directory — step 7
prints its whole path, so you never have to spell it out. `<task-id>` is either the tracker key
(`PROJ-123`) or today's date (`2026-08-11`). There is deliberately no shared counter: two people
running this skill at the same moment must never derive the same folder name, which is exactly what
a `T-<next-number>` scheme cannot guarantee. Never introduce one.

Folders created by the old `T-N` scheme stay valid — every other `/adlc-lh:*` skill still resolves
them. Do not renumber or rename them.

## Steps

### 1 — Read the task-details config

Read `.claude/repo_config/project-env.json` and take `taskDetailsSkill`: the name of a skill that
fetches task details from this project's tracker (Jira, Linear, GitHub Issues, anything). Empty,
absent, or no config file at all means this project has no tracker lookup.

### 2 — Decide the mode

Judge the first whitespace-separated token of the input: does it look like a key from an issue
tracker rather than the opening word of a sentence? `PROJ-123`, `AB-7`, `PLATFORM_X-4021` do;
`add`, `fix`, `the`, `session-export` do not. Trackers vary, so use your judgment on the token in
front of you — the tell is a project-ish prefix bound to a number.

- **Tracker mode** — it looks like a key. That token is the task key; any text after it is extra
  context the user typed on top of the tracked task. That text does double duty: on a key nobody
  has scratched yet it is extra requirements layered on the tracker's own description, and on a key
  that already has a task folder it describes a **follow-up** — the small fix or adjustment that
  came out of the first task's implementation. Step 7 tells the two apart; you do not have to
  decide here.
- **Idea mode** — it does not (the normal case for a free-text idea). The whole input is the raw
  idea.

If it is genuinely borderline — the input could be read either way and the two readings would
produce different task folders — ask the user which they meant instead of guessing. Do not ask
about clear cases.

In tracker mode with no `taskDetailsSkill` configured **and** no extra text after the key, stop and
tell the user:

> `<KEY>` looks like a tracker key, but this project has no `taskDetailsSkill` configured in
> `.claude/repo_config/project-env.json`, so I cannot fetch its details. Either configure that
> skill, or re-run with the description inline: `/adlc-lh:scratch <KEY> <what needs doing>`.

In tracker mode with no configured skill but extra text present, skip step 3 and use that text as
the idea — the key still becomes the task id.

### 3 — Tracker mode: fetch the task details

Invoke the configured skill with the key as its argument:

```
Skill({ skill: '<taskDetailsSkill>', args: '<KEY>' })
```

Use what it returns as the source material for the requirements doc — typically title/summary,
description, acceptance criteria, type, priority, and a link back to the tracker. Take those fields
as given; do not invent fields it did not return, and do not "improve" the tracker's wording into
something that says more than it does.

If the lookup fails or comes back empty (no such skill, key not found, no access), stop and report
what happened, then suggest the same fallback: re-run as `/adlc-lh:scratch <KEY> <description>`, which
keeps the key as the task id and takes the description from the user instead. A "no such task"
answer is also the tracker telling you this token was never a key — say so, and offer to treat the
whole input as a raw idea instead.

If the user supplied extra text after the key, treat it as additional requirements layered on top of
the fetched details, not as a replacement for them.

### 4 — Derive the task id

- Tracker mode: the task key, in the exact case the tracker reports it (fall back to the case the
  user typed if the lookup returned nothing else) — e.g. `PROJ-123`.
- Idea mode: today's date as `YYYY-MM-DD` — e.g. `2026-08-11`. Get it from `date +%F` (or the
  environment's current date), never from memory.

### 5 — Derive a slug

From the fetched title in tracker mode, from the idea in idea mode:

- kebab-case only (lowercase letters, digits, hyphens)
- 10–30 characters total
- Must meaningfully describe the task (not generic words like "new-feature" or "task-update")
- Example: "session-export-csv" or "repo-delete-confirm"

For a follow-up under a key that is already scratched (step 7), the slug describes the follow-up
itself, not the original task — `export-header-encoding`, not `session-export-csv-2`. It is what
distinguishes the two folders, so never number it and never reuse the original's slug.

### 6 — Derive a human-readable title

Tracker mode: use the tracker's title as-is (trim a leading duplicate of the key if it has one).
Idea mode: derive one from the idea (title case, concise).

### 7 — Claim the task folder

Ask the resolver where this task's docs go, and whether the id is still free — run this with the
id from step 4 and the slug from step 5:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" --new "<task-id>" --slug "<slug>" --project "${CLAUDE_PROJECT_DIR}"
```

It prints the whole paths to use for the rest of this skill — `TASK_DIR`, `REQUIREMENTS`,
`TODO_INDEX`. **Use those strings verbatim**, absolute as printed; never build a task path
yourself out of a directory and a folder name, never rewrite one as a relative path, and never
assume the docs live under `docs/tasks/` — a project can move them.

Act on `STATUS`:

- `available` — the id is free. Continue; the files you write in the next steps create the folder.
- `exists-in-todo` / `exists-in-done` — this task was already scratched; its folder is at
  `TASK_DIR`. Do not write into that folder and do not create a variant of it. What happens next
  depends on whether the user gave you text of their own after the key (step 2) — see *Already
  scratched* below.
- `error` — show its `ERROR` line and stop. A rejected slug means step 5 produced something that is
  not kebab-case; fix that and re-run rather than working around it.

Note what `exists-in-*` does NOT mean in idea mode: another task carrying today's date is not a
collision, and the resolver does not report one. Idea-mode ids repeat by design (several ideas a
day), so the check there is against the exact `<date>-<slug>` folder — reaching this status means
that same folder exists, not merely that some other task shares the date.

#### Already scratched

In idea mode this status can only mean today's date *and* this exact slug are both taken — a real
duplicate of something scratched earlier today. Stop and report it; everything below is about
tracker keys.

**No text after the key** — nothing to build a second task out of. Stop, report `TASK_DIR`, and
tell the user this task was already scratched; that is the normal signal that someone else already
pulled the same key. If they want a follow-up, say so: re-run as
`/adlc-lh:scratch <KEY> <what needs doing>`.

**Text after the key, and the status is `exists-in-done`** — the original is finished and the user
is describing something left over from it. Scratch a follow-up: a second task folder under the same
key, with its own slug from step 5. Claim it by re-running step 7's command with `--followup`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/adlc-task.js" --new "<task-id>" --slug "<slug>" --followup --project "${CLAUDE_PROJECT_DIR}"
```

That flag narrows the check to the exact `<task-id>-<slug>` folder, so the key being taken no longer
blocks it, and it prints a `RELATED_TASK:` line per task already scratched under this key — the
originals this follow-up hangs off. Act on the new `STATUS` the same way: `available` means
continue, and `exists-in-todo` / `exists-in-done` now means this exact slug is taken, so pick a
more specific one and re-run. Carry the `RELATED_TASK:` paths into steps 8 and 9.

**Text after the key, and the status is `exists-in-todo`** — the original task is still open, so
their text could just as well belong in it. Do not guess; ask, then do what they answer:

> `<KEY>` is already scratched and still open at `<TASK_DIR>`. Should I add this to that task's
> requirements, or scratch it as a separate follow-up task under the same key?

Adding it to the open task is not this skill's job — `adlc-lh:tracker` owns edits to an existing
task's docs, so hand it over rather than editing `requirements.md` here. For a separate follow-up,
proceed exactly as in the `exists-in-done` case above.

In tracker mode, do not re-fetch the tracker for a follow-up: step 3 already returned the key's
details, and they describe the original task. The follow-up's own scope comes from the user's text.

### 8 — Write the requirements doc

Read the template from `.claude/repo_config/requirements-template.md`; if that file does not
exist, fall back to `${CLAUDE_PLUGIN_ROOT}/skills/scratch/requirements-template.default.md`.
Create the file at `REQUIREMENTS` from it:

- Substitute the task id, Title, Owner (current git user), Created (today's date).
- `**Tracker:**` line: in tracker mode, fill in the key and the tracker URL if the lookup returned
  one; in idea mode, remove the line entirely.
- Insert the source material into the Description section: the raw idea verbatim in idea mode, the
  fetched description (plus any extra text the user typed) in tracker mode.
- Priority: use what the tracker returned or what the idea directly states; otherwise set it to
  `medium` (the default — never leave it blank or keep the `high | medium | low` placeholder).
- Other metadata fields (Module, Type, scope): fill in only what the tracker returned, what is
  directly stated in the idea, or what is trivially implied by it; leave everything else blank. Do
  not guess these — a speculative value just becomes a manufactured Open Question in review.
- Functional Requirements and Acceptance Criteria: actively draft these by restating/reformulating
  the source material, not just copying literal sentences. Break it down into concrete FR bullets,
  then write at least one verifiable Acceptance Criterion per FR. Acceptance criteria the tracker
  already supplies come across as-is. Only leave a bullet blank if the source truly gives nothing to
  work with for that requirement — don't invent scope it doesn't support, but do rephrase and
  structure what it already says.
- Prune sections per the template's own notes (Steps to Reproduce only for bugs;
  Non-Functional Requirements / Open Questions removed if empty).
- Follow-up task (step 7): scope it to the user's text alone — the original task's requirements are
  done and re-stating them here would put finished work back in the pipeline. Open the Description
  with one line naming what it follows, using the folder names from the `RELATED_TASK:` paths:
  `Follow-up to <folder-name>.` Keep the `**Tracker:**` line — a follow-up under a key belongs to
  the same tracker task.

### 9 — Update the index

Append a one-line entry to `TODO_INDEX`:
`- [<task-id>-<slug>] <Title> — <one-line summary>`
For a follow-up, end the summary with `(follow-up to <folder-name>)` so the index shows which task
it came out of — two entries sharing a task id are otherwise indistinguishable here.
If the `TODO_INDEX` file does not exist, create it with a `# Tasks` heading first.

### 10 — Report

Report back: the task id, `TASK_DIR` as the folder path, and — in tracker mode — that the details
came from the tracker via `<taskDetailsSkill>`. For a follow-up, say so and name the task it
follows, so it is clear this is a second folder under that key and not a rewrite of the first.

Then end with the next step, giving it `TASK_FOLDER_NAME` from step 7 — the full folder name,
never the bare task id. A bare id can match more than one task: in idea mode it is just today's
date, so `/adlc-lh:review 2026-08-11` matches every task scratched that day, and a follow-up makes its
key match both folders the same way. Either one makes the next skill stop and ask which was meant.
Print this line exactly, with only the folder name filled in:

> Next step: `/adlc-lh:review <TASK_FOLDER_NAME>`
