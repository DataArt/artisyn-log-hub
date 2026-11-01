-- Session-list flags per session (2026-10-31 session-list-slow-jsonb).
--
-- Four session_stats columns carry what GET /api/v1/repositories/:repoId/sessions used to derive
-- at request time by scanning logs.body jsonb: main_model (first non-null model of the deduped
-- main, non-sidechain assistant lines; NULL when none), has_workflow (any assistant event holds a
-- valid Workflow tool_use block), has_main_assistant (at least one main assistant line) and
-- list_flags_version (version of the derivation rules; NULL = not computed yet). The server
-- ingest (upsertSessionStatsRow, root transcripts only) writes them; rows that exist before this
-- migration are filled by the startup backfill (backfillSessionListFlags in initializeDatabase).
--
-- Additive only: no existing column, table, constraint or row is altered, renamed or deleted.
-- Every statement is guarded (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS), so the file
-- is re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). Older server builds ignore the new columns.
--
-- Lock/rewrite profile: main_model and list_flags_version are nullable WITH NO DEFAULT; the two
-- booleans are NOT NULL with a constant DEFAULT false, which PostgreSQL 11+ stores in the catalog
-- (no table rewrite). Each ADD COLUMN takes a brief AccessExclusiveLock only. The partial index
-- covers only pending rows (list_flags_version IS NULL) -- every row right after this migration,
-- shrinking to empty once the backfill has run -- so later starts find "nothing to backfill" with
-- one index probe. CREATE INDEX (not CONCURRENTLY: migrations run in a transaction) blocks writes
-- to session_stats for the build, which is a single scan of one narrow table.
--
-- Rollback: DROP INDEX IF EXISTS idx_session_stats_list_flags_pending; then ALTER TABLE
-- session_stats DROP COLUMN IF EXISTS main_model, DROP COLUMN IF EXISTS has_workflow,
-- DROP COLUMN IF EXISTS has_main_assistant, DROP COLUMN IF EXISTS list_flags_version. Readers of
-- the columns must be reverted first.

ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS main_model varchar;
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS has_workflow boolean NOT NULL DEFAULT false;
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS has_main_assistant boolean NOT NULL DEFAULT false;
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS list_flags_version smallint;
CREATE INDEX IF NOT EXISTS idx_session_stats_list_flags_pending ON session_stats (session_id) WHERE list_flags_version IS NULL;
