---
paths:
  - "server/**"
---

This is a NestJS application.

# Work cycle

Follow the `adlc-lh:check-health` skill (build/lint/test commands come from
`.claude/repo_config/repo-health-checks.json`). If it is not clear whether a failure is a broken
test or an error in the code — ask the user.

# Tests

**Always run tests via `npm run test` (from `server/`) — never `npx jest` or bare `jest`.**
The server jest suite holds only doc-driven algorithm tests (`*.algo.spec.ts`). Tests come in
three kinds only (CLAUDE.md → "Test policy"): algorithm doc rows, an API contract row
(`server/test/contract/registry/`), or a step in an existing scenario (`tests/scenarios/`; a new
scenario only for a new feature). Never add `*.spec.ts` / `*.e2e-spec.ts` for server behaviour.
`npm run test` runs `jest --runInBand` with no global setup — it needs no DB and no running app.

# Notes

I do not have python, do not try to use or install.
If you need some auxiliary scripts - use nodeJS.
Use only TypeScript.

# Database migrations

Migrations live in `server/drizzle/migrations/` and run automatically on app startup via
`initializeDatabase()` (`server/src/database/database-init.ts`).

That function is the single entry point for all database setup, and it runs **before the NestJS
context is created** — `main.ts` awaits it ahead of `NestFactory.create()`, and
the contract suite's `test/contract/setup/global-setup.ts` awaits it ahead of compiling its test module. `npm run
migrate` calls the same function. Consequences to respect:

- Any new startup-time schema/data step belongs **inside `initializeDatabase()`**, as another
  sequential step — not in a NestJS lifecycle hook. A hook runs after providers are constructed,
  which is what previously let the interval-driven schedulers query tables mid-migration.
- A new non-`main.ts` entry point that boots `AppModule` must call `initializeDatabase()` first,
  or it will run against an unmigrated database.

**Add a migration**: create a new `.sql` file in `drizzle/migrations/` and add an entry to `meta/_journal.json`. Naming pattern: `NNNN_<short-description>.sql`. Then run `npm run migrations:lock` (from `server/`). Never edit a committed migration.

**Run migrations manually** (e.g. after adding a new file):
```sh
npm run migrate
```

**Reset DB and re-run all migrations from scratch** (destructive — drops public schema):
```sh
npm run migrate:reset
```
Use `migrate:reset` when the DB state is out of sync with the migration tracking table (symptom: `relation "X" does not exist` errors on startup despite migrations being marked applied).

After seeding a fresh DB, run `npm run seed` to create the debug user and API key.

After any DB related changes, check that there are relevant migrations and migrations do not delete data unless this is directly stated in requirements.

# Server logs

Logs are written to `server/logs/` (gitignored).

- **Format:** `app-YYYY-MM-DD.log` — a new file starts every day.
- **Retention:** no automatic cleanup exists — files accumulate indefinitely until manually
  removed or the container is recreated.
- **Console:** colourised output is also written to stdout at the same time, prefixed with
  `[iN]` (N = `NODE_APP_INSTANCE`, the worker slot index) when running as a cluster worker, so log
  lines from different cluster workers can be told apart. No prefix in dev or in the cluster primary
  (`NODE_APP_INSTANCE` is unset outside cluster mode).
- **Logger:** `server/src/common/app-logger.ts` — wraps Pino (`pino` + `pino-pretty` for the
  console stream, plus a custom daily-rotating file stream). Passed to `NestFactory.create()`
  in `main.ts`, so all NestJS internal log calls go through it.

To tail the current log file:
```sh
# from repo root
Get-ChildItem server/logs | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | Get-Content -Wait
```

Check server/logs/ for errors when debugging.

# api.md document

Each time you change server code, review docs/knowledgebase/api-reference.md and update the document to reflect actual controller state.

# Endpoint map

Before adding or modifying any endpoint, read `docs/knowledgebase/server-endpoint-map.md`.  
After any endpoint change, update that file to keep it in sync with the actual controllers.

# Performance tests

After server code changes, run performance tests:

```sh
# from server/
npm run perf
```

Ensure metrics do not degrade more than 20%. Stop and ask the user if performance degrades more than 20%.
