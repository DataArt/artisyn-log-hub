---
name: migrations-data-integrity
description: "ALWAYS when you do drizze migrations of something that touch data schema or data"
---

If you change drizzle migrations - update schema or you do some data migrations.
Analyze - can this break production data base schema or data. 

You do not have access to it directly. So do additional analysis turn of this particular case 
Try to figure out possible edge cases in data and if it can break data

Do this on implementation plan stage

## Committed migrations are immutable

Never edit, rename or delete a migration `.sql` file (or an existing `meta/_journal.json` entry)
once it is committed — not even a comment, and not in an unpushed commit (no `--amend` fix).
Drizzle does not re-check applied migrations: on an already-migrated database the edit is never
applied, while a clean database gets a different schema. Every DB change is a **new** migration,
followed by `npm run migrations:lock` (from `server/`) to append its row to
`server/drizzle/migrations/meta/migrations.lock.json` (append-only, never hand-edited).

Enforced three ways, with no bypass flag: the `.githooks/pre-commit` hook
(`scripts/migrations-lock.js --pre-commit`), the reconciliation test
`scripts/__tests__/migrations-lock.test.js` (`npm run test:scripts`) and the server startup check
(`server/src/database/migration-lock-check.ts`), which refuses to start when an applied migration's
hash is not in the manifest.
