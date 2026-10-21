# Implementation plan — 2026-10-15 Claude Code Dev Container

## TL;DR

- **Delivery in two parts.** Chunks 1–7 are the **Phase 1 PoC**, a review sandbox: slim image, no DB, no ports, no hook. Chunks 8–17 are **Phase 2**, which extends the same files. Phase 1 must pass its own acceptance criteria before chunk 8 starts.
- **New launcher** `scripts/claude-docker.mjs` (ESM, Node built-ins only) plus modules in `scripts/claude-docker/`:
  - `config`, `state`, `git`, `docker`, `sandbox`, `prune`, `menu`;
  - thin `.ps1`/`.cmd` wrappers.
- **New image tree** `docker-dev/`:
  - `Dockerfile`, an allow-list `Dockerfile.dockerignore`, `entrypoint.sh`, `devctl`, `provision.mjs`, `npx.cmd`, `settings.template.json`, `gitconfig`, `CLAUDE.container.md`;
  - downloads are verified against pinned sha256 values, git comes from the signed git-core PPA, no Python.
- **New local infra** `local-run/docker-compose.yml`:
  - `log-hub-postgres` (postgres 18.4, external volume `log-hub-pgdata`, `max_connections=300`) and `log-hub-mailpit` on network `log-hub-net`;
  - deletes `server/artisyn-log-run-local/docker-compose.yml` and `tests/scenarios/docker-compose.yml`, plus a 13-file reference sweep.
- **Hook change (blast radius: every hook install):**
  - new env override `ARTISYN_PROJECT_ROOT`, applied in `resolveRootFromCommonDir` only when the cwd is inside that root;
  - unset means byte-identical behaviour;
  - hook 2.22.2 → **2.23.0**, plus the installer rebuild and the dogfood copy.
- **Test-runner change:** new env `TEST_DATABASE_URL`, which wins over `DATABASE_URL` in `scripts/scenarios/run.mjs` and the contract `global-setup.ts`.
- **Installer refactor:** `OTEL_ENV_KEYS`/`OTEL_ENDPOINT_KEYS` move to a pure `artisyn-hooks-installer/src/otel-env.ts`, imported by `install.ts` and by `provision.mjs` at runtime (Node type stripping).
- **Tests:**
  - new algorithm doc `docs/knowledgebase/algorithms/sandbox-prune-classification.md` with its table test `scripts/__tests__/sandbox-prune.algo.test.js`;
  - new steps in scenario `@S-HOOK-01`;
  - scenario helpers `hook-process.ts`/`installer.ts` blank `ARTISYN_PROJECT_ROOT`.
- **Small edits:**
  - `client/vite.config.ts` gets `server.host` from the env `LOG_HUB_VITE_HOST`;
  - the launcher generates a per-sandbox `server/.env`;
  - installer patch bump;
  - `.gitignore` and `server/stryker.config.json` lose the old compose path;
  - new KB article `docs/knowledgebase/docker-dev-container.md`;
  - no DB schema change, no new API route, no new npm package.

## Reference

Requirements: [requirements.md](requirements.md) · research trail: `research/findings-1.md` · approved
menu PoC: `docs/pocs/2026-10-21-1316-sandbox-menu-tui/menu.js` · wireframes: `wireframes/*.svg`.

## Design Decisions

### DD-1 Phasing
- Phase 1 is a milestone, not a long-lived mode. Phase 2 chunks replace the PoC-only behaviour:
  - the plugin-disable override;
  - the review-only guide;
  - the slim image.
- State files carry `"v": 1` (PoC: `ports: null`) or `"v": 2`.
- Phase 2 refuses to start a `v: 1` sandbox and hints `--remove <name>`, so a re-launch never silently diverges.

### DD-2 Script conventions
- The launcher is ESM `.mjs` because FR-B5 names it. This deviates from the `nodejs-script` skill, the same way `scripts/scenarios/*.mjs` and the PoC already do.
- All git/docker calls are synchronous `spawnSync` through one `run(cmd, args, opts)` helper that throws on a non-zero exit (pattern: `.claude/skills/big-prod-e2e-test/scripts/lib/proc.mjs:19`).
- Only these are async: the menu keypress loop, the port-bind probe and the readiness poll.
- No machine paths: everything is derived from `git rev-parse --show-toplevel`, `process.env` and `os.tmpdir()` (FR-B9).

### DD-3 Names and identifiers (single table, used by every chunk)

| Thing | Value |
|---|---|
| Name rule | `^[a-z0-9][a-z0-9-]{0,39}$` and not ending in `-test` |
| Container / hostname | `log-hub-dev-<name>` / `<name>` |
| Image | `log-hub-dev:latest`, label `log-hub.dev-image-hash=<sha256>` |
| Labels on the container and every per-sandbox volume | `log-hub.sandbox=<name>` |
| Per-sandbox volumes | `log-hub-dev-<name>-nm-root`, `-nm-client`, `-nm-server`, `-nm-hook`, `-nm-installer`, `-plugins` |
| Shared cache volumes (label `log-hub.shared=true`, never removed) | `log-hub-dev-cache-npm`, `log-hub-dev-cache-bun`, `log-hub-dev-cache-playwright` |
| DBs (`-` → `_`) | `log_hub_<name_>`, `log_hub_<name_>_test` |
| Docker network | `log-hub-net` |
| Worktrees dir | env `CLAUDE_DOCKER_WORKTREES_DIR`, else `<repoParent>/<repoName>-worktrees` |
| State | `<worktreesDir>/.sandboxes/<name>/state.json`; lock `<worktreesDir>/.sandboxes/.lock` |
| Stale threshold | env `CLAUDE_DOCKER_STALE_AFTER`, age syntax `^\d+(m\|h\|d)$`, default `7d` (same parser as `--older-than`) |
| Setup timeout (entrypoint done) | env `CLAUDE_DOCKER_SETUP_TIMEOUT_S`, default `900` |
| Readiness timeout (provisioned) | env `CLAUDE_DOCKER_READY_TIMEOUT_S`, default `180` |
| Port slot `n` (from 0) | server `3100+10n`→`3000`, client `5200+10n`→`5173`, mailpit `8100+10n`→`8025`, all on `127.0.0.1` |
| In-container markers | `/run/dev/entrypoint-done`, `/run/dev/provisioned` (both deleted at entrypoint start) |
| Timing constants (in `config.mjs`) | lock retry 200 ms / give-up 30 s / stale-report 10 min; `docker stop -t 30`; infra health poll 120 s; marker poll 1 s |
| Timing constants (container) | provision loop 10 s; devctl stop grace 10 s |
| Container user / CLAUDE_CONFIG_DIR | `dev` (uid 1000) / `/home/dev/.claude-home` (bind of host `<repo>/docker-dev/claude-home`); `-plugins` volume at `/home/dev/.claude-home/plugins` |

Name lengths at the 40-character maximum:
- DB: 53 characters, within Postgres' 63;
- container: 52 characters;
- longest volume (`-nm-installer`): 65 characters.

### DD-4 State file schema
`state.json` fields:
- `v`, `name`, `branch`, `branchCreated`;
- `base`: a branch name or `null`;
- `createdFrom`: the sha of the branch tip right after creation;
- `slot` and `ports {server, client, mailpit}`: `null` in v1;
- `worktree`: the host path;
- `createdAt`, `lastActivity`: ISO strings.

Rules:
- **Writes are atomic:** write a tmp file, then rename.
- **The lock** is `fs.openSync(lock, 'wx')` holding `{pid, at}`.
  - The launcher retries every 200 ms for up to 30 s.
  - A lock older than 10 min is reported with its path, never auto-deleted.
  - It is held across worktree creation, DB creation, slot choice and the state write (FR-W6/W7).
