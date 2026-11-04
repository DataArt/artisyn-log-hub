---
reviewed: no
reviewer: none
---

# Sandbox prune classification: what `--prune` may remove

## Purpose

Decides, per Claude Code dev-container sandbox, whether `claude-docker --prune` removes it, keeps
it because it still holds work, or leaves it alone. The rule exists so that a cleanup never loses
uncommitted changes or unmerged commits and never pulls a sandbox out from under a live Claude
session, while sandboxes with nothing to lose go away in one call.

## Code

- Implementation: `scripts/claude-docker/prune.mjs` (`classifyPruneCandidate`), called by
  `buildPlan` in the same file for `--prune` and for the menu's prune screen
  (`scripts/claude-docker/menu.mjs`).
- Twins: none.
- Test: `scripts/__tests__/sandbox-prune.algo.test.js` (`npm run test:scripts`).

## Input and output

`classifyPruneCandidate(input, opts)` takes plain values, no I/O and no clock:

- `input.containerState`: `running`, `stopped` or `missing`;
- `input.liveSessions`: number of `claude` processes in the container (`pgrep -x claude`);
- `input.lastActivity`, `input.now`: ISO times; a missing `lastActivity` counts as infinitely old;
- `input.files`: uncommitted changes (line count of `git status --porcelain`);
- `input.base`: the base branch name, or `null` (existing branch, tag/sha `--from`, detached HEAD);
- `input.isAncestor`: `git merge-base --is-ancestor <branch> <base>` succeeded against the base's
  current tip. A branch with no commits of its own is an ancestor of its base, so it counts as merged;
- `input.branchCreated`: the launcher created the branch;
- `opts.olderThan`: an age `<n>m`, `<n>h` or `<n>d` (default: none, every age is a candidate);
- `opts.includeRunning`, `opts.force`: booleans, default `false`.

It returns `{action, deleteBranch, reason}`; `reason` is display text only.

Sandboxes whose worktree is missing (orphans) never reach the classifier: `buildPlan` removes them
directly unless a live session is in the container. Orphan containers, volumes and DBs are not
classified either.

## Rules

Checked in this order; the first match wins.

1. **Running.** If `containerState` is `running` and `includeRunning` is not set: `not-candidate`.
2. **Age.** `age = now - lastActivity` (infinite when `lastActivity` is missing). If
   `age < olderThan`: `not-candidate`. An age exactly equal to `olderThan` is a candidate.
3. **Live session.** If `liveSessions > 0`: `live-session`. It is never removed, even with `force`.
4. **Nothing to lose.** If `files == 0`, `base` is set and `isAncestor`: `remove`, with
   `deleteBranch = branchCreated`.
5. **Has work** (uncommitted changes, unmerged commits, or no base to check against):
   - with `force`: `remove-force`, `deleteBranch = false` (the branch is always kept);
   - without `force`: `keep-has-work`, `deleteBranch = false`.

Every action other than `remove` has `deleteBranch = false`.

## Edge cases

- Running with a live session, without and with `--include-running --force`: SP-02, SP-01.
- Running and idle with `--include-running`: SP-10.
- Missing container treated like stopped: SP-04.
- No commits of its own counts as merged: SP-05.
- `--older-than` boundary on both sides: SP-12 (equal, candidate), SP-11 and SP-16 (younger).
- Missing `lastActivity` is infinitely old: SP-13.
- No base branch is work even when clean: SP-08.
- `--force` on a sandbox with nothing to lose stays a plain `remove`: SP-14.
- Branch kept on a `remove` when the launcher did not create it: SP-15.

## Examples

`input.sandbox` is the classifier's `input`, `input.opts` its `opts`. `expected` lists `action`
and `deleteBranch`. Times are UTC; `now` is `2026-10-21T12:00:00Z` throughout.

Rows (16): [`docs/algorithm-examples/sandbox-prune-classification.json`](../../algorithm-examples/sandbox-prune-classification.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- `includeRunning` ignored (running always skipped) -> SP-10; running never skipped -> SP-02.
- Live-session check after the force branch, so `force` removes a live sandbox -> SP-01.
- `>` instead of `>=` for the age -> SP-12; age check dropped -> SP-11, SP-16.
- Missing `lastActivity` treated as age 0 -> SP-13.
- Missing container treated as running -> SP-04.
- A clean sandbox without a base treated as merged -> SP-08.
- Uncommitted changes ignored -> SP-06; merge state ignored -> SP-07.
- `deleteBranch = true` on `remove-force` -> SP-09; always `true` on `remove` -> SP-15.
- `force` checked before rule 4 (`remove-force` for a clean merged sandbox) -> SP-14.

## Where the result is visible

The plan printed by `scripts/claude-docker.ps1 --prune` ("Will remove", "Will keep", "Not
candidates") and the menu's prune screen; the stale reminder printed on every launch ends with
that prune command. Safe behaviour: anything the rules do not clearly mark as nothing to lose is
kept unless `--force`, and a live session is never removed.
