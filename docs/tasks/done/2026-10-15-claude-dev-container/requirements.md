# 2026-10-15: Claude Code Dev Container (docker-dev + local infra + hook)

**Status:** todo **Priority:**
**Type:** feature **Module (s):** infra / dev environment, hook **Owner:** denis.tsyplakov **Created:** 2026-10-15

## Description

Provide Claude Code dev containers for this repository so that Claude can run with
`--dangerously-skip-permissions` in an isolated Linux environment instead of directly on the
developer's host. Each container is a self-contained **sandbox**: its own git worktree and branch,
its own database in the shared Postgres server, its own backend, client and Mailpit running inside
the container. Several sandboxes can run in parallel. Stopping a sandbox's container stops
everything in it; the worktree, branch and database persist. While the sandbox runs, the developer
opens its client in a host browser at the sandbox's own URL (`http://localhost:<sandbox client port>`)
to see how the agent's work looks; a stopped sandbox is brought back for viewing with `--serve`.

The work has these parts:

- **A. Local infrastructure:** the existing host compose file, unchanged except for a fixed container
  name, network name and `max_connections`, so sandboxes can share its Postgres server.
- **W. Sandbox:** worktree, database, in-container dev stack, host ports and lifecycle per sandbox.
- **B. Dev image and launcher:** a Linux image with Node/npm, bun, Claude Code, Chrome, Playwright and
  Mailpit; OS-dependent directories on container volumes; the host TEMP directory mounted for pasted
  images; a launch script in this repo.
- **C. Telemetry hook in the container:** Claude sessions run inside a sandbox are reported to the
  sandbox's own Log Hub.
- **E. Cleanup:** removing a sandbox and its resources, finding orphans.

Currently the DB is `server/artisyn-log-run-local/docker-compose.yml` (`postgres:18.4`, `127.0.0.1:5432`,
DB `a-log`, data is a bind mount from the Windows disk).

## Phase 1 — PoC: review sandbox

The first deliverable is a minimal sandbox in which Claude reviews a task (e.g.
`/adlc-lh:review-deep <task>`) in its own worktree and branch, with no servers and no code changes;
the developer then merges the result back (outside the launcher, see "Merging" below) and removes
the sandbox. Phases 2+ (the rest of this document) build on it.

**Merging is out of the launcher's scope (user decision, all phases).** The launcher has no
`--merge` command and no merge action in the menu; it never commits or merges. The developer
commits and merges a sandbox's branch on the host with their own agent, then removes the sandbox
with `--remove <name> [--delete-branch]` or `--prune`. Claude inside a sandbox never makes git
writes (as in the repo `CLAUDE.md`).

- PoC-1. **Scope.** From the FRs below only: FR-W1 (no DB, no ports), FR-W2, FR-W3, FR-B1 (slim image:
  Node/npm, Claude Code, git ≥ 2.48, `jq`, `ripgrep` — no Chrome, Playwright, Mailpit, bun),
  FR-B3, FR-B6 (no socat, no dev stack, no `node_modules` volumes), FR-B8, FR-B9, FR-D1. Out of the
  PoC: section A (no Postgres needed), FR-W4–W6, FR-B2, FR-B4, FR-B10, section C (no server, so no
  telemetry: the entrypoint disables `log-hub-hooks` and `typescript-lsp` — the slim image has no
  language server — for the worktree with a local-scope `enabledPlugins` override; no hook
  changes), `--serve`. Cleanup (section E, without the DB steps) is in the PoC.
- PoC-2. **Plugins.** The entrypoint registers and installs the project plugins enabled in
  `.claude/settings.json` (`adlc-lh`, `log-hub-hooks`) on every container start
  (`claude plugin marketplace add` / `claude plugin install --scope project`, idempotent) into the
  sandbox's own plugin state as described in FR-B6, so the `/adlc-lh:*` skills and the `Workflow`
  tool work in the sandbox.
- PoC-3. **Review-only guard.** The container guide (FR-B7, PoC version) says: review mode — only
  files under `docs/` may be changed; do not start servers, do not run builds or tests; no git write
  commands (as in the repo `CLAUDE.md`).
- PoC-4. **Launcher commands.** `claude-docker <name> [--branch <branch>] [--from <ref>]` (create/start
  + Claude session), `--shell <name>`, `--stop <name>`, `--list`, `--remove <name> [--force]
  [--delete-branch]`, `--prune`, the stale-sandbox reminder (section E without the DB steps),
  `--continue`/`--resume` passed to `claude`, and the interactive menu (FR-W8, without `--serve`).
- PoC-5. **Host prerequisite.** Host git ≥ 2.48 (`worktree.useRelativePaths`), checked by the
  launcher (FR-W2).

PoC acceptance criteria:

- [ ] `claude-docker r1` creates worktree + branch `r1` from the current `HEAD` and opens Claude in the
  container; `/adlc-lh:review-deep <task>` runs to completion there and changes only files under
  `docs/` of the worktree.
