# 2026-10-15: Claude Code Dev Container (docker-dev + local infra + hook)

**Status:** todo
**Priority:**
**Type:** feature
**Module(s):** infra / dev environment, hook
**Owner:** denis.tsyplakov
**Created:** 2026-10-15

## Description

Provide a Claude Code dev container for this repository so that Claude can run with
`--dangerously-skip-permissions` in an isolated Linux environment instead of directly on the
developer's host. The work has three parts:

- **A. Local infrastructure:** a checked-in compose file with Postgres (data on a persistent named
  Docker volume) and Mailpit.
- **B. Dev image and launcher:** a Linux image with Node/npm, bun, Claude Code, Chrome and Playwright;
  the whole project directory is mounted into the container, OS-dependent directories live on
  container volumes, the required ports are forwarded, the host TEMP directory is mounted for pasted
  images, and a launch script created in this repo starts everything.
- **C. Telemetry hook in the container:** Claude sessions run inside the container are reported to
  Log Hub like host sessions, without corrupting the hook state that the host and the container share
  through the bind mount (`.artisyn/ai_work_dir/`).

Currently the DB is `server/artisyn-log-run-local/docker-compose.yml` (`postgres:18.4`, `127.0.0.1:5432`,
DB `a-log`, data is a bind mount from the Windows disk). The old data is not needed.

## Functional Requirements

### A. Infrastructure

- FR-A1. Compose file `local-run/docker-compose.yml` (checked-in) with `postgres` and `mailpit`;
  fixed `container_name`/`hostname` (`log-hub-postgres`, `log-hub-mailpit`) and network name, so that
  the dev container connects by name. Replaces `server/artisyn-log-run-local/docker-compose.yml`:
  the old compose and its data directory are deleted together with the database, references to them
  are updated.
- FR-A2. `postgres:18.4`, data in an external named volume `log-hub-pgdata` (`external: true`, so
  `docker compose down -v` does not delete it); the volume is created by an idempotent
  `docker volume create`. Not a bind mount: a Windows bind mount does not honor fsync and lists a
  changing directory inconsistently, so after a power loss the cluster may fail WAL recovery
  (`could not create file …: File exists`). The DB is created from scratch, the schema is applied by
  the server migrations on startup.
- FR-A3. Ports and credentials are unchanged: `5432` (`a-log`, `postgres`/`pw`), Mailpit
  `1025`/`8025`; published only on `127.0.0.1`. `server/.env`, `.mcp.json`, jest and scenarios work
  without changes.
- FR-A4. healthcheck (`pg_isready`), `restart: unless-stopped`, `stop_grace_period` (e.g. `2m`, so
  Postgres can shut down cleanly); optionally tuned `max_connections`/`shared_buffers` for the
  parallel test suites.

### B. Dev container

- FR-B1. **Image** `docker-dev/Dockerfile`: `ubuntu:24.04`, user `dev` uid 1000 (the stock `ubuntu`
  user is removed so the uid is free), passwordless sudo; Node/npm of the host versions, bun,
  Claude Code (native binary), Google Chrome and Playwright chromium, language server for
  `typescript-lsp`, `postgresql-client`, `socat`, `git`, `jq`, `ripgrep`. `Dockerfile.dockerignore`
  is an allow-list. No Python.
  Design notes:
  - Split downloads across parallel BuildKit stages; a multi-connection downloader (e.g.
    `aria2c -x16 -s16`) helps when sites throttle per-connection speed.
  - Verify every downloaded archive against its official sha256.
  - Claude Code: the official native binary, verified against its release manifest, laid out the
    same way `claude install` does so that auto-update works.
  - Chrome: the official `.deb` plus its dependencies fetched with `apt-get install --download-only`
    and installed offline (list `libasound2t64` explicitly on 24.04).
- FR-B2. **Mounts**: the whole project directory → `/workspace` (bind mount). On top of it, container
  volumes for OS-dependent content: five `node_modules` (root, `client/`, `server/`, `hook/`,
  `artisyn-hooks-installer/`) and the caches `~/.npm`, `~/.bun`, `~/.cache/ms-playwright`. Empty
  `node_modules` volumes are populated by the entrypoint (`npm ci` / `bun install --frozen-lockfile`).
- FR-B3. **Host TEMP** read-only at `/host-tmp` + the `HOST_TEMP` variable, for images pasted with
  Ctrl+V (they arrive as Windows paths); the guide (FR-B7) explains how to translate a Windows path
  to `/host-tmp/…`.
- FR-B4. **Ports**: development happens in the container: Claude itself starts the backend (`3000`)
  and the Vite client (`5173`) there; they are published to the outside on `127.0.0.1:3000` and
  `127.0.0.1:5173`, so the UI and the host hook work at the same addresses as before. Inside the
  container, socat forwards on `127.0.0.1` to `log-hub-postgres:5432`, `log-hub-mailpit:1025/8025`
  and WebStorm MCP `host.docker.internal:64542`, so that `server/.env`, `.mcp.json`,
  `playwright.config.ts` work without changes. `nodelay` is set on both legs of every socat forward
  (without it Nagle + delayed ACK add ~40 ms per DB round trip and make tests several times slower).
- FR-B5. **Launch script** `scripts/claude-docker.ps1` (plus a thin `scripts/claude-docker.cmd`
  wrapper if convenient), created in this repo: brings up the infrastructure with
  `docker compose up -d --no-recreate` (without `--no-recreate` a changed compose would recreate a
  service the host backend depends on), builds the image if it is missing, creates/starts the
  container (`docker run -d --init … sleep infinity`) and runs
  `docker exec -it … claude --dangerously-skip-permissions <args>`; running it again in another
  terminal opens one more session in the same container. Flags `--shell`, `--reset` (rebuild the
  image with cache and recreate the container; refused while `claude` is alive).
