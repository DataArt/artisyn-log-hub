# Artisyn Log Hub

Artisyn Log Hub is a self-hosted server and web viewer for [Claude Code](https://docs.claude.com/en/docs/claude-code)
sessions. A Claude Code hook, installed into a project, uploads the session transcripts and related
telemetry to your own Log Hub server. The web app then lets you and your team browse sessions turn by
turn, see token usage and cost, compare harness setups (CLAUDE.md, rules, skills, MCP servers) and
produce reports.

> **Disclaimer.** This project is not affiliated with or endorsed by Anthropic, Cursor or GitHub.
> "Claude" and "Claude Code" are trademarks of Anthropic.

**Read [What is collected](#what-is-collected) before you install the hook.** It uploads complete
session transcripts, including file contents and command output.

## Repository layout

| Path | Contents |
|---|---|
| `server/` | NestJS server: API, authentication, log ingestion, migrations, scheduled jobs. See [server/README.md](server/README.md). |
| `client/` | React web app. See [client/README.md](client/README.md). |
| `hook/` | The Claude Code hook (source of truth). See [hook/README.md](hook/README.md) and [hook/INSTALL_HOOK.md](hook/INSTALL_HOOK.md). |
| `artisyn-hooks-installer/` | The `npx` installer that puts the hook into a project. The server serves it. |
| `release-template/` | Files of the self-contained release bundle (Docker image + compose). |
| `tests/e2e/` | Playwright end-to-end tests. |
| `docs/` | Knowledge base and task history. |

## Quick start

The easiest install is a release bundle: a Docker image, a `docker-compose.yml` with Postgres, and a
ready-to-use `.env`. You need a Docker Engine with the Compose v2 plugin. The bundle's `INSTALL.md`
has the details; in short, unzip the bundle for your CPU architecture and run in its folder:

```sh
docker load -i artisyn-log-hub-<stamp>-<arch>.tar
docker compose up -d
```

Open http://localhost:5003. The bundle starts in `AUTH_MODE=none` (Mode 1): no password, you
identify yourself with an email address, and only the local machine can connect.

To build a bundle yourself from this repository, run `npm run release` (needs Docker; writes
`release/`).

### Check that you are the admin

**Do this right after the install.** The first user who signs in becomes the admin; everyone after
that is a regular user. There is no setup token.

1. Sign in (or sign up) right away.
2. Open **Admin Panel** in the left navigation, then the **Users** tab, and check that your account has
   the `admin` role.
3. If there is no Admin Panel, or another account is the admin, someone signed in before you. Stop the
   app, delete the database (for the release bundle: `docker compose down`, then delete
   `$LOG_HUB_DATA_DIR/pgdata`), install again and sign in first.

### Install the hook into a project

In the web app, open **API Keys**, create a key and copy the install command from the **Install** tab.
It looks like this and is run from the root of the project you want to record:

```sh
npx "<server-origin>/static/artisyn-hooks-installer.tgz" install --server-url "<server-origin>" --api-key "<your-api-key>"
```

The installer prints what will be collected. Sessions show up in the web app after the next Claude
Code turn ends. See [hook/INSTALL_HOOK.md](hook/INSTALL_HOOK.md) for all options and for uninstalling.

## Other ways to run

### From a source build

```sh
npm install
npm run build          # server, client and hook installer -> dist/
```

`dist/` gets a `.env` copied from `.env.defaults` (`PORT`, `COOKIE_SECURE`, a local `DATABASE_URL`).
Set `DATABASE_URL` to your Postgres and run from the repository root:

```sh
# Linux / macOS
PORT=3000 DATABASE_URL=<url> node dist/index.js
```

```powershell
# Windows (PowerShell)
$env:PORT="3000"; $env:DATABASE_URL="<url>"; node dist/index.js
```

`SESSION_SECRET` is optional. When it is unset, the server generates one on first start and keeps it in
the database. Migrations run automatically at startup.

### Docker image

```sh
docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t artisyn-log-hub .
docker run -p 127.0.0.1:3000:3000 -e DATABASE_URL=<url> artisyn-log-hub
```

The image sets `NODE_ENV=production` and runs the server in cluster mode. Without
`--build-arg GIT_COMMIT=...` the build info reports `gitCommit: "unknown"`. The `docker-compose.yml`
at the repository root is the maintainers' deployment file (it expects an external network); for a
self-contained setup use the release bundle.

## Authentication modes

`AUTH_MODE` selects one of four modes:

| Value | Mode | Use it for |
|---|---|---|
| `none` | Mode 1, no password | One user on their own machine. Only local callers are accepted. |
| `password` | Mode 2, email and password | A small team on a trusted network. |
| `password-confirm` | Mode 3, email, password and emailed confirmation | Anything reachable from the internet. Needs SMTP. |
| `azure-oauth` | Mode 4, Azure Entra ID sign-in | Organisations on Microsoft Entra ID, single tenant. |

In every mode the first user to sign in becomes the admin.

## Configuration

The main settings are below. [server/README.md](server/README.md) lists every variable and
`server/.env.example` documents each one.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string. |
| `PORT` | `3000` | HTTP listen port. |
| `AUTH_MODE` | `password` | See above. The release bundle sets `none`. |
| `SESSION_SECRET` | generated | Optional. Generated and stored in the database when unset. |
| `PUBLIC_BASE_URL` | — | Externally reachable URL, used for the links in emails. Required in production for Modes 2/3. |
| `ALLOWED_EMAIL_DOMAINS` | any | Mode 3 sign-up allow-list, comma-separated domains. |
| `COOKIE_SECURE` | `true` | Set `false` when served over plain HTTP. |
| `TRUST_PROXY` | `false` | Set when running behind a reverse proxy. When enabled it overrides `COOKIE_SECURE`. |
| `SESSION_RETENTION_DAYS` | `30` | Sessions older than this are deleted. |
| `AI_TOOL_VERSION_CHECK_ENABLED` | on | `false` turns off the outbound npm version check. |
| `MODEL_PRICING_FETCH_ENABLED` | on | `false` turns off the outbound pricing-page fetch. |

## What is collected

The hook sends a lot of data to the server it is configured for. The full description, per hook
event, is in [hook/README.md](hook/README.md#what-is-collected).

**Full transcripts.**

- The complete Claude Code transcripts of the project, **including earlier sessions** of the same
  repository that are still on disk when the hook is installed.
- That means every prompt, every tool input and tool result, the contents of every file Claude read,
  and the output of every command Claude ran. Secrets that appeared in a session are uploaded with it.
- The hook does not redact transcripts.

**Local context.**

- `CLAUDE.md` files, rules, skills, agents and MCP server configuration of the project, plus the
  user-level skills, plugins and MCP configs that apply to it.
- The git remote URL (with any `user:password@` part removed) and git `user.name`.
- Absolute paths, including the project root and transcript paths, which usually contain your OS user
  name.
- `logTail`: the last 50 lines of the hook's own `hook.log`, sent with each upload for diagnostics.

**Other channels.**

- **Post-turn analysis.** When the server asks, the hook runs a local `claude -p` (cost advisor and
  session attribution) with your Claude Code account and sends the result.
- **OTEL export.** The installer turns on Claude Code's OpenTelemetry export to a loopback receiver,
  with `OTEL_LOG_TOOL_DETAILS=1` (tool names and parameters). The hook uploads what it receives.
- **Code inventory.** The number of git-tracked files and lines (`trackedFiles`, `trackedLines`).
- **Session attribution.** A short classification of what the session was about.
- **MCP probe.** On each `Stop`, the hook starts each configured stdio MCP server briefly to list its
  tools, waiting at most `mcpProbeTimeoutMs` (default 3000 ms) per server.

**How to stop sending.** Remove `apiKey` from `.artisyn/config/log-hub.local.json` or `serverUrl`
from `.artisyn/config/log-hub.json`; the hook then records locally but uploads nothing. Or uninstall the
hook (`npx <server-origin>/static/artisyn-hooks-installer.tgz uninstall`).

**Who operates the server, retention and rights.**

- The data goes to whichever server `serverUrl` points at. Whoever runs that server (usually your
  employer or team) controls the data and is responsible for it. This project runs no hosted service
  and receives none of it.
- The server deletes sessions older than `SESSION_RETENTION_DAYS` (default 30). Users can delete their
  own account, which removes their data.
- Requests to access, correct or delete personal data go to the server operator.
- **Employers:** tell employees before you install the hook in their projects. Explain what is
  collected, who can see it and how long it is kept, and check that this fits your employment and
  data-protection rules.

## Trust model

- **The server sees everything listed above.** Point the hook only at a server you trust, and use
  `https://` for anything that is not on your own machine. Plain `http://` is accepted.
- **The API key identifies you.** Uploads are attributed to the key's owner. Keep the key in the
  gitignored `log-hub.local.json`, never in the tracked `log-hub.json`.
- **The server can make the hook run `claude -p`**, with your Claude Code account and usage.
- **The hook runs with your user rights**, like any Claude Code plugin.
- **The installer is fetched with `npx` from the server** with no checksum or signature, so it is only
  as trustworthy as that server and the connection to it.
- **Inside the server,** you see your own sessions. Teams can share sessions between members: a
  member becomes visible to the team only after accepting a disclosure notice, and the team's access
  mode and roles decide who sees prompts and reports. The app admin can read any session's raw logs.
- **The OTEL receiver listens on `127.0.0.1` only** and has no token, so another local process
  running as you could post to it.

The in-app help article *Security hardening* lists the known limitations and accepted risks.

## Security notes

- **Mode 1 (`AUTH_MODE=none`): publish the port on `127.0.0.1` only.** Inside a container, Mode 1
  also trusts the container's default gateway, because that is where host traffic to the published
  port comes from. With Docker's userland proxy every inbound connection arrives from that gateway, so
  a port published on all interfaces lets every client that can reach it sign in, without a
  password, as any user, including the admin. The release bundle publishes `127.0.0.1:5003` only. Switch `AUTH_MODE` to another mode
  before you change that.
- **Outbound requests.** Once a day the server asks the public npm registry for the latest Claude Code
  version (`AI_TOOL_VERSION_CHECK_ENABLED`, on by default) and fetches the public Anthropic pricing
  page (`MODEL_PRICING_FETCH_ENABLED`). Set either to `false` to turn it off, for example on air-gapped
  installs.
- **`PUBLIC_BASE_URL`.** Confirmation and password-reset links are built only from this value, never
  from the request's `Host` header. Set it on every Mode 2/3 deployment; in production the server
  refuses to start in those modes without it.
- **Internet-facing Mode 3.** Anyone who can reach the sign-up page can create an account. Set
  `ALLOWED_EMAIL_DOMAINS` to limit sign-up to your domains. Sign-up, password reset and resend are
  rate-limited (`AUTH_RATE_LIMIT_POINTS`, `AUTH_RATE_LIMIT_WINDOW_SEC`).
- **Azure (Mode 4) is single-tenant only.** `AZURE_TENANT_ID` must be your tenant GUID; `common`,
  `organizations`, `consumers` and domain names are rejected at startup, and sign-ins from other
  tenants are refused.
- **Secrets.** In Modes 2–4 the server warns at startup when it sees a known example `SESSION_SECRET` or database
  password. Replace them.

## For developers

The repository is set up so that a new developer can clone it and work the same way the maintainer
does: in the maintainer's Claude Code harness, with the project's own sessions logged to a local Log
Hub (dogfooding).

1. **Clone and install.** You need Node.js 22, [Bun](https://bun.sh), Docker and Git.

   ```sh
   git clone <repository-url>
   cd artisyn-log-hub
   npm install
   (cd server && npm install && cp .env.example .env)
   (cd client && bun install)
   ```

2. **Start Postgres, the server and the client.**

   ```sh
   docker compose -f server/artisyn-log-run-local/docker-compose.yml up -d
   (cd server && npm run start:dev)     # API on http://localhost:3000
   (cd client && bun run dev)           # web app on http://localhost:5173
   ```

   Point `DATABASE_URL` in `server/.env` at that database
   (`postgresql://postgres:pw@localhost:5432/a-log`). The end-to-end tests also need
   `PASSWORD_POLICY=any` and `AUTH_RATE_LIMIT_POINTS=0` in it.

3. **Work in the harness.** Open the repository in Claude Code. `CLAUDE.md` and `.claude/` (rules,
   skills, settings) are the maintainer's harness and are checked in on purpose: the build, lint and
   test commands, the work cycle and the project conventions all live there.

4. **Dogfood logging via `.artisyn/`.** `.claude/settings.json` enables the `log-hub-hooks` plugin from
   the project-local marketplace in `.artisyn/marketplace/`, a copy of `hook/`. Your Claude Code
   sessions in this repository are therefore uploaded to your local Log Hub. To make that work on
   your machine:
   - Sign in to your local Log Hub, create an API key and put it in the gitignored
     `.artisyn/config/log-hub.local.json` as `{ "apiKey": "<key>" }`. Without a key the hook only
     records locally.
   - In `.artisyn/config/log-hub.json`, change `serverUrl` if your server is not at
     `http://localhost:5173`, and `otelReceiverPort` if port `58603` is taken on your machine.
   - If you change `otelReceiverPort`, change the port in the `OTEL_EXPORTER_OTLP_*_ENDPOINT` values in
     `.claude/settings.json` to match.
   - Change other local values (ports, `context` labels) the same way. Keep machine-specific secrets in
     the gitignored `*.local.json` files.

5. **Change the hook in `hook/`**, not in the `.artisyn/` copy. `npm run build:hooks-installer`
   rebuilds the installer, and `.claude/rules/hook.md` describes how to refresh the dogfood copy.

The canonical build, lint and test commands are listed in `CLAUDE.md`.

## Licence

Artisyn Log Hub is released under the MIT licence; see [LICENSE](LICENSE). Third-party packages and
their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
