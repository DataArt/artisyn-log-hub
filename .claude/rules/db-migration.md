---
paths:
  - "server/drizzle/migrations/**"
---

# SQL Migration Production Safety Review

Every time you create or modify a migration file, perform this safety audit **before finishing**. Warn the user
explicitly if any risk is found — do not silently proceed.

**Never edit a committed migration** (even a comment) — add a new one and run `npm run migrations:lock`
from `server/`. See the `migrations-data-integrity` skill.

## Blocking risks (will stall deployment on prod)

**Table locks on large tables**

- `ALTER TABLE ... ADD COLUMN` with a DEFAULT that requires a full-table rewrite blocks reads+writes until complete.
    - Safe: `ADD COLUMN` with no default, or a `volatile` default added in a second statement.
    - Risky: `ADD COLUMN col TYPE NOT NULL DEFAULT <expr>` — PostgreSQL rewrites the table row-by-row while holding
      `AccessExclusiveLock`.
- `ALTER TABLE ... ALTER COLUMN TYPE` rewrites the table and blocks. Only safe for type changes that are cast-free (e.g.
  `varchar(10)` → `varchar(50)`) on Postgres ≥ 9.2.
- `ADD CONSTRAINT ... NOT VALID` + `VALIDATE CONSTRAINT` is the safe pattern for FK/check constraints on existing data.

**Index creation and CONCURRENTLY**

- `CREATE INDEX` holds a `ShareLock` for the full build — blocks writes while the index is being built.
- **NEVER use `CREATE INDEX CONCURRENTLY` in migration files in this project.** Drizzle's `migrate()` always wraps
  every migration file in a `BEGIN/COMMIT` transaction block, and PostgreSQL forbids `CONCURRENTLY` inside any
  transaction (error code `25001`). This will crash the server on startup in production.
- Use `CREATE INDEX IF NOT EXISTS` (without `CONCURRENTLY`) instead. The brief `ShareLock` is acceptable; the
  index tables targeted by migrations are typically small at creation time.
- If you see `CREATE INDEX CONCURRENTLY` anywhere in a migration file — stop, remove the `CONCURRENTLY` keyword,
  and warn the user before proceeding.

**Renaming columns or tables**

- Immediately breaks any running app instances still using the old name — zero-downtime deploys require a multi-step
  approach (add new, dual-write, backfill, remove old).

## Data loss risks

- `DROP COLUMN`, `DROP TABLE`, `TRUNCATE` — flag as destructive; confirm it is explicitly stated in requirements.
- Removing `NOT NULL` or changing default values silently alters application behavior.

## Correctness risks

- Missing `IF EXISTS` / `IF NOT EXISTS` — migration fails on re-run or in a fresh environment if the object is absent or
  already present.
- `ALTER TABLE ... SET NOT NULL` on a column that may already contain NULLs in prod — migration will fail and roll back
  deployment.
- Foreign-key additions without `NOT VALID` will scan the entire referenced table and fail if any orphan rows exist.

## Running update statements that rely on specific data layout

If migration contains UPDATE statements that rely on specific data layout, consider:

- Adding a check constraint to ensure the data layout is as expected.

## Checklist to output after review

After reading the new migration, output a short checklist like:

```
Migration safety review:
[ ] No full-table rewrites with blocking locks
[ ] No index uses CONCURRENTLY (forbidden in Drizzle migrations — use CREATE INDEX IF NOT EXISTS)
[ ] No destructive drops (or explicitly required)
[ ] NOT NULL additions have no existing NULLs risk
[ ] Long-running DML is batched / deferred
[ ] Idempotent (IF EXISTS guards where needed)

⚠ WARNINGS: <list any risks found, or "none">
```

If any warnings exist, stop and tell the user before proceeding with other work.
