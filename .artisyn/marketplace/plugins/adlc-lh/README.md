# ADLC Task Workflow

A documentation-driven task lifecycle for Claude Code. Every task lives as a folder of Markdown
under `docs/tasks/` (or wherever your project puts it — see `paths` below), and each stage of its
life — scratch, review, plan, implement, check, archive — is a skill that reads and writes those
files. Nothing is held in a session's head between stages.

The skills are project-agnostic. Everything specific to your repo (build commands, app URL,
thresholds, templates) lives in one directory you provide: `.claude/repo_config/`.

## Install

> **adlc-lh** is this repo's local copy of `adlc` 1.3.0, renamed so its skills (`/adlc-lh:*`) never
> collide with an installed `adlc`. In this repo it ships from the project-local `artisyn-e798dd87`
> marketplace (`.artisyn/marketplace`, registered in `.claude/settings.json`) and is enabled as
> `adlc-lh@artisyn-e798dd87`.

### Install into your project with Claude Code

Open Claude Code in the root of your project and paste the prompt below. Claude fetches this folder
from GitHub, installs it as a project-local marketplace plugin under `.claude/marketplace/`,
registers it in `.claude/settings.json`, and fits `.claude/repo_config/` to your project (your real
build/lint/test commands, app URL, task folders). Nothing is committed. Paste the same prompt again
later to update the plugin; your config is kept.

The plugin gets its own name in your project. `-lh` stands for Log Hub, the project this copy
lives in, so the prompt renames every `adlc-lh` to `adlc-<abbr>` — put your abbreviation in place
of `??` on the second line, or leave `??` and Claude derives one from your project's name. Below,
`<name>` is that plugin name, and your commands become `/<name>:scratch`, `/<name>:review`, ….

```text
Install the adlc task-lifecycle Claude Code plugin into this project as a project-local marketplace plugin.

Plugin name for this project: adlc-??
(If I left "??", pick a 2-4 letter lowercase abbreviation of this project's name, e.g. adlc-shop.
Never keep "adlc-lh" - "lh" is Log Hub, the project the plugin is copied from - and never use plain
"adlc", which collides with the upstream plugin. Below <name> means the chosen plugin name.)

Source: https://github.com/DataArt/artisyn-log-hub/tree/main/.artisyn/marketplace/plugins/adlc-lh
(public repo). Read its README.md and templates/repo_config/README.md before changing anything.

1. Fetch. Shallow sparse clone https://github.com/DataArt/artisyn-log-hub (branch main) into a
   new temp folder outside this project and check out only .artisyn/marketplace/plugins/adlc-lh.
   No git -> download the GitHub tarball of main instead. Delete only that temp folder at the end.
2. Copy the plugin folder (.claude-plugin/, skills/, workflows/, scripts/, templates/, README.md) to
   .claude/marketplace/plugins/<name>/ in this project. If it is already there, replace only that
   folder (this is how you update it; then redo the renaming below).
3. Rename the copy to <name>. First, in its README.md delete the "Install into your project with
   Claude Code" section (this prompt - it only works against the source repo) and replace the note
   that this is Log Hub's local copy with one line saying it is this project's copy of adlc. Then in
   every file of .claude/marketplace/plugins/<name>/ replace every "adlc-lh" with "<name>" (skill
   references /adlc-lh:..., adlc-lh@..., paths, plugin.json "name"), and in plugin.json set
   "displayName" to "ADLC Task Workflow (<project name>)". Change nothing else.
   Afterwards grep the folder: no "adlc-lh" and no "log-hub" may remain,
   and node .claude/marketplace/plugins/<name>/scripts/lint-skills.js must print OK.
4. Marketplace manifest .claude/marketplace/.claude-plugin/marketplace.json:
   {"name": "<mp>", "owner": {"name": "<project name>"}, "plugins": [{"name": "<name>",
   "source": "./plugins/<name>", "description": "ADLC task lifecycle"}]}.
   <mp> = this project's folder name in lower-kebab-case + "-local" (unique per project -
   marketplace names are global in Claude Code). If the file exists, add/replace only this entry.
5. Register it in .claude/settings.json (create if missing; keep every existing key, merge objects):
   extraKnownMarketplaces.<mp> = {"source": {"source": "directory", "path": "./.claude/marketplace"}}
   and enabledPlugins["<name>@<mp>"] = true.
6. Project config. Copy templates/repo_config/* to .claude/repo_config/ (never overwrite an existing
   file - adjust it instead) and fit it to THIS project:
   - repo-health-checks.json - replace every example with this project's real checks (build, lint,
     typecheck, unit/e2e tests) taken from package.json / pom.xml / *.csproj / Makefile / CI config /
     CLAUDE.md. Never invent a command: if the project has no lint, there is no lint check. Set dir,
     a group (checks that share a DB, a port or build output go in one group), finalOnly: true for
     slow ones, timeoutSeconds. Remove the example preCheckSkills / postCheckSkills entries (keep
     empty arrays) and write real environmentNotes.
   - project-env.json - appUrl only if the project runs a local web app/API (from its config or
     start script), else remove the key; tmpDir (e.g. tmp/, and add it to .gitignore); kbIndexPath
     only if a docs index exists; taskDetailsSkill empty unless a tracker skill is installed;
     paths.tasksRoot (default docs/tasks); drop credentialsNote if there is nothing to say.
   - review-dimensions.yaml, requirements-template.md - keep; remove dimensions/sections that cannot
     apply to this stack (e.g. DB with no database, UI with no frontend).
7. Task folders. Create <tasksRoot>/todo/index.md and <tasksRoot>/done/index.md (a "# Tasks" /
   "# Done tasks" heading) if missing.
8. CLAUDE.md (create if missing, else append) - a short section: task tracking always goes through
   the <name>:tracker skill, every code change follows <name>:workcycle, and the build/test commands
   live in .claude/repo_config/repo-health-checks.json.
9. Verify. Every JSON you wrote parses;
   node .claude/marketplace/plugins/<name>/scripts/adlc-task.js --paths --project .
   prints absolute paths and no WARNING; each configured check command really exists (run the fast
   ones once).
10. Do not commit. Report: the plugin name, files created/changed, each health check with where its
   command came from, anything you could not determine. Remind me to restart Claude Code in this
   folder, accept the workspace trust dialog and the marketplace/plugin install it offers (or run
   /plugin and enable <name>), then try /<name>:scratch <idea>.
```