- **A slot is free** when no state file claims it and `net.createServer().listen(port,'127.0.0.1')` succeeds for all three ports.
- **`lastActivity`** is updated at the start and end of every Claude session and every `--shell`.

### DD-5 Base branch and pending work
**Base branch**
- With `--from <local branch>`, the base is that branch.
- With no `--from`, a new branch's base is `git branch --show-current` of the main checkout.
- In every other case the base is `null`: existing branch, tag/sha `--from`, detached HEAD.

**Pending work**
- Changed files = the line count of `git -C <wt> status --porcelain`.
- Unmerged commits:
  - with a base: `git rev-list --count <base>..<branch>`;
  - without one: commits of `<branch>` not reachable from any other local branch.

**Merged and display text**
- "Merged" = `git merge-base --is-ancestor <branch> <base>`, checked against the base's current tip.
- Display text: tip == `createdFrom` gives `no changes, no commits`; otherwise `merged into <base>`.

### DD-6 Prune classification (pure function, the algorithm doc's subject)
`classifyPruneCandidate(s, opts)` returns one of:
- `not-candidate`: running and not `includeRunning`, or not older than `olderThan`;
- `live-session`: `liveSessions > 0`, never removed;
- `remove`: clean, `base` set and `isAncestor`; `deleteBranch = branchCreated`;
- `keep-has-work`: anything else, without `force`;
- `remove-force`: has work and `force`; `deleteBranch = false`.

**Orphans**
- Let N = the state-file names ∪ the worktree dir names.
- A name with a state file but no worktree is an orphan sandbox. It gets the full removal steps; its branch is deleted only if `branchCreated`, via `git branch -d`, which refuses an unmerged branch with a warning.
- Containers and volumes whose `log-hub.sandbox` label is not in N are removed.
- A DB is dropped only if it is exactly `log_hub_<n>` or `log_hub_<n>_test` for an orphan name n.
- A worktree without a state file is never removed; it is listed as "kept: run `--remove <name>`".

### DD-7 Container mount layout (FR-W3)
- **Container paths.** C is the deepest common ancestor of the repo root and the worktrees dir. The main repo's `.git` is mounted at `/work/<rel(C,repo)>/.git` and the worktree at `/work/<rel(C,wt)>`, both read-write, with POSIX separators. This keeps the relative gitdir links resolving. The launcher refuses to run if the two paths are on different drives.
- **Other mounts:**
  - `<repo>/docker-dev/claude-home` → `/home/dev/.claude-home`, read-write;
  - host `os.tmpdir()` → `/host-tmp`, read-only, plus env `HOST_TEMP=<host path>`.
- Nothing else from the host file system is mounted, and there is no Docker socket.
- **Named volumes** (no host paths). `<cwt>` is the container worktree path.

| Volume | Container path | Phase |
|---|---|---|
| `-plugins` | `/home/dev/.claude-home/plugins` | 1 |
| `-nm-root` | `<cwt>/node_modules` | 2 |
| `-nm-client` | `<cwt>/client/node_modules` | 2 |
| `-nm-server` | `<cwt>/server/node_modules` | 2 |
| `-nm-hook` | `<cwt>/hook/node_modules` | 2 |
| `-nm-installer` | `<cwt>/artisyn-hooks-installer/node_modules` | 2 |
| `log-hub-dev-cache-npm` | `/home/dev/.npm` | 2 |
| `log-hub-dev-cache-bun` | `/home/dev/.bun` | 2 |
| `log-hub-dev-cache-playwright` | `/home/dev/.cache/ms-playwright` | 2 |

### DD-8 Container env (set by `docker run -e`)
**Phase 1**
- `SANDBOX_NAME`, `SANDBOX_WORKTREE` (container path), `CLAUDE_CONFIG_DIR`, `HOST_TEMP`.
- `GIT_CONFIG_COUNT=6` with:
  - `core.autocrlf=input`, `core.filemode=false`, `core.ignorecase=false`, `worktree.useRelativePaths=true`;
  - `user.name` and `user.email` from the host `git config`.

**Phase 2 adds**
- `ARTISYN_PROJECT_ROOT=<container worktree>`;
- `DATABASE_URL=postgresql://postgres:pw@localhost:5432/log_hub_<name_>`;
- `TEST_DATABASE_URL=…/log_hub_<name_>_test`;
- `LOG_HUB_VITE_HOST=0.0.0.0`;
- `SANDBOX_HOST_EMAIL` = the host `git config user.email`.

The launcher refuses to create or start a sandbox while the host `user.name` or `user.email` is empty, and names the missing key.

**Accepted side effect.** `GIT_CONFIG_*` outranks repo-local config, so hook scenarios' fake repos run with `autocrlf=input` inside a sandbox. That is harmless because they write LF files.

**Image `/etc/gitconfig`:** `safe.directory=*` (container-only).

### DD-9 Hook root override (FR-C2)
- New `hook/.claude/telemetry_tool/project-root-override.js` exports `projectRootOverride(cwd, env = process.env)`. It mirrors `claude-config-dir.js:21`.
- It returns `path.normalize(path.resolve(v))` only when `v = env.ARTISYN_PROJECT_ROOT.trim()` is non-blank and `path.relative(root, path.resolve(cwd))` neither starts with `..` nor is absolute. Otherwise it returns `null`.
- `resolveRootFromCommonDir` (`git-context.js:49`) returns the override first, so `getGitRoot`, `getGitContext().root` and `getWorkDirPath` agree.
- Because of the cwd-inside rule, child processes in fixture repos outside the worktree (scenarios, corpus, big-prod-e2e) are unaffected even though the variable is container-wide.
- **Expected consumer behaviour with the override:**
  - `env-context.js:261,296` read the worktree's `.artisyn/config`;
  - `session-files.js:223` slug = the worktree path = Claude's own project slug;
  - `otel-register.js:88` and `otel-endpoint-check.js:80` owner = the worktree;
  - `send-logs-hook.js:945,1211,1318`, `post-turn-analysis-worker.js:434` (skill catalog) and `code-inventory.js` operate on the worktree, which is a valid git dir;
  - the `getGitContext` users (`lifecycle-hook.js:70`, `telemetry-hook.js:69`, `post-turn-analysis-hook.js:79`, `post-turn-analysis-worker.js:1716`) upload `root == worktreeRoot`.

### DD-10 Test-DB variable (FR-W4)
- `TEST_DATABASE_URL` has precedence `TEST_DATABASE_URL || DATABASE_URL || default`. It applies in two places:
  - `scripts/scenarios/run.mjs:376`, extracted as exported `resolveRunnerDatabaseUrl(env)`;
  - `server/test/contract/setup/global-setup.ts:43-45`, through `envBeforeAppModule`.
- Legacy e2e and the dev backend keep `DATABASE_URL`, which is the live DB.
- On the host neither variable is set, so nothing changes.

### DD-11 Postgres sizing
- Set `max_connections=300`. Computed need: 50 per sandbox × 3 sandboxes, plus the host dev server's 20, gives 170; 300 leaves headroom for the MCP servers and a fourth sandbox.
- No other tuning.

### DD-12 Image build
- **Build call.** `docker build -f docker-dev/Dockerfile -t log-hub-dev:latest --label log-hub.dev-image-hash=<h> docker-dev`. The context is `docker-dev/`, and `docker-dev/Dockerfile.dockerignore` starts with `*` and re-includes only the files listed in DD-3/TL;DR, so `claude-home/` is never sent.
- **Image file list.** One constant `IMAGE_FILES` in `scripts/claude-docker/config.mjs` must equal the `!` entries of the dockerignore.
  - Phase 1: `Dockerfile`, `Dockerfile.dockerignore`, `entrypoint.sh`, `settings.template.json`, `gitconfig`, `CLAUDE.container.md`.
  - Phase 2 adds `devctl`, `provision.mjs`, `npx.cmd`.