- [ ] The main checkout's working tree is untouched while `r1` works; `git worktree list` on the host
  shows `r1` and `git -C <worktree> status` works from the host.
- [ ] After the developer has committed and merged `r1`'s work on the host (outside the launcher),
  `--remove r1 --delete-branch` removes the container, the worktree and the branch; afterwards
  `git worktree list` and `--list` show no `r1`, and no `r1` container or volume is left in
  `docker ps -a` / `docker volume ls`.
- [ ] `claude-docker r3 --branch <existing branch>` checks that branch out in the new worktree instead
  of creating one; a branch already checked out in the main checkout or another worktree is refused
  with a message.
- [ ] A review session in `r1` produces no hook errors and creates nothing outside the worktree.
- [ ] `--remove r2` on an unmerged sandbox removes container and worktree, keeps branch `r2`, and
  refuses on uncommitted changes without `--force`.
- [ ] No launch ever removes a sandbox. Power-loss simulation: `docker kill` the container in the
  middle of a session that has not changed any file yet (and, separately, leave Claude with
  Ctrl+C); after any number of launches the sandbox still exists, and
  `claude-docker r1 --continue` reopens that conversation in the same worktree so the review can
  be finished.
- [ ] With the threshold set to a few minutes (env), a launch prints the stale sandboxes with branch,
  last activity and pending work, and ends with the exact `--prune --older-than …` command;
  running that command shows the plan, asks for confirmation, removes the nothing-to-lose ones
  and keeps the ones with work unless `--force`.
- [ ] `claude-docker` without arguments opens the menu: it lists the sandboxes, creates a new one,
  continues an existing one (Claude opens in the same terminal), removes and prunes —
  each destructive action only after a confirmation; Esc/`Q` leaves without changes.

## Functional Requirements

### A. Infrastructure

- FR-A1. **The host workflow does not change (user decision).** `server/artisyn-log-run-local/docker-compose.yml`
  stays where it is and keeps its service `db`, image, env, `PGDATA`, the `./data` bind mount and
  the data in it. The developer still runs `docker compose up -d` there and then the server and
  client on the host, with no knowledge of sandboxes.
- FR-A2. The only changes to that file are additive/cosmetic, so sandbox containers can reach the DB
  by name: `container_name`/`hostname` `log-hub-postgres`, a fixed network name `log-hub-net`, and
  `command: postgres -c max_connections=300` (several sandboxes running test suites in parallel).
  Recreating the container with these changes keeps the data (same bind mount).
- FR-A3. Host-side ports and credentials are unchanged: `127.0.0.1:5432` (`a-log`, `postgres`/`pw`).
  The host `server/.env`, `.mcp.json`, jest and scenarios work without changes.
- FR-A4. The launcher waits for the DB with `docker exec log-hub-postgres pg_isready` (the compose
  gets no healthcheck).
- FR-A5. `tests/scenarios/docker-compose.yml` and its references are not changed. Sandboxes do not
  need a host Mailpit (each runs its own, FR-W5).

### W. Sandbox

- FR-W1. **Identity.** A sandbox is identified by a name matching `^[a-z0-9][a-z0-9-]{0,39}$` and not
  ending in `-test` (so no main DB name can equal another sandbox's test DB), validated by the
  launcher. It
  owns: container `log-hub-dev-<name>`, one branch, worktree, databases `log_hub_<name>` and
  `log_hub_<name>_test` (dashes → underscores), its `node_modules` volumes and its host port
  triple. The branch is `<name>` by default or the one given on creation with
  `claude-docker <name> --branch <branch> [--from <ref>]` (existing or new); it is recorded in the
  sandbox state file (FR-E4) and used by `--list`, `--remove --delete-branch` and the prune
  "merged" check. The state file also records `branchCreated` (true only when the launcher created the branch) and
  the **base branch**: for a new branch, the branch named by `--from`, otherwise the branch checked
  out in the main checkout at creation; none for an existing branch, a tag/sha `--from` or a
  detached HEAD.
- FR-W2. **Worktree.** Created by the launcher on first launch with `git worktree add`: an existing
  branch is checked out; a new one is created from the main checkout's current `HEAD` (or
  `--from <ref>`). If the branch is already checked out in the main checkout or another worktree,
  git refuses and the launcher exits with that message. The host-side command is
  `git -c core.autocrlf=input worktree add --relative-paths …`, so the worktree's files are LF from
  the start and no host git config is changed. Location: a sibling directory of the repo, `<repo-parent>/<repo-name>-worktrees/<name>`
  (overridable by an env variable), so the main checkout's tools and IDE never index it. The worktree
  links (`<worktree>/.git` and `.git/worktrees/<name>/gitdir`) are **relative**
  (`worktree.useRelativePaths`, git ≥ 2.48), so the same worktree works from the Windows host and
  from the container; the launcher exits with a message if the host git is older.
- FR-W3. **Mounts.** Only the sandbox's worktree and the main repo's `.git` directory are mounted,
  read-write, at container paths that mirror their relative host layout (so the relative links
  resolve); the main checkout's working tree is not mounted. Nothing else of the host file system is
  writable from the container except `docker-dev/claude-home` (FR-B6).
