# Notes: 2026-10-15-claude-dev-container

## 2026-10-21 (moved from requirements.md)

**History.**
- 2026-10-15: merged with the drafts `2026-10-15-dev-infra-compose` and
  `2026-10-15-hook-in-dev-container`.
- 2026-10-15: requirements simplified by the user's decision: the old DB data is deleted (no
  migration), the whole project is mounted into the container, development happens in the container,
  ports `3000`/`5173` are published to the outside.
- 2026-10-15: the rule "the server and client are already running, do not restart them" was replaced
  in `CLAUDE.md` and `repo-health-checks.json → environmentNotes` with "Claude starts them itself when
  needed".
- 2026-10-20: design notes previously kept in a separate `notes.md` were folded into the FRs and that
  file was removed.

**2026-10-20: worktrees side discussion.** Running several parallel task sessions via `git worktree`
(one branch per worktree) isolates working-tree state so unrelated changes don't get mixed, which
actually happened in one session: two other sessions' edits landed in this checkout and had to be
untangled by hand before committing. The current design (FR-A1/FR-B4: fixed
`log-hub-postgres`/`log-hub-mailpit` container/hostnames, fixed host ports `3000`/`5173`/`5432`/
`1025`/`8025`) assumes one active container for the whole repo, consistent with FR-B10's "only one
watch backend active on port 3000 at a time". If multi-worktree parallel sessions become routine,
each worktree would need its own compose project name + port offset (the `tests/scenarios` stand
already does exactly this per test run — own port, own `scn_*` schema — and is a usable reference
pattern) to avoid the port collision hit directly in that session (`scenarios-postgres-1` failing to
bind 5432 because a manually-run dev-DB container already held it).
Separately, not container-related: the installer's per-repo marketplace name
(`resolveMarketplaceName`, a hash of `git remote get-url origin`) is identical across every worktree
of this same repo, so switching which worktree's Claude session is active will keep re-triggering the
stale-user-level-registration path (now handled automatically by the
`findStaleUserLevelMarketplaceName` fix) — expected friction, not a bug, if worktrees get adopted.

## 2026-10-21 (moved from requirements.md, distillation)

**2026-10-21: scope change by the user.** Every container is a sandbox with its own worktree/branch,
its own DB in the shared Postgres server and its own in-container backend/client; sandboxes run in
parallel. This replaced the earlier single-container design (whole project mounted, fixed host ports
`3000`/`5173`, worktrees out of scope) and removed the shared-`ai_work_dir` problem.

## 2026-10-21 (moved from requirements.md, second distillation)

- Host git version observed when PoC-5 (host git ≥ 2.48) was written: 2.56.0.