Then restart Claude Code in the project and accept the trust prompt. If the `/<name>:*` skills
still don't show up, install it from the CLI in the project root (`<mp>` is the marketplace name
Claude reported):

```bash
claude plugin marketplace add ./.claude/marketplace
claude plugin install <name>@<mp> --scope project
```

Review what Claude put into `.claude/repo_config/` before your first `/<name>:implement` — the
health checks are the commands every code-touching skill will run. Do not use
`claude plugin marketplace remove <mp>` to "reset" the install: it also empties
`extraKnownMarketplaces` / `enabledPlugins` in the project's `.claude/settings.json`.

### Install by hand

Copy this folder into a local marketplace of your project and rename it as steps 2–5 of the prompt
above describe, then copy the config templates into your project and edit them:

```bash
cp -r "<plugin-root>/templates/repo_config" .claude/repo_config
```

Only `repo-health-checks.json` is worth filling in before your first run — every file and key is
optional, and a skill that needs a missing one skips its dependent step or falls back to a bundled
default rather than failing.

## The two tracks

Both tracks share the same doc conventions and produce the same artifacts. They differ only in how
much machinery they bring.

**Simple track** — runs inline, in one session, no Workflow and no subagents. Use it when you are
sure the change is small (move a button, add a CRUD page):

| Command | What it does |
|---|---|
| `/adlc-lh:scratch <idea>` or `/adlc-lh:scratch <TASK-KEY>` | Create the task folder `<task-id>-<slug>/` with its `requirements.md`, from a raw idea or from a task pulled out of the project's tracker |
| `/adlc-lh:review <task-id>` | Single-pass review of the requirements for gaps and vagueness |
| `/adlc-lh:plan <task-id>` | Minimal `impl-plan.md`, usually one chunk |
| `/adlc-lh:implement <task-id>` | Implement inline, health checks scoped to what you touched |
| `/adlc-lh:post-impl-check <task-id>` | Run the auto-discovered post-implementation checks |
| `/adlc-lh:archive <task-id>` | Move to `done/`, write the summary, update both indexes |

**Deep track** — same conventions, but Workflow-backed with subagents (research, parallel dimension
analysis, chunk-by-chunk implementation with verification). Use it for anything non-trivial:

| Command | What it does |
|---|---|
| `/adlc-lh:review-deep <task-id>` | Review across every configured dimension, in parallel |
| `/adlc-lh:plan-deep <task-id>` | Full plan with research and review subagents |
| `/adlc-lh:implement-deep <task-id>` | Implement chunk-by-chunk via a sequential Workflow |

