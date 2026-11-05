---
name: db-state-update
description: "ALWAYS each time you add a DB migration, right after it has been applied to the local dev DB — comment new tables/columns and regenerate docs/knowledgebase/db_state.sql"
---

`docs/knowledgebase/db_state.sql` is the current database schema as plain DDL with light comments —
the KB's answer to "what does the DB look like now". It is generated, never hand-edited, and must
name the latest migration in its header. Keep it in step with every new migration.

## When

Each time you add a migration under `server/drizzle/migrations/`, once it is written, locked
(`npm run migrations:lock` from `server/`) and applied to the local dev DB without errors
(`npm run migrate` from `server/`, or the dev server's startup log). Not for a migration you only
read, and never for an already committed migration (they are immutable — see the
`migrations-data-integrity` skill).

## Steps

1. **Comments in the same migration.** A new table gets `COMMENT ON TABLE <t> IS '…'`: one line —
   what a row is and who writes it (service / module). A new or changed column gets
   `COMMENT ON COLUMN <t>.<c> IS '…'` **only** when name and type do not explain it:
   discriminator values, units, what NULL means, a cached copy of other data, soft-delete or legacy
   flags, an id stored as text without an FK. Most columns get none. Plain English, no task ids,
   DD numbers or dates. Get the comments right before the first `npm run migrations:lock`: once a
   migration is locked and applied it is immutable, even if uncommitted, so a wrong comment is
   fixed by a new comments-only migration (see the `migrations-data-integrity` skill).
2. **Regenerate** from the repo root:
   ```sh
   npm run db:state
   ```
   It migrates its own throw-away database (`loghub_db_state`, next to the dev `DATABASE_URL`) with
   the server's `npm run migrate`, writes the DDL from the Postgres catalog and drops the database —
   the dev DB itself is not read or changed. Expect `wrote docs\knowledgebase\db_state.sql
   (<latest migration tag>, N bytes)`.
3. **Read the diff** of `docs/knowledgebase/db_state.sql`: only the tables, columns, constraints,
   indexes and comments your migration touched may change, and the header must name your migration.
   An unrelated change means the dev DB server, the generator or another uncommitted migration
   differs — find out why before keeping it.
4. **Verify**: `npm run db:state -- --check` prints `is up to date (<tag>)`.
5. Keep the regenerated `db_state.sql` in the same change as the migration. If the migration also
   changes a cross-table rule (cascade, soft delete, scoping, a derived table), update
   `docs/knowledgebase/db-tables.md` too.

## If it fails

- `DATABASE_URL is not set` — set it in the env or `server/.env` (any role allowed to create a
  database on the dev Postgres).
- `npm run migrate failed` — the migration itself does not apply on a clean database; fix the
  migration first (output is in the error).
- A stale `loghub_db_state` database left by an interrupted run is dropped by the next run.
