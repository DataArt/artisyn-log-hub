---
name: migrations-data-integrity
description: "ALWAYS when you do drizze migrations of something that touch data schema or data"
---

If you change drizzle migrations - update schema or you do some data migrations.
Analyze - can this break production data base schema or data. 

You do not have access to it directly. So do additional analysis turn of this particular case 
Try to figure out possible edge cases in data and if it can break data

Do this on implementation plan stage

Once a new migration is applied to the local dev DB, follow the `db-state-update` skill: comment
new tables / non-obvious columns with `COMMENT ON` and regenerate `docs/knowledgebase/db_state.sql`.

## No stored procedures, functions or triggers

Keep all logic in the application code. A migration must not create a stored procedure, a
plpgsql/SQL function, or a trigger — and a plan must not design one. Anything a trigger would
enforce (revision counters, hash invalidation, audit columns, cascades beyond FK `ON DELETE`) is
written explicitly in the SQL of every write path. One-off `DO $$ … $$` blocks for idempotent DDL
inside a migration are fine — they create no persistent DB object.

**Temporary exception:** `logs_body_guard()` and its trigger `logs_body_guard` on `logs` (with the
sequence `logs_body_rev_seq`), added in migration `0096_logs_streaming_skip_tombstones.sql` by task
`2026-11-23-session-logs-streaming`. They are scheduled for removal in a separate task — do not
copy the pattern, and do not add new logic that depends on the trigger.

## Migrations are immutable

Never edit, rename or delete a migration `.sql` file (or an existing `meta/_journal.json` entry)
once it is committed — not even a comment, and not in an unpushed commit (no `--amend` fix).
The same holds for an uncommitted migration once it has been locked and applied anywhere (dev DB,
scenario stand, a check's throw-away DB): treat it as shipped. A wrong text inside the file — a
`--` comment, a stale class name — just stays as it is. A wrong `COMMENT ON TABLE/COLUMN` that
needs fixing in the DB ships as a new comments-only migration (`COMMENT ON` replaces the old text),
never as an edit of the old one.
Drizzle does not re-check applied migrations: on an already-migrated database the edit is never
applied, while a clean database gets a different schema. Every DB change is a **new** migration,
followed by `npm run migrations:lock` (from `server/`) to append its row to
`server/drizzle/migrations/meta/migrations.lock.json` (append-only, never hand-edited).

Enforced three ways, with no bypass flag: the `.githooks/pre-commit` hook
(`scripts/migrations-lock.js --pre-commit`), the reconciliation test
`scripts/__tests__/migrations-lock.test.js` (`npm run test:scripts`) and the server startup check
(`server/src/database/migration-lock-check.ts`), which refuses to start when an applied migration's
hash is not in the manifest.
