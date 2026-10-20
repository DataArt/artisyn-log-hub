-- Server-generated secrets (open-source readiness, Design Decision 3): one row per named
-- secret. Today only `session_secret`, written by resolveSessionSecret() at startup when the
-- SESSION_SECRET env var is empty (INSERT ... ON CONFLICT DO NOTHING, then re-read), so every
-- cluster worker and every restart share one value.
--
-- Additive only: one new, empty table. CREATE TABLE IF NOT EXISTS makes the file re-runnable
-- (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). No backfill, no secondary index (lookups are by PK).

CREATE TABLE IF NOT EXISTS server_secrets (
  name       varchar(64) PRIMARY KEY,
  value      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
