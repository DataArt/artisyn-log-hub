---
type: "Schema Reference"
title: "DB Schema - Code Location and Structure"
description: "Drizzle schema location, DI wiring, full table/enum reference, safe migration patterns (hand-written SQL, never `drizzle-kit generate`), and Drizzle limitations."
tags:
  - database
  - drizzle
timestamp: "2026-08-04T19:40:00+04:00"
---

# DB Schema — Code Location and Structure

## Source of truth

All table and enum definitions live in a single file:

```
server/src/database/schema/index.ts
```

This is a **Drizzle ORM** schema using `drizzle-orm/pg-core`. There are no entity classes, decorators, or separate model files — everything is in that one file.

## How it is wired up

`DatabaseModule` (`server/src/database/database.module.ts`) imports `* as schema` from `./schema/index` and passes it to `drizzle(pool, { schema })`. This makes all tables available for type-safe queries via the `DRIZZLE` injection token (type alias `DrizzleDb`).

Inject the DB in any service:

```ts
constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}
```

`DRIZZLE` and `PG_POOL` constants are in `server/src/database/database.constants.ts`.

## What the schema file exports

| Export | Kind | Notes |
|---|---|---|
| `userRoleEnum` | pgEnum | `'admin' \| 'user'` |
| `users` | pgTable | Auth users |
| `apiKeys` | pgTable | Per-user API keys |
| `sessions` | pgTable | Session dedup table; stores `session_id` string + optional `parent_session_id` (true immediate parent session/agent, not always the root — see db-tables.md) + soft-delete flag |
| `repositories` | pgTable | Per-user repo URLs |
| `contexts` | pgTable | Key/value context pairs |
| `logs` | pgTable | Central telemetry log table |
| `logRepositories` | pgTable | Junction: logs ↔ repositories |
| `logContexts` | pgTable | Junction: logs ↔ contexts |
| `teams` | pgTable | |
| `teamMembers` | pgTable | Junction: teams ↔ users |
| `teamRepositories` | pgTable | Per-team repo URLs |
| `invitations` | pgTable | Team invitations |
| `modelPricing` | pgTable | Read-only reference table: per-model token pricing (USD) |
| `deletedSessionLog` | pgTable | Audit log of soft-deleted sessions; written on deletion |
| `sessionStats` | pgTable | Per-session pre-computed token / work-time / file-edit metrics |
| `repoConfig` | pgTable | File-category config per repository, scoped to team or user |
| `sessionFileStats` | pgTable | Per-session, per-category file-read statistics |
| `userFavoriteSessions` | pgTable | Junction: users ↔ favorited sessions |
| `userSettings` | pgTable | Generic per-user key/value settings: `(user_id, setting_name, setting_value)`, composite PK (migration `0062`). Domain-agnostic — the server never interprets a name or parses a value |
| `uploadQueueStatusEnum` | pgEnum | `'pending' \| 'processing' \| 'partially_uploaded' \| 'failed'` (`partially_uploaded` added migration `0032`) |
| `uploadQueue` | pgTable | Staging rows for the async `/api/v2/logs` upload path; extended with chunked-upload columns |
| `uploadQueueMeasurements` | pgTable | Append-only per-attempt worker measurements (duration, queue latency, size, outcome) backing the admin Upload Queue stats block (migration `0059`); no FK on `sessionId`, pruned at `UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS` |
| `exportImportJobKindEnum` | pgEnum | `'export' \| 'import' \| 'staged_upload'` |
| `exportImportJobStatusEnum` | pgEnum | `'staged' \| 'running' \| 'done' \| 'error'` |
| `exportImportJobs` | pgTable | Background export/import/staged-upload jobs for the repository session export/import feature; `id` is app-generated, not serial |

For column details and relationships see `db-tables.md`.

## Adding or changing a table

1. Edit `server/src/database/schema/index.ts`.
2. **Hand-write** a new migration SQL file in `server/drizzle/migrations/` (pattern: `NNNN_<short-description>.sql`) and register it in `meta/_journal.json`. See "Do not run `drizzle-kit generate`" below — do not let it write this file for you.
3. Run `npm run migrations:lock` (from `server/`) to append the new migration's row to `meta/migrations.lock.json`, then `npm run migrate` to apply. Never edit an already committed migration — the pre-commit hook, `npm run test:scripts` and the startup check (below) reject it.
4. Update `db-tables.md` to reflect the new columns/tables.

Do **not** rely on Drizzle's `push` command in production — only SQL migration files are applied on startup.

### How migrations run at startup

