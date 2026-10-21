---
name: review-poc
description: "ALWAYS when, while reviewing a task (adlc-lh:review, adlc-lh:review-deep, or an ad-hoc review of requirements/plan), you need to build a prototype / proof of concept / spike to check an assumption. Defines where the PoC lives (docs/pocs/<datetime>-<slug>/) and that every non-source file in it (dependencies, build output, logs) is listed in that folder's own .gitignore."
---

# Prototypes during task review

A review sometimes cannot answer a question from code and docs alone — "does library X support Y",
"will this query be fast enough", "can the hook read Z on Windows". Then build a small prototype.
This skill fixes where it goes and what of it gets committed.

## Location

```
docs/pocs/<datetime>-<slug>/
```

- `<datetime>` — local time when the PoC is started, `YYYY-MM-DD-HHmm` (e.g. `2026-10-21-1435`).
  Get it from the shell (`Get-Date -Format yyyy-MM-dd-HHmm`), never guess it.
- `<slug>` — short kebab-case name of what is being checked (`otel-port-reuse`,
  `drizzle-jsonb-index`), not the task id.
- One PoC = one folder. A second experiment for the same task gets its own folder.
- Never put a PoC in the repo root, in `tmp/`, under `docs/tasks/`, or inside a real package
  (`server/`, `client/`, `hook/`). Do not add the PoC to any workspace / package list of the repo.

## Required files

1. **`README.md`** (English, like everything under `docs/`):
   - the task it belongs to — relative link to `docs/tasks/todo/<task-id>/requirements.md`;
   - the question the PoC answers;
   - how to run it (exact commands, from this folder);
   - **Result** — the answer and the evidence (numbers, output excerpt), filled in when done.
2. **`.gitignore`** — inside the PoC folder, created **before** the first `npm install` / build.
   It lists everything that is not source code:
   - dependencies: `node_modules/`, `.pnpm-store/`, `vendor/`, downloaded binaries/jars;
   - build output: `dist/`, `build/`, `out/`, `target/`, `bin/`, `obj/`, `*.tsbuildinfo`;
   - runtime garbage: `*.log`, `.cache/`, `coverage/`, `.env`, local DB files, generated data
     dumps, screenshots/recordings that are not part of the result;
   - anything else the PoC's tools generate — add it as soon as it appears.

   Keep as source (do not ignore): code, configs, `package.json` and its lock file, small fixture
   inputs, and the `README.md`. Patterns are relative to the PoC folder — do not edit the root
   `.gitignore` for a PoC.

   Starting template:

   ```gitignore
   # dependencies
   node_modules/
   # build output
   dist/
   build/
   out/
   *.tsbuildinfo
   # runtime garbage
   *.log
   .cache/
   coverage/
   .env
   ```

## Rules

- Project tooling rules still apply: Node.js or PowerShell only, **no Python** (not in code, not in
  fixtures). Node scripts follow the `nodejs-script` skill.
- Keep it minimal: only what is needed to answer the question. A PoC is not production code and is
  never imported by the real packages; if the approach is adopted, the implementation is written
  again in the right package during `implement`.
- No secrets in the PoC; credentials go to the ignored `.env`.
- Background processes started for the PoC (servers, watchers) are stopped when done — see
  `## Background processes cleanup` in `CLAUDE.md`.

## Before finishing

1. Check that nothing non-source would be committed (read-only git only):
   `git status --porcelain --untracked-files=all docs/pocs/<datetime>-<slug>/` — the list must
   contain only source files, `README.md` and `.gitignore`. If something else shows up, add it to
   the PoC's `.gitignore` and re-check.
2. Fill in **Result** in the PoC `README.md`.
3. Reference the PoC from the review output: in the task's requirements / review findings (and in
   `open_questions_ru.md` if a question is answered or raised by it) — link
   `docs/pocs/<datetime>-<slug>/` and state the conclusion in one or two sentences.
