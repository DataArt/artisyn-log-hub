---
type: "Architecture Guide"
title: "Artisyn AI Work Hub"
description: "Work Hub (work-hub/), the separate Rust + React product in this repo: architecture and module map, the container model (workspace and workstream containers, volumes, images, checkpoints), Docker names, labels and cleanup rules, configuration env vars, inline and dockerized run modes, its own commands, test stand, fake agent and test policy, and known limits (checkpoint layer limit, no coverage measurement)."
tags:
  - work-hub
  - docker
  - rust
  - architecture
timestamp: "2026-11-13T00:00:00+04:00"
---

# Artisyn AI Work Hub

Work Hub is a self-hosted web workspace for working with a coding agent (Claude Code in the
alpha). It lives in `work-hub/` next to Log Hub but is a **separate product**: its own Rust server,
its own React SPA, its own Postgres database, its own commands and CI job. It is not part of
`scripts/build.js`, Log Hub's `dist/` or Log Hub's health checks, and it shares no code with Log
Hub — the auth port is re-implemented in Rust and checked against Log Hub's algorithm docs.

Task and design: `docs/tasks/*/2026-11-13-ai-work-hub-alpha/` (`requirements.md`, `impl-plan.md`
— the D-numbers below refer to its Design Decisions). User-facing run instructions:
`work-hub/README.md` (self-contained, offline).

## Concepts

- **Workspace** — one git repository owned by one user, living in a Docker container
  (`wh-ws-<uuid>`) with two volumes. Its checkout at `/workspace/repo` is on the **working
  branch** (`main` by default; switchable in Settings). Files, login and configure sessions of the
  working-branch view run here.
- **Workstream** — a branch `ws/<slug>` worked on by the agent in its **own** container
  (`wh-st-<uuid>`) with copies of the workspace's volumes; the checkout is a git worktree at
  `/workspace/worktree`. Each has one agent chat (tmux session `chat`) shown in a browser terminal.
  Closing it brings the branch into the working branch (merge), closes it for now, marks it merged
  elsewhere, or discards it. States: `opening` → `open` ↔ `closed`, `done`, `discarded`.
- **Agent adapter** — `server/src/agent/` (`AgentAdapter` trait, `claude.rs`). Only these two files
  may name the agent; everything else uses the adapter, and the web shows the API's `agentName`
  (AC-2, enforced by `scripts/agent-names-check.mjs` in `npm run lint`).
- **Login** — one per user and agent (2026-11-14): the login tab runs the adapter's token flow
  (`claude setup-token`); its output is collected in the container's tmpfs `/tmp/wh-login.raw`,
  the watcher takes the token (`token_from_login_output`) into the **secret store** and marks all
  of the user's workspaces with that agent logged in (`login_state` is a cache of "the token
  exists"). The token reaches the agent only as an env var (`token_env`) through
  `tmux::SessionOpts.secret` (exec stdin → `-e NAME=…`); old login files are removed before the
  agent starts. "Copy login" is a no-op kept for old clients. Rotating refresh tokens made
  per-workspace copies invalidate each other — the reason for this design.
- **Secret store** (`server/src/secrets.rs`) — AES-256-GCM files
  `<data dir>/secrets/<user id>/<name>.enc`, key in table `secret_key` (generated on first use).
  Everything else on disk stays readable; secrets never go into containers, workspace folders or
  recordings. Use it for every future secret.
- **Configure** — an agent session in the workspace container that installs tools; on finish the
  container is `docker commit`ed into a **checkpoint image** that new workstreams start from.

## Layout

