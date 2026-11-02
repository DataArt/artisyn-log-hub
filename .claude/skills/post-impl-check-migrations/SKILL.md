---
name: post-impl-check-migrations
description: "Check that DB migrations run on clean DB"
---

start new fresh postgres DB In container on some free port
in another container start server and point to this DB
read logs ensure that it runs without errors 
AND especially that all migrations were applied.

Then run `npm run db:state -- --check` from the repo root (it migrates its own throw-away DB next to
the dev `DATABASE_URL`). If it reports `db_state.sql is stale`, run `npm run db:state` and keep the
regenerated `docs/knowledgebase/db_state.sql` as part of the change. A new table must have a
`COMMENT ON TABLE` in its migration.
