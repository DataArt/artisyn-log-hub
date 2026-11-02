# Leaner knowledge base and a generated database schema file

- The large knowledge-base catalogs were cut to what agents actually use: a folder-level client map, one HTTP API map checked against the controllers, and a much shorter index.
- The database now carries short comments on every table and on non-obvious columns, and `npm run db:state` writes the current schema as `docs/knowledgebase/db_state.sql`; a CI check on every PR into `main` keeps it in step with the migrations.