- FR-W4. **Database.** The launcher creates `log_hub_<name>` in `log-hub-postgres` if missing
  (`docker exec log-hub-postgres createdb …`, idempotent). The container gets
  `DATABASE_URL=postgresql://postgres:pw@localhost:5432/log_hub_<name>` (through the socat forward,
  FR-B4) as an environment variable; the server, contract and scenarios already honour
  `DATABASE_URL` from the environment. The worktree's git-ignored `server/.env` is generated by the
  launcher on creation with exactly `AUTH_MODE=none`, `COOKIE_SECURE=false` and `PORT=3000`
  (`DATABASE_URL` comes from the container env, `SESSION_SECRET` is generated by the server; nothing
  is copied from the host checkout). Mirroring the
  host split (runner on `postgres`, dev server on `a-log`), the launcher also creates
  `log_hub_<name>_test` for the test runners: the backend and the e2e helpers use `log_hub_<name>`,
  the scenario and contract runners get the test DB through an explicit env variable (named in the
  plan), so the scenario runner's schema fingerprint never sees the live backend's hook uploads. All
  test schemas (`contract_*`, `scn_*`) of a sandbox live in its own DBs, so stale-schema cleanup in
  one sandbox never touches another sandbox's run.
- FR-W5. **In-container dev stack.** The entrypoint starts, as user `dev`, the backend (`npm run start:dev`, `3000`),
  the Vite client (`bun run dev`, `5173`, bound to `0.0.0.0` through an
  env-driven `server.host` in `client/vite.config.ts` that only the launcher sets) and Mailpit (`1025`/`8025`, binary in
  the image) under a small supervisor; logs go to `/var/log/dev/*.log`. A
  helper `devctl status|restart|stop|logs <server|client|mailpit>` lets Claude manage them. They stop
  when the container stops and start again when it starts.
- FR-W6. **Host ports.** Inside the container the ports are the usual `3000`/`5173`/`8025`, so all
  checked-in configs work unchanged. On the host each sandbox gets its own port triple, allocated by
  the launcher on first launch (first free slot from a base, e.g. `3100+10·n` / `5200+10·n` /
  `8100+10·n`), published on `127.0.0.1` only and kept for the sandbox's lifetime. The sandbox state
  file (FR-E4) is the single source of truth; container labels are a copy written on (re)create. A
  slot is free when no state file claims it and all three host ports are bindable on `127.0.0.1`;
  allocation holds an exclusive lock file in `.sandboxes/` from choosing the slot until the state
  file is written. Host ports `3000`/`5173` stay free for a host dev server.
- FR-W7. **Lifecycle.** Launcher commands:
    - `claude-docker <name> [args]` — create or start the sandbox and open a Claude session in it;
      running it again in another terminal opens one more session in the same container. Prints the
      sandbox URLs.
    - `--serve <name>` — start the sandbox (dev stack up) without a Claude session, to look at its UI.
    - `--shell <name>` — a bash shell in the sandbox.
    - `--stop <name>` — stop the container (and with it the dev stack and sessions). `--stop` and
      `--remove` refuse while `pgrep -x claude` finds a process in the container, naming the number
      of live sessions, unless `--force`; in the menu `T`/`D` on such a sandbox ask for a
      confirmation that names those sessions.
    - **Re-launch** of an existing sandbox never silently diverges from its state file:
      `--branch`/`--from` that differ from it are an error (matching ones are ignored with a note);
      a kept host port that is no longer bindable fails the start naming the port, with no
      re-allocation; a state file without its worktree, or a worktree without a state file, is
      refused with a hint to run `--remove <name>` or `--prune`. Worktree creation, DB creation and
      the state-file write run under the same `.sandboxes/` lock as port allocation.
    - `--list`, `--remove`, `--prune` — see section E.
    - `--reset <name>` — rebuild the image with cache and recreate the container; keeps worktree, DB
      and volumes; refused while `pgrep -x claude` finds a process in the container.
      The container keeps running after the last Claude session exits, until `--stop`.
- FR-W8. **Interactive mode.** `claude-docker` without arguments opens a full-screen terminal menu in
  the Claude Code style (keyboard-driven, single list, hotkey footer):
    - the list of sandboxes with the `--list` columns (FR-E6), stale ones (FR-E4) highlighted;
    - on the selected sandbox: Enter = continue (`--continue`), `R` = pick a session (`--resume`),
      `S` = shell, `T` = stop, `D` = remove; a "+ New sandbox" row asks for the name (and
      optionally the branch and the base ref);
    - `P` = prune: shows the `--prune` plan in the menu and runs it only after a confirmation; every
      destructive action (`D`, `P`, anything with `--force`) asks for a confirmation that names
      what will be lost;
    - choosing a session leaves the menu and hands the terminal to `docker exec -it … claude`; when
      Claude exits, the launcher returns to the shell (not to the menu).
      Every menu action calls the same code path as its command-line flag; the flags stay for scripting.
      `--serve` and `--reset` stay CLI-only (not in the approved prototype).
      The layout, key map and dialogs follow the approved UI prototype
      `docs/pocs/2026-10-21-1316-sandbox-menu-tui/` (zero-dependency Node: raw ANSI + readline keypress,
      alternate screen), minus its merge action and merge dialogs; without a TTY the menu prints a
      hint and exits 1.

  ![Sandbox menu — list](wireframes/sandbox-menu-list.svg)

  ![Sandbox menu — confirmation, refusal and input dialogs](wireframes/sandbox-menu-dialogs.svg)

  ![Sandbox menu — prune plan](wireframes/sandbox-menu-prune.svg)