| Path | What |
|---|---|
| `work-hub/Cargo.toml`, `rust-toolchain.toml` | Cargo workspace (`members = ["server"]`), Rust 1.92 pinned, edition 2024 |
| `work-hub/server/src/config.rs`, `db.rs`, `state.rs`, `error.rs`, `locks.rs`, `timing.rs` | config (D2), pool + schema + migrations, `AppState`, `ApiError` (D4), per-container locks, timing constants |
| `work-hub/server/migrations/` | sqlx migrations (schema `WORK_HUB_DB_SCHEMA`) |
| `server/src/auth/` | auth port of Log Hub's modes (`none`, `password`, `password-confirm`, `azure-oauth`), sessions (`tower-sessions`, cookie `workhub.sid`) |
| `server/src/docker/` | Engine API layer over bollard: names and labels, containers, exec, archive, volumes, images |
| `server/src/devcontainer.rs` | `.devcontainer/devcontainer.json` subset parser (D6) |
| `server/src/names.rs`, `repo_path.rs`, `git.rs` | display names and branch slugs, repo-relative path validation, git helpers |
| `server/src/workspaces/` | workspace lifecycle, login copy, configure session |
| `server/src/workstreams/` | open, close modes, discard, reopen, retry, reconciler |
| `server/src/terminal/` | tmux sessions, WebSocket bridge, takeover hub, recordings, pane watchers |
| `server/src/fs/` | file listing, poll, save (commit per file), upload, move, download |
| `server/src/api/` | HTTP routes (`routes!` macro also fills `ROUTE_TABLE`), security headers / CSP, embedded SPA |
| `work-hub/web/` | React SPA (bun, Vite, hash router, react-query, radix, Monaco, xterm); plain CSS: tokens in `src/app.css`, a `<Component>.module.css` per component, no CSS framework |
| `work-hub/image/` | default devcontainer image (`Dockerfile`, `tmux.conf`), embedded in the server |
| `work-hub/scripts/` | `dev.mjs`, `image.mjs`, `scenarios.mjs`, `contract.mjs`, `typecheck.mjs`, `agent-names-check.mjs`, `license-check.mjs` |
| `work-hub/tests/` | Playwright scenarios and the fake agent (test infrastructure, never shipped) |
| `work-hub/Dockerfile`, `deploy/` | dockerized run mode |

## Container model (D5, D6)