- **Hash** `h` is the sha256 over `IMAGE_FILES` sorted, each as `relpath\0content`. The dockerignore itself is included.
- **Pinned ARGs**, all with sha256 except where noted:
  - `NODE_VERSION=24.18.1` (verified against the official `SHASUMS256.txt` value pinned as an ARG), `NPM_VERSION=11.16.0`;
  - `BUN_VERSION=1.3.14`;
  - `MAILPIT_VERSION` (the same tag as the compose image);
  - `CHROME_VERSION` (versioned pool `.deb` URL);
  - `CLAUDE_VERSION`: verified against `platforms["linux-x64"].checksum` of its release `manifest.json`, from the dist bucket URL copied from the official `install.sh`;
  - `PLAYWRIGHT_VERSION`: the root `package-lock.json` version, installed by Playwright's own installer;
  - `TS_LS_VERSION` and `TYPESCRIPT_VERSION` (npm global).
- **Choosing pins.** Every unpinned version takes the latest stable release at implementation time. Its sha256 is copied from the vendor's official checksum source:
  - Node `SHASUMS256.txt`;
  - the bun and Mailpit GitHub release checksums;
  - for Chrome, the sha256 of the versioned `.deb` from Google's apt `Packages` index.
- The git-core PPA signing-key fingerprint is copied from its Launchpad page into `ARG GIT_PPA_KEY_FPR`.
- The compose Mailpit tag equals `MAILPIT_VERSION`.
- **Stages.** Parallel BuildKit `fetch-*` stages (`aria2c -x16 -s16`, then `sha256sum -c`), and a `chrome-debs` stage on `ubuntu:24.04` running `apt-get install --download-only ./chrome.deb libasound2t64`.
- **git** comes from `ppa:git-core/ppa`, added manually: a `signed-by` keyring imported with `gpg` and checked against the PPA key fingerprint, because `add-apt-repository` pulls in Python.
- **Final assertions:** `git --version` ≥ 2.48 and `! command -v python3`.
- **Image paths:**
  - `entrypoint.sh` → `/usr/local/bin/entrypoint.sh`;
  - `settings.template.json` and `provision.mjs` → `/opt/log-hub-dev/`;
  - `devctl` and `npx.cmd` → `/usr/local/bin/`;
  - `gitconfig` → `/etc/gitconfig`;
  - `CLAUDE.container.md` → `/etc/claude-code/CLAUDE.md`.
- **Claude layout** is the same as `claude install`: `/home/dev/.local/share/claude/versions/<v>`, with the symlink `/home/dev/.local/bin/claude` on `PATH`.

### DD-13 In-container services (FR-W5)
**`devctl`** (bash, `/usr/local/bin/devctl`) supports `start|stop|restart|status|logs <server|client|mailpit|provision|all>`.

| Service | Command |
|---|---|
| server | `cd $SANDBOX_WORKTREE/server && npm run start:dev` |
| client | `cd client && bun run dev` |
| mailpit | `mailpit --smtp 127.0.0.1:1025 --listen 0.0.0.0:8025` |
| provision | `node /opt/log-hub-dev/provision.mjs --loop` |

**Process handling**
- Each service runs under `setsid` as `dev`, with a pid file `/run/dev/<svc>.pid` and a log appended to `/var/log/dev/<svc>.log`.
- `stop` sends TERM to the process group, waits 10 s, then sends KILL.
- `status` checks the pid and probes the service: `GET :3000/api/v1/auth/config`, `GET :5173/`, `GET :8025/`.
- `logs` is `tail -n 200 -f`.
- PID 1 is `docker run --init` (tini). The entrypoint ends with `exec sleep infinity`.
- **socat:** `socat TCP-LISTEN:5432,bind=127.0.0.1,fork,reuseaddr,nodelay TCP:log-hub-postgres:5432,nodelay`, started by the entrypoint and logged to `/var/log/dev/socat.log`.

### DD-14 Entrypoint order (`docker-dev/entrypoint.sh`, root)
1. `rm -f /run/dev/*` markers; `chown dev` on the volumes and `/run/dev`, `/var/log/dev`.
2. *(Phase 2)* Start socat.
3. *(Phase 2)* Refresh `node_modules` per FR-B2. The volume's `.lockhash` = `sha256sum <lockfile>`; when it is empty or differs, run `npm ci` or `bun install --frozen-lockfile` as `dev`, logged to `/var/log/dev/install.log`.
4. Merge settings: `jq -s '.[0] * .[1]' /opt/log-hub-dev/settings.template.json $CLAUDE_CONFIG_DIR/settings.json` (user keys win). The template only sets container defaults.
5. Plugins, as `dev`, idempotent:
   - `claude plugin marketplace add $SANDBOX_WORKTREE/.artisyn/marketplace`;
   - `claude plugin install <id> --scope project` for every `true` key of the worktree's `.claude/settings.json` `enabledPlugins` (read with `jq`) whose marketplace part is the project marketplace's `name` from `.artisyn/marketplace/.claude-plugin/marketplace.json`. Other marketplaces' ids are skipped here;
   - *(Phase 2)* also `claude plugin marketplace add anthropics/claude-plugins-official` and install `typescript-lsp@claude-plugins-official`; a failure logs `WARN` and continues;
   - then `git -C $SANDBOX_WORKTREE diff --quiet -- .claude/settings.json`; a diff logs `WARN`.
6. *(Phase 1 only)* Merge `{"enabledPlugins":{"log-hub-hooks@artisyn-e798dd87":false,"typescript-lsp@claude-plugins-official":false}}` into the worktree's git-ignored `.claude/settings.local.json`. *(Phase 2)* Delete exactly those two keys instead.
7. *(Phase 2)* MCP: `claude mcp add --scope local postgres` with the tracked `.mcp.json` postgres args, `npx.cmd`→`npx` and DB `/log_hub_<name_>`. `/usr/local/bin/npx.cmd` is a shim that runs `exec npx "$@"`.
8. *(Phase 2)* `node /opt/log-hub-dev/provision.mjs --static`, then `devctl start all`.
9. `touch /run/dev/entrypoint-done`; `exec sleep infinity`.

### DD-15 Provisioning (`docker-dev/provision.mjs`, FR-C3)

**`--static`** writes only git-ignored files, preserving all other keys:
- `.artisyn/config/otel-port.json` `{"port":P,"allocatedAt":ISO}`, where P = the tracked `log-hub.json` `otelReceiverPort`, so there is no allocation. Each container has its own loopback.
- `OTEL_ENV_KEYS(P)` merged into `.claude/settings.local.json` `env`, imported from `$SANDBOX_WORKTREE/artisyn-hooks-installer/src/otel-env.ts`.

**`--loop`**, every 10 s:
1. If `GET 127.0.0.1:3000/api/v1/auth/config` is not 200, skip this round.
2. If `log-hub.local.json` has an `apiKey` and `POST /api/v1/log-echo` with header `X-API-Key` (body `{}`) returns 2xx, touch the marker and skip.
3. Otherwise:
   - `POST /api/v1/auth/identify {"email":$SANDBOX_HOST_EMAIL}` and keep its `set-cookie`;
   - `POST /api/v1/api-keys {"name":"sandbox-<name>"}` with that cookie and read the response `.key`;
   - write `log-hub.local.json` `{"apiKey":key}`;
   - touch `/run/dev/provisioned`.
4. Log every round's result to the provision log.

### DD-16 Launcher command flow
**`claude-docker <name> [--branch b] [--from ref] [--continue|--resume]`**
1. Check prerequisites: git ≥ 2.48, `docker info`.
2. Validate the name.
3. *(Phase 2)* `docker volume create log-hub-pgdata`, `docker compose -f local-run/docker-compose.yml up -d --no-recreate`, then wait for healthy.
4. Under the lock:
   - reconcile with the state file (DD-1 and FR-W7 re-launch rules);
   - create the worktree (`git -c core.autocrlf=input worktree add --relative-paths …`);
   - *(Phase 2)* generate `server/.env` (`AUTH_MODE=none`, `COOKIE_SECURE=false`, `PORT=3000`), create both DBs idempotently, allocate the slot;
   - write the state.