`initializeDatabase()` (`server/src/database/database-init.ts`) is the single entry point for database setup.
`server/src/main.ts` awaits it **before** `NestFactory.create()`, the contract suite's global setup
(`server/test/contract/setup/global-setup.ts`) awaits it before compiling its test module, and `npm run migrate`
(`server/src/database/migrate.ts`) calls the same function. Because no Nest provider exists yet while it runs, no
scheduler, timer or `onModuleInit` hook can query a half-migrated schema.

In order, it validates the migration files and checks each one against its row in
`meta/migrations.lock.json` (`verifyMigrationFilesAgainstLock`, `server/src/database/migration-lock-check.ts`),
optionally resets the schema (`migrate:reset`, refused in production), then, under a Postgres advisory lock
(`pg_advisory_lock(MIGRATION_LOCK_KEY)`), checks that every row of `__drizzle_migrations` maps by `created_at` to a
journal entry whose `acceptedHashes` contain its hash (`verifyAppliedMigrations`) — drizzle itself never re-checks
applied hashes — and runs the migrations. A mismatch throws and the server does not start; there is no bypass.
When several cluster workers start at once, exactly one migrates and the others wait for the lock and then find
nothing left to apply. `SESSION_SECRET` resolution runs under the same lock, so all workers agree on one value.

Rules that follow from this:

- A new startup-time schema or data step goes **inside `initializeDatabase()`** as another sequential step, not in
  a Nest lifecycle hook, which runs after providers are constructed.
- A new entry point other than `main.ts` that boots `AppModule` must call `initializeDatabase()` first, or it runs
  against an unmigrated database.

### Do not run `drizzle-kit generate` — write migrations by hand

Every migration in this repo (`0001` through the latest) is **hand-written plain SQL** — uppercase keywords, unquoted identifiers, `CREATE TABLE/INDEX IF NOT EXISTS` guards (see any file in `server/drizzle/migrations/`, e.g. `0029_team_session_visibility_setting.sql` or `0037_export_import_jobs_fk_indexes.sql`). Nobody runs `npx drizzle-kit generate` as part of the normal workflow, and **running it will produce a broken migration**:

- `drizzle-kit generate` doesn't read your migration `.sql` files or the live database. It diffs the current `schema/index.ts` against the **most recent** `meta/NNNN_snapshot.json` file, then writes SQL for the delta plus a new snapshot.
- Only `meta/0000_snapshot.json` and `meta/_journal.json` are committed to git (verify with `git ls-files server/drizzle/migrations/meta/`) — snapshots `0001` onward were never generated/committed, because nobody has used `generate` to author a migration.
- With no `003X_snapshot.json` to diff against, `generate` falls back to `0000_snapshot.json` — the schema state *before any migration ever ran*. It then treats every table that exists today as new and emits `CREATE TABLE` for all of them (checkable: the generated snapshot's `prevId` field will match `0000_snapshot.json`'s `id`, not the true prior state).
- Applying that output would fail against a real database (tables already exist) or, if it didn't fail cleanly, would be destructive.

**If you (or an agent) accidentally run `generate` and see it emit far more than your intended change:** discard the generated `.sql` and `meta/00XX_snapshot.json`, then hand-write the migration yourself, mirroring the style of a recent migration file. Add the journal entry by hand too — copy the shape of the preceding entry in `meta/_journal.json`, bump `idx`, use any later `when` timestamp, and set `tag` to the new file's basename (without `.sql`).

This is a known repo-level gap (not something fixed by writing one more migration correctly) — the snapshot chain will keep producing this failure for anyone who tries `generate` until someone deliberately reconstructs and commits a full, continuous snapshot chain (or the team commits to always hand-writing, making `generate` permanently unnecessary).

## Drizzle limitations to know

**Partial unique indexes** — conditional indexes (`WHERE status = 'pending'`, or `WHERE team_id IS NOT NULL` / `WHERE user_id IS NOT NULL`) cannot be expressed in Drizzle's TypeScript DSL. They must be written as raw SQL in a migration file. `invitations`, `repoConfig`, and `sessionFileStats` each have such an index; each is noted with a comment directly above its table definition in `schema/index.ts` (not a single note at the bottom of the file).

**NEVER use `CREATE INDEX CONCURRENTLY` in migration files.** Drizzle's `migrate()` wraps every migration file in a `BEGIN/COMMIT` transaction. PostgreSQL forbids `CONCURRENTLY` inside any transaction block (error code `25001`) — this crashes the server on startup with a `DrizzleQueryError`. Always use `CREATE INDEX IF NOT EXISTS` (no `CONCURRENTLY`).