### B. Dev image and launcher

- FR-B1. **Image** `docker-dev/Dockerfile`: `ubuntu:24.04`, user `dev` uid 1000 (the stock `ubuntu`
  user is removed so the uid is free), passwordless sudo; Node/npm of the host versions, bun,
  Claude Code (native binary), Google Chrome and Playwright chromium, Mailpit, git ≥ 2.48, language
  server for `typescript-lsp`, `postgresql-client`, `socat`, `jq`, `ripgrep`.
  `Dockerfile.dockerignore` is an allow-list. No Python. One image serves all sandboxes.
  Design notes:
    - Split downloads across parallel BuildKit stages; a multi-connection downloader (e.g.
      `aria2c -x16 -s16`) helps when sites throttle per-connection speed.
    - Verify every downloaded archive against its official sha256.
    - Claude Code: the official native binary, verified against its release manifest, laid out the
      same way `claude install` does so that auto-update works.
    - Chrome: the official `.deb` plus its dependencies fetched with `apt-get install --download-only`
      and installed offline (list `libasound2t64` explicitly on 24.04).
- FR-B2. **Volumes**: per sandbox, five `node_modules` volumes (root, `client/`, `server/`, `hook/`,
  `artisyn-hooks-installer/`) mounted over the worktree; shared across sandboxes, the caches `~/.npm`,
  `~/.bun`, `~/.cache/ms-playwright`. The entrypoint stores a hash of the matching lockfile in each
  `node_modules` volume and runs its install command when the volume is empty or the hash differs:
  root, `server/`, `hook/`, `artisyn-hooks-installer/` → their `package-lock.json` → `npm ci`;
  `client/` → `client/bun.lock` → `bun install --frozen-lockfile`. The root `bun.lock` is ignored.
- FR-B3. **Host TEMP** read-only at `/host-tmp` + the `HOST_TEMP` variable, for images pasted with
  Ctrl+V (they arrive as Windows paths); the guide (FR-B7) explains how to translate a Windows path
  to `/host-tmp/…`.
- FR-B4. **Forwards**: inside the container, socat forwards `127.0.0.1:5432` to `log-hub-postgres:5432`,
  so that the DB URLs work unchanged. There is no WebStorm MCP forward: the host IDE works on the main
  checkout, which a sandbox must never touch (FR-W3).
  `nodelay` is set on both legs of every socat forward (without it Nagle + delayed ACK add ~40 ms per
  DB round trip and make tests several times slower).
- FR-B5. **Launch script**: the logic is a Node script `scripts/claude-docker.mjs` (Node is on the host
  anyway; the FR-W8 menu is built with Node built-ins only, as in the approved prototype), with
  thin `scripts/claude-docker.ps1` / `.cmd` wrappers; it implements the commands of FR-W7 and FR-W8. On every launch it
  brings up the infrastructure
  with `docker compose up -d --no-recreate` (without `--no-recreate` a changed compose would recreate
  a service that running sandboxes depend on) and builds the image if it is missing. The image
  carries a hash of `docker-dev/*` as a label; a normal launch never rebuilds, but warns and suggests
  `--reset` when the label differs from the current files.
- FR-B6. **Entrypoint and Claude profile**: `docker-dev/entrypoint.sh` (runs as root) `chown`s the
  volumes to `dev`, populates/refreshes `node_modules` volumes (FR-B2), merges
  `docker-dev/settings.template.json` into the profile with `jq -s '.[0] * .[1]'` (user keys win),
  starts the socat forwards (FR-B4) and the dev stack (FR-W5). `CLAUDE_CONFIG_DIR` points to the
  main checkout's `docker-dev/claude-home` (git-ignored, mounted into every sandbox), so the login and
  history are shared by all sandboxes and survive `--reset`/`--remove`. Plugin and marketplace state
  is **not** shared: each sandbox has its own (e.g. a per-sandbox volume over the plugin directory of
  the profile, removed with the sandbox), and on every container start the entrypoint re-registers
  the project marketplace from the sandbox's own worktree and installs the plugins into it — a
  snapshot of the worktree's `.artisyn/marketplace` as of that start (a later change there takes
  effect on the next start). The entrypoint also registers the `claude-plugins-official` marketplace
  and installs `typescript-lsp` into the same per-sandbox state on every start (idempotent); a
  failed network install logs a warning and does not block the session. The project plugins
  (`log-hub-hooks`, `adlc-lh`, `typescript-lsp`) work; a shim `npx.cmd` → `npx` for Playwright MCP.
  The entrypoint registers a local-scope `postgres` MCP server for the worktree path
  (`claude mcp add --scope local postgres … /log_hub_<name>`), which overrides the tracked
  `.mcp.json` entry (`a-log`) in the sandbox only; `.mcp.json` stays unchanged for the host.