5. Build the image if it is missing; warn about a stale hash.
6. `docker run`, or `docker start`, or nothing if the container is already running.
7. Wait for the markers, showing progress.
8. Print the URLs.
9. Run `docker exec -it -u dev -w <cwt> log-hub-dev-<name> claude --dangerously-skip-permissions [flags]` with `stdio: 'inherit'`.
10. Update `lastActivity`.
11. Print the stale reminder (FR-E4) on every launch.

**Live sessions** = the line count of `docker exec <c> pgrep -x claude`.

**Re-launch rules (FR-W7)**, checked under the lock before any change:

| Situation | Result |
|---|---|
| `--branch`/`--from` differ from the state | Exit 1: `<name> was created with --branch X --from Y; drop the flags or use another name` |
| `--branch`/`--from` match the state | Note `ignored: matches state`, continue |
| State file but no worktree | Exit 1: `worktree missing; run --remove <name> or --prune` |
| Worktree but no state file | Exit 1: `worktree without state; run --remove <name> or --prune` |
| Kept port not bindable | Exit 1, naming the port, with no re-allocation |

**`--remove` order (FR-E1).** All checks run first:
- live sessions (unless `--force`);
- `git status --porcelain` non-empty (unless `--force`);
- with `--delete-branch`, the branch is not merged into its base (unless `--force`).

Then:
1. `docker stop` + `docker rm`;
2. remove the `nm-*` and `-plugins` volumes;
3. `dropdb --force` both DBs;
4. `git worktree remove [--force]`, then `git worktree prune`;
5. delete the state dir;
6. with `--delete-branch`, `git branch -d`.

Every step tolerates the resource already being gone.

**Acceptance checklists.** Chunks 7 and 17 verify against requirements.md, sections "PoC acceptance criteria" and "Acceptance Criteria". Those lists are the source and are not copied here.

## Files to create/modify

| Path | Purpose | Note |
|---|---|---|
| `docker-dev/Dockerfile` | Dev image | Slim in Phase 1, full in Phase 2 (DD-12) |
| `docker-dev/Dockerfile.dockerignore` | Allow-list build context | DD-12 |
| `docker-dev/entrypoint.sh` | Container start | DD-14 |
| `docker-dev/devctl` | Service supervisor CLI | Phase 2, DD-13 |
| `docker-dev/provision.mjs` | Hook provisioning | Phase 2, DD-15 |
| `docker-dev/npx.cmd` | `npx.cmd` → `npx` shim for Playwright MCP | Phase 2, DD-14 step 7 |
| `docker-dev/settings.template.json` | Claude profile defaults | Merged by the entrypoint |
| `docker-dev/gitconfig` | Image `/etc/gitconfig` | `safe.directory=*` |
| `docker-dev/CLAUDE.container.md` | Managed policy → `/etc/claude-code/CLAUDE.md` | PoC review-mode text, then the Phase 2 guide |
| `docker-dev/claude-home/` | Shared Claude profile | Git-ignored, created by the launcher |
| `scripts/claude-docker.mjs` | CLI entry, argv parse, dispatch | |
| `scripts/claude-docker/config.mjs` | DD-3 names, paths, age parser, name validation | Pure |
| `scripts/claude-docker/state.mjs` | State file, lock, slot allocation | DD-4 |
| `scripts/claude-docker/git.mjs` | Worktree/branch ops, pending work, merged check | DD-5 |
| `scripts/claude-docker/docker.mjs` | `run()`, docker/compose/psql/volume helpers, image hash | |
| `scripts/claude-docker/sandbox.mjs` | create/start/session/shell/stop/remove/list/serve/reset | DD-16 |
| `scripts/claude-docker/prune.mjs` | `classifyPruneCandidate`, plan, orphans, execution | DD-6 |
| `scripts/claude-docker/menu.mjs` | FR-W8 TUI | Ported from the PoC |
| `scripts/claude-docker.ps1`, `scripts/claude-docker.cmd` | Thin wrappers | |
| `local-run/docker-compose.yml` | Shared Postgres + Mailpit | Phase 2 |
| `server/artisyn-log-run-local/docker-compose.yml`, `tests/scenarios/docker-compose.yml` | **Delete** | FR-A1/A5 |
| `hook/.claude/telemetry_tool/project-root-override.js` | Root override helper | DD-9 |
| `hook/.claude/telemetry_tool/git-context.js` | Use the override in `resolveRootFromCommonDir` | :49 |
| `hook/.claude/telemetry_tool/version.json` | 2.23.0 | |
| `.artisyn/marketplace/plugins/log-hub-hooks/scripts/*`, `.claude-plugin/plugin.json` | Dogfood refresh | `.claude/rules/hook.md` |
| `hook/INSTALL_HOOK.md` | Via the `update-install-instructions` skill | |
| `artisyn-hooks-installer/src/otel-env.ts` | Pure `OTEL_ENV_KEYS`, `OTEL_ENDPOINT_KEYS` | Erasable TS syntax only |
| `artisyn-hooks-installer/src/install.ts` | Import and re-export from `otel-env.ts` | :1543, :1559 |
| `artisyn-hooks-installer/package.json` | Patch bump | `.claude/rules/installer.md` |
| `scripts/scenarios/run.mjs` | `resolveRunnerDatabaseUrl` (DD-10) | :376 |
| `server/test/contract/setup/global-setup.ts` | `TEST_DATABASE_URL` precedence | :43-45 |
| `client/vite.config.ts` | `server.host: process.env.LOG_HUB_VITE_HOST \|\| undefined` | :20-26 |
| `tests/scenarios/helpers/hook-process.ts` | Blank `ARTISYN_PROJECT_ROOT` in `fakeHomeEnv` | :173 |
| `tests/scenarios/helpers/installer.ts` | Blank `ARTISYN_PROJECT_ROOT` in the child env | :85 |
| `tests/scenarios/hook/s-hook-01.spec.ts` | Override steps | Scenario |
| `docs/knowledgebase/algorithms/sandbox-prune-classification.md` | New algorithm doc | DD-6 |
| `scripts/__tests__/sandbox-prune.algo.test.js` | Its table test | `npm run test:scripts` |
| `docs/knowledgebase/algorithms/README.md` | Row for the new doc | |
| `docs/knowledgebase/docker-dev-container.md` + `index.md` | New KB article | FR-D2 |
| `docs/knowledgebase/hook-system-overview.md`, `hook-api-versioning.md`, `legacy-design-decisions-map.md` | Override documentation | :40-99, :349-367, :110 |
| `docs/knowledgebase/test/scenarios.md`, `test/contract-tests.md` | Compose path, `TEST_DATABASE_URL` | |
| Reference sweep | Old compose paths → `local-run/` | Chunk 9 list |
| `.gitignore` | `docker-dev/claude-home/`; drop the `artisyn-log-run-local` lines | FR-D1 |
| `CLAUDE.md`, `.claude/repo_config/repo-health-checks.json`, `README.md` | Compose command, launcher, environment note | FR-D2/D3 |

## API changes

None. Provisioning uses existing routes:
- `POST /api/v1/auth/identify`;
- `POST /api/v1/api-keys` (`{name}` returns `{…, key}`);
- `POST /api/v1/log-echo` (`X-API-Key`);
- `GET /api/v1/auth/config`.

## Database changes

No schema or migration change.

**Per-sandbox databases** `log_hub_<name_>` and `log_hub_<name_>_test`:
- created with `docker exec log-hub-postgres createdb -U postgres <db>` after a `psql -tAc "select 1 from pg_database where datname='<db>'"` existence check;
- dropped with `dropdb -U postgres --if-exists --force <db>`.

