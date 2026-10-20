# Tests

How the test suites of this repository are laid out, what each one needs from your machine, and
which scenarios depend on how the server under test is configured. Deeper per-layer notes for
maintainers live in [`docs/knowledgebase/test/`](../docs/knowledgebase/test/overview.md).

## Test layers and commands

These are the only supported commands. Run each one from the directory in the last column.

| Layer | What it covers | Command | Run from |
|---|---|---|---|
| Build | all packages into `dist/` | `npm run build` | repo root |
| Client lint | eslint over `client/` | `bun run lint` | `client/` |
| Client typecheck | `tsc` over the client | `bun run typecheck` | `client/` |
| Client algorithms | Vitest over the doc-driven `*.algo.test.ts` (the only client unit tests) | `bun run test` | `client/` |
| Server lint | eslint over `server/` | `npm run lint` | `server/` |
| Server typecheck | `tsc` over `server/src` and `server/test` | `npm run typecheck` | `server/` |
| Server algorithms | Jest over the doc-driven `*.algo.spec.ts` (the only server unit tests), `--runInBand` | `npm run test` | `server/` |
| Build scripts | `node --test` over `scripts/__tests__` and `client/scripts/__tests__` | `npm run test:scripts` | repo root |
| Hook algorithms | `node --test` over the `*.algo.test.js` in `hook/.claude/telemetry_tool/__tests__/` (list collected by `hook/scripts/run-tests.js`) | `npm test` | `hook/` |
| E2E, fast | Playwright, only tests tagged `@core` (under 3 minutes) | `npm run test:e2e` | repo root |
| E2E, full | Playwright, every spec in `tests/e2e/` | `npm run test:e2e:full` | repo root |

The root `package.json` has no `lint` or `test` script. Use the per-package commands above, not
`npx vitest`, `npx playwright test` or a bare `jest`.

### Things that must not overlap

The contract suite, both e2e suites and `npm run build` share resources, so run them one at a time:

- the contract suite and the e2e suites use the same Postgres database;
- the build rewrites `server/src/public/static/*`, and a backend running in watch mode reloads
  on that, which drops the backend in the middle of an e2e run.

Lint, typecheck, the algorithm tests (server `npm run test`, client, hook) and `test:scripts` touch
neither, so they can run alongside anything.

## Environment requirements

| Requirement | Needed by | Notes |
|---|---|---|
| Node.js and npm | everything | |
| [`bun`](https://bun.sh) | client lint, typecheck and unit tests; the client part of `npm run build` | `client/` is a bun project (`client/bun.lock`) |
| PostgreSQL on `localhost:5432` | contracts, scenarios, e2e | `server/artisyn-log-run-local/docker-compose.yml` starts one. The contract suite reads `DATABASE_URL` / `DB_USER` / `DB_PASSWORD` from `server/.env` and creates a throwaway `contract_*` schema per run. |
| Backend on `localhost:3000` | e2e | started from `server/` (`npm run start:dev`), configured by `server/.env` (an optional `server/.env.local` overrides it) |
| Vite dev client on `localhost:5173` | e2e | started from `client/` (`bun run dev`); it proxies `/api`, `/static` and `/health` to `:3000`. All Playwright traffic goes through it. |
| Mailpit on `localhost:1025` (SMTP) and `localhost:8025` (HTTP API) | the two `*-mailpit.spec.ts` specs | see [Mailpit](#mailpit) |
| Playwright browsers | e2e | `npx playwright install chromium` once |

The e2e suite does not start the backend or the client. It drives whatever is running on
`:5173`/`:3000`, and its DB helper (`tests/e2e/helpers/db.ts`) must reach the same database. It
reads `DATABASE_URL` / `DB_USER` / `DB_PASSWORD` from the environment, falling back to the root
`.env.defaults`.

### Hard-coded ports

The ports are fixed in code, not read from configuration:

| Port | Where |
|---|---|
| 5173 | `playwright.config.ts` (`baseURL`), `tests/e2e/helpers/credentials.ts` (`BASE_URL`) |
| 3000 | `client/vite.config.ts` (dev proxy) |
| 5432 | `.env.defaults`, the local docker-compose file |
| 8025 | `tests/e2e/helpers/mailpit.ts` (override with `MAILPIT_BASE_URL`) |

### Dev-server settings the e2e suite assumes

Set these in the `server/.env` of the backend that the e2e suite drives:

| Setting | Why |
|---|---|
| `PASSWORD_POLICY=any` | the e2e identities use the password `12345678`, which the default `long` policy rejects (password modes only) |
| `AUTH_RATE_LIMIT_POINTS=0` | the suite signs in many times from `127.0.0.1`; the default of 5 per 15 minutes would return 429 within the first specs |

The server Jest run (algorithm tests only) boots no app and needs neither setting.

All test identities use the reserved `.test` domain (`muaddib@arrakis.test` and similar, see
`tests/e2e/helpers/credentials.ts`). The first account ever created becomes admin, so on an empty
database the e2e setup project creates the admin identity first. On a database that already had
users before the first e2e run, `muaddib@arrakis.test` is created as a regular user. Promote it
to admin once (Admin Panel → Users, or `UPDATE users SET role = 'admin' WHERE email =
'muaddib@arrakis.test'`); otherwise the setup sweep fails with `GET /admin/repos failed (403)`.

### Mailpit

`password-reset-mailpit.spec.ts` and `email-confirmation-mailpit.spec.ts` read the real email the
server sends. Start Mailpit and point the backend's SMTP at it:

```sh
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
```

```dotenv
# server/.env
SMTP_HOST=localhost
SMTP_PORT=1025
```

If Mailpit is not running these two specs fail with "No Mailpit message found". They are not
skipped. Under `AUTH_MODE=none` they skip before Mailpit is needed.

## AUTH_MODE matrix

The e2e suite does not set `AUTH_MODE`. Its config-level `globalSetup` asks the running server
(`GET /api/v1/auth/config`), passes the answer to every worker, and prints a **Skipped scenarios**
summary that lists each mode-gated or Mailpit-gated spec and the reason, before any test runs.
Authentication adapts automatically: under `none` sessions come from `POST /api/v1/auth/identify`,
and under the password modes from signup, confirmation through a DB read, and login.

| Spec | `none` | `password` | `password-confirm` | `azure-oauth` |
|---|---|---|---|---|
| `password-reset.spec.ts` | skipped | runs | runs | not supported |
| `password-reset-mailpit.spec.ts` | skipped | runs, needs Mailpit | runs, needs Mailpit | not supported |
| `email-confirmation-mailpit.spec.ts` | skipped | skipped (no confirmation step) | runs, needs Mailpit | not supported |
| every other spec | runs | runs | runs | not supported |

`azure-oauth` cannot be driven by the suite: sign-in goes through Microsoft, and the setup
project has no way to open a session.

Two specs also skip single tests at run time, with an explicit reason, when the environment does
not match:

- `admin-panel.spec.ts`, "System Info … single-process dev fallback and DB Space": skipped when the
  server runs under a cluster supervisor, is a stamped release build (version not `dev`), or its DB
  role cannot read table sizes;
- `analytics-horizontal-view.spec.ts`, "clicking a session bar": skipped when no session bar is
  rendered for the seeded repo.

The scenario suite runs every auth mode on its own stand (see `tests/scenarios/README.md`).