- FR-B7. **Guide** `docker-dev/CLAUDE.container.md` → `/etc/claude-code/CLAUDE.md` (managed policy,
  takes priority over the repo `CLAUDE.md` where they diverge): Linux/bash; the sandbox has its own
  branch, DB, backend, client and Mailpit, already running — manage them with `devctl`, never start a
  second copy; build and the full test set (including `contract`, `scenarios-a/b/c`, `e2e-full`) run
  in the sandbox against its own DB; `/host-tmp` for images; Docker is not available from inside; the
  WebStorm MCP and the `web-storm-mcp` skill are unavailable (use Read/Edit/Grep and `typescript-lsp`).
- FR-B8. **Git**: `safe.directory` for the worktree path, `core.autocrlf input`, `core.filemode false`,
  `core.ignorecase false`, `worktree.useRelativePaths true`, author taken from the host `git config`.
  They are container-only: the image's global gitconfig plus `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
  `GIT_CONFIG_VALUE_n` env vars set by the launcher (needed to override repo-level keys such as
  `core.ignorecase = true` in the shared `.git/config`). Nothing is ever written to the shared
  `.git/config`.
- FR-B9. Everything in `docker-dev/`, the host compose file and the launch script is checked-in, with no
  developer machine paths (they are taken from the environment).
- FR-B10. **Build isolation**: `npm run build` in a sandbox must not disrupt its own backend running in
  watch mode (the build rewrites `server/src/public/static/*`, which the watch backend reloads on).
  The guide (FR-B7) states that the build and the e2e/contract suites never run concurrently (the
  `app` group of `repo-health-checks.json`).

### C. Hook in the container

- FR-C1. **Own Log Hub.** Claude sessions from a sandbox (transcript, prompts, OTEL through the
  receiver inside the container) are reported only to the sandbox's own server: the tracked
  `.artisyn/config/log-hub.json` `serverUrl` (`http://localhost:5173`) resolves inside the container
  to the sandbox client, which proxies to the sandbox backend. Nothing from a sandbox reaches the
  host Log Hub or another sandbox; sandbox sessions are lost when the sandbox is removed (accepted).
- FR-C2. **Hook root = worktree in a sandbox.** Today the hook resolves its root with
  `git rev-parse --git-common-dir` (`hook/.claude/telemetry_tool/git-context.js` `getGitRoot`), so in
  a linked worktree it reads `.artisyn/config/*` and writes `.artisyn/ai_work_dir/` of the **main**
  checkout — which is not mounted into the sandbox (FR-W3). The hook gets a backward-compatible env
  override of that root (e.g. `ARTISYN_PROJECT_ROOT`); unset → current behaviour, so host sessions
  and old hook installs are unaffected. The launcher sets it to the worktree path, so in a sandbox
  the hook reads the worktree's own config (tracked `log-hub.json` + git-ignored
  `log-hub.local.json`, `otel-port.json`) and keeps its state in the worktree's own
  `.artisyn/ai_work_dir/` — never shared with the host checkout or another sandbox; the main
  checkout's `.artisyn/` is never mounted, copied or rewritten. The override applies in `resolveRootFromCommonDir`, so `getGitRoot` and
  `getGitContext().root` (uploaded as `gitRoot`) agree on the worktree. The plan checks that the
  `getGitRoot` users (code inventory, skill catalog, OTEL registration, session-file matching) and
  the `getGitContext` users (`lifecycle-hook.js`, `post-turn-analysis-hook.js`,
  `post-turn-analysis-worker.js`) behave correctly with the override.
- FR-C3. **Provisioning.** After the sandbox backend is healthy, the entrypoint provisions the hook,
  idempotently:
    - identifies (`POST /api/v1/auth/identify`, the server runs with `AUTH_MODE=none`) as the host
      git `user.email`, passed by the launcher — on a fresh DB the first user becomes admin, and the
      developer sees the sandbox sessions in the browser by identifying with the same email;
    - creates an API key (`POST /api/v1/api-keys`) and writes only the git-ignored hook files of the
      worktree: `.artisyn/config/log-hub.local.json` (`apiKey`), `.artisyn/config/otel-port.json` and the
      OTEL `env` keys of `.claude/settings.local.json`, in the installer's formats; tracked files
      (`.claude/settings.json`, `log-hub.json`) are not modified;
    - reuses an existing key if the server accepts it, otherwise (e.g. the DB was recreated) creates a
      new one;
    - writes a readiness marker; the launcher opens a Claude session only after it exists, because the
      hook silently skips uploads while `apiKey` is empty. The wait is bounded (env-configurable,
      e.g. 180 s) and shows progress; on timeout the launcher prints the failing component and the
      `devctl logs <server|client>` hint and opens the session anyway with a warning that telemetry
      upload is off. The entrypoint retries provisioning whenever the backend later becomes healthy.
