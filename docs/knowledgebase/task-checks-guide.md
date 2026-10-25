---
type: "Process Guide"
title: "Task Workflow and Post-Implementation Checks"
description: "The /adlc-lh:* task lifecycle in short (scratch, review, plan, implement, post-impl-check, archive) and the reference for post-implementation checks: the available checks, how discovery works, naming rules, the issue format and how to add a check."
tags:
  - workflow
  - adlc
timestamp: "2026-10-14T00:00:00+04:00"
---

# Task Workflow and Post-Implementation Checks

Read this before running or adding a post-implementation check, or when you need the order of the
task lifecycle steps. The full, authoritative description of the lifecycle skills is the
`adlc-lh:tracker` skill; this article does not repeat it.

## Task lifecycle

Tasks are run with the `adlc-lh` plugin, the repo's local copy of the shared `adlc` plugin. It lives
in `.artisyn/marketplace/plugins/adlc-lh/` and is enabled as `adlc-lh@artisyn` in
`.claude/settings.json`. Every step reads its project settings from `.claude/repo_config/`.

```
/adlc-lh:scratch → /adlc-lh:review(-deep) → /adlc-lh:plan(-deep) → /adlc-lh:implement(-deep)
  → /adlc-lh:post-impl-check → /adlc-lh:archive
```

| Step | What it does |
|---|---|
| `scratch` | Creates the task folder `docs/tasks/todo/<YYYY-MM-DD>-<slug>/` with `requirements.md` and adds it to `docs/tasks/todo/index.md` |
| `review` / `review-deep` | Reviews `requirements.md` and suggests improvements; it does not apply them. Re-run after edits as often as needed |
| `plan` / `plan-deep` | Writes `impl-plan.md`, including the `## Implementation Chunks` section that `implement-deep` executes |
| `implement` / `implement-deep` | Implements the plan; the deep variant runs it chunk by chunk with a health-check pre-flight and a final verification |
| `post-impl-check` | Runs the discovered post-implementation checks (below) one by one |
| `archive` | Moves the folder from `docs/tasks/todo/` to `docs/tasks/done/` and updates both indexes |

The plain variants (`review`, `plan`, `implement`) are single-session and meant for small,
low-risk changes. Use the `-deep` variants for anything non-trivial. Every code change follows the
`adlc-lh:workcycle` skill, whose health-check loop is driven by
`.claude/repo_config/repo-health-checks.json`.

## Available Checks

Project checks live in `.claude/skills/post-impl-check-*/`. One more check is bundled with the
plugin.

### client-component-size (`post-impl-check-client-component-size`)
Checks React component code size for oversized components that should be split.
Returns issues categorized by severity.

### cost-calc-no-auto (`post-impl-check-cost-calc-no-auto`)
Manual-only. Walks the latest 50 sessions (Plain list view) via Playwright, comparing each session's
header cost against the sum of its per-turn costs; flags mismatches, then investigates the DB rows
for any broken session.

### docker-build (`adlc-lh:post-impl-check-docker-build`)
Bundled with the plugin. Runs the Docker build and confirms the app is buildable. It does not run
the resulting image. On failure, it fixes the issue and re-runs the build.

### indexes (`post-impl-check-indexes`)
Audits for missing indexes on foreign keys and WHERE/ORDER BY columns, composite index
opportunities and redundant indexes. Returns issues categorized by severity.

### kb-actual (`post-impl-check-kb-actual`)
Audits knowledgebase articles to verify that every referenced file path exists in the codebase.
Returns issues for broken references.

### migrations (`post-impl-check-migrations`)
Starts a fresh Postgres DB in a container plus a server container pointed at it, and confirms the
app starts and all migrations apply cleanly against an empty database.

### performance-no-auto (`post-impl-check-performance-no-auto`)
Manual-only. Audits for N+1 queries, missing pagination, sync operations that should be async,
memory leaks, expensive render computations and large bundle additions. Returns issues categorized
by severity.

### security-no-auto (`post-impl-check-security-no-auto`)
Manual-only. Audits for XSS, SQL injection, auth flaws, exposed secrets, CSRF, XXE, insecure
deserialization and path traversal. Returns issues categorized as CRITICAL / HIGH / MEDIUM.

## How discovery runs the checks

`/adlc-lh:post-impl-check <task-folder>` scans `.claude/skills/` for folders named
`post-impl-check-*`, drops every one whose id ends in `-no-auto`, adds the bundled checks and sorts
by id. The automatic pass is therefore `client-component-size`, `docker-build`, `indexes`,
`kb-actual` and `migrations`, in that order. Checks run one by one with no pause between
them; only a hard blocker stops the run. The "locate changed files" scaffolding is injected once by
the workflow prompt, so each check skill defines only its own audit.

Run a manual-only check by invoking its skill directly, for example
`/post-impl-check-security-no-auto <task-folder>`.

## Adding a New Check

1. Create `.claude/skills/post-impl-check-<name>/SKILL.md`.
2. Add frontmatter whose `name` equals the folder name:

   ```yaml
   ---
   name: post-impl-check-<name>
   description: "One-line description of what this check does."
   argument-hint: <task-folder-name>
   ---
   ```

3. In the body, read `impl-plan.md` to find the changed files, run the audit and return the
   structured issue list (see "Issue Format").
4. Nothing else is needed: discovery picks it up on the next `/adlc-lh:post-impl-check` run.

## Naming Convention

Folder names are `post-impl-check-<id>`, where `<id>` is lowercase kebab-case. The displayed name is
derived as `<id capitalized> Check` (e.g., `sql-index` → `Sql-index Check`).

Two rules discovery enforces, both silent when broken:

- **The frontmatter `name:` must equal the folder name.** Discovery builds the skill invocation
  string from the *folder* name, and the Skill tool resolves it against the registered name. A
  mismatch makes the check undiscoverable with no error. The discovery filter is
  `name.startsWith('post-impl-check-')`, so any other prefix hides the check.
- **A `-no-auto` suffix marks a check manual-only.** Discovery excludes it, so it never runs in the
  automatic pass; invoke it directly instead.

A project check whose `<id>` matches a check bundled with the plugin overrides the bundled one.

## Issue Format

All checks should return issues in this format:

```
## <Check Name> Issues Found

- [CRITICAL] path/to/file.ts:42 — description
- [HIGH] path/to/file.ts:87 — description
- [MEDIUM] path/to/file.ts:123 — description

## Summary
N critical, N high, N medium issues.
```

If there are no issues, return "No <check name> issues found."