- FR-B6. **Entrypoint and Claude profile**: `docker-dev/entrypoint.sh` (runs as root) `chown`s the
  volumes to `dev`, populates empty `node_modules` volumes (FR-B2), merges
  `docker-dev/settings.template.json` into the profile with `jq -s '.[0] * .[1]'` (user keys win),
  starts the socat forwards (FR-B4) and ends with `exec sleep infinity`.
  `CLAUDE_CONFIG_DIR=/workspace/docker-dev/claude-home` (git-ignored, login and history survive
  `--reset`). The project plugins (`log-hub-hooks`, `adlc-lh`, `typescript-lsp`) work; a shim
  `npx.cmd` → `npx` for Playwright MCP.
- FR-B7. **Guide** `docker-dev/CLAUDE.container.md` → `/etc/claude-code/CLAUDE.md` (managed policy,
  takes priority over the repo `CLAUDE.md` where they diverge): Linux/bash; Claude starts and
  restarts the dev server and client in the container itself; build and tests run in the container;
  `/host-tmp` for images; Docker is not available from inside.
- FR-B8. **Git**: `safe.directory /workspace`, `core.autocrlf input`, `core.filemode false`, author
  taken from the host `git config`.
- FR-B9. Everything in `docker-dev/`, `local-run/` and the launch script is checked-in, with no
  developer machine paths (they are taken from the environment).
- FR-B10. **Build isolation**: `npm run build` in the container must not disrupt a backend running in
  watch mode (the build rewrites `server/src/public/static/*`, which the watch backend reloads on).
  The guide (FR-B7) states that the build and the e2e/contract suites never run concurrently (the
  `app` group of `repo-health-checks.json`), and the launcher/guide make clear that only one
  watch backend (host or container) is active on port `3000` at a time.

### C. Hook in the container

- FR-C1. Claude sessions from the container (transcript, prompts, OTEL through the receiver inside
  the container) reach Log Hub under the same repository; paths in the change surface are
  repo-relative.
- FR-C2. The hook state in `.artisyn/ai_work_dir/` is shared between host and container through the
  bind mount. Container sessions must not corrupt or clobber host state: no absolute Linux paths
  written where the host expects Windows paths (or vice versa), no conflicting writes to the same
  state files from two OSes, no file-locking assumptions that break across the bind mount. If needed,
  container state is kept apart (e.g. a container-specific subdirectory or a separate work dir via
  environment variable).
- FR-C3. If this requires hook changes: in `hook/` with tests, `npm run build:hooks-installer`,
  update of the dogfood install; the upload format is backward compatible.

### General

- FR-D1. `.gitignore`: `docker-dev/claude-home/`.
- FR-D2. KB article `docs/knowledgebase/docker-dev-container.md` (launch, what is mounted, ports,
  volumes, limitations) + a line in `index.md`; references in `CLAUDE.md`/`README.md` to the new
  compose.
- FR-D3. The rule "the server and client are already running, do not restart them" has already been
  replaced (2026-10-15) in `CLAUDE.md` and `repo-health-checks.json → environmentNotes` with "Claude
  starts them itself when needed"; in the container the same applies through FR-B7.
- FR-D4. After the DB is recreated, the user wipes the working directories (old DB data,
  `.artisyn/ai_work_dir/`, etc.) and reinstalls the hook (new API key) themselves; this is out of the
  task scope; the old state does not need to be migrated or preserved.

## Non-Functional Requirements

- The container has no Docker socket and no private keys or credentials beyond the Claude login.
- Tests in the container are not noticeably slower than on the host (`nodelay` on socat is mandatory).

## Acceptance Criteria

- [ ] The launch script from scratch brings up `log-hub-postgres` (data in the `log-hub-pgdata`
      volume) and `log-hub-mailpit`, builds the image and opens Claude inside the container; a second
      console is a second session; `--shell` and `--reset` work.
- [ ] The old `server/artisyn-log-run-local/docker-compose.yml` is deleted; `docker compose down -v`
      does not delete the volume.
- [ ] In the container the static checks, server `npm run test`, `npm run test:e2e` pass;
      `npm run build` passes and does not drop a running watch backend mid-suite.
- [ ] The backend and client started in the container open from the host at `http://localhost:5173`.
- [ ] An image pasted with Ctrl+V is readable by Claude in the container through `/host-tmp`.
- [ ] Playwright MCP and postgres MCP work in the container; the Claude login survives `--reset`.
- [ ] The host `node_modules` are unchanged after working in the container; the host `git status`
      shows no false changes.
- [ ] A session from the container is visible in the UI under the project repository with logs, cost
      and OTEL data; host sessions run afterwards still upload correctly (shared
      `.artisyn/ai_work_dir/` not corrupted).
- [ ] The KB article and index are updated.

## Open Questions

## Notes

<!-- Append timestamped notes here as work progresses -->
**2026-10-15:** Merged with the drafts `2026-10-15-dev-infra-compose` and
`2026-10-15-hook-in-dev-container`.

**2026-10-15:** Requirements simplified by the user's decision: the old DB data is deleted (no
migration), the whole project is mounted into the container, development happens in the container,
ports `3000`/`5173` are published to the outside.

**2026-10-20:** Design notes previously kept in a separate `notes.md` folded into the FRs above;
`notes.md` removed.