**Shared cluster**
- The cluster moves to the external volume `log-hub-pgdata`.
- `a-log` is created from scratch (`POSTGRES_DB`) and migrated by the server on startup.
- Old data is not migrated (FR-D4).

## Test coverage plan

Per the CLAUDE.md test policy.

**Algorithm**
- New doc `docs/knowledgebase/algorithms/sandbox-prune-classification.md` (DD-6), with one examples row per AC prune state:
  - running with a session;
  - stopped merged;
  - stopped with no commits;
  - uncommitted changes;
  - unmerged commits;
  - no base;
  - `--force`;
  - `--include-running` idle;
  - `--older-than` not reached.
- New table test `scripts/__tests__/sandbox-prune.algo.test.js`, using `scripts/algo-docs/load-examples.cjs` like the hook `.algo.test.js` files. It runs in `npm run test:scripts`; the existing `algo-docs.test.js` validates the doc's format.

**Scenario**
- Extend `tests/scenarios/hook/s-hook-01.spec.ts` (`@S-HOOK-01`, mode a) with three steps:
  - in a linked worktree of the fake repo with `ARTISYN_PROJECT_ROOT` = the worktree, the hook reads the worktree's `.artisyn/config`, writes the worktree's `.artisyn/ai_work_dir`, and the upload has `git.root` == the worktree;
  - with the variable unset, the same worktree resolves to the main fake repo, as before;
  - with the variable set to a directory that does not contain the cwd, it is ignored.

**API contract:** none; no route changes.

**Scenario-coverage target.** `scripts/claude-docker/*` (except the prune classifier), `resolveRunnerDatabaseUrl` and the `docker-dev/` files are dev tooling outside the server/client/hook code that the ≥ 80 % scenario-coverage target measures.

**Manual acceptance (not automated tests).** Docker, git and the TUI cannot run in any allowed suite:
- the Phase 1 PoC acceptance criteria at the end of chunk 7;
- the requirements' acceptance criteria at the end of chunk 17, including the full set inside a sandbox (`contract`, `scenarios-a/b/c`, `e2e-fast`, `e2e-full`).

## Visual/UX notes

**Menu** (`menu.mjs`): a faithful port of the PoC renderer:
- `pad()` (ANSI-aware), `ago()`, `renderList`, `renderBox`;
- colours: running green, stale amber `⚠`, merged green, work cyan;
- alternate screen `?1049h`, hidden cursor;
- non-TTY: print the PoC hint and exit 1.

Changes from the PoC:
- **Removed:** the `M` key, the merge dialogs and the "M merge" prune hint. The prune hint reads `→ merge outside · F removes anyway, keeps branch`.
- **Footer:** `↑↓ Enter R S T D P Q`; on the "+ New sandbox" row, `↑↓ Enter create P Q`.
- **Detail block:**
  - `branch X ← base · container log-hub-dev-X`;
  - the worktree path from config;
  - *(Phase 2)* `app http://localhost:<client> · api :<server> · mailpit :<mailpit> · db log_hub_X <size>`, or `ports a · b · c (stopped)` when the sandbox is stopped.
- **New-sandbox input:** the full DD-3 name rule; errors `only a-z, 0-9 and "-"`, `max 40 characters`, `must not end in -test`, `a sandbox named X already exists`. Then optional branch and base-ref prompts (Enter = default).
- **Refusal box** (red): the git message, any key closes.
- **Confirmations** (amber) name the lost work and the live sessions for `T`/`D`.
- **Prune screen:** title `✻ Prune plan · candidates: stopped / missing containers`, then the "Will remove" and "Will keep" sections. Live sessions show `never pruned, even with F`. Prompt: `y / F / Esc`. After it runs, the list shows `✓ pruned N sandbox(es)`.
- **Session keys** (Enter/R/S) restore the screen, then run the same `docker exec` as the CLI and exit to the shell when it ends.

## Wireframes

No changes needed. The three SVGs already match DD-3/DD-16, and the PoC deviations above are code-only.

## Implementation Chunks

Order: each phase follows Services → Frontend (menu) → Tests/docs on its own. Phase 1 closes with its tests and acceptance (chunk 7) before Phase 2 starts (DD-1).

| # | Chunk | Items | Notes |
|---|-------|-------|-------|
| 1 | PoC image | 6 | Phase 1; no repo deps |
| 2 | Launcher core: config, state, git | 6 | Pure + git helpers used by all commands |
| 3 | Launcher docker helpers and create/start/session | 6 | Needs 1–2 |
| 4 | Launcher stop/shell/list/remove | 5 | Needs 3 |
| 5 | Prune, stale reminder, wrappers | 6 | Needs 4 |
| 6 | Interactive menu | 6 | Needs 3–5 (same code paths) |
| 7 | PoC tests, docs and acceptance | 5 | Phase 1 sign-off |
| 8 | Local infra compose | 6 | Phase 2 start |
| 9 | Reference sweep for the old composes | 6 | Needs 8 |
| 10 | Hook root override | 7 | Independent of 8–9 |
| 11 | Test-DB variable, Vite host, installer otel-env | 6 | Needed by 13–14 |
| 12 | Full image | 6 | Extends chunk 1 |
| 13 | Container runtime: devctl, entrypoint, provisioning | 8 | Needs 10–12 |
| 14 | Launcher Phase 2: infra, DB, ports, readiness | 7 | Needs 8, 13 |
| 15 | Launcher Phase 2: serve, reset, list, remove, prune, menu | 6 | Needs 14 |
| 16 | Tests | 4 | Needs 10, 15 |
| 17 | Docs and final acceptance | 7 | Last |

### Chunk 1 — PoC image
- [ ] Create `docker-dev/Dockerfile` (slim, per DD-12 minus Chrome/Playwright/Mailpit/bun/socat/postgresql-client):
  - stages `fetch-node` and `fetch-claude` with sha256 verification;
  - `ubuntu:24.04`, remove user `ubuntu`, add `dev` uid 1000 with passwordless sudo;
  - `ca-certificates`, `gnupg`, `aria2`, `sudo`, `procps`, git-core PPA, `jq`, `ripgrep`;
  - COPY targets per DD-12 "Image paths" (`docker run --init` provides tini);
  - final checks for git ≥ 2.48 and no `python3`.
- [ ] Create `docker-dev/Dockerfile.dockerignore` as an allow-list (`*` then `!Dockerfile`, `!Dockerfile.dockerignore`, `!entrypoint.sh`, `!settings.template.json`, `!gitconfig`, `!CLAUDE.container.md`, matching `IMAGE_FILES`), extended for later files in chunk 12.
- [ ] Create `docker-dev/gitconfig` (`[safe] directory = *`) and copy it to `/etc/gitconfig`. Create `docker-dev/settings.template.json` as `{"skipDangerousModePermissionPrompt": true}`.
- [ ] Create `docker-dev/CLAUDE.container.md` (PoC review mode, copied to `/etc/claude-code/CLAUDE.md`):
  - Linux/bash;
  - only `docs/` may change;
  - no servers, builds or tests;
  - no git writes;
  - Docker and WebStorm MCP are unavailable;
  - translating a Windows `HOST_TEMP` path to `/host-tmp/…`.
- [ ] Create `docker-dev/entrypoint.sh` with DD-14 steps 1, 4, 5 (project plugins only), 6 (Phase 1 variant) and 9. Set it as the image `ENTRYPOINT`, running as root.
- [ ] Add `docker-dev/claude-home/` to `.gitignore` (FR-D1).

