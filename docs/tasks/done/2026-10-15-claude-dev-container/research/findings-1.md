## Requirements summary
Build a `claude-docker` launcher (`scripts/claude-docker.mjs` + thin `.ps1`/`.cmd` wrappers) that per run creates/starts a **sandbox**: a git worktree+branch in `<repo-parent>/<repo-name>-worktrees/<name>` (relative links, git ≥ 2.48 `--relative-paths`, `-c core.autocrlf=input`), a container `log-hub-dev-<name>` from one image `docker-dev/Dockerfile` (ubuntu 24.04, user `dev` uid 1000, Node/npm, bun, Claude Code native binary, Chrome/Playwright, Mailpit, socat, jq, rg, pg client, no Python), two DBs `log_hub_<name>` / `log_hub_<name>_test` in a shared `log-hub-postgres`, in-container backend + Vite client + Mailpit managed by `devctl`, own host port triple `3100/5200/8100 + 10·n`, per-sandbox `node_modules` volumes refreshed by lockfile hash, per-sandbox plugin state, shared `docker-dev/claude-home` as `CLAUDE_CONFIG_DIR`. Also: new `local-run/docker-compose.yml` (postgres 18.4 on external volume `log-hub-pgdata` at `/var/lib/postgresql`, + mailpit, fixed names) replacing `server/artisyn-log-run-local/` and `tests/scenarios/docker-compose.yml`; a hook back-compat env override of the project root (e.g. `ARTISYN_PROJECT_ROOT`) so a sandbox's sessions report to its own Log Hub; entrypoint provisioning (identify host git email → API key → only git-ignored files → readiness marker); lifecycle `--serve/--shell/--stop/--reset/--list/--remove/--prune`, stale reminder, no auto-cleanup, never commits/merges; interactive menu (FR-W8) from the approved PoC. **Phase 1 PoC** = slim image, review-only sandbox (no DB, no ports, no hook — entrypoint disables `log-hub-hooks@artisyn-e798dd87` and `typescript-lsp@claude-plugins-official` via local-scope `enabledPlugins`), covering create/start, shell, stop, list, remove, prune, menu.

## Wireframes
- `wireframes/sandbox-menu-list.svg`: header "✻ Claude sandboxes · <repo> · N sandboxes · stale > 7 d"; columns NAME/BRANCH, STATE (`● running`/`○ stopped`), SESS, LAST ACTIVE (amber `⚠` stale), PENDING WORK (`N files, M commits`/`merged`/`—`); "+ New sandbox" row; detail block for selection: `branch X ← base · container …`, worktree path, `app http://localhost:5200 · api :3100 · mailpit :8100 · db log_hub_… <size>`; stale reminder `scripts/claude-docker.ps1 --prune --older-than 7d (or press P)`; footer `↑↓ Enter R S T D P Q`; on "+ New" row footer shrinks to `↑↓ Enter create P Q`.
- `wireframes/sandbox-menu-dialogs.svg`: three box types — amber confirm "Remove (force)" (lists work that will be lost, branch kept, `y` confirms); red refusal "Create refused" (git message for branch already checked out elsewhere, any key closes); cyan input "New sandbox" (inline-validated name: `only a-z, 0-9 and "-"`, not existing; Enter/Esc). A stopped sandbox detail line: `ports 3140 · 5240 · 8140 (stopped)` (slot n=4).
- `wireframes/sandbox-menu-prune.svg`: "✻ Prune plan · candidates: stopped / missing containers"; Will remove (no-change, merged); Will keep (has work `→ merge outside · F removes anyway, keeps branch`; live session `never pruned, even with F`); prompt `Remove N sandbox(es)? y / F / Esc`; after: `✓ pruned N sandbox(es)` in list.
- PoC `docs/pocs/2026-10-21-1316-sandbox-menu-tui/menu.js` (CommonJS, built-ins only, readline keypress, alt screen `?1049h`): reuse `pad()` ANSI-aware width :51, `ago()` :58, `renderList` :82, `renderBox` :131, `prunePlan` :144, key handlers :203–263, non-TTY hint + exit 1 :266. **Must drop** `M` merge key & its dialogs (:226–230, footer :127, prune hint :170) and hard-coded `WORKTREES` path :29 (FR-B9). PoC name regex :246 lacks 40-char limit and no-`-test`-suffix rule.

