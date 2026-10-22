# Artisyn Log Hub — server

The NestJS server of Artisyn Log Hub. It provides the HTTP API (log ingestion from the hook, the
viewer's read API, authentication and admin), runs the database migrations and the scheduled jobs
(upload queue, session retention, pricing and version checks), and in production serves the built
web client.

> **Disclaimer.** This project is not affiliated with or endorsed by Anthropic, Cursor or GitHub.
> "Claude" and "Claude Code" are trademarks of Anthropic.

## Requirements

- Node.js 22.
- PostgreSQL 18. For local work, `artisyn-log-run-local/docker-compose.yml` starts one on
  `127.0.0.1:5432` (database `a-log`, user `postgres`, password `pw`, data in the gitignored
  `artisyn-log-run-local/data/`):

  ```sh
  docker compose -f artisyn-log-run-local/docker-compose.yml up -d
  ```

  The container is named `log-hub-postgres` on the Docker network `log-hub-net`, so Claude
  sandboxes (`scripts/claude-docker`) can share it; the usage above stays the same.

## Setup

```sh
cd server
npm install
cp .env.example .env    # then edit DATABASE_URL and the other values you need
```

The server loads `server/.env` at startup, then `server/.env.local` on top of it (gitignored; put
real secrets such as Azure credentials there).

## Run

| Command | Purpose |
|---|---|
| `npm run start:dev` | Watch mode on `PORT` (default 3000). Also rebuilds the hook installer tarball first. |
| `npm run start` | Single run, no watch. |
| `npm run start:debug` | Watch mode with the Node inspector. |

For the full UI in development, run the client next to it (`cd client && bun run dev`, see
[client/README.md](../client/README.md)) and open http://localhost:5173.

The production build is made from the repository root with `npm run build`: it bundles the server with
`ncc` into `dist/index.js` and copies the client, static files and migrations next to it. The Docker
image runs that bundle in cluster mode (`CLUSTER_MODE=primary`, one worker per instance slot).

## Database migrations

- Migrations are hand-written SQL files in `drizzle/migrations/`, listed in
  `drizzle/migrations/meta/_journal.json`. The Drizzle schema in `src/database/schema/index.ts` must
  match them. Do not generate migrations with `drizzle-kit generate`.
- **They run automatically at server start** (`initializeDatabase()`, under a Postgres advisory lock,
  so several workers or instances can start at once).
- `npm run migrate` runs the same step without starting the server.
- `npm run migrate:reset` drops the whole `public` schema and migrates from scratch. It refuses to run
  when `NODE_ENV=production`.
- `npm run seed` creates a debug user and API key for development. It also refuses to run in
  production.

### Committed migrations are immutable

Drizzle records a hash of each applied migration but never checks it again, so an edited migration
is silently skipped on a migrated database and yields a different schema on a clean one. Therefore:

- Never edit, rename or delete a committed migration or an existing `meta/_journal.json` entry —
  not even a comment. Every database change is a **new** migration.
- After adding one, run `npm run migrations:lock`. It appends a row `{idx, tag, when, sha256,
  acceptedHashes}` to `drizzle/migrations/meta/migrations.lock.json` (append-only, never edit it by
  hand). It refuses, naming the tag, if a locked migration's file changed.
- The `pre-commit` hook (`.githooks/`, installed by the root `npm install` via `prepare`) rejects
  commits that modify, rename or delete a migration already in `HEAD`, or change existing journal
  entries / manifest rows.
- `npm run test:scripts` (from the repository root) reconciles the manifest with the journal and the
  files, so the guard also holds where the hook is not installed (CI, `--no-verify`).
- At startup (and in `npm run migrate`) the server checks every migration file against the manifest
  and every row of `__drizzle_migrations` against the manifest's `acceptedHashes` (LF and CRLF
  checkouts and historical versions count). On a mismatch, or an applied migration missing from the
  journal, it **does not start**.
- There is no bypass flag or environment variable. A local dev/test database that applied a
  different version of a migration has to be rebuilt with `npm run migrate:reset`.

