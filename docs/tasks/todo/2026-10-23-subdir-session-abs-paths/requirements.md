# 2026-10-23: Subdirectory Sessions Show Absolute Paths

**Status:** todo
**Priority:**
**Type:** bug
**Module(s):** client
**Owner:** denis.tsyplakov
**Created:** 2026-10-23

## Description

A Claude Code session started in a repo subdirectory (for example `packages/web`) shows absolute
paths in the session viewer for files elsewhere in the repo. In `/big-prod-e2e-test` run
20261023-192004, S10 (`ts-webapp`, cwd `packages/web`) and S11 (the same in a linked worktree with
`ARTISYN_PROJECT_ROOT`) ran `cat "<repo>/packages/core/src/index.ts"`. The Bash tab showed the
FILES read and the command text as the full `D:/…/ts-webapp/packages/core/src/index.ts` instead of
`packages/core/src/index.ts`.

Cause (from the code): the client has no repo root from the server.
`log-parser.ts` derives the display root from the shortest `CLAUDE.md` path, else from the common
prefix of file paths in at least two directories, else from the **first main-thread `cwd`**. When
the session reads no `CLAUDE.md` and touches files in one directory, the root falls back to the
subdirectory cwd, and `toRepoRelative` (bash-command-view.md rule 6) leaves every path outside it
absolute.

## Functional Requirements

- The session viewer's display root is the repository root (git top-level, or
  `ARTISYN_PROJECT_ROOT` for a worktree), not the cwd a session started in.
- Paths under that root show repo-relative everywhere `toRepoRelative` applies (Bash tab command
  and FILES, tool bodies, Context Growth).

## Acceptance Criteria

- [ ] A session started in `packages/web` that reads `<root>/packages/core/src/index.ts` shows
      `packages/core/src/index.ts` in the Bash tab FILES and command, with no absolute path.
- [ ] The same holds for a linked-worktree session (root = the worktree root).
- [ ] Sessions started at the repo root are unchanged.
- [ ] `/big-prod-e2e-test` S10 and S11 `bashPaths` pass.

## Steps to Reproduce

1. Install the hook into a repo without a `CLAUDE.md`.
2. Start a session in a subdirectory with project settings from the root (`--settings`) and run
   `cat "<repo-root>/<other-dir>/file"`.
3. Open the session's Bash tab.

**Expected:** FILES reads `<other-dir>/file`; the command shows the repo-relative path.
**Actual:** both show the absolute path.

## Notes

**2026-10-23:** Evidence: `log_hub_big_test-20261023-192004/_report/S10/bashPaths-mismatch.png`,
`_report/S11/bashPaths-mismatch.png`, `verdict.json` in both. Code:
`client/src/viewer/pages/repository/session-log/log-parser.ts` (`displayRepoRoot`, the
`firstMainCwd` fallback).

**2026-10-24:** Child of [2026-10-24-post-e2e-test-bugs](../2026-10-24-post-e2e-test-bugs/requirements.md). Analysis (high confidence): the verifier looked at the right sessions; the worktree, attribution and FR-WT were correct. The cwd fallback is the documented behaviour (`docs/knowledgebase/session-log-view.md:335`, `algorithms/bash-command-view.md:48`), so treat this as a design change and update both docs. Fix source: the hook already uploads `root` / `worktreeRoot` (stored as `logs.git_repo_root` / `git_worktree_root`, used only for change-surface); send both with the session logs and pass the longest root that prefixes a path as `parseSessionLogs({ repoRoot })` (the option exists and is unused). Keep the CLAUDE.md / prefix / cwd fallback for older hooks that send no root. Worktree without `ARTISYN_PROJECT_ROOT`: `root` = main checkout, `worktreeRoot` = worktree (`hook/.../git-context.js:53-60`) — add an AC for that case; sending only `git_repo_root` would leave worktree paths absolute.

**2026-10-24:** Deferred — out of scope for now (user decision): sessions are assumed to start at the project root; how to handle a subdirectory cwd systemically is not decided yet. Removed from the umbrella `2026-10-24-post-e2e-test-bugs`; `/big-prod-e2e-test` S10/S11 now start at the root.