## Knowledgebase
- `docs/knowledgebase/hook-system-overview.md:40,52-56,92,99` — root from `--git-common-dir`; linked worktrees share main checkout's config/`ai_work_dir`; transcript slug from `getGitRoot`. Must document the override here.
- `docs/knowledgebase/legacy-design-decisions-map.md:110` (T-79 worktree root resolution) — update.
- `docs/knowledgebase/hook-api-versioning.md:349-367` — `git.root` documented as "the primary checkout"; with override root == worktreeRoot. Additive/back-compat upload.
- `docs/knowledgebase/hook-installation.md` — formats provisioning must reproduce: `log-hub.local.json` `{apiKey}`; `otel-port.json` `{"port":N,"allocatedAt":ISO}`; 9-key OTEL `env` in `.claude/settings.local.json` (table :335-345); `.artisyn/config/.gitignore` already lists `log-hub.local.json`, `otel-port.json`; per-repo marketplace name `artisyn-e798dd87` (matches `.artisyn/marketplace/.claude-plugin/marketplace.json:2`).
- `docs/knowledgebase/otel-receiver.md:74,119-126` — owner `gitRoot` used for 409 guard; each container has own loopback → no cross-sandbox port collision.
- `docs/knowledgebase/authorization-and-authentificaiton.md:195-257` + `server/src/auth/utils/localhost.util.ts:33` — mode 1 (`none`) trusts `127.0.0.1`/`::1` + container gateway; in sandbox the host browser hits backend via Vite proxy → backend sees loopback. `AutoIdentifyGuard` (`server/src/auth/guards/auto-identify.guard.ts:22`) auto-logs cookie-less local browser as user #1 → first identified user (provisioning's host email) is what the host browser gets.
- `docs/knowledgebase/server-endpoint-map.md` — `POST /api/v1/auth/identify` :61/:76; `POST /api/v1/api-keys` (SessionAuthGuard) :812; `POST /api/v1/log-echo` (ApiKeyAuthGuard) :112 = validity probe for "reuse key if accepted" (installer uses it: `artisyn-hooks-installer/src/install.ts:16`). No CSRF middleware → scripted session-cookie POST works.
- `docs/knowledgebase/test/scenarios.md` — `:19` compose command (to update); preflight, `public`-schema fingerprint of `DATABASE_URL`, modes; helpers `hook-process.ts`, `installer.ts`; `:306-309` runner pure-logic tests in `scripts/__tests__/scenarios-*.test.js`.
- `docs/knowledgebase/test/contract-tests.md` / `server/test/contract/README.md` — contract suite takes `DATABASE_URL` from caller or `server/.env`.
- `docs/knowledgebase/algorithms/README.md` — no algorithm doc applies (unless plan chooses to document prune classification / slot allocation as one).
- `docs/knowledgebase/index.md` — add line for new `docker-dev-container.md` (FR-D2).