## Tests

| Command | Purpose |
|---|---|
| `npm run test` | Jest over the doc-driven algorithm tests (`src/**/*.algo.spec.ts`) and the migration lock check. No DB, no app. |
| `npm run test:contract` | The API vs DB contract suite (`test/contract/`), its own app and `contract_*` schema on a real Postgres. |
| `npm run lint` | ESLint with auto-fix (cache in `../tmp/`). |
| `npm run typecheck` | `tsc --noEmit`. The `ncc` build only compiles what `src/main.ts` imports, so this is the only check that covers `test/**`. |

The contract suite uses the database in `DATABASE_URL`, but each run creates and drops its own
schema, so it does not touch your data. `test/contract/setup/global-setup.ts` sets its environment
(short queue intervals, `AUTH_MODE=password-confirm`, outbound fetches off, a high auth rate limit).
Server behaviour is otherwise tested by the scenario suite (see `tests/scenarios/README.md`). Jest usually
prints `Jest did not exit one second after the test run has completed`; that is a known open handle,
not a failure.

The browser end-to-end tests (Playwright) are run from the repository root (`npm run test:e2e`) against
the running dev server and client.

## Environment variables

`.env.example` documents each variable with its default. Variables marked **new** were added for the
open-source release; see the changelog in the in-app help for the upgrade steps.

### Core

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | **Required.** PostgreSQL connection string. `DB_USER`/`DB_PASSWORD` override the credentials in it. |
| `PORT` | `3000` | HTTP listen port. |
| `NODE_ENV` | — | `production` turns on the production checks: Modes 2/3 require `PUBLIC_BASE_URL`, and `migrate:reset`/`seed` refuse to run. The Docker image and the release bundle set it. |
| `SESSION_SECRET` | generated | Session-cookie signing secret. When unset, the server generates one on first start and stores it in the `server_secrets` table. A known example value only logs a warning. |
| `COOKIE_SECURE` | `true` | Set `false` when the app is served over plain HTTP. |
| `TRUST_PROXY` | `false` | Express `trust proxy` value (`true`, a hop count or an IP/CIDR list). When enabled it overrides `COOKIE_SECURE` and makes `req.ip` the real client address. |
| `PUBLIC_BASE_URL` | `http://localhost:5173` outside production | **New.** Externally reachable URL, used for the links in confirmation and password-reset emails. Never taken from the request `Host` header. Required in production for Modes 2/3; without it no email with a link is sent. |
| `RELEASE_LINK_SECRET` | derived from `SESSION_SECRET` | **New.** HMAC key for release download links. Changing it invalidates links already handed out. |
| `DB_POOL_MAX` | `20` | Connection pool size per process (capped per worker in cluster mode). |
| `ENV_NAME` | `local` | Environment label shown in the page header, e.g. `[local] Artisyn Log Hub`. |

### Authentication

| Variable | Default | Notes |
|---|---|---|
| `AUTH_MODE` | `password` | `none` (Mode 1, local only), `password` (Mode 2), `password-confirm` (Mode 3, emailed confirmation), `azure-oauth` (Mode 4). The first user to sign in becomes admin in every mode. |
| `PASSWORD_POLICY` | `long` | `any`, `mid` or `long`, for Modes 2/3. |
| `ADMIN_CONTACT_EMAIL` | — | Required in Mode 3. Shown to users when an email cannot be delivered. |
| `ALLOWED_EMAIL_DOMAINS` | any domain | **New.** Mode 3 sign-up allow-list: comma-separated domains without `@`, matched exactly. A malformed value stops the server at startup. |
| `AUTH_RATE_LIMIT_POINTS` | `5` | **New.** Requests allowed per IP and per email address on sign-up, forgot password, resend confirmation and reset password. `0` disables the limit. Counted per worker process. |
| `AUTH_RATE_LIMIT_WINDOW_SEC` | `900` | **New.** Window for the limit above, in seconds. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` | — | Required in Mode 3, optional in Mode 2 (password reset by email then never succeeds). |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | —, —, `false` | SMTP authentication and TLS. |
| `AZURE_TENANT_ID` | — | Mode 4. **Must be your tenant GUID**: multi-tenant values (`common`, `organizations`, `consumers`, a domain) stop the server at startup, and sign-ins whose token `tid` is a different tenant are refused. |
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI` | — | Mode 4 app registration. |
| `AZURE_AUTHORITY`, `AZURE_SCOPES` | derived, `openid profile email` | Optional. `AZURE_AUTHORITY` must point at the same tenant GUID. |