### Chunk 2 — Launcher core: config, state, git
- [ ] Create `scripts/claude-docker/config.mjs`:
  - `validateName(name)` → error text or `null`;
  - the derived-name helpers `containerName(n)`, `volumeNames(n)`, `dbNames(n)` → `[main, test]` (DD-3);
  - `resolvePaths()` (repo root via `git rev-parse --show-toplevel`, worktrees dir, state dir);
  - `parseAge('15m'|'2h'|'7d')` → ms;
  - `containerPaths()` per DD-7;
  - the env-var names and `IMAGE_FILES` (DD-12) as constants.
- [ ] Create `scripts/claude-docker/state.mjs`: `readState`, `writeState` (atomic), `listStates`, `withLock(fn)` and `allocateSlot(states)` with the async bind probe, all per DD-4.
- [ ] In `scripts/claude-docker/git.mjs`, add `assertGitVersion()` (≥ 2.48, otherwise exit with a message) and `branchExists`, `currentBranch`, `isLocalBranch`.
- [ ] In `git.mjs`, add `addWorktree({wt, branch, from, create})` running the DD-16 step 4 command. On failure, rethrow git's stderr verbatim for the "already checked out" refusal.
- [ ] In `git.mjs`, add `pendingWork(state)` → `{files, commits, merged, noCommits}` and `isMerged(branch, base)` per DD-5, plus `removeWorktree(wt, force)` and `worktreePrune()`, both tolerant of the resource being gone.
- [ ] In `git.mjs`, add `deleteBranch(branch)` (`git branch -d`, returning the refusal message rather than throwing) and `hostGitIdentity()` (`user.name`, `user.email`).

### Chunk 3 — Launcher docker helpers and create/start/session
- [ ] Create `scripts/claude-docker/docker.mjs`:
  - `run(cmd,args,opts)` (sync, throws with stderr);
  - `containerState(name)` → `running|stopped|missing`;
  - `liveSessions(name)` (DD-16);
  - `volumeCreate(name,labels)`, `volumeRemove(name)`, `containerRemove(name)`, all idempotent.
- [ ] In `docker.mjs`, add `imageHash()` (DD-12), `ensureImage({rebuild})` (build when missing or on rebuild) and `warnIfStaleImage()` (prints the `--reset` hint).
- [ ] In `docker.mjs`, add `runContainer(state, phase)`. First create `docker-dev/claude-home/` (`mkdirSync recursive`). Then `docker run -d --init` with the name, hostname, labels, DD-7 mounts, DD-8 Phase 1 env and the `-plugins` volume (created first with its label). Ports and network come in chunk 14.
- [ ] In `scripts/claude-docker/sandbox.mjs`, add `createOrStart(name, opts)` per DD-16 Phase 1. It enforces the DD-16 re-launch rules. It records `base`, `createdFrom` and `branchCreated`.
- [ ] In `sandbox.mjs`, add `waitForMarker(name, marker, timeoutS)` with one progress line per second, and `openSession(name, passthrough)`: `docker exec -it`, update `lastActivity` before and after, and return claude's exit code.
- [ ] Create `scripts/claude-docker.mjs`: parse argv (`<name>`, `--branch`, `--from`, `--continue`, `--resume`, the flags of chunks 4/5/15, `--help`), dispatch, and with no args and no TTY print the menu hint and exit 1. Unknown flags are a usage error with exit 2.

### Chunk 4 — Launcher stop/shell/list/remove
- [ ] In `sandbox.mjs`, add `shell(name)`: start the container if it is stopped, `docker exec -it -u dev -w <cwt> … bash`, and update `lastActivity`.
- [ ] In `sandbox.mjs`, add `stop(name, {force})`: refuse when `liveSessions > 0` without `--force`, naming the count; then `docker stop -t 30`.
- [ ] In `sandbox.mjs`, add `listRows()` with the FR-E6 fields available in Phase 1 (branch, base, state, sessions, last activity, pending work, worktree). `--list` prints them as an aligned table.
- [ ] In `sandbox.mjs`, add `remove(name, {force, deleteBranch})`:
  - follow the DD-16 `--remove` order (the DB step is a no-op in Phase 1);
  - when a check fails, exit non-zero listing what is pending.
- [ ] Wire `--shell`, `--stop`, `--list`, `--remove` and `--force`/`--delete-branch` in `scripts/claude-docker.mjs`.

### Chunk 5 — Prune, stale reminder, wrappers
- [ ] Create `scripts/claude-docker/prune.mjs` with pure `classifyPruneCandidate(input, opts)` exactly per DD-6. Inputs are plain values (container state, liveSessions, lastActivity, now, files, base, isAncestor, branchCreated); the function has no I/O.
- [ ] In `prune.mjs`, add `findOrphans()` per DD-6:
  - label-filtered `docker ps -a` and `docker volume ls`;
  - `psql -tAc "select datname from pg_database where datname like 'log\_hub\_%'"`, skipped in Phase 1;
  - worktree dirs plus state files.
- [ ] In `prune.mjs`, add `buildPlan(opts)` and `printPlan(plan)`, listing what is removed, kept and why, and `executePlan(plan)`, which reuses the chunk 4 `remove` steps with `force` per action.
- [ ] Add `--prune [--older-than <age>] [--force] [--yes] [--include-running]` to the CLI: print the plan, ask `y/N` on the TTY unless `--yes`, and exit 1 without a TTY and without `--yes`.
- [ ] Add `printStaleReminder()` (FR-E4), called on every launch: list the sandboxes whose `lastActivity` is older than `CLAUDE_DOCKER_STALE_AFTER` with branch, last activity and pending work, ending with `scripts/claude-docker.ps1 --prune --older-than <age>`.
- [ ] Create `scripts/claude-docker.ps1` (`node "$PSScriptRoot/claude-docker.mjs" @args; exit $LASTEXITCODE`) and `scripts/claude-docker.cmd` (`@node "%~dp0claude-docker.mjs" %*`).

### Chunk 6 — Interactive menu
- [ ] Create `scripts/claude-docker/menu.mjs`: port `pad`, `ago`, `rule`, `renderList`, `renderBox`, `footer` and `render` from `docs/pocs/2026-10-21-1316-sandbox-menu-tui/menu.js:46-181` to ESM, with data from `listRows()` and the worktree path from config. Follow Visual/UX notes.
- [ ] Remove the PoC merge parts: the `M` handler (:226-230), the footer entry (:127) and the prune hint (:170). Replace the hint text per Visual/UX notes.
- [ ] Port the list key handlers (:203-239): Enter/R/S leave the alternate screen and call `openSession`/`shell` (exit to the shell afterwards); T calls `stop`, confirming when sessions are live; D calls `remove`, confirming with lost work and sessions named; Q/Esc exit with "nothing changed".
- [ ] Port the input dialog (:241-251) with `validateName`, plus optional branch and `--from` prompts. Create calls `createOrStart` and then `openSession`. A git refusal shows the red "Create refused" box.
- [ ] Port the prune screen (:162-175, :253-263) using `buildPlan`/`executePlan` from chunk 5. `y` runs the plan, `F` runs it with force, and live-session sandboxes are listed as never pruned.
- [ ] Call the menu from `scripts/claude-docker.mjs` when there are no args and a TTY is present. Wrap rendering errors so the screen and cursor are restored before exit 1.

### Chunk 7 — PoC tests, docs and acceptance
- [ ] Create `docs/knowledgebase/algorithms/sandbox-prune-classification.md` in the README format (`reviewed: no`). Purpose and rules per DD-6; the examples block has the rows listed in the Test coverage plan.
- [ ] Create `scripts/__tests__/sandbox-prune.algo.test.js`: load the doc's examples via `scripts/algo-docs/load-examples.cjs`, dynamically import `scripts/claude-docker/prune.mjs` and assert each row. Add the doc row to `docs/knowledgebase/algorithms/README.md`.
- [ ] Create a first version of `docs/knowledgebase/docker-dev-container.md`: sandbox model, Phase 1 commands, mounts, state file, prune rules. Add it to `docs/knowledgebase/index.md`.
- [ ] Run `npm run test:scripts` and fix any failures.
- [ ] Run the Phase 1 PoC acceptance criteria from requirements.md manually (r1/r2/r3, `docker kill` plus `--continue`, the stale threshold via `CLAUDE_DOCKER_STALE_AFTER=2m`, the menu) and record the results in the task `notes.md`.

