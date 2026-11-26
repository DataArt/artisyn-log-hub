---
name: agentbook-ws
description: Use whenever you need to know where you are on this AgentBook laptop - which laptop this is, its shared folder, the git repos with their branches, worktrees and uncommitted changes, the other laptops working on the same files, or which folders from the user's computer you can see and whether they are View only - and whenever an environment variable (a Variable the user set, such as a token) is missing or was just added. Run `ws whoami`, `ws mounts` or `ws env` instead of guessing.
---

# Where am I? (`ws`)

You run on an AgentBook **laptop**: a container on the user's computer that sees the user's
**shared folder** live, plus any **given folders** the user connected. Two commands answer
"where am I" from the laptop's current state; they re-read it on every call, so run them again
rather than trusting an old answer.

## `ws whoami`

Run it when the user asks where you are, before starting a new line of work, and before editing
files another laptop may be changing. It prints:

- the laptop's name and the shared folder (path here and on the user's computer);
- every git repo in the shared folder: current branch, local branches, worktrees and the
  uncommitted changes;
- the other laptops of the same shared folder and whether each is Working or Sleeping. They work
  on the **same files** as you;
- the names of the Variables the user set for programs on this laptop (never their values).

Answer "where am I" from its output: the laptop name, then each repo with its branch and its
uncommitted changes.

## `ws mounts`

Run it before reading or writing outside the shared folder, and when the prompt line says the
connected folders changed. It lists each connected folder as `path here <- folder on the
computer` with its mode:

- **read and write**: your changes appear on the user's computer at once;
- **View only**: writing fails; do not try to work around it, ask the user.

Nothing else on the user's computer is visible from the laptop.

## `ws env`

The user's Variables (environment variables for programs on this laptop) can be added or changed
while you work, but this session's environment keeps the values from when it started. `ws env`
reads them as they are now:

- `ws env ls`: the Variable names; the ones added or changed after this session started are marked.
- `ws env run <command>`: runs the command with the current values, e.g.
  `ws env run node jira-projects.js`. Use it when a Variable is missing from the environment
  instead of asking the user to restart the session.
- `ws env get NAME`: one current value; prefer `ws env run`, and never print, log or copy a value.

If a Variable does not exist at all, ask the user to add it in AgentBook (**Variables…**), then
use `ws env run`.

## How to use what they tell you

- Another laptop or the user's IDE may change the same files at the same time. When your work is
  likely to collide with another laptop's (same repo, same files), warn the user before editing.
- For a separate line of work in a git repo, prefer a branch in a git worktree inside the repo, in
  an ignored folder such as `.worktrees/<name>`; remove it when done. It is valid inside this
  laptop only; the user reviews the committed branch on their computer.
- A part of the shared folder that is not a git repo has no worktrees: say so and let the user
  decide.
- Commit when the user asks. Push only when the user asks and credentials are available here.
