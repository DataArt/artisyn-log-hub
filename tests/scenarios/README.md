# Scenario suite

End-to-end scenarios that run against an **isolated stand**: `npm run test:scenarios` builds the
app into `tmp/scenarios/stand/`, starts its own server process on a free port and in its own
Postgres schema (`scn_<mode>_<8 hex>`) for each auth mode, drives it with Playwright and drops the
schema afterwards. It never uses the dev server on `:3000`/`:5173`, never writes into the dev
database's `public` schema and never touches `server/src/public/static` — the runner fingerprints
both before and after the run and fails if either changed.

Maintainer notes (stand layout, modes, fixtures, helpers) live in
[`docs/knowledgebase/test/scenarios.md`](../../docs/knowledgebase/test/scenarios.md). The older
suites are described in [`tests/README.md`](../README.md).

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js 24 | the runner imports `tests/scenarios/modes.ts` directly through Node's built-in type stripping |
| [`bun`](https://bun.sh) | installs `client/` dependencies; the stand build runs that `vite` with Node |
| PostgreSQL | every stand gets its own schema in `DATABASE_URL` |
| Mailpit (SMTP + HTTP API) | mode B (`password-confirm`) confirms signups through real emails |
| Playwright Chromium | `npx playwright install chromium` once |
| Docker (optional) | the easiest way to get Postgres and Mailpit: `docker compose -f tests/scenarios/docker-compose.yml up` |

`npm install` in the repo root, `server/` and `artisyn-hooks-installer/`, and `bun install` in
`client/`, are assumed — the stand is built from the working tree.

## Environment

Start Postgres 16 and Mailpit in the background, then run the suite:

```sh
docker compose -f tests/scenarios/docker-compose.yml up -d
npm run test:scenarios
```

The compose file publishes Postgres on `5432` (user `postgres`, password `pw`) and Mailpit on
`1025` (SMTP) and `8025` (HTTP API), which are exactly the runner's defaults, so no variable has
to be set. Stop it with `docker compose -f tests/scenarios/docker-compose.yml down`.

The runner checks everything first (preflight) and exits with code **2** and a readable message
when something is missing: the database is unreachable, Mailpit does not answer (only when mode B
is selected), the Chromium browser is not installed, or a stray `tmp/scenarios/.env.local` exists
(the stand bundle would load it as overrides).

### Environment variables

| Variable | Set by | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | you | `postgresql://postgres:pw@localhost:5432/postgres` | Postgres that holds the stand schemas |
| `MAILPIT_URL` | you | `http://localhost:8025` | Mailpit HTTP API (mode B) |
| `MAILPIT_SMTP` | you | `localhost:1025` | Mailpit SMTP, becomes the stand's `SMTP_HOST`/`SMTP_PORT` |
| `STAND_URL` | runner → Playwright | — | `baseURL` of the stand (`http://127.0.0.1:<port>`) |
| `STAND_MODE` | runner → Playwright | — | `a`, `b` or `c` |
| `STAND_SCHEMA` | runner → Playwright | — | the stand's schema, used by the `db` fixture |
| `STAND_RUN_DIR` | runner → Playwright | — | the stand's working dir; its `upload-queue/` and `export-import/` sub-dirs are the stand's `UPLOAD_QUEUE_DIR` and `EXPORT_IMPORT_DIR` |
| `SCENARIOS_COVERAGE` | you | not set | `1` starts the stand with `NODE_V8_COVERAGE`; after each stand the runner writes a c8 report to `tmp/coverage/scenarios-<runId>/<mode>/report/` |
| `PUBLIC_BASE_URL` | runner → stand | `STAND_URL` | base URL of links in emails; required in mode B |
| `ADMIN_CONTACT_EMAIL` | runner → stand | `admin@arrakis.test` | required in mode B |

The `runner → …` variables are set by `scripts/scenarios/run.mjs`; you never set them yourself.
The stand gets no `.env` file: its whole environment comes from `tests/scenarios/modes.ts`.

### Modes

| Mode | `AUTH_MODE` | `NODE_ENV` | Notes |
|---|---|---|---|
| A | `none` | `test` | identify-only login |
| B | `password-confirm` | `production` | `PASSWORD_POLICY=long`, SMTP to Mailpit; runs in two passes on two fresh stands (`@backoff` tests last), because login backoff counts per IP |
| C | `password` | `test` | signup + login |

A scenario declares its modes with tags in its title: `@mode-a`, `@mode-b`, `@mode-c`.

### Runner options

```sh
npm run test:scenarios -- --mode a          # one mode (a, b, c or a list: a,c)
npm run test:scenarios -- --grep S-AUTH-01  # only matching titles
npm run test:scenarios -- --mode a --grep @TOUR-  # only the screen tours (tests/scenarios/tours/)
npm run test:scenarios -- --skip-build      # reuse tmp/scenarios/stand/ as is
npm run test:scenarios -- --only scenarios  # pick steps: scenarios, corpus, contract (all by default)
npm run test:scenarios -- --mode a --only corpus  # only the session corpus (tests/corpus/), mode-A stand
npm run test:scenarios -- --only contract   # only the API vs DB contract suite: no stand, no Mailpit, no browser
```

The `corpus` step runs the Playwright project `corpus` ([`corpus/`](corpus/), the session corpus of
[`tests/corpus/`](../corpus/README.md)) on the mode-A stand, in the same pass as `mode-a` when both
are selected. The `contract` step runs `npm run test:contract` in `server/` after the modes, with the runner's
`DATABASE_URL` (see [`server/test/contract/README.md`](../../server/test/contract/README.md)).

The stand is rebuilt only when its inputs changed (content hash of `client/`, `server/src`,
`server/drizzle`, `hook/`, `artisyn-hooks-installer/`). The HTML report lands in
`tmp/scenarios/report/<pass>/`, the stand's log in `tmp/scenarios/run-<runId>/<mode>/stand.log`.

The stand build updates the installer in place, like `npm run build`, so never run the two at the
same time.

### Frozen legacy hooks (S-COMPAT-01)

`tests/fixtures/legacy-hooks/<version>/` holds old hook versions exactly as they shipped; they stand
for users who never upgrade and are never edited or refreshed. To freeze another version (read-only
`git archive`, the version is checked against the commit's `version.json`):

```sh
git log --format=%h -- hook/.claude/telemetry_tool/version.json   # find the commit
node scripts/scenarios/freeze-legacy-hook.mjs --commit <sha> [--label <version>]
```

The installer scenarios (`installer/`) need nothing extra: they run the CLI from the stand's own
installer tarball with a fake `claude`. The one test that runs the real `claude plugin validate` is
skipped when no `claude` is on PATH.

## Running every suite

| Suite | Command | Run from | Needs |
|---|---|---|---|
| Server (Jest, real DB) | `npm run test` | `server/` | Postgres |
| Client (Vitest) | `bun run test` | `client/` | nothing |
| Hook (`node --test`) | `npm test` | `hook/` | nothing |
| Installer (`node --test` via tsx) | `npm test` | `artisyn-hooks-installer/` | nothing |
| Build scripts (`node --test`) | `npm run test:scripts` | repo root | nothing |
| Tests typecheck | `npm run typecheck:tests` | repo root | nothing |
| Scenarios (this suite) | `npm run test:scenarios` | repo root | Postgres, Mailpit, Chromium |
| API vs DB contracts | `npm run test:contract` | `server/` | Postgres (also the `contract` step of `npm run test:scenarios`) |
| Log-format corpus | `npm run test:scenarios -- --mode a --only corpus` | repo root | as scenarios — being added; until then `--only corpus` is rejected |
| Documentation audit | `npm run audit:docs` | repo root | a logged-in Claude Code (`claude -p`) — being added |

The server tests, `npm run build` and the dev-server e2e suite share resources and must run one at
a time. The scenario suite is independent of the dev server, but it builds into the same installer
directory as `npm run build`, so it belongs to that serial group too.
