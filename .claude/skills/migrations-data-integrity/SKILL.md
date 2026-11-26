---
name: migrations-data-integrity
description: "ALWAYS when you do drizze migrations of something that touch data schema or data"
---

If you change drizzle migrations - update schema or you do some data migrations.
Analyze - can this break production data base schema or data. 

You do not have access to it directly. So do additional analysis turn of this particular case 
Try to figure out possible edge cases in data and if it can break data

Do this on implementation plan stage

## Heavy migrations: call them out, ask, look for a way around

A migration is **heavy** when deploying it makes the server rework a large share of the existing
data, at migration time or in the background after start. Examples:

- a full-table `UPDATE` / `INSERT … SELECT` over a big table (`logs`, `logs_otel`, `otel_calls`, …);
- bumping a version stamp that re-queues work for every row (`OTEL_PROJECTION_VERSION`, a
  re-extraction / re-classification / backfill version) — this one is easy to miss, because the
  migration file itself can be empty;
- building an index or rewriting a column on a big table;
- an irreversible drop of tables or columns that still hold data.

When a plan contains one:

1. **Write it down separately** — its own `### Heavy migration` subsection in the plan (and one
   line in the chat when you present the plan), not a bullet buried in External surface → DB. Say
   what is reworked, how many rows on a large install, and an estimate of time, CPU, memory and
   disk on the **smallest install Log Hub supports** (a Raspberry Pi-class box: 1 GB RAM, slow SD
   card, a memory-limited app container with several workers), not on the dev machine.
2. **Look for a way without it first** and write down what you considered: a targeted pass that
   touches only the rows that need the new data, reading the value lazily on read, writing it only
   for new data and leaving history as it is, a cheaper extraction that does not redo the whole
   pipeline. Choose the heavy path only when none of these works.
3. **Ask the user to confirm explicitly** that the heavy migration is wanted, quoting the estimate
   — never let it ship as a side effect of another change.
4. If it ships: make it resumable and batched (a crash or an OOM mid-way must not lose work or
   restart from zero), bounded in memory per batch, and logged with progress, so an operator can
   see it is moving.

Observed 2026-11-25 (`2026-11-24-otel-session-tags`): bumping `OTEL_PROJECTION_VERSION` 2 → 3 only
to backfill session tags re-queued all 21 k OTEL chunks of a small install; on a Pi-class box that
meant hours of 100 % Postgres CPU, a 12 s session list and one worker heap OOM, while reading only
the resource attributes would have been enough.

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
