# PoC: workstream volumes copied by a helper container

Task: [2026-11-13-ai-work-hub-alpha](../../tasks/todo/2026-11-13-ai-work-hub-alpha/requirements.md)
(FR-5a, FR-5b, FR-5d, FR-24a, AC-3, AC-20c).

## Question

The requirements moved the repository and the profile (`~/.claude`) out of the container
filesystem into per-container named volumes. The earlier
[container-branching PoC](../2026-11-13-1906-workhub-container-branching/README.md) kept them in the
container layer, so it does not cover:

- does a `docker commit` checkpoint of the workspace container leave the repo and the login out;
- does copying both volumes with a short-lived helper container (`tar` pipe, run as root) keep
  owner, mode and symlinks, so git and the agent work unchanged in the workstream container;
- how long the copy takes for a repo with many small files (an installed `node_modules`);
- do the bundle round trip, `docker cp` (archive endpoint) and stop/start still work on volumes?

## How to run

From this folder (needs Docker and the image of the branching PoC,
`docker build -t workhub-poc-branch ../2026-11-13-1906-workhub-container-branching/image`).
Creates only `wh-poc-vol-*` containers, volumes and image and removes them at the end
(`--keep` leaves them):

```sh
node run.js
```

`WH_POC_FILES` sets the number of extra small files (default 20000).

## Result

**Works. 14/14 checks pass** (Docker Engine 29.7, Linux engine).

```
PASS  fresh profile volume is populated from the image home (.gitconfig present)
PASS  volumes are owned by the container user (node) after populate
PASS  docker commit of the workspace container holds neither the repo nor the login (commit 2247 ms)
open workstream a: volume copy (20000 extra files) 1983 ms, run 408 ms
PASS  tool from the checkpoint is present in the workstream
PASS  repo is copied, git works without safe.directory complaints
PASS  owner, mode and symlink are kept
PASS  all 20000 extra files are copied
PASS  login file is copied into the workstream profile
PASS  file written in workstream a is absent in the workspace repo volume
PASS  commit on the working branch after opening is absent in workstream a
PASS  bundle from the workstream volume merges into the workspace volume
PASS  docker cp writes into the volume-mounted repo
PASS  docker cp reads a file out of the volume as a tar stream
PASS  stop/start keeps the workstream files
14/14 checks passed
```

Conclusions for the plan:

1. **The volume model holds.** A checkpoint (`docker commit`) carries the installed tools and
   none of the repo or login; workstream = `docker run` from the checkpoint image with two fresh
   volumes copied from the workspace's.
2. **Copy recipe:** create the target volume, then one helper container from the default image,
   run as `root` (`-u 0`), source mounted read-only:
   `cd /from && tar cf - . | tar xpf - -C /to`. Owner (`node`), modes (`600` on
   `.credentials.json`) and symlinks survive; git needs no `safe.directory`. About 2 s for both
   volumes with 20 000 extra small files; the container start adds about 0.4 s.
3. **First mount populates a fresh volume from the image** (the workspace's profile volume gets
   the image's `/home/node` — `.gitconfig`, `.tmux.conf`). A copied volume is already non-empty,
   so no populate happens and the copy is exactly the workspace's state.
4. `docker cp` (the Engine's archive endpoints) reads and writes paths that are volume mounts,
   so uploads and downloads need no exec helper; the bundle round trip and stop/start behave as in
   the branching PoC.