### Chunk 8 — Local infra compose
- [ ] Create `local-run/docker-compose.yml`:
  - `name: log-hub-local`;
  - service `postgres`: image `postgres:18.4`, `container_name`/`hostname` `log-hub-postgres`, env `POSTGRES_DB=a-log`/`POSTGRES_USER=postgres`/`POSTGRES_PASSWORD=pw`, command `postgres -c max_connections=300`, ports `127.0.0.1:5432:5432`, volume `log-hub-pgdata:/var/lib/postgresql`.
- [ ] Add to the postgres service: a healthcheck `pg_isready -U postgres -d a-log` (interval 5s, retries 30), `restart: unless-stopped`, `stop_grace_period: 2m`. Declare `volumes: log-hub-pgdata: {external: true, name: log-hub-pgdata}` and `networks: default: {name: log-hub-net}`.
- [ ] Add service `mailpit` to the compose file: image `axllent/mailpit:<MAILPIT_VERSION>`, `container_name`/`hostname` `log-hub-mailpit`, ports `127.0.0.1:1025:1025` and `127.0.0.1:8025:8025`, `restart: unless-stopped`. Add a header comment: run `docker volume create log-hub-pgdata` first.
- [ ] Before deleting anything, stop the old stacks: `docker compose -f server/artisyn-log-run-local/docker-compose.yml down` and `docker compose -f tests/scenarios/docker-compose.yml down` (no `-v`). Check with `docker ps` that ports 5432, 1025 and 8025 are free.
- [ ] Delete `server/artisyn-log-run-local/docker-compose.yml` and `tests/scenarios/docker-compose.yml`. Leave `server/artisyn-log-run-local/data/` for the user to delete (FR-D4) and mention it in the final report.
- [ ] Remove `server/artisyn-log-run-local` from `.gitignore:24-25` and from the `server/stryker.config.json:18` ignorePatterns.

### Chunk 9 — Reference sweep for the old composes
- [ ] Update the compose command to `docker volume create log-hub-pgdata && docker compose -f local-run/docker-compose.yml up -d` in `CLAUDE.md:128` and `.claude/repo_config/repo-health-checks.json:9` (`environmentNotes`). Add FR-D3 there: on the host Claude starts server and client itself; in a sandbox they already run.
- [ ] Update `docs/knowledgebase/test/scenarios.md:19`, `tests/scenarios/README.md:23,33,39` and `tests/corpus/README.md:39` to the `local-run/` compose and the container names.
- [ ] Update the messages and comments in `tests/scenarios/helpers/mailpit.ts:7,75` and `scripts/scenarios/preflight.mjs:48,65` to point at `local-run/docker-compose.yml`.
- [ ] Update `scripts/corpus/bootstrap.js:10`, `tests/README.md:45` and `server/README.md:14-19` to the `local-run/` compose.
- [ ] Update `README.md:249`: the new compose plus a short "Claude sandboxes" pointer to `scripts/claude-docker.ps1` and the KB article.
- [ ] Grep the repo (excluding `docs/tasks/`) for `artisyn-log-run-local` and `tests/scenarios/docker-compose`. Zero hits are expected; fix any remaining one.

