# Artisyn AI Work Hub (alpha)

Work Hub is a self-hosted web workspace for working with a coding agent (Claude Code in the alpha).
Each workspace is a Docker container with its own git repository; each workstream is a branch
with its own container and an agent chat in a browser terminal. A built-in file tree and editor
let you read and change the files the agent works on, and closing a workstream brings its branch
back into the workspace's working branch.

It lives in this repository next to Log Hub but is a separate product: its own Rust server
(`server/`), its own web UI (`web/`), its own Postgres database and its own build. Nothing here is
part of Log Hub's build or `dist/`.

## Prerequisites

- **Docker Engine** reachable by the server (unix socket, Windows named pipe or `DOCKER_HOST`).
  Work Hub creates containers, volumes and images on it.
- **Postgres** with a database of its own for Work Hub (e.g. `workhub`); inside it Work Hub
  creates and uses the schema `work_hub` by default.
- **Rust 1.92** — pinned by `rust-toolchain.toml`; rustup installs it on the first `cargo` call.
- **bun** (1.4.4) for the web UI, and **Node.js** with npm for the orchestration scripts.

## Configuration

Every environment variable, its default and its meaning is listed in `.env.example` (the inline
mode reads `work-hub/.env`; real environment variables win over the file). The dockerized mode
uses `deploy/.env`, whose template `deploy/.env.example` repeats only what matters there.

## Where your files are

Every workspace is a plain folder on the machine that runs Work Hub, under the data directory
(`WORK_HUB_DATA_DIR`, `./data` by default; `WORK_HUB_FILES`, `/srv/workhub` by default, in the
dockerized mode):

```
<data dir>/users/<your email>/<workspace name>-<id>/
    workspace/repo/        the workspace's git repository (every commit, closed workstreams' branches)
    home/                  the container user's home, with the agent login (readable by its owner only)
    workspace.json         name, owner, working branch, dates
    workstreams/<workstream name>-<id>/
        workspace/worktree/    the workstream's files, on its branch ws/<name>
        workspace/repo/        the workstream's copy of the repository
        home/  workstream.json
```

The containers only mount these folders, so your files stay readable with ordinary tools (e.g.
`git log` in `workspace/repo/`) when Work Hub or Docker is down. Back up the data directory. On Linux the
files belong to the container user (uid 1000 in the default image). Deleting a workspace or
discarding a workstream in Work Hub deletes its folder.

## Running it

There are two ways to run Work Hub. Both talk to the Docker Engine of the machine they run on.

### Network and offline use

The **first start needs the network**: the server builds its default workspace image
(`artisyn-work-hub-default:<version>`: Ubuntu packages, Node.js and the Claude Code CLI) through
Docker when it is missing, and the dockerized mode also pulls its base images. While that build
runs, the UI says it is still preparing its container image. After that first start Work Hub itself
needs no network: its web UI is embedded in the server and these instructions ship with it.
The agent inside a workstream still needs to reach its own service to answer.

### Inline (on the host)

Use it for development, or to run Work Hub straight from this folder.

1. **Prerequisites** (see above): Docker Engine running, Postgres reachable, Rust via rustup,
   bun and Node.js.
2. **Configure.** Create a database for Work Hub once (`CREATE DATABASE workhub;`), copy
   `.env.example` to `.env` and set at least `DATABASE_URL` to that database. Work Hub keeps
   everything in its schema (`WORK_HUB_DB_SCHEMA`, `work_hub` by default) and creates it on start. With
   `WORK_HUB_ENV=production` also set `SESSION_SECRET`.
3. **Install the web dependencies** once: `cd web && bun install && cd ..`.
4. **Build the default image** (optional; the server builds it on first start otherwise):
   `npm run image`.
5. **Run.**
   - `npm run dev` starts the server (`cargo run`, port 3100) and the Vite dev server together.
     Open **http://localhost:5180** — Vite serves the UI and proxies `/api` to the server. Ctrl+C
     stops both.
   - `npm run start` builds the web UI, then runs the release server with the UI embedded. Open
     **http://localhost:3100** (`PORT`). Ctrl+C stops it.

The first `cargo` call downloads the pinned Rust toolchain and builds the server, which takes a few
minutes; later starts are quick.

### Dockerized

Work Hub and its own Postgres run as a Docker Compose stack; the app drives the host's Docker
Engine through the mounted socket `/var/run/docker.sock`.

1. **Configure.** From `work-hub/`: copy `deploy/.env.example` to `deploy/.env` and set at least
   `POSTGRES_PASSWORD` and `SESSION_SECRET` (any long random string). `WORK_HUB_PORT` (5010) is
   the host port of the UI. `WORK_HUB_FILES` (`/srv/workhub`) is the host folder with everyone's
   files (see "Where your files are"); on Docker Desktop for Windows also set
   `WORK_HUB_FILES_ENGINE` as `deploy/.env.example` explains. The other variables are described in
   `.env.example`.
2. **Start:** `docker compose -f deploy/docker-compose.yml up -d --build`. The first build compiles
   the web UI and the server inside Docker (several minutes); then the app builds the default
   workspace image on its first start.
3. **Open** **http://localhost:5010**.
4. **Logs:** `docker compose -f deploy/docker-compose.yml logs -f app`.
5. **Stop:** `docker compose -f deploy/docker-compose.yml down`. The database stays in the volume
   `workhub-pg`, the files in `WORK_HUB_FILES`, and the workspace containers stay on the Docker
   Engine. `down -v` also deletes the database, but neither the files nor those workspace
   objects: delete the workspaces in the UI first.

**Security note.** The app container runs as root and has the host's Docker socket. Access to the
Docker socket is equivalent to root on the host, so treat the app like any other process with that
access: keep `AUTH_MODE=none` (no password; only requests from the same machine may identify) for a
single-user install, and use `password`, `password-confirm` or `azure-oauth`, HTTPS and
`TRUST_PROXY` / `COOKIE_SECURE=true` for anything shared.

### Third-party software in the default image

The default workspace image is built on your machine and is not part of the Work Hub binary. It
contains separately licensed programs that Work Hub runs but does not link: Ubuntu packages
(including git, GPL-2.0, unmodified and used as a separate program) and the Claude Code CLI, under
Anthropic's own terms.

## Commands

All run from `work-hub/`.

| Command | What it does |
|---|---|
| `npm run build` | build the web UI, then the release server binary |
| `npm run lint` | `cargo fmt --check`, `cargo clippy`, web eslint, agent-name check, licence check of every dependency |
| `npm run typecheck` | `tsc --noEmit` over the web UI and the browser tests |
| `npm run test:algo` | Rust and web algorithm tests |
| `npm run test:contract` | API contract tests |
| `npm run test:scenarios` | browser scenarios on an isolated stand |
| `npm run dev` | server and Vite dev server (http://localhost:5180) |
| `npm run start` | build the web UI, then the release server with it embedded (http://localhost:3100) |
| `npm run image` | build the default workspace container image |
