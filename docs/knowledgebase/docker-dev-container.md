---
type: "Architecture Guide"
title: "Claude Code Dev Container (sandboxes)"
description: "The claude-docker sandbox model: one container, git worktree, branch, database pair and host port triple per sandbox; every launcher command and env var, what is mounted, the in-container dev stack (devctl), hook provisioning, the host-side state file and lock, prune and stale-reminder rules, and the limitations."
tags:
  - docker
  - dev-environment
  - claude-code
  - hook
timestamp: "2026-10-22T00:00:00+04:00"
---

# Claude Code Dev Container (sandboxes)

> Task: `docs/tasks/todo/2026-10-15-claude-dev-container/`. The host workflow is unchanged:
> `docker compose up -d` in `server/artisyn-log-run-local/`, then server and client on the host.
> Sandboxes are optional and live next to it.

## Sandbox model

A **sandbox** is a named, disposable place where Claude Code runs with
`--dangerously-skip-permissions` without touching the main checkout. Each sandbox owns:

- its own **git worktree** and **branch**, created on the host next to the repo;
- its own **container** `log-hub-dev-<name>` from the shared image `log-hub-dev:latest`;
- its own **databases** `log_hub_<name_>` (live) and `log_hub_<name_>_test` (test runners) in the
  shared host Postgres `log-hub-postgres`;
- its own **dev stack** inside the container: backend (`:3000`), Vite client (`:5173`) and Mailpit
  (`:1025`/`:8025`), published on the host as a per-sandbox **port triple** on `127.0.0.1`;
- its own **`node_modules` volumes** and **plugin state** (named volumes);
- its own **Log Hub**: the hook in the sandbox reports to the sandbox backend only.

The Claude profile (login, transcripts, history) is shared by all sandboxes, so `--continue` finds a
conversation started in an earlier session and the login survives `--reset`/`--remove`.

At least three sandboxes run in parallel without interfering. The launcher never commits or
merges: the developer commits and merges a sandbox's branch on the host, then removes the sandbox
with `--remove` or `--prune`. **Nothing is ever removed automatically**; a crashed or killed
session leaves the sandbox intact.

Inside the container Claude follows the managed guide `docker-dev/CLAUDE.container.md`
(→ `/etc/claude-code/CLAUDE.md`, priority over the repo `CLAUDE.md` where they diverge): Linux/bash,
the dev stack is already running and is managed with `devctl`, the full test set runs here
against the sandbox DBs, build and e2e/contract never run concurrently, no Docker, no WebStorm MCP.

## Code

