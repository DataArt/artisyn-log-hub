# Local test bundle — not a published release

artisyn-log-hub `{{VERSION}}` — {{ARCH_LABEL}}. Built {{DATE}} from commit {{GIT_COMMIT}}.

This bundle was made by `npm run local-release-bundle` (`scripts/local-release-bundle.js`) from a
developer's working tree, possibly with uncommitted changes (a commit ending in `-dirty`), to hand
the latest code to someone for manual testing. It is **not** a published release: published
releases are installed from the GitHub Release install kit
(https://github.com/DataArt/artisyn-log-hub/releases) and pull their image from
`ghcr.io/dataart/artisyn-log-hub`. Do not run this bundle in production.

`{{VERSION}}` is the bundle's build identity — `local-` plus the UTC `YYYYMMDD-HHMMSS` moment it was
built. It names this bundle's files and is what the running app reports as `build.version`.

**This bundle runs on {{ARCH_LABEL}} hosts only** — {{ARCH_HOSTS}}. Check with `uname -m`, which
must print `{{ARCH_UNAME}}`. If it prints something else, you want the
`{{OTHER_ZIP}}` bundle instead ({{OTHER_ARCH_LABEL}}); the image inside this one will not run on
your machine.

## Contents

- `{{IMAGE_FILE}}` — exported Docker image (`ghcr.io/dataart/artisyn-log-hub:{{VERSION}}`), built
  for {{ARCH_LABEL}}
- `docker-compose.yml` — app + Postgres, with bind-mounted host directories for logs and DB data
- `.env` — ready to use as-is: fresh random `POSTGRES_PASSWORD`/`SESSION_SECRET`, `LOG_HUB_DATA_DIR`
  set to `./loghub-db` (created next to this file), and `AUTH_MODE=none` (no login — see below)
- `.env.example` — reference documenting every setting, in case you want to change one

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

## Install on a clean machine (no source code needed)

```sh
docker load -i {{IMAGE_FILE}}
docker compose up -d
```

The image comes from the tar, so `docker compose up -d` never pulls it from GHCR — the
`{{VERSION}}` tag exists only in this bundle.

If `docker compose up -d` warns that *"the requested image's platform does not match the detected
host platform"*, you are on the other architecture — load the `{{OTHER_ZIP}}` bundle's image
instead. Only the `app` image is architecture-specific; the `postgres` image is multi-arch and
Docker pulls the matching variant on its own.

No `.env` editing is required to get running. `AUTH_MODE=none` (Mode 1) auto-identifies you with
no login step, which is safe by default because the app only listens on `127.0.0.1` — see the
port note below. Mode 1 accepts only local callers: localhost, plus the container's own default
gateway, which is the address your host's traffic to the published port arrives from (inside a
container it never arrives from loopback, so without this Mode 1 could not be used at all). The
container logs the gateway it trusts at startup — `docker compose logs app` shows a line reading
`AUTH_MODE=none: container detected, also trusting default gateway ... as a local caller`. Edit
`.env` first only if you want a different data directory, or see
`docs/knowledgebase/authorization-and-authentificaiton.md` before switching `AUTH_MODE` if you
plan to expose the app beyond localhost.

`app` only starts once `db` reports healthy, so Postgres finishing its first-time image pull
and startup before `app` starts is already guaranteed — no separate prefetch step needed.

By default the app is bound to `127.0.0.1:5003` only — reachable from the host machine itself
(`http://localhost:5003`), not from other machines on the network. To expose it more broadly,
change the `ports:` mapping in `docker-compose.yml` (e.g. `"5003:3000"` to listen on all
interfaces, or `"<lan-ip>:5003:3000"` for a specific one) before running `docker compose up -d` —
and **switch `AUTH_MODE` away from `none` first.**

That last point is not optional advice: this `127.0.0.1`-only publish is the actual security
boundary for Mode 1, not the in-app local-caller check. With Docker's userland proxy every
inbound connection reaches the container from the container's default gateway — which Mode 1
trusts — so a non-loopback `ports:` mapping gives every client that can reach the port full,
password-less, auto-identified access. Change `AUTH_MODE` to `password` (or another mode) in the
same edit.

Postgres data, the upload queue, and logs are bind-mounted from `$LOG_HUB_DATA_DIR` on the
host (see `.env.example`) into `pgdata/`, `upload-queue/`, and `logs/` subdirectories. Unlike
named volumes, this data lives at a predictable host path outside of Docker's storage area, so
it survives `docker compose down` *and* `docker compose down -v`, and it's easy to back up or
inspect directly.

`docker-compose.yml` also pins `PGDATA` to a fixed subdirectory (`/var/lib/postgresql/data/pgdata`)
inside that bind mount, rather than relying on the postgres image's own default data path. The
official postgres image moves its default `PGDATA` location on every major-version bump (it was
`/var/lib/postgresql/data` through pg17, `/var/lib/postgresql/18/docker` on pg18, and may change
again). Without a pinned `PGDATA`, a version bump that changes that default — or a bind mount
that doesn't line up with it — makes Docker silently fall back to an anonymous volume for the
real data while the host bind mount stays empty; the container still starts and looks healthy,
but every future recreation re-initializes an empty database. Keep the `PGDATA` env var and the
`db` volume mount's destination path in sync if you ever change either one.

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

