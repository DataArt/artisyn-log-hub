# Notes — Artisyn AI Work Hub, Alpha

## 2026-11-13 — moved from requirements.md (owner's answers and PoC results)

These are the evidence trail behind the requirements; the current contract is `requirements.md`.
Where a later round replaced an earlier answer, the later one wins (marked below).

### Owner's answers

- Round 1: auth is inherited from Log Hub logically, not by code (own users table, different
  users); "agnostic" = any agent, alpha tested with Claude; Claude is preinstalled and authorized
  through an in-app hint running `claude login`; one container per workspace, a container branched
  off it per workstream, workstreams do not interfere.
- Round 2 (from `open_questions_ru.md`): workspace by clone (ask for git authorization) or empty
  without a remote *(clone replaced by round 8: no remote in the alpha)*; default empty
  devcontainer when the repo has none; everything is personal; Claude authorization once per
  workstream plus "copy it from there" *(replaced by round 4: per workspace)*; a workstream
  container takes the workspace container's state at opening; close = commit, push if there is a
  remote, offer merge (maybe via PR), or discard after confirmation *(push/PR dropped by round 8)*;
  closing and similar actions are buttons; a closed, not discarded workstream can be reopened in
  the same context; files can be edited by hand on the working branch; folder `work-hub/`; a
  separate sub-product with its own tests and, later, its own release. Added: the accounting
  reference scenario, running the code with viewable and downloadable results, drag and drop for
  the file tree.
- Round 3: the result of a run is only files (code and produced files), anything more — in later
  versions; a hand edit is committed at once — a commit is the equivalent of saving a document, on
  a branch there is little difference between "save" and "save and commit"; a finer mode for
  advanced users may come later.
- Round 4 (replaces "once per workstream" of round 2): the Claude login is per workspace = per git
  repository, and inside the workspace everything inherits it transparently; the question is asked
  right at workspace creation — a new login, or copy from one of the user's existing workspaces.
- Round 5: inside the chat there is simply the Claude CLI and it is not improved for now, so result
  names cannot be reliably taken from it — no result card in the chat; results are reached through
  the file tree.
- Round 6: the chat is a real terminal with the interactive Claude CLI and full support of special
  key sequences, so that a question Claude asks looks and works as in a real terminal —
  conceptually like a Guacamole terminal (colours, arrow keys and so on), but without installing
  Guacamole.
- Round 7: the theme is LIGHT, the terminal too; dark comes later.
- Round 8: git authorization is undecided — the alpha can do without a remote altogether. For the
  future: a flexible way to set up configurations and tools — a "configure" (wrench) action on the
  workspace opens a service session: an agent session in the workspace container with instructions
  "this session configures the container; do what the user asks". It changes the workspace
  container itself and saves a checkpoint, without copying the whole image. PoC: a checkpoint is a
  `docker commit`, which stores only the changed layer (20 MB installed → 21.4 MB layer, under
  1 s), and every workstream opened afterwards inherits it.
- Round 9 (from `open_questions_ru.md`): the Claude login is kept, for simplicity, as
  `~/.claude/.credentials.json` in the workspace's container profile; security is hardened later
  (a server-held token was the alternative proposed). Keep in mind that later one container may run
  Codex and another OpenCode. The configuration session (wrench) is IN the alpha *(replaces round
  8's "for the future")*, without rollback to an earlier checkpoint for now — the owner wants to see
  how it is laid out and works first. The git tree and the profile should be mounted as volumes
  outside the container, so the container does not intersect with frequently changing files
  *(replaces the PoC's "repository and home in the container filesystem")*.
- Round 10 (2026-11-13, after review-deep): 14 of 16 review questions resolved as common sense
  (see the requirements' Common sense considerations). The owner left refresh-token rotation of
  copied `.credentials.json` to be checked by the owner during implementation. Closing: Work Hub
  never commits for the user (that is asked of Claude in the chat) and every close first checks
  the worktree is clean, listing stuck files otherwise. Then either "take it and merge" — a local
  merge, which needs no remote (a pull request does) — or "it is already merged via a remote,
  just check no files are left and close (remove)". The owner does not yet know how this should
  work in general; this is the alpha's take *(replaces the "offer to merge, abort on conflict"
  flow)*.

### PoC results

- [`docs/pocs/2026-11-13-1906-workhub-container-branching/`](../../../pocs/2026-11-13-1906-workhub-container-branching/README.md)
  — 14/14: snapshot branching, isolation, bundle transfer, merge and conflict, close/reopen,
  discard, checkpoint size.
- [`docs/pocs/2026-11-13-1906-workhub-terminal-bridge/`](../../../pocs/2026-11-13-1906-workhub-terminal-bridge/README.md)
  — Rust axum + bollard + tmux + xterm.js: the interactive Claude CLI with arrow-key prompts,
  resize, reconnect, survival of a server restart, recorded history, light theme, Claude's login
  flow in the terminal (working up to the code prompt).

Both confirm the container model and the terminal design.