| Path | Role |
|---|---|
| `scripts/claude-docker.mjs` | CLI entry: argv parsing, dispatch, the menu when run without arguments |
| `scripts/claude-docker.ps1`, `scripts/claude-docker.cmd` | Thin wrappers (`node claude-docker.mjs …`) |
| `scripts/claude-docker/config.mjs` | Names, constants, env vars, path resolution, name rule, age parser, `IMAGE_FILES` |
| `scripts/claude-docker/state.mjs` | State file, lock, `lastActivity`, port slot allocation |
| `scripts/claude-docker/git.mjs` | git version check, worktree/branch operations, pending work, merged check |
| `scripts/claude-docker/docker.mjs` | `run()` helper, container/volume helpers, shared infra and DB helpers, image hash and build, `runContainer` |
| `scripts/claude-docker/sandbox.mjs` | create/start, readiness, session, shell, stop, serve, reset, list, remove |
| `scripts/claude-docker/prune.mjs` | prune classifier, orphans, plan, stale reminder |
| `scripts/claude-docker/menu.mjs` | interactive TUI menu |
| `docker-dev/Dockerfile`, `Dockerfile.dockerignore` | the image; the dockerignore is an allow-list equal to `IMAGE_FILES` |
| `docker-dev/entrypoint.sh` | container start (root) |
| `docker-dev/devctl` | in-container service supervisor → `/usr/local/bin/devctl` |
| `docker-dev/provision.mjs` | hook provisioning → `/opt/log-hub-dev/provision.mjs` |
| `docker-dev/npx.cmd` | `npx.cmd` → `npx` shim for the tracked `.mcp.json` (Playwright MCP; Chrome runs without its sandbox, see [Image](#image)) |
| `docker-dev/settings.template.json` | Claude profile defaults merged by the entrypoint (user keys win) |
| `docker-dev/gitconfig` | image `/etc/gitconfig` (`safe.directory=*`) |
| `docker-dev/CLAUDE.container.md` | the managed in-container guide |
| `docker-dev/claude-home/` | shared Claude profile (git-ignored, created by the launcher) |
| `server/artisyn-log-run-local/docker-compose.yml` | host Postgres; names it `log-hub-postgres` on network `log-hub-net`, `max_connections=300` |

The launcher uses Node built-ins only. Every location derives from `git rev-parse`,
`process.env` and `os.tmpdir()`; there are no machine-specific paths.

## Prerequisites

- Docker (the launcher runs `docker info` first).
- Host git **≥ 2.48** (`worktree add --relative-paths`, `worktree.useRelativePaths`); checked on
  every launch, older versions exit with a message.
- Non-empty host `git config user.name` and `user.email`; they become the commit author inside the
  container, and the email is the identity the hook provisions with.
- The repo and the worktrees directory on the **same drive** (the container mounts both under one
  common root).

## Commands

Run from the repo with `scripts/claude-docker.ps1` (PowerShell), `scripts\claude-docker.cmd` or
`node scripts/claude-docker.mjs`. Usage errors exit 2, command failures exit 1, a session exits
with claude's own exit code.

| Command | What it does |
|---|---|
| `claude-docker` | Interactive menu (needs a TTY): list, create, continue, resume, shell, stop, remove, prune |
| `claude-docker <name> [--branch <b>] [--from <ref>] [--continue \| --resume[=<id>]]` | Create or start the sandbox, print its URLs and open Claude in it; again in another terminal = one more session in the same container |
| `claude-docker --serve <name>` | Create or start the sandbox without a session (to look at its UI); prints the URLs |
| `claude-docker --shell <name>` | bash in the sandbox as `dev` (starts a stopped container) |
| `claude-docker --stop <name> [--force]` | `devctl stop all`, then `docker stop -t 30`; refused while Claude sessions are live unless `--force` |
| `claude-docker --reset <name>` | Rebuild the image (with cache) and recreate the container; keeps worktree, DBs, volumes and ports; refused while Claude sessions are live |
| `claude-docker --list` | Table: branch, base, state, sessions, last activity, pending work, URLs/ports, DB size, worktree |
| `claude-docker --remove <name> [--force] [--delete-branch]` | Remove container, volumes, both DBs, worktree, state (and branch) |
| `claude-docker --prune [--older-than <age>] [--force] [--yes] [--include-running]` | Remove sandboxes that have nothing to lose |
| `claude-docker --help` | Usage |

Names: `^[a-z0-9][a-z0-9-]{0,39}$`, not ending in `-test` (so no main DB name can equal another
sandbox's test DB). Ages: `<n>m`, `<n>h`, `<n>d`. `--serve` and `--reset` are CLI-only.

### Create / start (`claude-docker <name>`)

1. Check git version and Docker; validate the name; refuse an empty host `user.name`/`user.email`;
   refuse a **protected branch** (below) before anything is created or started.
2. Under the lock:
   - apply the re-launch rules (below);
   - bring up the shared infra: `docker compose -f server/artisyn-log-run-local/docker-compose.yml
     up -d --no-recreate`, then poll `docker exec log-hub-postgres pg_isready -U postgres` (120 s);
     `--no-recreate` keeps a changed compose from recreating Postgres under running sandboxes;
   - for a new sandbox: allocate a port slot, create the worktree
     (`git -c core.autocrlf=input worktree add --relative-paths …`) and write the state;
     - the branch is `--branch`, else the sandbox name. If it does not exist it is created from
       `--from` (default `HEAD`); `--from` with an existing branch is an error;
     - an existing branch is checked out as is; git refuses one that is already checked out in the
       main checkout or another worktree, and the launcher shows git's message;
   - write the worktree's git-ignored `server/.env` if it is missing (exactly `AUTH_MODE=none`,
     `COOKIE_SECURE=false`, `PORT=3000`; `DATABASE_URL` comes from the container env,
     `SESSION_SECRET` is generated by the server, nothing is copied from the host checkout);
   - create both DBs if missing (`createdb`, idempotent).
3. Build the image if it is missing (printing the first-build warning, see **Image**); warn (with
   the `--reset` hint) when the image's `log-hub.dev-image-hash` label differs from the hash of the
   current `docker-dev/` image files. A normal launch never rebuilds.
4. If the container is not running, check that every kept host port is bindable (or already
   published by this container); otherwise fail naming the port — ports are never re-allocated.
   Then `docker run`, `docker start`, or nothing if already running.
5. Wait for `/run/dev/entrypoint-done` (`CLAUDE_DOCKER_SETUP_TIMEOUT_S`, default 900 s; a first
   start installs every `node_modules`), then for `/run/dev/provisioned`
   (`CLAUDE_DOCKER_READY_TIMEOUT_S`, default 180 s), with one progress line per second. A
   readiness timeout is not fatal: the launcher prints `devctl status`, the hint
   `devctl logs <server|client>` and the warning that telemetry upload is off, and opens the session
   anyway.
6. Print `app http://localhost:<client> · api http://localhost:<server> · mailpit http://localhost:<mailpit>`.
7. `docker exec -it -u dev -w <worktree> log-hub-dev-<name> claude --dangerously-skip-permissions
   [--continue|--resume]`; `lastActivity` is updated before and after.
8. Print the stale-sandbox reminder.

**Re-launch rules** (checked under the lock before any change):

| Situation | Result |
|---|---|
| `--branch`/`--from` differ from the state | exit 1: `<name> was created with --branch X --from Y; drop the flags or use another name` |
| `--branch`/`--from` match the state | note `ignored: matches state`, continue |
| State file but no worktree | exit 1: `worktree missing; run --remove <name> or --prune` |
| Worktree but no state file | exit 1: `worktree without state; run --remove <name> or --prune` |
| Kept host port not bindable | exit 1 naming the port, no re-allocation |
| `v: 1` state (a Phase 1 PoC sandbox) | exit 1: run `--remove <name>` and create it again |

**Protected branches.** `.claude/claude-isolation.json` (`{"protectedBranches": ["main"]}`) lists
branches a sandbox must never work on. The launcher refuses — before any change — a new sandbox
whose branch (`--branch`, else the name) is listed, and an existing sandbox whose state branch is
listed (session, `--shell`, `--serve`, `--reset`). `--from main` stays allowed: a new branch made
from `main` is the normal case. In the menu the branch is a required field (an existing branch or
a new name; there is no default) and a protected one is rejected in the dialog. No file means no
protection; an invalid file is an error, so a typo never silently turns it off. The main checkout
itself may be on `main` — the launcher runs from there.

**Base branch.** With `--from <local branch>` the base is that branch; a new branch without
`--from` takes the main checkout's current branch; otherwise (existing branch, tag/sha, detached
HEAD) there is no base, and pending work is the branch's commits not reachable from any other local
branch.

### Stop, serve, reset

- `--stop` stops the whole dev stack: `devctl stop all` (each service with its grace period), then
  `docker stop -t 30`. The worktree stays readable on the host. A later launch or `--serve`
  `docker start`s the container, which runs the entrypoint again (markers reset, socat,
  provisioning, `devctl start all`), so every service comes back on the same ports with the same
  data.
- The container keeps running after the last Claude session exits, until `--stop`.
- `--reset` builds the image first (a failing build leaves the sandbox as it was), then
  `docker rm -f` and `docker run` from the kept state. `--reset` without a name does that for every
  sandbox, one after another (the first rebuilds the image, the rest reuse the layer cache); a
  failing sandbox is reported and the others still run.

### Remove

All checks run before any change: live sessions, uncommitted changes and (with `--delete-branch`)
an unmerged branch each refuse without `--force`, listing what is pending, and nothing is removed.
Then, in order:

1. `docker stop` + `docker rm`;
2. remove the five `nm-*` volumes and the `-plugins` and `-tmp` volumes (shared caches are never
   touched);
3. `dropdb -U postgres --if-exists --force` both DBs (open connections are terminated);
4. `git worktree remove [--force]` + `git worktree prune`;
5. delete the state dir (releases the port slot);
6. with `--delete-branch`, `git branch -d` (refuses an unmerged branch); otherwise the branch is kept.

Every step tolerates the resource being already gone, so an interrupted removal can be re-run.

**Deletion guards.** Every directory the launcher deletes is derived from a validated sandbox name
as a direct child of a launcher-owned dir — never taken from a state file or a user-supplied path:

- the worktree is always `<worktreesDir>/<name>`; a state file whose `worktree` points anywhere
  else is refused (`assertOwnWorktree`), so an edited `state.json` can never steer
  `git worktree remove --force` at another directory; the removal itself is `git worktree remove`,
  which only deletes a registered worktree;
- the state dir must be exactly `<worktreesDir>/.sandboxes/<name>`;
- `CLAUDE_DOCKER_WORKTREES_DIR` is refused when it is a filesystem root, the repo or inside it, an
  ancestor of the repo, or the home dir or one of its ancestors;
- containers and volumes are removed by exact name or by the `log-hub.sandbox` label, databases
  by exact name matching `^log_hub_[a-z0-9_]+$`.
Everything the sandbox wrote — its DBs (sessions, `contract_*`/`scn_*` test schemas),
`ai_work_dir`, server logs — goes with it.

## Names

| Thing | Value |
|---|---|
| Container / hostname | `log-hub-dev-<name>` / `<name>` |
| Image | `log-hub-dev:latest`, label `log-hub.dev-image-hash=<sha256 of the image files>` |
| Label on the container and its volumes | `log-hub.sandbox=<name>` |
| Per-sandbox volumes | `log-hub-dev-<name>-nm-root`, `-nm-client`, `-nm-server`, `-nm-hook`, `-nm-installer`, `-plugins`, `-tmp` |
| Shared cache volumes (label `log-hub.shared=true`, never removed) | `log-hub-dev-cache-npm`, `log-hub-dev-cache-bun`, `log-hub-dev-cache-playwright` |
| Databases (`-` → `_`) | `log_hub_<name_>`, `log_hub_<name_>_test` |
| Shared Postgres / network | container `log-hub-postgres` / `log-hub-net` |
| Worktrees dir | `CLAUDE_DOCKER_WORKTREES_DIR`, else `<repo>/.worktrees` (git-ignored, visible in the IDE; state in `<repo>/.worktrees/.sandboxes`) |
| Worktree | `<worktreesDir>/<name>` |
| In-container markers | `/run/dev/entrypoint-done`, `/run/dev/provisioned` (both deleted at entrypoint start) |

At the 40-character name maximum the DB name is 53 characters (Postgres allows 63).

## Ports

Inside the container the ports are the usual ones, so every checked-in config works unchanged. On
the host each sandbox gets slot `n` (from 0), published on `127.0.0.1` only and kept for the
sandbox's lifetime:

| Service | Host | Container |
|---|---|---|
| Backend | `3100 + 10n` | `3000` |
| Client (Vite, `server.host` from `LOG_HUB_VITE_HOST=0.0.0.0`) | `5200 + 10n` | `5173` |
| Mailpit UI | `8100 + 10n` | `8025` (SMTP `1025` stays inside) |

A slot is free when no state file claims it and all three ports are bindable on `127.0.0.1`.
Allocation runs under the `.sandboxes/` lock together with worktree creation, DB creation and the
state write. The state file is the single source of truth. Host ports `3000`/`5173` stay free for
a host dev server.

## Mounts and volumes

C is the deepest common ancestor of the repo root and the worktrees dir. Paths under `/work` keep
their position relative to C, so the relative gitdir links of the worktree resolve inside the
container. With the default worktrees dir C is the repo root: `.git` is at `/work/.git` and the
worktree at `/work/.worktrees/<name>`. The main checkout's working tree is never mounted — only
`.git` and the sandbox's own worktree, so a container never sees the other sandboxes.

**Where worktrees live, and the migration.** Worktrees are in `<repo>/.worktrees/<name>`: inside
the clone and git-ignored, so the IDE shows a sandbox's files, nothing is created next to the repo,
and removing the clone removes its sandboxes. No repo tool scans the root (eslint, tsc and the test
runners are scoped to their packages; the hook's code inventory reads only git-tracked files). The
first layout kept them next to the repo in `<repoParent>/<repoName>-worktrees`; at the start of every
command the launcher moves such sandboxes (`migrate.mjs`): it refuses while a Claude session is
live, removes the container (volumes, DBs, ports kept), `git worktree move`s the worktree with
relative links, moves the state dir and fixes its `worktree`, and renames the sandbox's Claude
history dir in the profile (its name comes from the container path), so `--continue` still works.
The emptied legacy dirs are removed only if empty.

| Host | Container | Mode |
|---|---|---|
| `<repo>/.git` | `/work/<rel(C, repo)>/.git` | read-write |
| `<worktreesDir>/<name>` | `/work/<rel(C, worktree)>` (`SANDBOX_WORKTREE`) | read-write |
| `<repo>/docker-dev/claude-home` | `/home/dev/.claude-home` (`CLAUDE_CONFIG_DIR`) | read-write |
| `os.tmpdir()` | `/host-tmp` (`HOST_TEMP` holds the host path) | read-only |
| volume `-plugins` | `/home/dev/.claude-home/plugins` | per sandbox |
| volumes `-nm-root`, `-nm-client`, `-nm-server`, `-nm-hook`, `-nm-installer` | `<worktree>/node_modules`, `client/`, `server/`, `hook/`, `artisyn-hooks-installer/` `node_modules` | per sandbox |
| volume `-tmp` | `<worktree>/tmp` | per sandbox |
| `log-hub-dev-cache-npm`, `-bun`, `-playwright` | `/home/dev/.npm`, `/home/dev/.bun`, `/home/dev/.cache/ms-playwright` | shared |

**Why `tmp/` is a volume.** The worktree itself is a Docker Desktop bind mount (9p file sharing),
which is slow, and several sandboxes doing heavy I/O at once slow each other down: test stands,
reports, upload queues and eslint caches all live under `tmp/`. On a per-sandbox volume they stay
off the bridge. The sandbox's `tmp/` is therefore not visible from the host worktree; read it via
`--shell` or `docker cp log-hub-dev-<name>:<worktree>/tmp/… .`.

Nothing else from the host is mounted and there is no Docker socket. The container runs with
`--init` (tini) as PID 1, on network `log-hub-net`; Claude and the services run as `dev`
(uid 1000, passwordless sudo).

Images pasted with Ctrl+V arrive as Windows paths under the host temp dir; the guide tells Claude to
replace the `$HOST_TEMP` prefix with `/host-tmp` and turn backslashes into slashes.

## Environment variables

**Host** (read by the launcher):

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_DOCKER_WORKTREES_DIR` | `<repo>/.worktrees` | where worktrees and `.sandboxes/` live; a custom dir must not be a drive root, the repo or inside it, an ancestor of the repo, or the home dir |
| `CLAUDE_DOCKER_STALE_AFTER` | `7d` | stale-reminder threshold (`<n>m`/`h`/`d`) |
| `CLAUDE_DOCKER_SETUP_TIMEOUT_S` | `900` | wait for `entrypoint-done` (fatal on timeout) |
| `CLAUDE_DOCKER_READY_TIMEOUT_S` | `180` | wait for `provisioned` (session opens anyway on timeout) |

**Container** (set by `docker run -e`):

| Variable | Value |
|---|---|
| `SANDBOX_NAME`, `SANDBOX_WORKTREE` | the name; the container path of the worktree |
| `CLAUDE_CONFIG_DIR` | `/home/dev/.claude-home` |
| `HOST_TEMP` | the host path of `os.tmpdir()` (mounted at `/host-tmp`) |
| `GIT_CONFIG_COUNT=6` + `GIT_CONFIG_KEY_n`/`VALUE_n` | `core.autocrlf=input`, `core.filemode=false`, `core.ignorecase=false`, `worktree.useRelativePaths=true`, host `user.name`/`user.email` — container-only, they outrank the shared `.git/config`, which is never written |
| `ARTISYN_PROJECT_ROOT` | the worktree path: the hook root override (see below) |
| `DATABASE_URL` | `postgresql://postgres:pw@localhost:5432/log_hub_<name_>` (backend, legacy e2e, postgres MCP) |
| `TEST_DATABASE_URL` | `…/log_hub_<name_>_test` (scenario and contract runners) |
| `LOG_HUB_VITE_HOST` | `0.0.0.0`, read by `client/vite.config.ts` `server.host` (unset on the host) |
| `SANDBOX_HOST_EMAIL` | host `git config user.email`, the identity used by provisioning |
| `SANDBOX_APP_URL`, `SANDBOX_API_URL`, `SANDBOX_MAILPIT_URL` | the sandbox's host URLs (`http://localhost:<slot port>`); the container guide tells Claude to give the user these, never the in-container `localhost:5173`/`3000`/`8025` |
| `LOG_HUB_TEST_TIMEOUT_SCALE` | `5`: multiplies the Playwright test, `expect` and `test.setTimeout()` timeouts of scenarios and legacy e2e (`tests/timeout-scale.ts`; unset on the host = 1) |

## Databases and `TEST_DATABASE_URL`

Both DBs live in the shared host cluster (`log-hub-postgres`, `max_connections=300`), reached from
the container through `socat` on `127.0.0.1:5432` (`nodelay` on both legs; without it Nagle and
delayed ACK add ~40 ms per round trip). The URLs therefore look exactly like the host ones.

The test runners resolve their DB as **`TEST_DATABASE_URL || DATABASE_URL || default`**:
`scripts/scenarios/run.mjs` (`resolveRunnerDatabaseUrl`) and
`server/test/contract/setup/global-setup.ts`. In a sandbox they use `log_hub_<name_>_test`, so
their `scn_*`/`contract_*` schemas and the scenario runner's schema fingerprint never see the live
backend's hook uploads, and stale-schema cleanup in one sandbox never touches another sandbox. The
backend and legacy e2e keep `DATABASE_URL` (the live DB). On the host neither variable is set, so
nothing changes there.

## Image

`docker build -f docker-dev/Dockerfile -t log-hub-dev:latest --label log-hub.dev-image-hash=<h>
docker-dev`. The context is `docker-dev/`; the allow-list dockerignore keeps `claude-home/` out.
`h` = sha256 over `IMAGE_FILES` sorted, each as `relpath\0content`.

Contents: `ubuntu:24.04`; Node/npm of the host versions; bun; Claude Code native binary (laid out
like `claude install`, so auto-update works); Google Chrome and Playwright chromium; Mailpit;
gitleaks (the repo's git hooks refuse to commit/push without it, see [git-hooks.md](git-hooks.md));
git ≥ 2.48 from the signed git-core PPA; `typescript-language-server` + `typescript`;
`postgresql-client`, `socat`, `jq`, `ripgrep`, `curl`. Every download is verified against a pinned
sha256 in parallel BuildKit stages; a tampered sha256 fails the build. The build asserts
`git --version` ≥ 2.48 and that there is no `python3`.

**Chrome sandbox.** The container cannot create the user/PID namespaces Chrome's own sandbox needs
(`Failed to move to new namespace … Operation not permitted`, then `Zygote process exited
prematurely`), so the entrypoint registers the Playwright MCP for each sandbox (local scope, over
the tracked `.mcp.json` server) with the `.mcp.json` args plus `--no-sandbox`; the container is the
isolation boundary and the tracked `.mcp.json` stays unchanged for the host. Checked in a sandbox:
`google-chrome --headless --no-sandbox --screenshot` works, without `--no-sandbox` it fails with
that error. The explicit flag is used rather than an env variable: `@playwright/mcp`'s README names
`PLAYWRIGHT_MCP_NO_SANDBOX`, its code was read as `PLAYWRIGHT_MCP_SANDBOX`, and the flag is
unambiguous. The Playwright test runner (scenarios, legacy e2e) launches Chromium without the
sandbox by default.

**Build time.** The first build takes **~20–30 min** (it downloads Node, Claude, Chrome, Playwright
Chromium, bun, Mailpit and the apt packages); the launcher and the menu say so when the image is
missing. Later launches reuse the image and start in seconds (plus a few minutes of
`npm ci`/`bun install` into a new sandbox's `node_modules` volumes, cached afterwards). The image is
rebuilt only by `--reset` or when it is missing; when `docker-dev/` files change, launches warn
until `--reset`. A rebuild reuses the BuildKit layer cache, so only the changed steps re-run.

How the build is kept short:

- every download is its own stage, and BuildKit runs them in parallel with the apt stages;
- Playwright's Chromium (the slowest download, ~5 min) has its own stage too, so it overlaps the
  apt work and is not re-downloaded when a later step changes;
- the image files (`entrypoint.sh`, `devctl`, `provision.mjs`, the guide…) are copied last, so
  editing one rebuilds only the last layers;
- apt lists and `.deb`s live in BuildKit cache mounts (one id per stage, so parallel stages never
  wait on each other), kept between builds and never part of a layer.

## Entrypoint

`docker-dev/entrypoint.sh` runs as root on every container start (so `docker start` redoes it):

1. delete the markers; `chown dev` the run/log dirs, the plugin volume, the mounted
   `node_modules` volumes and the caches;
2. start `socat` `127.0.0.1:5432` → `log-hub-postgres:5432` (`/var/log/dev/socat.log`);
3. refresh `node_modules`: each volume stores the sha256 of its lockfile in
   `node_modules/.lockhash`; when it is missing or differs, run the install as `dev`
   (`/var/log/dev/install.log`) — root, `server/`, `hook/`, `artisyn-hooks-installer/` →
   `package-lock.json` → `npm ci`; `client/` → `bun.lock` → `bun install --frozen-lockfile`; the root
   `bun.lock` is ignored. An unchanged lockfile skips the install;
4. merge `settings.template.json` into the profile `settings.json` (`jq -s '.[0] * .[1]'`, user
   keys win);
5. plugins, per sandbox and idempotent: register the worktree's `.artisyn/marketplace`
   (`--scope local`) and install every project-marketplace plugin enabled in the worktree's
   `.claude/settings.json` (`--scope project`) — a snapshot of the worktree's marketplace as of this
   start; register `anthropics/claude-plugins-official` and install `typescript-lsp` (a network
   failure only warns); warn if the tracked `.claude/settings.json` changed;
6. delete the two Phase 1 plugin-disable keys from the worktree's `.claude/settings.local.json`;
7. register a local-scope `postgres` MCP server for the worktree with the tracked `.mcp.json`
   args, `npx.cmd` → `npx` and the DB path `/log_hub_<name_>` (`.mcp.json` stays unchanged);
   likewise a local-scope `playwright` MCP server with the `.mcp.json` args plus `--no-sandbox`:
   Chrome's own sandbox needs new user/PID namespaces, which the unprivileged container cannot
   create ("Failed to move to new namespace … Operation not permitted"); the container is the
   isolation boundary;
8. `provision.mjs --static`, then `devctl start all`;
9. touch `/run/dev/entrypoint-done`; `exec sleep infinity`.

## devctl

`devctl start|stop|restart|status|logs <server|client|mailpit|provision|all>` (unknown arguments:
usage, exit 2). Claude uses it instead of starting services itself.

| Service | Command | Probe (`status`) |
|---|---|---|
| `server` | `cd $SANDBOX_WORKTREE/server && npm run start:dev` | `GET :3000/api/v1/auth/config` |
| `client` | `cd $SANDBOX_WORKTREE/client && bun run dev` | `GET :5173/` |
| `mailpit` | `mailpit --smtp 127.0.0.1:1025 --listen 0.0.0.0:8025` | `GET :8025/` |
| `provision` | `node /opt/log-hub-dev/provision.mjs --loop` | `/run/dev/provisioned` exists |

Each service runs under `setsid` as `dev`, with its pid in `/run/dev/<svc>.pid` and its output
appended to `/var/log/dev/<svc>.log`. `stop` sends TERM to the process group, waits 10 s, then
KILL. `logs` is `tail -n 200 -f`. `status` exits non-zero when a service is stopped or not
responding.

## Claude profile and login

All sandboxes share one Claude profile: `<repo>/docker-dev/claude-home` (git-ignored, a bind mount
at `CLAUDE_CONFIG_DIR=/home/dev/.claude-home`). It survives `--reset` and `--remove`.

- **Login once.** Run `/login` in the first sandbox session; the token lands in the profile's
  `.credentials.json` and every sandbox — existing, new, reset — is logged in from then on. The
  host's login is never copied: its OAuth refresh token rotates, so a copied one would log the
  host or the sandboxes out. The sandboxes' login is a session of its own.
- **No first-run screens.** Before every session or shell the launcher merges into the profile's
  `.claude.json`: the host's `theme` (from `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`),
  `hasCompletedOnboarding`, and `hasTrustDialogAccepted` for this sandbox's container worktree
  path. Only these keys are written, atomically.
- Plugin state is per sandbox (the `-plugins` volume over `claude-home/plugins`).
- **Local settings that follow you in.** The host user settings (`~/.claude/settings.json`) never
  reach a sandbox, and each worktree has its own git-ignored `.claude/settings.local.json`. Before
  every session or shell the launcher copies an allow-list of keys (`SHARED_LOCAL_SETTINGS` in
  `sandbox.mjs`, today `language`) from the main checkout's `.claude/settings.local.json` into the
  worktree's one, keeping its other keys. So to have, say, Russian replies everywhere for this
  repo, put `"language": "russian"` into the main checkout's `.claude/settings.local.json`.

## Hook in the sandbox and provisioning

**Own Log Hub.** The `serverUrl` that `provision.mjs --static` writes into the worktree's gitignored
`.artisyn/config/log-hub.local.json` (`http://localhost:5173`) resolves inside the container to the sandbox client, which proxies to the sandbox backend. Sessions
from a sandbox (transcript, prompts, OTEL through the receiver inside the container) reach only the
sandbox's own Log Hub, never the host one or another sandbox. The developer sees them at the
sandbox `app` URL after identifying with the host git email.

**Root override.** In a linked worktree the hook would normally resolve its root to the main
checkout (`git rev-parse --git-common-dir`), which is not mounted. `ARTISYN_PROJECT_ROOT` (hook
≥ 2.23.0, `hook/.claude/telemetry_tool/project-root-override.js`) overrides that root in
`resolveRootFromCommonDir` when the cwd is inside it, so the hook reads the worktree's
`.artisyn/config/*`, keeps its state in the worktree's `.artisyn/ai_work_dir/`, and uploads
`git.root` = the worktree. Unset, or a cwd outside it, means the old behaviour; see
[hook-system-overview.md](hook-system-overview.md).

**Provisioning** (`docker-dev/provision.mjs`) writes only git-ignored worktree files, in the
installer's formats, keeping every other key:

- `--static` (entrypoint): picks the port — the existing `otel-port.json` `port`, else a legacy
  tracked `log-hub.json` `otelReceiverPort` (branches made before installer `1.0.75`), else the
  fixed `25317` (the hook's `OTEL_FALLBACK_PORT`; each container has its own loopback, so no
  allocation) — and writes it into `.artisyn/config/otel-port.json`; writes `serverUrl`
  `http://localhost:5173` and `otelReceiverPort` into `.artisyn/config/log-hub.local.json`; and the
  OTEL `env` keys into `.claude/settings.local.json`, imported at runtime from the worktree's
  `artisyn-hooks-installer/src/otel-env.ts`. Takes effect once the sandbox image is rebuilt;

- `--loop` (`devctl` service, every 10 s): skip while `GET /api/v1/auth/config` is not 200; if
  `log-hub.local.json` has an `apiKey` that `POST /api/v1/log-echo` accepts, touch
  `/run/dev/provisioned`; otherwise `POST /api/v1/auth/identify` as `SANDBOX_HOST_EMAIL` (on a
  fresh DB the first user becomes admin), `POST /api/v1/api-keys {"name":"sandbox-<name>"}`, write
  `apiKey` into `.artisyn/config/log-hub.local.json` and touch the marker. So a recreated DB gets a new
  key automatically, and a server that becomes healthy later (after `devctl restart server`) is
  provisioned on the next round. Each round is logged to `/var/log/dev/provision.log`.

Tracked files (`.claude/settings.json`, `log-hub.json`) are only read.

## State file

`<worktreesDir>/.sandboxes/<name>/state.json`, written atomically (tmp file + rename):

| Field | Meaning |
|---|---|
| `v` | `2` (a `v: 1` Phase 1 state is refused with a `--remove` hint) |
| `name`, `branch`, `branchCreated` | sandbox name, its branch, whether the launcher created the branch |
| `base` | base branch name or `null` |
| `from` | the `--from` value given at creation, or `null` (used by the re-launch rules) |
| `createdFrom` | sha of the branch tip right after creation |
| `slot`, `ports {server, client, mailpit}` | the port slot and its host ports |
| `worktree` | host path of the worktree |
| `createdAt`, `lastActivity` | ISO times; `lastActivity` = last start/end of a session or `--shell` |

**Lock:** `<worktreesDir>/.sandboxes/.lock`, created with `open(…, 'wx')` holding `{pid, at}`;
retried every 200 ms for up to 30 s. A lock older than 10 min is reported with its path and never
deleted automatically.

## Prune and the stale reminder

**Stale reminder.** Every launch lists the sandboxes whose `lastActivity` is older than
`CLAUDE_DOCKER_STALE_AFTER` (default `7d`) with branch, last activity and pending work, and ends
with `scripts/claude-docker.ps1 --prune --older-than <age>`. It never asks and never removes.

**Prune.** Candidates are stopped or missing containers (`--include-running` adds running ones
with no `claude` process), limited by `--older-than`. Each candidate is classified by
`classifyPruneCandidate` — the exact rules and worked examples are in
[algorithms/sandbox-prune-classification.md](algorithms/sandbox-prune-classification.md):

- live Claude session → never removed, even with `--force`;
- clean and merged into its base (or no commits of its own) → full `--remove`, branch deleted only
  if the launcher created it;
- anything else (uncommitted changes, unmerged commits, no base) → kept, or removed with
  `--force` while the branch is kept.

**Orphans.** N = state-file names ∪ worktree dir names. A state file without a worktree gets the
full removal steps. Containers and volumes whose `log-hub.sandbox` label is not in N are removed. A
DB is dropped only when it equals `log_hub_<n>` or `log_hub_<n>_test` (exact string match, never a
prefix or pattern) for an orphan name n, so another sandbox's `_test` DB is never dropped. A
worktree without a state file is never removed; it is listed as "kept: run `--remove <name>`".

`--prune` always prints the plan ("Will remove", "Will keep", "Not candidates") and asks `y/N` on a
TTY unless `--yes`; without a TTY and without `--yes` it exits 1. The menu's prune screen runs the
same plan (`y` runs it, `F` with force).

## Menu

`claude-docker` without arguments opens a full-screen menu (alternate screen, raw ANSI, Node
built-ins): the `--list` columns with stale sandboxes highlighted, and a detail block with branch,
base, container, worktree and `app … · api … · mailpit … · db log_hub_X <size>` (or
`ports … (stopped)`). Keys: Enter = continue (`--continue`), `R` = resume picker, `S` = shell,
`T` = stop, `D` = remove, `P` = prune, `Q`/Esc = quit; "+ New sandbox" asks for the name, then a
required branch (an existing one or a new name; protected ones are rejected) and an optional base
ref. Destructive actions confirm and name what is lost and the live sessions. Without a TTY the
menu prints a hint and exits 1.

**Keys on Windows without raw mode.** In the WebStorm terminal the whole terminal closed right
after the menu (Node) switched raw mode off following a real key press — not reproducible in
conhost or Windows Terminal, while Claude, `docker exec -it` and PowerShell's own line editor work
there. So on Windows the menu never calls `process.stdin.setRawMode`: `scripts/claude-docker/keys.mjs`
starts a small PowerShell child that reads keys with `[Console]::ReadKey($true)` (ReadConsoleInput
underneath, which returns key events in any console mode, so nobody changes the mode) and streams
one line per key over a pipe; Node's own stdin is never read. Ctrl+C stays a console signal and
quits the menu. On Linux/macOS the classic raw-mode keypress stream is used. The `--prune` `y/N`
prompt reads a plain line for the same reason.

`CLAUDE_DOCKER_MENU=simple` switches to a line menu (numbered list and plain line input: `<n>` opens
Claude, `<n>r` the resume picker, `<n>s` a shell, `n` a new sandbox, `q` quits) for a terminal where
the full-screen menu misbehaves anyway.

**Sessions run outside the menu.** Enter / `R` / `S` / create do not start anything inside the
menu process: the menu ends, restores the console and writes the chosen command (one argument per
line) to the file named by `CLAUDE_DOCKER_NEXT_FILE`; the `claude-docker.ps1`/`.cmd` wrapper sets
that variable and then runs the command as a fresh `claude-docker` process — exactly
`claude-docker <name> --continue`, `--shell <name>` or `<name> --branch <b> [--from <ref>]`. Reason:
on Windows (seen in Windows Terminal), starting containers and `docker exec` from the same process
after the menu had read the console in raw mode closed the whole terminal. Run without a wrapper
(`node scripts/claude-docker.mjs`), the menu prints the command instead. Stop, remove and prune
still run inside the menu.

Any launcher failure is also appended to `<repo>/tmp/claude-docker/launcher-errors.log` (with the
stack), so it can be read even when the terminal window closed.

## Limitations

- **No Docker and no WebStorm MCP inside the container** (no Docker socket; the host IDE works on
  the main checkout, which a sandbox never touches). Claude uses Read/Edit/Grep and `typescript-lsp`.
- **Sandbox telemetry is lost on `--remove`**: the sandbox's sessions live in its own DB, which is
  dropped with it. They never reach the host Log Hub.
- **No automatic cleanup**: a session ended by power loss, a crash or Ctrl+C looks the same as a
  finished one, so only `--remove`/`--prune` remove anything.
- **Only a Windows host has been tested.** The launcher has no Windows-only code, but Linux/macOS
  hosts are untested.
- **Host git ≥ 2.48** is required (relative worktree links).
- The repo and the worktrees dir must be on the same drive.
- A plugin marketplace change in a worktree reaches that sandbox on its next container start, never
  another sandbox.
- **Legacy e2e on a fresh sandbox DB** expects the e2e user `muaddib@arrakis.test` to be an
  admin (its global setup fails with `GET /admin/repos failed (403)` otherwise), but on a fresh DB
  the developer's email, identified first by provisioning, is the only admin. Provisioning
  (`provision.mjs --loop`) therefore promotes the e2e user once, as the developer
  (`PATCH /api/v1/users/:id/role`), and records it in `/run/dev/e2e-admin`; a failure is logged and
  retried next round. The admin-panel sort spec also needs at least one repository, which the
  first hook upload of a Claude session in the sandbox creates. The scenario and contract suites
  have no such precondition (own schemas).
- Under heavy parallel load (three sandboxes each running a scenario stand, Chromium and its dev
  stack at once) a few UI steps with 10 s waits timed out (`@S-SESS-12`, `@S-SLIFE-06`): the stand's
  I/O went through the shared 9p file-sharing bridge. Since then a sandbox's `tmp/` is a volume and
  its test timeouts are ×5 (`LOG_HUB_TEST_TIMEOUT_SCALE`).
