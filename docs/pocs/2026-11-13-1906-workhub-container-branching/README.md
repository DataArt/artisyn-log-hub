# PoC: branch a workstream container off a workspace container

Task: [2026-11-13-ai-work-hub-alpha](../../tasks/todo/2026-11-13-ai-work-hub-alpha/requirements.md)
(FR-3, FR-4, FR-29–FR-31, AC-3, AC-4, AC-24–AC-26).

## Question

Can Work Hub "branch" a workstream container off a workspace container so that:

- what was installed in the workspace container before opening is present in the workstream
  (AC-3), while working-branch commits made after opening are not;
- two workstreams and the working-branch view do not see each other's files or processes (AC-4);
- *keep* can bring the workstream's commits back into the workspace repository and merge them
  (AC-24) without any network between containers;
- *discard* and close/reopen behave as required (AC-25, AC-26)?

And what does one workstream cost (time, disk)?

## Model tested

- The repository lives in the **container filesystem** (`/workspace/repo`), not in a volume or a
  bind mount.
- Open workstream = `docker commit <workspace container>` → `docker run` from that snapshot →
  `git worktree add -b ws/<name>` inside the new container.
- Keep = commit in the worktree → `git bundle create - main..ws/<name>` streamed out over
  `docker exec` stdout → piped into the workspace container → `git fetch <bundle>` → `git merge`.
- Discard = `docker rm` the container, `docker rmi` its snapshot, delete the branch.
- Close = `docker stop`; reopen = `docker start`.

## How to run

From this folder (needs Docker; creates only `wh-poc-br-*` containers/images/volume and removes
them at the end, `--keep` leaves them for inspection):

```sh
docker build -t workhub-poc-branch image
node run.js
```

## Result

**Works. 14/14 checks pass.**

```
open workstream a: commit 1843 ms, run 409 ms, worktree 143 ms
open workstream b: commit 832 ms, run 422 ms, worktree 142 ms
checkpoint after installing 20 MB: commit 947 ms, new layers on top of the 13-layer base: 21.4MB
PASS  a checkpoint stores only the changes (new top layer ~ size of the change), not a copy of the image
PASS  tool installed in workspace container is present in workstream
PASS  Claude login file is inherited by the workstream container
PASS  file committed on main after opening is absent in workstream a
PASS  workstream b (opened later) does see it
PASS  a named volume is shared, not branched (data written in a is visible in b) — keep repo/home out of volumes
PASS  file written in a is absent in b and in the workspace
PASS  process started in a is invisible in b and in the workspace
PASS  branch ws/a transferred to the workspace repo via bundle (489 bytes, 107 ms)
PASS  merge of ws/a into main (main moved on meanwhile, no conflict) succeeds
PASS  conflicting merge is detected and can be aborted cleanly (branch kept)
PASS  reopened workstream keeps its files
PASS  reopened workstream has no old processes (the agent must be restarted, e.g. with --continue)
container sizes (writable layer):  ws 418kB, a 217kB, b 205kB  (all on one ~380MB base)
PASS  discard removes container, snapshot and branch
13/13 checks passed
```

Conclusions for the requirements:

1. **FR-3 is feasible with `docker commit`**, about 1–2 s per workstream open, plus about 0.5 s
   for `run` and the worktree. Snapshots share the base layers, so a workstream costs only its own
   writable layer on disk (hundreds of kB here).
2. **Hard rule: the repository and the user's home (`~/.claude`) must be in the container
   filesystem, not in a volume or bind mount.** `docker commit` does not copy volumes. A named
   volume ends up *shared* between the workspace and all its workstreams, which breaks FR-4. The
   standard devcontainer layout (workspace folder bind-mounted from the host) does not fit. Work
   Hub has to clone *into* the container.
3. **Each workstream container has its own copy of the repository.** The "worktree" inside it is
   only a branch checkout and isolates nothing extra. The branch has to be carried back explicitly.
   `git bundle` over `docker exec` stdin/stdout does that in ~100 ms, needs no network between
   containers and no credentials, and works the same on any Docker host.
4. **Merge conflicts are detectable** (`git merge` exit code) and can be aborted with the branch
   kept, so the alpha can say "could not combine, your work is saved" (open question 2).
5. **Close = `docker stop`, reopen = `docker start`** keeps files but not processes. The agent
   must be restarted on reopen with its conversation resumed (`claude --continue` /
   `--resume <id>`). Claude's conversation files are under `~/.claude/projects/` in the container
   filesystem, so they survive stop/start (not a container removal).
6. **A checkpoint of the workspace container is cheap.** It is the same `docker commit`. It
   stores only what changed since the image below it: installing 20 MB gave a 21.4 MB layer in
   under 1 s, and the base was not copied. So a "configure the workspace" session (the agent
   installs tools in the workspace container) can end with a checkpoint, and every workstream
   opened afterwards inherits it (check 1). Caveats for the product: each checkpoint adds a layer
   (overlayfs allows about 127), so long chains need an occasional squash or rebuild. Rolling back
   to an older checkpoint would also roll back the repository, because the repository is in the
   same filesystem. Carry the repository across a rollback with a bundle (point 3).
7. The workspace's Claude login file is inherited by every workstream through the snapshot. But
   after that each container has its *own copy*. See the terminal-bridge PoC for why a
   server-held long-lived token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) is safer than
   copied credential files.