### Ingestion, queue and limits

| Variable | Default | Notes |
|---|---|---|
| `LOGS_MAX_BODY_MB` | `2500` | Body limit of `POST /api/v2/logs` only. Other routes accept at most 500 KB, and the hook's other API-key routes 1 MB. |
| `UPLOAD_QUEUE_DIR` | `upload-queue` | Where uploads are staged before the queue worker stores them. |
| `UPLOAD_QUEUE_INTERVAL_MS`, `UPLOAD_QUEUE_LEASE_TIMEOUT_MS`, `UPLOAD_QUEUE_TICK_BUDGET_MS` | `1000`, `180000`, `500` | Queue worker timing. |
| `UPLOAD_QUEUE_STATS_WINDOW_MS`, `UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS`, `UPLOAD_QUEUE_MEASUREMENT_PRUNE_INTERVAL_MS` | 15 min, 7 days, 5 min | Admin queue statistics. |
| `UPLOAD_QUEUE_PARTIAL_UPLOAD_TTL_MS`, `UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS` | 24 h, 10 min | Cleanup of abandoned chunked uploads. |
| `IMPORT_MAX_UPLOAD_BYTES` | 5 GiB | **New.** Largest repository zip accepted for import. |
| `IMPORT_MAX_ENTRIES` | `20000` | **New.** Most entries in an import zip. |
| `IMPORT_MAX_UNCOMPRESSED_BYTES` | 20 GiB | **New.** Total uncompressed size of an import zip. |
| `IMPORT_MAX_ENTRY_BYTES` | 400 MiB | **New.** Uncompressed size of one entry in an import zip. |
| `EXPORT_IMPORT_DIR` | `export-import` | Temporary files of repository export and import jobs. |
| `EXPORT_IMPORT_JOB_TTL_MS`, `EXPORT_IMPORT_CLEANUP_INTERVAL_MS` | 30 min, 5 min | Export and import jobs and their files are deleted after the TTL. |
| `RELEASES_DIR` | `releases/` next to the bundle | Directory listed by Admin → System → Release Downloads (absolute path). |

An import over a limit is rejected with HTTP 400 and a message naming the variable to raise.

### Scheduled jobs and outbound requests

| Variable | Default | Notes |
|---|---|---|
| `SESSION_RETENTION_DAYS` | `30` | Sessions older than this are purged. |
| `SESSION_RETENTION_CHECK_INTERVAL_MS`, `SESSION_RETENTION_PURGE_BATCH_SIZE` | 30 min, `200` | Purge schedule. |
| `TURN_END_ADVISOR_ORPHAN_CLEANUP_INTERVAL_MS`, `TURN_END_ADVISOR_ORPHAN_RETENTION_MS` | 30 min, 24 h | Cleanup of advisor runs without a session. |
| `AI_TOOL_VERSION_CHECK_ENABLED` | on | Daily request to the public npm registry for the latest Claude Code version. Set `false` to turn it off (air-gapped installs). |
| `AI_TOOL_VERSION_CHECK_INTERVAL_MS` | 1 h | Scheduler tick for that check. |
| `MODEL_PRICING_FETCH_ENABLED` | on | Daily fetch of the public Anthropic pricing page for model prices. Set `false` to turn it off. |
| `MODEL_PRICING_FETCH_INTERVAL_MS` | 1 h | Scheduler tick for that fetch. |

`CLUSTER_MODE` is set by the Docker image and is not meant to be set by hand.

## Licence

MIT — see [LICENSE](../LICENSE). Third-party packages are listed in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
