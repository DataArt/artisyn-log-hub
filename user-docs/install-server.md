# Install the server

Artisyn Log Hub is a self-hosted server and web viewer for Claude Code sessions. This page shows
how to install the server, how to check that you are its admin, and the other ways to run it.

## Install from a release

Every release is published on the
[releases page](https://github.com/DataArt/artisyn-log-hub/releases/latest) as a multi-arch
Docker image (`ghcr.io/dataart/artisyn-log-hub`, `linux/amd64` and `linux/arm64`) plus a small
install kit: a `docker-compose.yml` with Postgres, `install.sh`, `install.ps1` and an install
guide. You need a Docker Engine with the Compose v2 plugin; nothing is built locally.

Install or upgrade with one command:

```sh
# Linux, macOS, WSL
curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.ps1 | iex
```

The script installs into `$HOME/artisyn-log-hub` (Windows: `%USERPROFILE%\artisyn-log-hub`),
generates a `.env` with a random database password on the first install only, pulls the image
and starts it with `docker compose up -d`.

- Run the same command again to upgrade. An existing `.env` is never changed, and installing a
  version lower than the installed one is refused.
- Set `VERSION=X.Y.Z` to pin a release and `INSTALL_DIR` to install elsewhere.
- The install guide (the `README.md` of the release) lists every option, the manual install and
  how to verify the downloads with `SHA256SUMS`.

Open http://localhost:5003. The install starts in `AUTH_MODE=none` (Mode 1): no password, you
identify yourself with an email address, and only the local machine can connect. To let other
people in, pick another mode — see [Authentication modes](authentication-modes.md).

## Check that you are the admin

**Do this right after the install.** The first user who signs in becomes the admin; everyone
after that is a regular user. There is no setup token.

1. Sign in (or sign up) right away.
2. Open **Admin Panel** in the left navigation, then the **Users** tab, and check that your
   account has the `admin` role.
3. If there is no Admin Panel, or another account is the admin, someone signed in before you.
   Stop the app, delete the database (for a release install: `docker compose down` in the install
   directory, then delete `$LOG_HUB_DATA_DIR/pgdata`), install again and sign in first.

## Next steps

- Install the hook into a project: [Install the hook](../hook/INSTALL_HOOK.md).
- Record and open your first session: [Your first session](getting-started.md).
- Change the settings of the server: [Server settings](server-configuration.md).
- Before you open the server to anyone else, read
  [Security Hardening & Configuration](security-hardening.md).

## Other ways to run

### From a source build

```sh
npm install
npm run build          # server, client and hook installer -> dist/
```

`dist/` gets a `.env` copied from `.env.defaults` (`PORT`, `COOKIE_SECURE`, a local
`DATABASE_URL`). Set `DATABASE_URL` to your Postgres and run from the repository root:

```sh
# Linux / macOS
PORT=3000 DATABASE_URL=<url> node dist/index.js
```

```powershell
# Windows (PowerShell)
$env:PORT="3000"; $env:DATABASE_URL="<url>"; node dist/index.js
```

`SESSION_SECRET` is optional. When it is unset, the server generates one on first start and
keeps it in the database. Migrations run automatically at startup.

### Docker image

The published image runs against any Postgres you already have:

```sh
docker run -p 127.0.0.1:3000:3000 -e DATABASE_URL=<url> ghcr.io/dataart/artisyn-log-hub:latest
```

Tags: `X.Y.Z` (one release), `X.Y` (the newest patch of a line) and `latest`. To build the image
yourself from the source repository:

```sh
docker build --build-arg VERSION=local --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t ghcr.io/dataart/artisyn-log-hub:local .
```

The image sets `NODE_ENV=production` and runs the server in cluster mode. Without the build args
the build info reports `version: "unknown"` and `gitCommit: "unknown"`. The `docker-compose.yml`
at the root of the source repository is the maintainers' deployment file (it expects an external
network); for a self-contained setup use the release install above.
