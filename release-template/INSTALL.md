# Artisyn Log Hub {{VERSION}}

Release `v{{VERSION}}`, built from commit `{{GIT_COMMIT}}`.

The app runs as two containers: the Log Hub image `ghcr.io/dataart/artisyn-log-hub:{{VERSION}}`
(multi-arch: `linux/amd64` and `linux/arm64`, Docker picks the right one) and Postgres. Docker
pulls both images from their registries; there is no image file to download and nothing to build.

## Release files

| File | What it is |
|---|---|
| `install.sh` | Installer and upgrader for Linux, macOS and WSL (POSIX `sh`) |
| `install.ps1` | Installer and upgrader for Windows (Windows PowerShell 5.1 or PowerShell 7) |
| `docker-compose.yml` | App + Postgres, pinned to image `{{VERSION}}`, with bind-mounted host directories for logs and DB data |
| `env.example` | Every setting `docker-compose.yml` reads, documented. The installers save it as `.env.example` (GitHub does not allow release file names that start with a dot) |
| `README.md` | This guide |
| `artisyn-log-hub-{{VERSION}}.zip` | The same files in one archive, for manual installs |
| `SHA256SUMS` | SHA-256 checksums of all the files above |

## Requirements

A **Docker Engine** (the daemon) plus the `docker` CLI with the Compose v2 plugin — nothing else,
no source code. Docker Desktop is *not* required: any distribution that gives you a Docker Engine
works, e.g. **Rancher Desktop** (pick the `dockerd`/moby container engine, not containerd), Colima,
OrbStack, or `docker-ce` installed straight from your distro's package repository on Linux.

Verify before you start — both commands must succeed, and `docker version` must print a **Server**
section, not just a Client one:

```sh
docker version
docker compose version
```

`install.sh` also needs `curl`; `install.ps1` needs nothing extra. Both need outbound HTTPS to
`github.com` and `ghcr.io`.

## Install or upgrade with one command

Linux, macOS, WSL:

```sh
curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.ps1 | iex
```

The same command installs a fresh copy and upgrades an existing one. It:

1. checks that Docker and Compose are installed and that the Docker daemon is running;
2. downloads `docker-compose.yml` and `env.example` of the requested release;
3. refuses to install a version lower than the one already installed (database migrations only go
   forward), unless `FORCE=1` is set;
4. copies the files into the install directory, keeping the previous compose file as
   `docker-compose.yml.prev`;
5. on the first install only, generates `.env` from `.env.example` with a random
   `POSTGRES_PASSWORD` and `SESSION_SECRET` and `NODE_ENV=production`. **An existing `.env` is never
   changed** — your database password and settings survive every upgrade;
6. runs `docker compose pull` (on failure it restores the previous compose file) and
   `docker compose up -d`;
7. prints the install directory and the URL — `PUBLIC_BASE_URL` from `.env` when set, otherwise
   `http://localhost:5003`.

Options, all optional, passed as environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `VERSION` | `latest` | Release to install: `latest`, `X.Y.Z` or `vX.Y.Z` |
| `INSTALL_DIR` | `$HOME/artisyn-log-hub` (Windows: `%USERPROFILE%\artisyn-log-hub`) | Where `docker-compose.yml`, `.env` and the data directory live |
| `FORCE` | unset | `1` allows installing a lower version than the installed one. Only for restoring together with a database backup made on that version |

To install exactly this release:

```sh
curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/download/v{{VERSION}}/install.sh | VERSION={{VERSION}} sh
```

```powershell
$env:VERSION = '{{VERSION}}'; irm https://github.com/DataArt/artisyn-log-hub/releases/download/v{{VERSION}}/install.ps1 | iex
```

Run the installer again with the same `INSTALL_DIR` for every upgrade. Database migrations run
automatically when the new app container starts.

## Install manually

The same steps as the installer, by hand:

1. Create the install directory and download `docker-compose.yml` and `env.example` of this
   release into it (or unpack `artisyn-log-hub-{{VERSION}}.zip` there). Save `env.example` as
   `.env.example`.
2. First install only: copy `.env.example` to `.env` and replace the two `change-me` values with
   random ones, e.g. `openssl rand -hex 18` for `POSTGRES_PASSWORD` and `openssl rand -hex 32` for
   `SESSION_SECRET`. Add a line `NODE_ENV=production` at the end. Restrict the file to your user
   (`chmod 600 .env`). On an upgrade keep your existing `.env`, and only carry over new settings
   from the new `.env.example` if you need them.
3. `docker compose pull`
4. `docker compose up -d`
5. Open `http://localhost:5003`.

## Verify the downloads

Every release file is listed in `SHA256SUMS` and has a GitHub build attestation that proves it was
built by this repository's release workflow. To check the files before you run anything:

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify install.sh -R DataArt/artisyn-log-hub
gh attestation verify oci://ghcr.io/dataart/artisyn-log-hub:{{VERSION}} -R DataArt/artisyn-log-hub
```

On Windows, compare `(Get-FileHash install.ps1 -Algorithm SHA256).Hash` with its line in
`SHA256SUMS` (case does not matter). If you want to verify the installer before running it,
download it, verify it, then run the local file: `sh install.sh` or
`powershell -ExecutionPolicy Bypass -File install.ps1`.

### Security scanners and `install.ps1`

Every release lists the VirusTotal result of `install.sh`, `install.ps1` and the zip in its notes.
Antivirus engines report nothing, but on the VirusTotal page of `install.ps1` the **Crowdsourced
Sigma Rules** block shows one *medium* match: **"Usage Of Web Request Commands And Cmdlets -
ScriptBlock"**. That is a threat-hunting rule, not a malware verdict: it flags any PowerShell
script that calls `Invoke-WebRequest` (or `Invoke-RestMethod`, `WebClient`, `curl`, ...). The
installer has to download `docker-compose.yml` and `env.example` of the release from
`github.com`, so it matches by design, and so does the `irm ... | iex` one-liner itself. An EDR
on your machine may raise the same alert when you run it.

If your policy does not allow running a downloaded PowerShell script, or `irm | iex` at all, do
not run the installer: use the zip, which needs no script and no web request from PowerShell.

1. Download `artisyn-log-hub-{{VERSION}}.zip` and `SHA256SUMS` from the release page in your
   browser.
2. Check the zip: `(Get-FileHash artisyn-log-hub-{{VERSION}}.zip -Algorithm SHA256).Hash` must
   equal its line in `SHA256SUMS`. With the GitHub CLI you can also prove it was built by this
   repository: `gh attestation verify artisyn-log-hub-{{VERSION}}.zip -R DataArt/artisyn-log-hub`.
3. Unpack it. The zip holds one folder, `artisyn-log-hub/` (with `.env.example` already named
   so): that folder is the install directory. Follow [Install manually](#install-manually) from
   step 2 inside it. On Windows, a random hex secret for `.env` comes from
   `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`
   (use 18 bytes for `POSTGRES_PASSWORD`), or from any password manager.
4. To upgrade, check the new zip the same way and unpack it into the same parent directory, so its
   files replace the ones in `artisyn-log-hub/` (on Windows: `Expand-Archive -Force`). The zip holds no `.env`, so yours is kept. Then
   run `docker compose pull` and `docker compose up -d` in that folder.

## Upgrade from an old zip bundle

Installs made from the old per-architecture zip bundles (which shipped the app image as
a `.tar` file) use `image: artisyn-log-hub:latest`. To move such an install onto the published
images, run the installer with `INSTALL_DIR` set to the bundle directory — the one holding its
`docker-compose.yml` and `.env`:

```sh
curl -fsSL https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.sh | INSTALL_DIR=/path/to/old/bundle sh
```

```powershell
$env:INSTALL_DIR = 'C:\path\to\old\bundle'; irm https://github.com/DataArt/artisyn-log-hub/releases/latest/download/install.ps1 | iex
```

It keeps your `.env` (so the database password and `LOG_HUB_DATA_DIR` stay the same), replaces the
compose file and recreates the containers on the same data. Use the bundle directory, not a new
one: the container names are fixed, so a second install directory would clash with the running
containers. Afterwards you can delete the image `.tar` files, the old local image
(`docker image rm artisyn-log-hub:latest`), the release download-link secret line in `.env` (if you set one) and the
`releases/` subdirectory of `LOG_HUB_DATA_DIR` — none of them are used any more.

## Access and authentication

The generated `.env` sets `AUTH_MODE=none` (Mode 1): it auto-identifies you with no login step,
which is safe by default because the app only listens on `127.0.0.1` — see the port note below.
Mode 1 accepts only local callers: localhost, plus the container's own default gateway, which is
the address your host's traffic to the published port arrives from (inside a container it never
arrives from loopback, so without this Mode 1 could not be used at all). The container logs the
gateway it trusts at startup — `docker compose logs app` shows a line reading
`AUTH_MODE=none: container detected, also trusting default gateway ... as a local caller`. Read
[Authorization and Authentication](https://github.com/DataArt/artisyn-log-hub/blob/v{{VERSION}}/docs/knowledgebase/authorization-and-authentificaiton.md)
before switching `AUTH_MODE` if you plan to expose the app beyond localhost.

`app` only starts once `db` reports healthy, so Postgres finishing its first-time image pull
and startup before `app` starts is already guaranteed — no separate prefetch step needed.

By default the app is bound to `127.0.0.1:5003` only — reachable from the host machine itself
(`http://localhost:5003`), not from other machines on the network. To expose it more broadly,
change the `ports:` mapping in `docker-compose.yml` (e.g. `"5003:3000"` to listen on all
interfaces, or `"<lan-ip>:5003:3000"` for a specific one) and run `docker compose up -d` —
and **switch `AUTH_MODE` away from `none` first.** Note that the installer replaces
`docker-compose.yml` on every upgrade (the previous one stays as `docker-compose.yml.prev`), so
re-apply a changed `ports:` mapping after each upgrade.