A simple-track skill that runs into DB/API/cross-module concerns, or past the configured file-count
threshold, does not stop or escalate on its own — it finishes the job and adds a warning to its
report recommending the deep variant. Your judgment that a task was simple stands.

Every lifecycle skill on both tracks writes a short progress line as it moves to its next step (and,
in `implement`, to the next plan chunk). While a deep-track workflow runs in the background, the
session posts a 3–4 sentence status every 15 minutes that ends with a sanity check — a flag on
anything implausible, such as a gigabyte import finished in a second or a test run with zero tests.
The shared rules live in `adlc-lh:tracker`'s
`## Progress tracking` section.

## Task ids and your tracker

Every command after `scratch` takes the **task id** — the folder-name prefix of the task. There are
two forms, and `scratch` picks one from what you give it:

- `/adlc-lh:scratch PROJ-123` — the argument looks like a tracker key, so the task id *is* that key:
  the folder is `PROJ-123-<slug>/`. The requirements doc is drafted from the real task, fetched by
  the skill named in `.claude/repo_config/project-env.json → taskDetailsSkill`. That skill is yours
  (or another plugin's): the plugin knows only its name, so Jira, Linear, GitHub Issues, and
  in-house trackers all work the same way. Add your own notes after the key —
  `/adlc-lh:scratch PROJ-123 also drop the legacy toggle` — and they are layered on top of what the
  tracker returned.
- `/adlc-lh:scratch <raw idea>` — no tracker involved, so the task id is today's date and the folder
  is `2026-08-11-<slug>/`.

There is no shared task counter, and the plugin will not grow one: a counter is read-then-write, so
two people scratching a task at the same moment derive the same number and one silently overwrites
the other's folder. A tracker key and a date are both collision-free without coordination. Existing
`T-N-<slug>` folders keep working everywhere — every skill still resolves them.

Where a date-only id matches several tasks, the skills list the matches and ask which one you meant;
pass the full folder name (`2026-08-11-add-login`) to skip the question. Scratching more than one
idea on the same day is expected and never reports a clash: for a date id the "already scratched"
check is against the exact `<date>-<slug>` folder, not against everything sharing the date. A
tracker key is checked the other way — any `PROJ-123-*` folder, open or archived, means that key is
taken.

A taken key is not a dead end, though. `/adlc-lh:scratch PROJ-123 fix the CSV header encoding` on a key
that is already scratched creates a **follow-up**: a second folder under the same key
(`PROJ-123-export-header-encoding/`), scoped to the text you typed, with a `Follow-up to …` line
pointing at the original. That is the path for the small adjustment that falls out of implementing
the first task, and it is why the key alone can now match more than one folder — pass the full
folder name to the later commands, as `scratch` tells you to. With the original still open, `scratch`
asks first whether you meant a follow-up or an addition to that task's requirements.

## Always-on skills

| Skill | When |
|---|---|
| `adlc-lh:tracker` | Entry point for anything task-shaped: create, note, update, close |
| `adlc-lh:workcycle` | After **any** code change — the iterate loop, definition of done, cleanup |
| `adlc-lh:check-health` | The single owner of *how* build/lint/test checks are run |

`adlc-lh:check-health` is the only place check-running rules live. It reads
`repo-health-checks.json`, runs the checks (concurrently by `group`, in order within a group),
fixes what fails at the root cause, and writes anything it cannot fix to `docs/BLOCKED.md`. Other
skills call it rather than restating the rules.

## Post-implementation checks

`/adlc-lh:post-impl-check <task-id>` discovers its checks at runtime from two places:

- the checks bundled here — `docker-build`, `indexes`, `client-component-size`, `kb-actual`, plus
  manual-only `performance` and `security`
- any your project defines in `.claude/skills/post-impl-check-<id>/`

A project-local folder whose name matches a bundled one replaces it, so you can override a bundled
check instead of being stuck with it. A skill whose name ends in `-no-auto` is manual-only and
never runs in the automatic sweep.

To add your own, create `.claude/skills/post-impl-check-<id>/SKILL.md` with a `description` in its
frontmatter. That is the whole registration step — there is no list to update.

## Skills vs. workflows

Everything you invoke is a **skill**. The scripts under `workflows/` are engines the skills drive,
and they all carry a `-wf` suffix — `adlc-lh:review-deep-wf`, `adlc-lh:implement-deep-wf`,
`adlc-lh:check-health-wf`, `adlc-lh:post-impl-check-wf`, `adlc-lh:review-dimensions-wf`.

The suffix exists because a workflow and a skill sharing a name collide in the slash-command
namespace and the workflow wins. When `workflows/review-deep.js` was named `review-deep`,
`/adlc-lh:review-deep SHAD-241` launched the workflow directly and quietly skipped everything the
skill wraps around it — the clean-context guard, the chat report of suggestions and dropped items,
the common-sense resolution pass, and the distill step. The suffix keeps the two namespaces apart.

Never rename a workflow to match a skill, and never point users at `/adlc-lh:*-wf` — a workflow run on
its own does only its own half of the job.

## Context hygiene

`review`(`-deep`), `plan`(`-deep`), `implement`(`-deep`) and `post-impl-check` each refuse to run
unless the invoking message is the first user turn of the conversation. Run `/clear` before each
of them; never chain two of them in the same session. `scratch` is the exception: it only records
an idea in a new task folder, so it runs at any point of a session.

This is not ceremony. These skills read a document, reason about it, and write it back — a context
already carrying a previous task's reasoning reliably produces a worse document.

## Where the task docs live

The **shape** of the task docs is the plugin's own contract and is identical in every project: a
todo directory holding one `<task-id>-<slug>/` folder per task with `requirements.md` and
`impl-plan.md` inside, an `index.md` beside those folders, and a done directory holding archived
tasks. `impl-plan.md` always ends with an `## Implementation Chunks` section — the only place
checkboxes appear, and the thing both implement skills consume as-is without re-deriving.

The **location** is configurable, through the `paths` block in
`.claude/repo_config/project-env.json`. It defaults to `docs/tasks`, so a project that never sets
it sees exactly the layout above.

No skill ever assembles one of these paths itself. `scripts/repo-config.js` reads
`project-env.json` — one table declaring every key's default and validation rule, so no skill has
to apply a default from prose — and `scripts/adlc-task.js` uses it to resolve a task id to the whole
path of every file that task owns. The skills use what it prints verbatim:

```bash
node "<plugin-root>/scripts/adlc-task.js" --task PROJ-123 --project "<repo-root>"
```

That is also what makes the lookup reliable: one piece of code owns matching an id against folder
names (`PROJ-123`, `2026-08-11-<slug>`, a legacy `T-7`, or a full folder name), spotting an id that
matches two tasks, noticing the task is already archived, and falling back to the index when a
folder was renamed. Run it with `--list` for every open task at once, `--paths` for just the
directory and index paths, or `--new <id> --slug <slug>` to check that an id is still free before
creating its folder.

Its paths are absolute, and it finds the project root by walking up from wherever it starts — the
nearest directory holding `.claude/repo_config`, else the git root. Both matter because Claude Code
can be started in a subdirectory: it finds skills and CLAUDE.md by walking up, so a session in
`apps/web` is normal, and a repo-relative path handed to a tool in that session would quietly
resolve under `apps/web/`. A monorepo package that keeps its own `.claude/repo_config` therefore
gets its own task docs, and everyone else gets the repo root.

`PROJECT_ROOT_VIA` in the output names which rule applied, which is the first thing to look at if a
task comes back `not-found` when you can see the folder.

### How the skills get it

`adlc-lh:plan`, `adlc-lh:plan-deep`, `adlc-lh:review`, `adlc-lh:implement`, `adlc-lh:implement-deep` and
`adlc-lh:tracker` don't call the resolver — they carry it as a ` ```! ` block, so Claude Code runs
`--list` and inlines the project's open tasks, with the whole path of every file each one owns,
before Claude reads a word of the skill. Locating a task costs no tool call, and there is no step
for a model to skip. `adlc-lh:archive` and `adlc-lh:scratch` still call it: one needs the assembled move
command, the other derives its task id and slug halfway through the skill.

The task id is deliberately **not** injected, and the lint in `scripts/lint-skills.js` fails the
build if anyone adds it. Claude Code substitutes `$ARGUMENTS` before running an injected command, so
`` !`node adlc-task.js --task "$ARGUMENTS"` `` would work — and `/adlc-lh:review $(whoami)` would then
execute `whoami`, unprompted, before Claude sees the skill. A probe skill with
`allowed-tools: Bash(echo *)` and `` !`echo "[$ARGUMENTS]"` `` printed this machine's username when
invoked that way; the operator-aware permission check doesn't catch it, because as a shell string it
is a single `echo`. A failed injected command also aborts the whole invocation, which would replace
"which of these two tasks did you mean?" with `Shell command failed`. So the injected commands carry
no user input, and a task id that needs resolving goes through an ordinary, permission-checked Bash
call.

## Configuration reference

See `templates/repo_config/README.md` for every file, key, and the `group` concurrency model.
