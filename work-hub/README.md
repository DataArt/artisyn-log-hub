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

### Administrators

To make someone an administrator, put their e-mail into `WORK_HUB_ADMIN_EMAILS` (several are
separated by commas, case does not matter) and restart the server:

```
WORK_HUB_ADMIN_EMAILS=alice@example.com,bob@example.com
```

An administrator sees "Admin" in the account menu. That page is a read-only resource overview:
every user, their workspaces, the open / total workstreams of each, and the disk space each
workspace takes (its files, its containers, its volumes, its images), with per-user and grand
totals and the size of the git proxy's cache. "Refresh" measures again. It never shows
connections, secrets or file contents. Everyone else gets no menu item and "Not allowed".

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

Secrets are the exception: your agent login (one per user, e.g. Claude's long-lived token) is
kept encrypted in `<data dir>/secrets/` with the key in Work Hub's database, so neither a copy of
the data directory nor a database dump alone reveals it. It is passed to the agent only in
memory and never written into a container or a workspace folder. (Whoever controls the whole
host or the Docker socket can still reach it.)

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
runs, the UI says it is still preparing its container image. It also builds its small git proxy
image (`artisyn-work-hub-git-proxy:<version>`: Alpine with git, OpenSSH client, lighttpd and curl)
the same way; see "Remote repositories and connections" below. After that first start Work Hub
itself needs no network: its web UI is embedded in the server and these instructions ship with it.
The agent inside a workstream still needs to reach its own service to answer, and a remote
repository is reachable only when its git host is.

**Installing on a machine without network access.** Build both images on a machine that has
network access and the same Work Hub version, then move them over as files:

```
npm run image                    # artisyn-work-hub-default:<version>
npm run image -- --git-proxy     # artisyn-work-hub-git-proxy:<version>
docker save -o work-hub-images.tar artisyn-work-hub-default:<version> artisyn-work-hub-git-proxy:<version>
# copy work-hub-images.tar to the offline machine, then there:
docker load -i work-hub-images.tar
```

`<version>` is the `version` in `server/Cargo.toml` (`npm run image` prints the tag it built).
When an image with that tag is already present, Work Hub uses it and builds nothing. To use
images under other names, set `WORK_HUB_DEFAULT_IMAGE` / `WORK_HUB_GIT_PROXY_IMAGE`.

### Inline (on the host)

Use it for development, or to run Work Hub straight from this folder.

1. **Prerequisites** (see above): Docker Engine running, Postgres reachable, Rust via rustup,
   bun and Node.js.
2. **Configure.** Create a database for Work Hub once (`CREATE DATABASE workhub;`), copy
   `.env.example` to `.env` and set at least `DATABASE_URL` to that database. Work Hub keeps
   everything in its schema (`WORK_HUB_DB_SCHEMA`, `work_hub` by default) and creates it on start. With
   `WORK_HUB_ENV=production` also set `SESSION_SECRET`.
3. **Install the web dependencies** once: `cd web && bun install && cd ..`.
4. **Build the images** (optional; the server builds them on first start otherwise):
   `npm run image` (default workspace image) and `npm run image -- --git-proxy` (git proxy).
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
Anthropic's own terms. The git proxy image is built the same way and contains Alpine Linux
packages (git, OpenSSH client, lighttpd, curl), each under its own licence, run as separate
programs.

## Remote repositories and connections

A workspace can start as an empty repository (as before) or as a clone of a repository on a git
host, and can push its branches back there. Everything below is optional: Work Hub works fully
without connections.

### How it works

- A **connection** is a credential for one git host: an SSH key or an access token. It belongs to
  you (open the account menu at the top right → **Connections**); other users never see it.
- Work Hub keeps the credential encrypted in `<data dir>/secrets/` (like the agent login) and hands
  it only to one small container per Work Hub install, the **git proxy** (`wh-gitproxy-<instance>`),
  which keeps it in memory. That container is the only one that talks to git hosts.
- Workspace and workstream containers never see the key or token. Their git remotes point at the
  proxy (`http://wh-git/git/<remote id>.git`), and each container holds only a short random
  capability in `/tmp/wh-git-capability` (memory only, replaced on every container start) that
  lets it use the remotes of its own workspace. So `git fetch`, `git pull` and `git push` work in
  any terminal of the workspace, for you and for the agent, without the credential being in the
  container, its files, checkpoint images or recordings.
- The proxy keeps a mirror of every remote in the Docker volume `wh-gitcache-<instance>`; each fetch
  first brings the mirror up to date from the host, and each push is passed on to the host before
  it is accepted.

### Providers

The Add connection dialog lists the supported providers:

| Provider | Server URL | SSH key | Access token |
|---|---|---|---|
| GitHub | fixed (`https://github.com`) | yes | yes (user is not needed) |
| GitLab | `https://gitlab.com` or your self-managed server (may have a path) | yes | yes |
| Azure DevOps | `https://dev.azure.com/<organization>` | yes | yes |
| Other git server | any `https://` or `http://` URL of a server speaking the git smart HTTP or SSH protocol | yes | yes (with a username) |

For **Other git server**, Test needs a repository URL, and the remote URL you paste is used as is:
an SSH connection needs an SSH URL (`ssh://user@host/path` or `user@host:path`), a token connection
an `http(s)://` URL.

### Adding a connection

1. Account menu → **Connections** → **+ Add connection**.
2. Choose the provider, enter the server URL when the provider asks for one, and a name (unique
   among your connections).
3. Choose how to authenticate:
   - **Generate a key in Work Hub** (recommended): Work Hub creates an SSH key pair and shows the
     public key. Copy it and add it as an SSH key of your account (or as a deploy key of one
     repository) on the git host; the dialog links to the host's SSH keys page when it knows it.
     The private key never leaves Work Hub.
   - **Use my own SSH key**: paste a private key (OpenSSH or PEM). If it has a passphrase, enter
     it: Work Hub removes the passphrase once and never stores it.
   - **Access token**: create a token on the git host with read and write access to repositories
     (the dialog shows the scopes and links to the host's token page when it knows it), then paste
     it. Other git servers also need the username the token belongs to. The token is write-only:
     Work Hub shows only its last four characters afterwards.
4. **Test.** For SSH, the first test shows the git host's key fingerprint ("First connection to
   <host>"). Compare it with the fingerprint the host publishes, then **Trust and pin**. Work Hub
   then refuses to talk to that host if its key ever changes. A passing test shows the account the
   host recognised.

**Edit** renames the connection, replaces the token or key (**Update key…** / **Update token…**),
or, for a generated key, creates a new pair (**Regenerate key…**: add the new public key to the
host, the old one stops working). **Delete…** lists the workspaces whose remotes still use the
connection; deleting it anyway leaves those remotes without a credential until you rebind them.

### Granting a connection to workspaces

A connection can be used only by the workspaces you grant it to (Edit → **Workspaces that may use
it**, or **Grant…** next to a connection that is not granted yet). A workspace without a grant
cannot fetch or push through it, even when one of its remotes names it.

### Cloning and remotes

- **New workspace → Start from: Clone from a connection.** Choose a connection, paste the
  repository URL as the git host shows it (HTTPS or SSH form, either works with any auth method of
  the hosted providers), pick a branch (the repository's default branch is preselected) and
  create. The dialog shows the clone progress and can cancel it. The new workspace gets the
  connection granted and a remote `origin`; an empty repository starts on `main`.
- **Settings → Remotes** of a workspace lists its remotes. **Attach remote** adds one (name, a
  granted connection, the repository URL), **Test** checks it, **Detach…** removes it from the
  workspace and its running containers.

### Push policy

Each remote has a push policy (**Push policy…** on its card), enforced by the git proxy for every
push from any terminal:

- **Block force push to the default branch** (on by default): a force push or a delete of the
  remote's default branch is rejected; a normal push to it is allowed.
- **Only allow pushing Work Hub branches (ws/\*)** (off by default): only workstream branches may
  be pushed.
- Only branches and tags can ever be pushed.

**Closing a workstream** can push too: tick **Push to <remote>** in the close dialog ("Close for
now" pushes the workstream branch, "Bring into main" pushes the working branch after the merge;
nothing is pushed when the work was already merged elsewhere). A rejected push never undoes the
close; the dialog shows why and, when the host supports it, a link to open a pull or merge request.

### Expose to agent

A token connection can additionally be given to the agent as an environment variable (**Expose to
agent as env var**, off by default), e.g. for a command-line tool that calls the host's API. The
variable is set in the agent and terminal sessions of the workspaces the connection is granted to.
Only turn it on when you need it: the agent and anything it runs can then read the token. SSH
connections cannot be exposed. The name must be upper case (`A-Z`, `0-9`, `_`), must not start
with `WH_` and must not clash with a common variable or the workspace's `containerEnv`.

### Error messages

Git in a workspace terminal prints these (after `remote:` or `fatal: remote error:`):

| Message | What to do |
|---|---|
| `Work Hub connection <name> was rejected by the host — update its credential in Settings` | the token expired or was revoked, or the key was removed from the host: update it on the Connections page |
| `Work Hub connection <name>: the host key of the git host changed — check it and re-pin it in Settings` | ask the host's admin whether the key change is expected, then Test the connection and trust the new key |
| `Work Hub connection <name> was deleted — rebind the remote in workspace settings` | attach the remote again (Settings → Remotes) with another connection |
| `Work Hub: this workspace has no grant for the connection of this remote` | grant the connection to this workspace |
| `Work Hub: unknown or revoked capability` | the container's capability is stale: restart the workstream or reopen the workspace |
| `Work Hub push policy: …` | the remote's push policy blocked the push; push a `ws/*` branch or change the policy |
| `Work Hub: the git host rejected the push:` followed by the host's own lines | the host refused it (branch protection, missing permission, non-fast-forward) |
| `Work Hub connection <name>: <message>` | any other failure reaching the host (network, DNS, a wrong URL); the last line of git's output |

When the git proxy is not ready yet (its image is being built at first start, or Docker is
unreachable), Test, clone and push answer that the git proxy is not ready; try again in a minute.

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
| `npm run image -- --git-proxy` | build the git proxy sidecar image |
