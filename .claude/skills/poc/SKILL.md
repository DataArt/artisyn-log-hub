---
name: poc
description: "ALWAYS when you build a prototype / proof of concept / PoC / spike / experiment to check an assumption — during research, task review (adlc-lh:review, adlc-lh:review-deep, ad-hoc), planning, or on a direct request (\"сделай poc\", \"прототип\", \"проверь гипотезу\", \"spike\", \"research\"). Defines where the PoC lives (docs/pocs/<datetime>-<slug>/ — never tmp/ or docs/tasks/), its README (task, question, how to run, result) and that every non-source file in it (dependencies, build output, logs) is listed in that folder's own .gitignore."
---

# Prototypes and proofs of concept

Research, a review or a plan sometimes cannot answer a question from code and docs alone — "does
library X support Y", "will this query be fast enough", "can the hook read Z on Windows". Then build
a small prototype. This skill fixes where it goes and what of it gets committed — whether the PoC
was asked for directly or started on your own initiative.

**Decide the location before writing the first file.** A PoC is not a throwaway temp file: even if
it starts as a quick experiment, it goes to `docs/pocs/` from the start, not to `tmp/` "for now".
`tmp/` is only for run artefacts you will delete.

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
- A sample project inside the PoC must not carry a live `.claude/` folder (it would activate its
  hooks/settings for anyone who opens the folder in Claude Code) — name it e.g. `claude-config/`
  and pass it with `claude --settings`. Never commit a nested `.git/` of such a sample.
- Background processes started for the PoC (servers, watchers) are stopped when done — see
  `## Background processes cleanup` in `CLAUDE.md`.

## Before finishing

1. Check that nothing non-source would be committed (read-only git only):
   `git status --porcelain --untracked-files=all docs/pocs/<datetime>-<slug>/` — the list must
   contain only source files, `README.md` and `.gitignore`. If something else shows up, add it to
   the PoC's `.gitignore` and re-check.
2. Fill in **Result** in the PoC `README.md`.
3. **Private machine data check — in a subagent.** Launch a subagent (fresh context, so it reads
   the files as an outsider would) over everything the PoC adds or changes: the PoC folder and every
   doc, wireframe or note that quotes its results. It reports, with `file:line`, anything that
   describes the machine the PoC ran on:
   - absolute paths that show how that computer is laid out — drive and folder structure, the
     home directory, workspace / checkout locations, install locations of tools
     (`D:\work\…`, `C:\Users\<name>\…`, `/home/<name>/…`, `~/.dotnet/tools/…`);
   - host / machine names, local network addresses, local ports of the developer's own services,
     process ids, pipe / socket names, session or device ids taken from that machine;
   - environment variable values, tokens, keys, account ids; local DB names / users;
   - anything else that tells a reader what is installed where on that computer.

   The **name of the person who ran it is fine** (author, `Owner:`, a git user name). Generic paths
   that are the same on every machine are fine too (`C:\WINDOWS\system32\find.exe`,
   `/usr/bin/find`, paths relative to the repo). Clean every finding: make the path relative,
   or replace the machine-specific part with a placeholder (`<repo>`, `<home>`, `<tool-dir>`) —
   in code prefer deriving the path at runtime over hard-coding it. Re-run the check until it
   reports nothing.
4. Reference the PoC from the work it serves: in the task's requirements / research note / review
   findings (and in
   `open_questions_ru.md` if a question is answered or raised by it) — link
   `docs/pocs/<datetime>-<slug>/` and state the conclusion in one or two sentences.