- FR-C4. Hook changes (FR-C2): in `hook/` with tests,
  `npm run build:hooks-installer`, update of the dogfood install; the upload format is backward
  compatible.

### E. Cleanup

- FR-E1. `--remove <name> [--force] [--delete-branch]`. Before any destructive step it checks the
  worktree (`git status --porcelain`) and, with `--delete-branch`, that the branch is merged; if a
  check fails and `--force` is not given, it exits non-zero listing what is pending and removes
  nothing. Then, in this order: stop and remove the container;
  remove its `node_modules` volumes and its own plugin state (FR-B6); drop `log_hub_<name>` and `log_hub_<name>_test` (`dropdb --force`,
  terminating open connections); `git worktree remove` (refused on uncommitted or untracked changes
  unless `--force`) and `git worktree prune`; release the host ports (delete the sandbox state file). The branch is
  kept; `--delete-branch` deletes it
  with `git branch -d` (refuses an unmerged branch). Everything a sandbox wrote — its DB (sessions,
  test schemas), `ai_work_dir`, server logs — goes with it. Shared caches are never touched.
- FR-E2. Each step of `--remove` is idempotent and tolerates the resource already being gone, so a
  failed or interrupted removal can simply be re-run.
- FR-E3. **No automatic cleanup.** Nothing is ever removed without an explicit command: a session
  ended by power loss, a crash or a stray Ctrl+C looks the same as a finished one, so the launcher
  cannot tell an abandoned sandbox from one the developer will come back to. Any existing sandbox
  can be resumed with `claude-docker <name> --continue` (or `--resume` for the picker): the launcher
  passes the flag to `claude`, which finds the transcript because `claude-home` is shared and the
  worktree path inside the container is stable.
- FR-E4. **Stale-sandbox reminder.** The launcher keeps per-sandbox state on the host, outside the
  worktree (e.g. `<worktrees-dir>/.sandboxes/<name>/`: branch, base branch, ports, creation time, last
  activity = the last start or end of a Claude session or `--shell`). On every launch, if any
  sandbox has had no activity for longer than a threshold (default 7 days, configurable by env), the
  launcher prints the list — name, branch, last activity, pending work (changed files / unmerged
  commits) — and ends with the ready-to-run cleanup command, e.g.
  `scripts/claude-docker.ps1 --prune --older-than 7d`. It does not ask and does not remove anything.
- FR-E5. **`--prune [--older-than <age>] [--force] [--yes] [--include-running]`** removes inactive
  sandboxes in one call.
    - **Candidates** by default are sandboxes whose container is stopped or missing.
      `--include-running` adds running containers with no `claude` process (`pgrep -x claude`; from
      phase 2 their UI may be open in a browser). A container with a live `claude` process is never
      pruned, even with `--force`. `--older-than` limits it to sandboxes whose last activity is older
      than `<age>`.
    - Each candidate is classified:
        - **nothing to lose** — the worktree is clean and the branch is merged into its base branch
          (`git merge-base --is-ancestor <branch> <base>` against the base's current tip) or has no
          commits of its own → full `--remove`, including the branch only if `branchCreated`;
          a sandbox with no base branch is classified as having work;
        - **has work** — uncommitted/untracked changes or unmerged commits → kept and listed with what is
          pending; removed (keeping the branch)
          only with `--force`.
    - **Orphans** are found by cross-checking sandbox resources by name — `log-hub-dev-*` containers,
      their volumes, `log_hub_*` databases, worktrees under the worktrees directory, git worktree
      metadata (`git worktree prune`) — and resources without a worktree are removed. A DB belongs
      to sandbox `n` only if it is `log_hub_<n>` or `log_hub_<n>_test` for a name `n` from a state
      file or worktree. A worktree is never treated as an orphan.
    - It always prints the plan first (what will be removed, what is kept and why) and asks for
      confirmation unless `--yes`. Each step reuses the idempotent `--remove` steps (FR-E2).
- FR-E6. `--list` shows, per sandbox, branch, base branch, state, active `claude` sessions, last
  activity, pending work (changed files / unmerged commits), URLs, worktree path and DB size.

### General

- FR-D1. `.gitignore`: `docker-dev/claude-home/`.
- FR-D2. KB article `docs/knowledgebase/docker-dev-container.md` (sandbox model, launcher commands,
  what is mounted, ports, volumes, DB per sandbox, limitations) + a line in `index.md`; references in
  `CLAUDE.md`/`README.md` to the launcher.
- FR-D3. `CLAUDE.md` and `repo-health-checks.json → environmentNotes` say Claude starts the server and
  client itself when needed on the host; in a sandbox they are already running (FR-B7).
- FR-D4. The host DB and its data are kept (FR-A1); no migration or reinstall is needed on the host.

## Non-Functional Requirements

- The container has no Docker socket and no private keys or credentials beyond the Claude login.
- The container design does not depend on the repo's test suites (user decision: they may change or
  be deleted without affecting the sandbox); there is no test-speed requirement. Sandboxes only
  provide isolation (own DB, ports, Mailpit, worktree) so that whatever checks exist can run in
  them.