## Existing patterns
**Hook (FR-C2)**
- `hook/.claude/telemetry_tool/git-context.js:49` `resolveRootFromCommonDir` — insertion point for override; `getGitRoot` :59, `getGitContext().root` :86, `getWorkDirPath` :117 all flow from it.
- `getGitRoot` consumers to check: `env-context.js:261` (`loadConfig`), `:296` (`resolveTelemetryDir`); `session-files.js:223` (transcript slug matching — with override slug becomes worktree path = Claude's own projects slug in container); `otel-register.js:88` (owner payload); `otel-endpoint-check.js:80`; `send-logs-hook.js:945,1211,1318`; `post-turn-analysis-worker.js:434` (skill catalog); `code-inventory.js`.
- `getGitContext` consumers: `lifecycle-hook.js:70`, `telemetry-hook.js:69`, `post-turn-analysis-hook.js:79`, `post-turn-analysis-worker.js:1716`.
- Env-var helper w/ injectable `env`: `hook/.claude/telemetry_tool/claude-config-dir.js:21`. Hook reads no `ARTISYN_*` var today except `ARTISYN_HOOK_SERVICE`.
- Hook version `hook/.claude/telemetry_tool/version.json` = 2.22.2; propagation per `.claude/rules/hook.md` (bump, `npm run build:hooks-installer`, dogfood copy into `.artisyn/marketplace/plugins/log-hub-hooks/scripts/` + `plugin.json`) and `update-install-instructions` skill (`hook/INSTALL_HOOK.md`).

**Installer helpers for provisioning**
- `artisyn-hooks-installer/src/install.ts:1501` `resolveInstallOtelPort`, `:1477` `allocateOtelPort`, `:1543` `OTEL_ENV_KEYS(port)`, `:1559` `OTEL_ENDPOINT_KEYS`. `runInstall` :785 not reusable as-is (rewrites tracked `.claude/settings.json` & `.artisyn/marketplace/`).

**Scenarios/contract (FR-W4 test-DB var)**
- `scripts/scenarios/run.mjs:376` single entry (`process.env.DATABASE_URL || DEFAULT_DATABASE_URL`) → passed into `startStand` :322, `contractCommand` :280-285, fingerprints :389, preflight. Also `stand.mjs:183`, `preflight.mjs:97` defaults.
- Contract: `server/test/contract/setup/global-setup.ts:43-45` honours caller `DATABASE_URL` (`envBeforeAppModule`); `global-teardown.ts:25`, `oracle.ts:44` read `process.env.DATABASE_URL`.
- Server `dotenvConfig()` (`server/src/app.module.ts:52`) does not override existing env → container `DATABASE_URL` wins over `server/.env`; but `server/.env.local` (:57-59) **does** override.
- Legacy e2e `tests/e2e/helpers/db.ts:27-58` env wins over `.env.defaults`.
- Hook/installer scenario children inherit `...process.env`: `tests/scenarios/helpers/hook-process.ts:302`, `installer.ts:85`; `fakeHomeEnv` (`hook-process.ts:173`) already blanks `ARTISYN_HOOK_SERVICE` — new root var must be blanked likewise.

**Existing compose & references**
- `server/artisyn-log-run-local/docker-compose.yml` (service `db`, PGDATA pinned `data/pgdata` bind); `tests/scenarios/docker-compose.yml` (postgres:16 on `5432:5432`, not loopback-only, + `axllent/mailpit`).
- Reference sweep (AC "no file references old paths"): in FR-A5 list — `CLAUDE.md:128`, `.claude/repo_config/repo-health-checks.json:9`, `docs/knowledgebase/test/scenarios.md:19`, `tests/scenarios/README.md:23,33,39`, `tests/corpus/README.md:39`, `tests/scenarios/helpers/mailpit.ts:7,75`, `scripts/scenarios/preflight.mjs:48,65`, `scripts/corpus/bootstrap.js:10`; **not in FR-A5 list**: `README.md:249`, `server/README.md:14-19`, `tests/README.md:45`, `.gitignore:24-25`, `server/stryker.config.json:18` (ignorePattern `/artisyn-log-run-local`).

**Docker/process helpers in Node**
- `.claude/skills/big-prod-e2e-test/scripts/lib/proc.mjs:19` `run` (spawnSync throw), `:47` `killTree`, `:150` `which`; `.../lib/stand.mjs:91-268` compose render/up/waitReady/down/assertDown with `-p` project names; `.../lib/hooks.mjs:28` `readServerUrl`.

**Image reference**
- Root `Dockerfile` (multi-stage node:22-slim, `npm install -g bun`), `.dockerignore` (deny-list) — FR-B1 wants allow-list `Dockerfile.dockerignore`.

**Build-script tests (`npm run test:scripts`, globs `scripts/__tests__/*.test.js`)**
- Pattern `scripts/__tests__/scenarios-stand.test.js:20-25` (`node:test` + dynamic import of `.mjs`/`.ts`) — natural home for launcher pure logic (name validation, DB/volume naming, slot allocation, prune classification, state-file reconcile, age parsing). `scenarios-run.test.js:53-57` already asserts `contractCommand` env → extend for test-DB var.

**Scenario to extend for hook override**
- `tests/scenarios/hook/s-hook-01.spec.ts` (`@S-HOOK-01 @mode-a`, fake repo + fake hub, `runHook(..., { env })` via `RunOptions.env` `hook-process.ts:279`) — add steps: env set → config read from / `ai_work_dir` written under override root, `git.root` equals it; unset inside linked worktree → old behaviour. `makeFakeGitRepo` (:147) already commits HEAD "for `git worktree`".

**Tracked config sandbox must not modify**
- `.artisyn/config/log-hub.json` (`serverUrl` `http://localhost:5173`, `otelReceiverPort` 58603); `.claude/settings.json` (`enabledPlugins`, marketplace `./.artisyn/marketplace`); `.mcp.json` (postgres `npx.cmd … /a-log`, playwright `npx.cmd`, webstorm http).

**Vite/server dev scripts**
- `client/vite.config.ts:20-26` (server.port 5173, proxy → `localhost:3000`) — env-driven `server.host` goes here. `server/package.json:13` `start:dev` runs `build-hooks-installer.js` first (needs `artisyn-hooks-installer/node_modules`).

**Lockfiles present** (FR-B2): `package-lock.json`, `server/package-lock.json`, `hook/package-lock.json`, `artisyn-hooks-installer/package-lock.json`, `client/bun.lock`; root `bun.lock` exists (to be ignored).

**Host versions measured**: node v24.18.1, npm 11.16.0, bun 1.3.14, git 2.56.0.windows.2, Docker 29.7.2, Compose v5.4.0. Host git config (`--show-origin`): system `core.autocrlf true`, `core.symlinks false`; repo `.git/config` `core.ignorecase true`, `core.filemode false`, `core.hookspath .githooks` (`pre-commit` → `node scripts/migrations-lock.js`). `git worktree list` = main checkout only.

## Open gaps
1. **Root-override var leakage into children**: if `ARTISYN_PROJECT_ROOT` is set container-wide, every child inherits it (hook/installer scenario processes, `claude -p` in fixture repos — corpus bootstrap, big-prod-e2e — and stands). Plan must choose: blank it in `fakeHomeEnv`/installer env, set only on `docker exec … claude` env, or have the hook apply it only when cwd is inside that root.
2. **Test-DB var name** not chosen (e.g. `TEST_DATABASE_URL`); precedence rules in `run.mjs:376`, `global-setup.ts:43`, README/KB. A plain `npm run test:contract` health check in a sandbox would otherwise use the live `log_hub_<name>`.
3. **`GIT_CONFIG_COUNT/KEY/VALUE`** is env-scope (outranks repo-local) → would override fake repos' `core.autocrlf false` (`hook-process.ts:152`) in hook scenarios inside a sandbox. Plan should scope it (only `claude`/shell sessions) or accept.
4. **Ubuntu 24.04 apt ships git 2.43**; git ≥ 2.48 needs a source (git-core PPA or build) with sha256/signing story — undecided.
5. **No existing pattern** for: sha256-verified parallel BuildKit downloads, Claude Code native install layout/manifest verification, Chrome offline `.deb`, Mailpit binary, supervisor/`devctl`, socat `nodelay` forward, entrypoint lockfile-hash refresh, `jq -s '.[0] * .[1]'` settings merge, `.sandboxes/` lock file and state-file schema, image-hash label + stale warning, `pgrep -x claude` liveness probe, per-sandbox plugin volume path under `CLAUDE_CONFIG_DIR` (hook reads `<claudeConfigDir>/plugins/installed_plugins.json` via `skill-catalog.js`).
6. **Script convention conflict**: FR-B5 wants ESM async/keypress `scripts/claude-docker.mjs`; `nodejs-script` skill mandates CommonJS + sync. PoC already deviated and documented it; existing `.mjs` precedent: `scripts/scenarios/*.mjs`, `big-prod-e2e-test/scripts/*.mjs`.
7. **Postgres `max_connections` sizing** — exact inputs: app pool `max = DB_POOL_MAX || 20` (`server/src/database/database.module.ts:27`); `pg.Pool` default max 10 (scenario `db` fixture `workers: 1`, contract pools, postgres MCP). Per sandbox with `app` group serialising its suites: dev backend 20 + stand/contract app 20 + test-side pool 10 = 50; three sandboxes = 150, plus host dev server 20 = 170. Postgres default is 100. Plan decides the value.
8. **Name-derived lengths (computed, max name 40)**: DB `log_hub_` + 40 + `_test` = 53 chars (≤ Postgres 63); container `log-hub-dev-` + 40 = 52; a volume like `log-hub-dev-<name>-nm-artisyn-hooks-installer` = 12+40+27 = 79 (volume naming scheme undecided).
9. **Mount layout**: container paths must mirror `<parent>/_repo/.git` and `<parent>/_repo-worktrees/<name>` so relative `gitdir` links resolve; `safe.directory` needed for both (Docker Desktop bind ownership); `docker-dev/claude-home` lives in main checkout but must be mounted rw while the rest of main is not — concrete container paths undecided.
10. **Entrypoint provisioning script**: no Node/shell script exists doing identify → create key → validate via `/api/v1/log-echo` → write `log-hub.local.json`/`otel-port.json`/`settings.local.json` env → readiness marker; either export/bundle the installer's TS helpers or re-implement formats.
11. **Phase-1 PoC tests**: plan must decide which parts get `scripts/__tests__` build-script tests vs manual acceptance only (Docker/git actions can't run in `test:scripts`, which never shells Docker).