That last point is not optional advice: this `127.0.0.1`-only publish is the actual security
boundary for Mode 1, not the in-app local-caller check. With Docker's userland proxy every
inbound connection reaches the container from the container's default gateway — which Mode 1
trusts — so a non-loopback `ports:` mapping gives every client that can reach the port full,
password-less, auto-identified access. Change `AUTH_MODE` to `password` (or another mode) in the
same edit.

## Data

Postgres data, the upload queue, and logs are bind-mounted from `$LOG_HUB_DATA_DIR` on the
host (default `./loghub-db`, next to `docker-compose.yml`) into `pgdata/`, `upload-queue/`, and
`logs/` subdirectories. Unlike named volumes, this data lives at a predictable host path outside
of Docker's storage area, so it survives `docker compose down` *and* `docker compose down -v`, and
it's easy to back up or inspect directly.

`docker-compose.yml` also pins `PGDATA` to a fixed subdirectory (`/var/lib/postgresql/data/pgdata`)
inside that bind mount, rather than relying on the postgres image's own default data path. The
official postgres image moves its default `PGDATA` location on every major-version bump (it was
`/var/lib/postgresql/data` through pg17, `/var/lib/postgresql/18/docker` on pg18, and may change
again). Without a pinned `PGDATA`, a version bump that changes that default — or a bind mount
that doesn't line up with it — makes Docker silently fall back to an anonymous volume for the
real data while the host bind mount stays empty; the container still starts and looks healthy,
but every future recreation re-initializes an empty database. Keep the `PGDATA` env var and the
`db` volume mount's destination path in sync if you ever change either one.