The bundle's `.env` sets `NODE_ENV=production`, which turns on the production checks below. Each
setting is documented in `.env.example`; uncomment it in `.env`, then run `docker compose up -d` to
apply it.

| Setting | When you need it |
|---|---|
| `SESSION_SECRET` | Optional. The bundle's `.env` carries a random one. If you leave it empty, the app generates a secret on first start and keeps it in the database. |
| `PUBLIC_BASE_URL` | **Required for `AUTH_MODE=password` and `password-confirm`.** The externally reachable URL of the app, e.g. `https://log-hub.example.com`. Confirmation and password-reset links are built only from it. In production the app refuses to start in those modes without it. |
| `ALLOWED_EMAIL_DOMAINS` | Recommended when `password-confirm` is reachable from the internet: comma-separated domains allowed to sign up, e.g. `example.com,example.org`. A malformed value stops the app at startup. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | Outgoing mail for confirmation and password-reset emails. **Required for `AUTH_MODE=password-confirm`:** the relay must also be reachable at startup, otherwise the app does not start. **Optional for `AUTH_MODE=password`:** when `SMTP_HOST` is set, `SMTP_PORT` and `SMTP_FROM` are required too and an unreachable relay only logs a warning; when it is unset, password reset is unavailable and "Forgot password?" is disabled. Not used by `none` and `azure-oauth`. |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | Optional relay credentials and TLS flag (`SMTP_SECURE` unset = `false`). Only read when `SMTP_HOST` is set. |
| `ADMIN_CONTACT_EMAIL` | **Required for `AUTH_MODE=password-confirm`**, optional for `password`. Shown to users in the "email could not be sent" messages. |
| `AUTH_RATE_LIMIT_POINTS`, `AUTH_RATE_LIMIT_WINDOW_SEC` | Rate limit on sign-up, forgot password, resend confirmation and reset password, per client IP and per email. Defaults: 5 requests per 900 seconds; `0` points turns it off. |
| `IMPORT_MAX_UPLOAD_BYTES`, `IMPORT_MAX_ENTRIES`, `IMPORT_MAX_UNCOMPRESSED_BYTES`, `IMPORT_MAX_ENTRY_BYTES` | Limits for repository zip imports. Defaults: 5 GiB upload, 20000 entries, 20 GiB uncompressed, 400 MiB per entry. An import over a limit is rejected with a message naming the setting to raise. |

The app also makes two outbound requests a day: the public npm registry, for the latest Claude Code
version, and the public Anthropic pricing page, for model prices. To turn them off (for example on an
air-gapped host), add `AI_TOOL_VERSION_CHECK_ENABLED: "false"` and
`MODEL_PRICING_FETCH_ENABLED: "false"` under the `app` service's `environment:` in
`docker-compose.yml`.

## Update to a newer local bundle

1. Copy the newer bundle's image tar and `docker-compose.yml` onto the host — from its `{{ARCH}}`
   bundle, the same architecture you are running now. The compose file names the new
   `local-<stamp>` tag, so it must be replaced together with the image. Diff the new
   `.env.example` against yours and carry over any new settings before step 3. **Keep your
   existing `.env`** — do not overwrite it with the new bundle's `.env`, which ships its own
   freshly generated `POSTGRES_PASSWORD`/`SESSION_SECRET` and would invalidate your running
   database password and active sessions.
2. `docker load -i <the new bundle's image tar>`
3. Before upgrading, confirm the `db` container's data really is on the host bind mount, not an
   orphaned anonymous volume: `docker inspect artisyn-log-hub-db --format "{{json .Mounts}}"`
   should show a `"Type": "bind"` entry whose `Source` is `$LOG_HUB_DATA_DIR/pgdata` and
   whose `Destination` (`/var/lib/postgresql/data`) matches the `db` service's volume mount in
   `docker-compose.yml`, and that directory must hold a `pgdata/` subdirectory with `PG_VERSION`.
   A `"Type": "volume"` entry with `Destination` `/var/lib/postgresql` is expected and empty: the
   postgres 18 image declares that path as a volume. Stop only if the bind entry is missing or its
   `pgdata/` is empty while the app shows data — then real data is sitting in an anonymous
   volume, and recreating the container will silently drop it.
4. `docker compose up -d` — recreates only the `app` container with the newly loaded tag; `db` is
   untouched, so Postgres has no downtime.
5. Database migrations run automatically on app startup — no manual migration step needed.
   Migrations are forward-only: going back to an older bundle on the same database is not
   supported.
6. Verify: `docker compose logs -f app` until it reports ready, then in the app's Admin panel
   → System (or `GET /api/v1/admin/system` as an admin) check that the **Build** tile —
   `build.version` in the API response — reads the new bundle's `local-<stamp>`.