### Chunk 10 — Hook root override
- [ ] Create `hook/.claude/telemetry_tool/project-root-override.js` exporting `projectRootOverride(cwd, env = process.env)` per DD-9, with a header comment in the `claude-config-dir.js` style.
- [ ] In `hook/.claude/telemetry_tool/git-context.js:49`, make `resolveRootFromCommonDir(cwd)` return `projectRootOverride(cwd)` when it is non-null, before calling git. Update the comments at :45-61 and :89-92.
- [ ] Check every consumer listed in DD-9 against its expected behaviour. Fix any that bypasses `getGitRoot`/`resolveRootFromCommonDir` (grep `--git-common-dir` and `show-toplevel` in `hook/.claude/telemetry_tool/`).
- [ ] Bump `hook/.claude/telemetry_tool/version.json` to 2.23.0. Run `npm run build:hooks-installer`.
- [ ] Copy the changed hook files and `version.json` into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/`. Set `version` 2.23.0 in `.artisyn/marketplace/plugins/log-hub-hooks/.claude-plugin/plugin.json`.
- [ ] Run the `update-install-instructions` skill so `hook/INSTALL_HOOK.md` documents `ARTISYN_PROJECT_ROOT`.
- [ ] Run `npm run lint:fix`, `npm run lint` and `npm test` in `hook/` and fix any failures.

### Chunk 11 — Test-DB variable, Vite host, installer otel-env
- [ ] In `scripts/scenarios/run.mjs`, export `resolveRunnerDatabaseUrl(env = process.env)` (DD-10) and use it at :376 instead of the inline expression.
- [ ] In `server/test/contract/setup/global-setup.ts:43-45`, prefer `envBeforeAppModule.TEST_DATABASE_URL`, then `envBeforeAppModule.DATABASE_URL`, and update the comment. Ensure `TEST_DATABASE_URL` is read from `envBeforeAppModule` (check `server/test/helpers/env-snapshot.helper.ts` snapshots all env).
- [ ] In `client/vite.config.ts:20-26`, add `host: process.env.LOG_HUB_VITE_HOST || undefined` to `server`. Leave the port and proxy unchanged.
- [ ] Create `artisyn-hooks-installer/src/otel-env.ts` containing `OTEL_ENV_KEYS(port)` and `OTEL_ENDPOINT_KEYS`, moved verbatim with their comments from `install.ts:1527-1559`, with no imports and erasable-only syntax.
- [ ] In `artisyn-hooks-installer/src/install.ts`, import and re-export both symbols from `./otel-env`. Then run `npm run build:hooks-installer`. Ensure `artisyn-hooks-installer/package.json` is exactly one patch above `HEAD`.
- [ ] Run the client and server typecheck and lint commands from the CLAUDE.md table and fix any errors.

### Chunk 12 — Full image
- [ ] Add `fetch-bun`, `fetch-mailpit` and `fetch-chrome` stages to `docker-dev/Dockerfile` with pinned ARG versions and sha256 values (DD-12), using `aria2c -x16 -s16` and then `sha256sum -c`.
- [ ] Add a `chrome-debs` stage (`ubuntu:24.04`, `apt-get install --download-only ./chrome.deb libasound2t64`) and install the debs offline in the final stage with `apt-get install ./debs/*.deb`.
- [ ] Add `postgresql-client`, `socat`, `curl` and `procps` (for `pgrep`) to the final stage. Install `typescript-language-server@$TS_LS_VERSION` and `typescript@$TYPESCRIPT_VERSION` globally with npm, and pin npm with `npm i -g npm@$NPM_VERSION`.
- [ ] As `dev`, run `npx -y playwright@$PLAYWRIGHT_VERSION install chromium` into `/home/dev/.cache/ms-playwright`. Create `/home/dev/.npm`, `/home/dev/.bun`, `/var/log/dev` and `/run/dev` owned by `dev`.
- [ ] Create `docker-dev/npx.cmd` (`#!/bin/sh` + `exec npx "$@"`). Copy `devctl` and `npx.cmd` (mode 755) to `/usr/local/bin/` and `provision.mjs` to `/opt/log-hub-dev/`. Add `!devctl`, `!provision.mjs` and `!npx.cmd` to `Dockerfile.dockerignore` and `IMAGE_FILES`.
- [ ] Build the image with a deliberately wrong sha256 ARG and confirm the build fails. Confirm `which python3` is empty in the good image.

### Chunk 13 — Container runtime: devctl, entrypoint, provisioning
- [ ] Create `docker-dev/devctl` (bash) per DD-13 with `start|stop|restart|status|logs` for `server|client|mailpit|provision|all`. Unknown arguments print usage and exit 2.
- [ ] Create `docker-dev/provision.mjs` with `--static` per DD-15: write `otel-port.json` and merge the `OTEL_ENV_KEYS` env into `.claude/settings.local.json`, preserving other keys, with the dynamic import of `otel-env.ts` from `$SANDBOX_WORKTREE`.
- [ ] Add the `--loop` mode to `provision.mjs` per DD-15: health check, key probe, identify, create key, write `log-hub.local.json`, touch `/run/dev/provisioned`, log every round. It writes only git-ignored files.
- [ ] Extend `docker-dev/entrypoint.sh` with DD-14 steps 2–3, using the lockfile table from FR-B2:
  - root, `server/`, `hook/` and `artisyn-hooks-installer/` → `package-lock.json` → `npm ci`;
  - `client/` → `bun.lock` → `bun install --frozen-lockfile`;
  - the root `bun.lock` is ignored.
- [ ] Extend `entrypoint.sh` with the Phase 2 parts of step 5 (`claude-plugins-official` plus `typescript-lsp`, warn on failure), the Phase 2 variant of step 6 (remove the two disable keys), and steps 7–8.
- [ ] Rewrite `docker-dev/CLAUDE.container.md` as the FR-B7 guide. Section 1, the environment:
  - Linux/bash;
  - its own branch, DB, backend, client and Mailpit, already running;
  - manage them with `devctl` and never start a second copy;
  - `/host-tmp` for pasted images.
- [ ] Add section 2 to `CLAUDE.container.md`, rules:
  - the full test set runs here (runners use `TEST_DATABASE_URL`);
  - build and e2e/contract never run concurrently (FR-B10);
  - no Docker, no WebStorm MCP or `web-storm-mcp` skill; use Read/Edit/Grep and `typescript-lsp`.
- [ ] Confirm that `.claude/settings.local.json`, `server/.env`, `.artisyn/config/log-hub.local.json` and `.artisyn/config/otel-port.json` are git-ignored (`git check-ignore -v`). Add any missing entry to the matching `.gitignore`.

### Chunk 14 — Launcher Phase 2: infra, DB, ports, readiness
- [ ] In `docker.mjs`, add `ensureInfra()`: `docker volume create log-hub-pgdata`, then `docker compose -f local-run/docker-compose.yml up -d --no-recreate`, then poll `docker inspect -f {{.State.Health.Status}} log-hub-postgres` until `healthy` (120 s timeout).
- [ ] In `docker.mjs`, add `ensureDb(db)`, `dropDb(db)`, `dbSize(db)` and `listSandboxDbs()` per Database changes, all through `docker exec log-hub-postgres`.
- [ ] In `sandbox.mjs` `createOrStart`, under the lock: `ensureInfra`, write `server/.env` (DD-16) when it is missing, `ensureDb` for both DBs, `allocateSlot`, and write state `v: 2`. A `v: 1` state is refused per DD-1.
- [ ] In `runContainer`, add `--network log-hub-net`, the three `127.0.0.1` port publishes from the state, the DD-8 Phase 2 env, the five `nm-*` volumes and the three shared cache volumes (each created with its labels from DD-3).
- [ ] On start of an existing container, check that every kept host port is bindable or already published by this container; otherwise fail, naming the port, with no re-allocation.
- [ ] After `entrypoint-done`, wait for `/run/dev/provisioned` up to `CLAUDE_DOCKER_READY_TIMEOUT_S`. On timeout, print the `devctl status` output, the hint `devctl logs <server|client>` and a "telemetry upload is off" warning, then open the session anyway.
- [ ] Print the sandbox URLs (`app http://localhost:<client>`, `api http://localhost:<server>`, `mailpit http://localhost:<mailpit>`) before opening every session,.

### Chunk 15 — Launcher Phase 2: serve, reset, list, remove, prune, menu
- [ ] Add `serve(name)` to `sandbox.mjs` and `--serve <name>` to the CLI: run `createOrStart` without a session, wait for the markers and print the URLs. It is CLI-only.
- [ ] Add `reset(name)` to `sandbox.mjs` and `--reset <name>` to the CLI:
  - refuse when `liveSessions > 0`;
  - `ensureImage({rebuild:true})` (`docker build` with cache);
  - `docker rm -f`, then `runContainer` from the state;
  - volumes, DB and worktree are kept.
- [ ] Extend `remove` with `dropDb` for both DBs (DD-16 `--remove` step 3), and `listRows` with ports/URLs and `dbSize`.
- [ ] Extend `findOrphans`/`executePlan` with the DB rule from DD-6: compare each name from `listSandboxDbs()` by exact string equality against `dbNames(n)` for orphan names n only (DD-3). Never use a prefix or a pattern match.
- [ ] In `menu.mjs`, render the Phase 2 detail line (URLs, db size, or `ports … (stopped)`) per Visual/UX notes.
- [ ] Ensure `--stop` stops the whole dev stack (container stop), and that a later start runs the entrypoint again (`docker start`), so all services come back.

### Chunk 16 — Tests
- [ ] In `tests/scenarios/helpers/hook-process.ts:173` `fakeHomeEnv`, add `ARTISYN_PROJECT_ROOT: ''`. In `tests/scenarios/helpers/installer.ts:85`, blank it the same way in the child env.
- [ ] Extend `tests/scenarios/hook/s-hook-01.spec.ts` with the three override steps from the Test coverage plan, using `makeFakeGitRepo`, `git worktree add` and `runHook(..., { env })`.
- [ ] Run `npm run test:scenarios -- --mode a --only scenarios --grep "@S-HOOK-01"` and `npm run test:scripts`, and fix any failures.
- [ ] Run the fast set via `adlc-lh:check-health` (`finalRun: false`) and fix any failures.

### Chunk 17 — Docs and final acceptance
- [ ] Complete `docs/knowledgebase/docker-dev-container.md` (FR-D2): sandbox model, all commands and env vars (DD-3), mounts (DD-7), ports, volumes, DB per sandbox and `TEST_DATABASE_URL`, `devctl`, provisioning. Limitations:
  - no Docker or WebStorm MCP inside;
  - sandbox telemetry is lost on `--remove`;
  - no auto-cleanup;
  - Windows host only tested;
  - git ≥ 2.48 on the host.
- [ ] Update `docs/knowledgebase/hook-system-overview.md:40,52-56,92,99`, `hook-api-versioning.md:349-367` (`git.root` equals the worktree under the override) and `legacy-design-decisions-map.md:110` with the `ARTISYN_PROJECT_ROOT` override.
- [ ] Update `docs/knowledgebase/test/scenarios.md` and `docs/knowledgebase/test/contract-tests.md` (plus `server/test/contract/README.md`) with the `TEST_DATABASE_URL` precedence.
- [ ] Add a short "Claude sandboxes" section to `CLAUDE.md` pointing to the launcher and the KB article. Check `docker-dev/`, `local-run/` and `scripts/claude-docker*` for machine paths and user names (FR-B9).
- [ ] Run the full set via `adlc-lh:check-health` (`finalRun: true`) on the host and fix any failures.
- [ ] Run the requirements' acceptance criteria manually (three parallel sandboxes, `devctl`, lockfile refresh, `--list`, `--remove`, `--prune` states, the full set inside a sandbox, MCPs, telemetry isolation, re-provisioning) and record the results in `notes.md`.
- [ ] Confirm that the host `git status` shows no `docker-dev/claude-home/` and no false changes, and that the main checkout's `.artisyn/` is unchanged.