Before an upgrade you can confirm the `db` container's data really is on the host bind mount:
`docker inspect artisyn-log-hub-db` must show, under `Mounts`, a `"Type": "bind"` entry whose
`Destination` is `/var/lib/postgresql/data` and whose `Source` is `$LOG_HUB_DATA_DIR/pgdata`, and
that directory must hold a `pgdata/` subdirectory with `PG_VERSION` in it. A second,
`"Type": "volume"` entry with `Destination` `/var/lib/postgresql` is expected: the postgres 18
image declares that path as a volume, so Docker always adds an anonymous one there; with the
pinned `PGDATA` it stays empty. Data is in the wrong place only when the bind mount is missing or
its `pgdata/` is empty while the app shows data — stop and move it before recreating the
container. Back up `$LOG_HUB_DATA_DIR` before an upgrade: migrations only go forward, and the only
way back to an older version is that version plus a backup made on it.

## Right after install: check that you are the admin

The first user who signs in becomes the admin; everyone after that is a regular user. There is no
setup token, so do this straight away:

1. Open the app and sign in (in Mode 1, identify yourself with your email address).
2. Open **Admin Panel** in the left navigation, then the **Users** tab, and check that your account
   has the `admin` role.
3. If there is no Admin Panel, or another account is the admin, someone signed in before you. Run
   `docker compose down`, delete `$LOG_HUB_DATA_DIR/pgdata`, run `docker compose up -d` again and
   sign in first.

Do the same check whenever you switch `AUTH_MODE` on a fresh database.

## Settings

The generated `.env` sets `NODE_ENV=production`, which turns on the production checks below. Each
setting is documented in `.env.example`; uncomment it in `.env`, then run `docker compose up -d` to
apply it.

| Setting | When you need it |
|---|---|
| `SESSION_SECRET` | Optional. The generated `.env` carries a random one. If you leave it empty, the app generates a secret on first start and keeps it in the database. |
| `PUBLIC_BASE_URL` | **Required for `AUTH_MODE=password` and `password-confirm`.** The externally reachable URL of the app, e.g. `https://log-hub.example.com`. Confirmation and password-reset links are built only from it. In production the app refuses to start in those modes without it. The installers also print it as the app URL. |
| `ALLOWED_EMAIL_DOMAINS` | Recommended when `password-confirm` is reachable from the internet: comma-separated domains allowed to sign up, e.g. `example.com,example.org`. A malformed value stops the app at startup. |
| `AUTH_RATE_LIMIT_POINTS`, `AUTH_RATE_LIMIT_WINDOW_SEC` | Rate limit on sign-up, forgot password, resend confirmation and reset password, per client IP and per email. Defaults: 5 requests per 900 seconds; `0` points turns it off. |
| `IMPORT_MAX_UPLOAD_BYTES`, `IMPORT_MAX_ENTRIES`, `IMPORT_MAX_UNCOMPRESSED_BYTES`, `IMPORT_MAX_ENTRY_BYTES` | Limits for repository zip imports. Defaults: 5 GiB upload, 20000 entries, 20 GiB uncompressed, 400 MiB per entry. An import over a limit is rejected with a message naming the setting to raise. |

The app also makes two outbound requests a day: the public npm registry, for the latest Claude Code
version, and the public Anthropic pricing page, for model prices. To turn them off (for example on an
air-gapped host), add `AI_TOOL_VERSION_CHECK_ENABLED: "false"` and
`MODEL_PRICING_FETCH_ENABLED: "false"` under the `app` service's `environment:` in
`docker-compose.yml` (and re-apply that edit after each upgrade, like a changed `ports:` mapping).

## Check the running version

`docker compose logs -f app` until it reports ready, then open the app's Admin panel → System (or
`GET /api/v1/admin/system` as an admin): the **Build** tile — `build.version` in the API response —
reads `{{VERSION}}`, and its caption shows the short form of commit `{{GIT_COMMIT}}`. `GET /health/version`
returns the same two values without signing in.