| Object | Name | Role label |
|---|---|---|
| workspace container | `wh-ws-<workspace uuid>` | `workspace` |
| workspace volumes | `wh-ws-<uuid>-repo` (→ `/workspace`), `wh-ws-<uuid>-home` (→ the user's home); bound to file-area folders | `workspace` |
| workstream container | `wh-st-<workstream uuid>` | `workstream` |
| workstream volumes | `wh-st-<uuid>-repo`, `wh-st-<uuid>-home` | `workstream` |
| built devcontainer image | `wh-img-<workspace uuid>:1` | `built` |
| checkpoint image | `wh-ckpt-<workspace uuid>:<seq>` | `checkpoint` |
| helper container | `wh-helper-<random uuid>` (auto-remove) | `helper` |

- **File area (FR-5g, `server/src/files.rs`).** Every volume is a `local`-driver named volume with
  `type=none,o=bind,device=<folder>`, so its data is a plain host folder under
  `WORK_HUB_DATA_DIR`: `users/<email>/<workspace slug>-<id6>/{workspace,home,workspace.json}` and
  `…/workstreams/<workstream slug>-<id6>/{workspace,home,workstream.json}` (`workspace/` is the
  repo volume mounted at `/workspace`, so git is in `workspace/repo`, a worktree in
  `workspace/worktree`); the relative folder is stored
  in `workspaces.files_dir` / `workstreams.files_dir`. Files survive a dead server or Docker. The
  server creates the folders and writes the JSON metadata; contents are written by the containers
  and deleted by a root helper container (`rm -rf` with the parent bind-mounted), so a non-root
  server can delete uid-1000 files. The engine's view of the data dir is
  `WORK_HUB_DOCKER_DATA_DIR` (default: the absolute data dir; a Windows `D:\x` maps to Docker
  Desktop's `/run/desktop/mnt/host/d/x`). Removing a volume never deletes its folder — the
  folder is removed explicitly on workspace delete, workstream discard / done and failed
  create/open. A missing volume is re-created from its folder by the ensure paths.
- Every container: `Cmd ["sleep","infinity"]`, `Init: true`, tmpfs `/tmp` (tmux sockets and
  bundles never enter a checkpoint), env from `containerEnv` plus `TERM`/`LANG`, the default bridge
  network, **no published ports**, restart policy `no`. Every exec runs as the workspace's
  container user (discovered with a helper `docker run` at creation and stored on the row).
- **Image choice.** A container starts from `checkpoint_image` when set, else `base_image`: the
  default image `artisyn-work-hub-default:<crate version>`, a built `wh-img-<uuid>:1`, or a named
  local image (never pulled). The default image is built from the embedded `image/` at server start
  when missing; until it is ready, creating a workspace answers `image_not_ready`.
- **Opening a workstream** copies both workspace volumes with a helper container
  (`tar cf - . | tar xpf -`, sources read-only) under the workspace lock, runs `wh-st-<uuid>`, and
  adds a worktree on a new branch from the working branch.
- **Bringing into main** moves commits as a `git bundle` piped between containers, then merges
  `--no-ff` in the workspace container. A conflict aborts the merge and refreshes the workstream's
  copy of the base branch instead.
- **Reconciler** (startup + every 60 s): keeps every `open` workstream's container running with a
  live `chat` (a start failure shows the workstream as Unavailable until "Try again"), and deletes
  rows stuck in `creating`/`opening` for more than 10 min after removing their labelled objects.

### Labels and cleanup rules

Every object gets `artisyn.workhub=1`, `artisyn.workhub.instance=<WORK_HUB_INSTANCE>`,
`artisyn.workhub.role=…`, plus `artisyn.workhub.workspace=<uuid>` and, for workstream objects,
`artisyn.workhub.workstream=<uuid>`.

- **Everything is scoped by the instance label.** A server only lists, reconciles or removes
  objects whose `artisyn.workhub.instance` equals its own `WORK_HUB_INSTANCE`; test stands use their
  own (`whs-<8hex>` scenarios, `whc-<8hex>` contracts) so they never touch a dev or user install
  on the same Docker Engine.
- **Test cleanup removes only what carries its own instance label** and drops only its own schema
  (`whs_<mode>_<8hex>`, `whc_<8hex>`). Never clean up by name prefix (`wh-*`) or by
  `artisyn.workhub=1` alone — another instance's workspaces may be on the same engine.
- **Deleting a workspace** removes its workstream containers and volumes, its container and
  volumes, its `wh-ckpt-<uuid>:*` and `wh-img-<uuid>:*` images, its file-area folder and its
  recording files, then the
  row (cascade). A failed create or open undoes its steps in reverse and keeps nothing.
- **Discard / merged elsewhere** remove the workstream's container, volumes and folder; **close for now**
  and a successful **bring into main** only stop the container.
- Stopping Work Hub (or `docker compose down`, even `-v`) does **not** remove workspace
  containers, volumes or images: delete workspaces in the UI first.

### Checkpoint layer limit

Each Configure finish commits the workspace container into a new checkpoint image, adding one
overlay layer on top of the previous checkpoint. overlay2 caps an image at about 127 layers, so a
workspace configured over ~100 times (on top of the base image's own layers) eventually fails to
commit or start. This is **documented, not mitigated** in the alpha; the fix would be squashing
(export/import) the checkpoint. There is no rollback of a configure session either (FR-25c).

## Terminals and recordings (D11, D17)

- One tmux session per purpose: `chat` (workstream container, cwd `/workspace/worktree`), `login`
  and `configure` (workspace container, cwd `/workspace/repo`). `remain-on-exit on`; a dead `chat`
  pane is respawned with the adapter's resume command.
- WebSockets `…/chat/ws`, `…/login/ws`, `…/configure/ws` bridge to `tmux attach` via a bollard TTY
  exec; they require the session cookie and an `Origin` equal to the request origin or
  `PUBLIC_BASE_URL`. One live connection per session: a new tab takes over (`taken_over` frame).
- `chat` output is piped to `~/.workhub/term/chat.raw` in the container and synced to
  `<WORK_HUB_DATA_DIR>/recordings/<workstream uuid>.raw` (attach, detach, every 30 s, before
  stop/remove); resizes are stored with byte offsets so History replays with the right geometry
  (algorithm `workhub-terminal-replay`).

## Configuration (D2)

Read with `dotenvy` from `work-hub/.env` when present; real env vars win. `work-hub/.env.example`
documents every variable.

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3100` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `DATABASE_URL` | required | Postgres URL |
| `WORK_HUB_DB_SCHEMA` | `work_hub` | schema created if missing; `search_path` on every connection |
| `WORK_HUB_ENV` | `production` | `production` / `development` / `test` (Log Hub's `NODE_ENV` role) |
| `WORK_HUB_DATA_DIR` | `./data` | file area (`users/`), recordings (`recordings/`) and temp files (`tmp/`) |
| `WORK_HUB_DOCKER_DATA_DIR` | the absolute data dir (Windows drive → `/run/desktop/mnt/host/<drive>/…`) | the data dir as the Docker Engine sees it; bind source of every volume |
| `DOCKER_HOST` | bollard default (unix socket / Windows named pipe) | Docker Engine endpoint |
| `WORK_HUB_DEFAULT_IMAGE` | `artisyn-work-hub-default:<crate version>` | image for new workspaces and helper containers |
| `WORK_HUB_INSTANCE` | `default` | value of `artisyn.workhub.instance`; scopes every Docker object |
| `WORK_HUB_STATIC_DIR` | unset | serve the SPA from disk instead of the embedded copy (dev) |
| `SESSION_SECRET` | required in production | signs the session cookie (SHA-512 → 64-byte key); random per start otherwise |
| auth / SMTP / Azure vars | as in Log Hub | `AUTH_MODE`, `PASSWORD_POLICY`, `ADMIN_CONTACT_EMAIL`, `AUTH_RATE_LIMIT_*`, `ALLOWED_EMAIL_DOMAINS`, `PUBLIC_BASE_URL`, `COOKIE_SECURE`, `TRUST_PROXY`, `SMTP_*`, `AZURE_*` |

Startup validation follows `algorithms/auth-startup-config.md` with `NODE_ENV` read as
`WORK_HUB_ENV`.

## Run modes (D15)

- **Inline.** `work-hub/.env` (copy of `.env.example`), Postgres with a database of Work Hub's own
  (`workhub`; never Log Hub's database — the two products install independently), Docker
  running. `npm run dev` runs `cargo run` (port 3100)
  and Vite on **5180** with `/api` proxied (`ws: true`, no `changeOrigin`, so the WebSocket Origin
  check passes). `npm run start` builds the web and runs the release binary with the SPA embedded
  on 3100. A build without `web/dist` still compiles and serves a "Web UI not built" page.
- **Dockerized.** `docker compose -f deploy/docker-compose.yml up -d --build` (from `work-hub/`,
  env file `deploy/.env`): `db` (`postgres:18.7`) and `app` (three-stage `work-hub/Dockerfile`, UI
  on host port `${WORK_HUB_PORT:-5010}`), with `/var/run/docker.sock` mounted. The app runs as root
  — access to the Docker socket is host root anyway (README security note).
- **Offline.** The first start needs the network (it builds the default image: Ubuntu packages,
  Node, the agent CLI); afterwards Work Hub itself needs none — the accepted install-time exception
  to offline-first. The default image is not a dependency of the binary: it contains separately
  licensed programs (git under GPL-2.0, the agent CLI under its vendor's terms) that Work Hub runs
  but does not link.

## Commands

All from `work-hub/`. They are Work Hub's own and are listed in `CLAUDE.md` ("Work Hub").

| Command | What it does |
|---|---|
| `npm run lint` | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, web eslint (cache `tmp/.eslintcache-work-hub` at the repo root), `scripts/agent-names-check.mjs` (AC-2), `scripts/license-check.mjs` (D20) |
| `npm run typecheck` | `tsc --noEmit` over `web/` and `tests/` (`scripts/typecheck.mjs`) |
| `npm run test:algo` | Rust algorithm table tests and web `*.algo.test.ts` |
| `npm run build` | web build, then `cargo build --release` |
| `npm run test:contract` | contract tests (`scripts/contract.mjs` → `cargo test --test contract`) |
| `npm run test:scenarios -- --mode a\|b\|c [--grep <tag>]` | Playwright scenarios on an isolated stand |
| `npm run dev` / `npm run start` / `npm run image` | run modes; build the default image by hand |

**Licence check** (`scripts/license-check.mjs`, D20): every crate from `cargo metadata` and every
installed `package.json` under `web/node_modules` and `node_modules` must have a licence on the
permissive allowlist (MIT, Apache-2.0, BSD-2/3-Clause, ISC, Zlib, 0BSD, Unicode-3.0,
Unicode-DFS-2016, CDLA-Permissive-2.0, CC0-1.0, with `OR`/`AND`). A short `REVIEWED` list in the
script pins a few build/lint-only npm packages by name **and** licence (caniuse-lite CC-BY-4.0,
argparse Python-2.0, minimatch and graceful-fs BlueOak-1.0.0); none of them is in the binary or
the shipped SPA. **No MPL or other weak-copyleft exception is allowed** (owner, 2026-11-14):
Tailwind was removed from the web UI because its CSS compiler (lightningcss) is MPL-2.0. A new dependency outside the
allowlist fails `lint` — review it, do not widen the allowlist casually. The `zip` crate is built
with Deflate only, which keeps the bzip2-licensed codec out.

## Tests (D13, D14)

Same three kinds as Log Hub (CLAUDE.md → Test policy), in Work Hub's own places:

- **Algorithm** — docs `algorithms/workhub-*.md` with rows in `docs/algorithm-examples/`; Rust table
  tests in `server/tests/algo.rs` (also running the existing rows of `password-policy`,
  `login-backoff`, `auth-startup-config`, `local-request-detection` against the Rust port), web
  ones in `web/**/*.algo.test.ts`.
- **API contract** — `server/tests/contract/registry.rs`, one row per route; a meta-test compares it
  with `ROUTE_TABLE`. The app runs in process with schema `whc_<8hex>` and instance `whc-<8hex>`.
- **Scenario** — `work-hub/tests/scenarios/` (`@S-WH-NN`), run by `scripts/scenarios.mjs`: builds
  the web, the release server, the default and fake-agent images, creates schema
  `whs_<mode>_<8hex>`, starts the server on a free port with `WORK_HUB_INSTANCE=whs-<8hex>` and the
  mode's auth env (a: `none`; b: `password-confirm` + Mailpit; c: `password`), runs Playwright,
  then drops the schema and removes only its instance-labelled objects. A control endpoint
  (`WH_STAND_CONTROL_URL`, `POST /restart-server`) serves the restart scenarios; `--stand-only`
  starts and stops the stand without Playwright.
- **Fake agent** — `work-hub/tests/fake-agent/` (`claude.mjs` installed as the agent binary in
  image `artisyn-work-hub-fake-agent:test`), scripted login and chat commands so scenarios need no
  real agent account.
- Prerequisites: Docker, Postgres and Mailpit from the root `tests/scenarios/docker-compose.yml`.
- **Coverage is not measured** for the Rust server in the alpha (no `cargo-llvm-cov`): the ≥ 80 %
  scenario-coverage target does not apply to Work Hub yet — follow-up.