- At least three sandboxes can run in parallel without interfering.

## Acceptance Criteria

- [ ] `claude-docker a` from scratch brings up `log-hub-postgres` (the host compose), builds the image, creates worktree + branch `a` and DB `log_hub_a`, starts the
  in-container backend, client and Mailpit and opens Claude; the printed URL opens the sandbox UI
  from the host; a second console is a second session in the same sandbox.
- [ ] Sandboxes `a`, `b` and `c` run in parallel with different host ports, branches and DBs; a change
  committed in `a` is not visible in `b`'s working tree; their full test sets pass concurrently.
- [ ] `devctl restart server` restarts the backend and `devctl logs client` shows the Vite log; after
  `--stop` and a new start all three services are up again.
- [ ] Changing one of the five lockfiles makes the next start reinstall only that `node_modules`
  volume; an unchanged lockfile skips the install.
- [ ] `--stop a` stops the backend, client and Mailpit of `a`; the worktree stays readable on the host
  and `git status`/`git log` work there; `--serve a` brings the UI back on the same ports with the
  same data.
- [ ] A new sandbox `a` has both `log_hub_a` and `log_hub_a_test`; the contract and scenario runners
  use only `log_hub_a_test`.
- [ ] `--list` shows every FR-E6 column; a sandbox with one open session shows 1 active session and
  an uncommitted edit shows up in pending work.
- [ ] `--remove a` drops `log_hub_a` and `log_hub_a_test` (even with an open connection), removes
  the container, volumes and worktree, keeps branch `a`; on uncommitted changes without `--force`
  it exits non-zero and removes nothing; with a live `claude` session it refuses without `--force`;
  re-running an interrupted `--remove a` completes it.
- [ ] On the host, after only `docker compose up -d` in `server/artisyn-log-run-local/`: the host dev
  server starts on `a-log`, `npm run test:contract` and `npm run test:scenarios -- --mode b` pass, the
  host postgres MCP returns `a-log` with the data that was there before the change.
- [ ] The menu highlights stale sandboxes, and each of its keys gives the same result as its flag.
- [ ] In a fresh sandbox the `typescript-lsp` LSP tool answers a go-to-definition query on a `.ts`
  file.
- [ ] With sandboxes in every state — running with a session, stopped and merged, stopped with no
  commits, stopped with uncommitted changes, stopped with unmerged commits, and an orphan whose
  worktree was deleted manually — `--prune` removes exactly the merged, the no-commit and the
  orphan ones (container, volumes, both DBs, worktree, branch if created by the launcher), keeps
  the rest and never drops another sandbox's `_test` DB, and prints why each
  kept one was kept; with `--force` it also removes the ones with work but keeps their branches;
  `--include-running` also takes a running sandbox with no `claude` process, never one with a
  live session.
- [ ] The host compose differs from before only by `container_name`/`hostname`, the network name and
  `max_connections`; `show max_connections` returns `300`.
- [ ] In a sandbox the fast set and the full set (`contract`, `scenarios-a/b/c`, `e2e-fast`,
  `e2e-full`) pass; `npm run build` passes and does not drop the running watch backend mid-suite.
- [ ] An image pasted with Ctrl+V is readable by Claude in the sandbox through `/host-tmp`.
- [ ] Playwright MCP and postgres MCP work in the sandbox; `select current_database()` through the
  postgres MCP in sandbox `a` returns `log_hub_a`; the Claude login is shared by all sandboxes
  and survives `--reset`.
- [ ] Plugins are per sandbox: after `--remove a`, sandbox `b` still loads `/adlc-lh:*` and the hook
  from its own snapshot; a marketplace change committed in `a`'s worktree does not reach `b`, and
  reaches `a` on its next container start.
- [ ] A sandbox whose server fails to start still opens Claude after the readiness timeout with a
  warning; after the fix (`devctl restart server`) provisioning completes and uploads resume.
- [ ] A tampered sha256 fails the image build; `which python3` is empty in the image.
- [ ] The launcher refuses an invalid sandbox name and a host git older than 2.48 with a message;
  `--reset` with a live `claude` exits non-zero with a message; an edited `docker-dev/*` file
  triggers the stale-image warning.
- [ ] The main checkout's working tree and `node_modules` are untouched by sandbox work; the host
  `git status` shows no false changes and no `docker-dev/claude-home/`; a commit made in a sandbox
  has the host author and LF line endings.
- [ ] `docker-dev/`, the host compose file and the launch script contain no developer machine paths or user
  names.
- [ ] A session from sandbox `a` is visible, with logs, cost and OTEL data, in `a`'s own UI after
  identifying with the host git email from the host browser; it is absent from the host Log Hub
  and from sandbox `b`; host sessions keep uploading to the host Log Hub.
- [ ] Recreating `log_hub_a` (drop + restart of the sandbox) re-provisions a new API key and uploads
  resume; no tracked file in the worktree changes due to provisioning.
- [ ] Without the root override (host sessions, including a host session inside a linked worktree)
  the hook reads config and writes state exactly as before; the main checkout's `.artisyn/` is
  unchanged after sandbox work.
- [ ] The KB article and index are updated.

## Open Questions

- What priority should this task have (e.g. `medium` or `high`)?

## Common sense considerations

- Vite binds `0.0.0.0` in the container via an env-driven `server.host` set only by the launcher.
- The host workflow and host compose stay as they are (bind mount, data, `db` service); only name, network and `max_connections` are added (user decision).
- `tests/scenarios/docker-compose.yml` is not touched; sandboxes have their own Mailpit.
- `node_modules` volumes are refreshed on lockfile-hash change; `--reset` keeps all volumes.
- "claude alive" means `pgrep -x claude` in the container; hook background processes don't block `--reset`.
- A normal launch warns on a stale image (hash label), never rebuilds.
- Worktrees live in a sibling directory, not inside the repo, so host tools never scan them.
- Each sandbox runs its own Mailpit, so parallel mail-based scenarios cannot read each other's mail.
- The sandbox DB is created in the shared server; all test schemas of a sandbox stay in its DB.
- Worktree links are relative so one worktree works from both Windows and Linux.
- The container outlives its last Claude session so the UI stays viewable until `--stop`.
- `--remove` keeps the branch; work is never lost by removing a sandbox.
- With the hook root pointed at the worktree, each sandbox has its own `ai_work_dir` and hook config.
- Sandbox telemetry goes to the sandbox's own server (user decision, for isolation); losing it on `--remove` is
  accepted.
- The sandbox user is the host git `user.email`, so the developer sees the sessions in the browser without switching
  identity.
- Provisioning writes only git-ignored files, so it never shows up in the worktree's `git status`.
- No automatic cleanup (user decision): the launcher only reminds about sandboxes idle > 7 days and prints the `--prune`
  command.
- Pending work is removed only with an explicit `--force`; branches with unmerged commits are never deleted by prune.
- The sandbox postgres MCP targets `log_hub_<name>` via a local-scope override; the tracked `.mcp.json` is untouched.
- The launcher never commits or merges (user decision); the developer merges with their own agent on the host.
- Each sandbox gets its own plugin/marketplace state, snapshotted from its worktree on every container start (user
  decision); only the login and history are shared.
- The container design does not depend on the test suites; there is no test-speed requirement (user decision).
- The parallel AC uses three sandboxes, matching the NFR.
- `devctl` and the lockfile-driven volume refresh each get an acceptance criterion.
- Each sandbox has a separate test DB `log_hub_<name>_test`, mirroring the host runner/dev-server split.
- No WebStorm MCP in a sandbox: it works on the main checkout, which the sandbox must not touch.
- The PoC disables `log-hub-hooks` in the sandbox (no server, no hook changes).
- The readiness wait is bounded; on timeout Claude opens anyway with a telemetry-off warning.
- Prune never touches a container with a live `claude` process; `--include-running` adds only idle running ones.
- The sandbox state file is the source of truth for ports; slot allocation is guarded by a lock file.
- Sandbox names match `^[a-z0-9][a-z0-9-]{0,39}$` and cannot end in `-test`, so DB names never collide.
- Prune maps a `log_hub_*` DB to a sandbox only by exact `log_hub_<n>` / `log_hub_<n>_test` match.
- The generated sandbox `server/.env` is `AUTH_MODE=none`, `COOKIE_SECURE=false`, `PORT=3000`.
- Root `node_modules` uses `npm ci` from `package-lock.json`; the root `bun.lock` is ignored.
- Container git settings live in the image gitconfig and `GIT_CONFIG_*` env; the shared `.git/config` is never written.
- The host creates worktrees with `--relative-paths` and `-c core.autocrlf=input` (LF files, no host config change).
- The hook root override applies in `resolveRootFromCommonDir`, so `getGitRoot` and `getGitContext().root` agree.
- `--remove` runs all refusal checks before any destructive step.
- The state file records `branchCreated` and the base branch; prune deletes only launcher-created branches; no base → has work.
- "Merged" is checked against the base branch's current tip.
- `--stop`/`--remove` refuse with live `claude` sessions unless `--force`; menu `T`/`D` confirm naming them.
- A re-launch that disagrees with the state file fails with a message instead of silently re-creating or re-allocating.
- `typescript-lsp` is installed per sandbox on each start (warn on failure); the PoC disables it.
- `--serve` and `--reset` stay CLI-only; the menu follows the approved prototype.
- The `--list`, test-DB, host-side compose, menu and LSP behaviours each get an acceptance criterion.

## Notes

<!-- Append timestamped notes here as work progresses -->
History (merged drafts, scope changes) and the worktree side discussion are in `notes.md`.
