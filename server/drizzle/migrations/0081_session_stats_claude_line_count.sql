-- Session claude-log line count (2026-10-31 session-list-slow-jsonb, list flags version 2).
--
-- GET /api/v1/repositories/:repoId/analytics/timeline reported each session's log line count as
-- jsonb_array_length(logs.body) at request time, which detoasts the whole transcript (seconds for
-- a repository with multi-megabyte transcripts). claude_line_count stores that number with the
-- other session-list flags of migration 0080: written by the server ingest (upsertSessionStatsRow,
-- root transcripts only) and filled for existing rows by the startup backfill
-- (backfillSessionListFlags in initializeDatabase). NULL = the session has no claude log, or the
-- value is not computed yet.
--
-- The UPDATE marks rows computed under the version-1 rules (0080) as pending again, so the backfill
-- recomputes them with the new column. It only touches databases that already ran 0080 and its
-- backfill; on a database coming straight from 0079 every row is still pending and it updates
-- nothing. It changes list_flags_version only — no flag value, no other column, no row deleted.
--
-- Additive otherwise: ADD COLUMN IF NOT EXISTS of a nullable column with no default (catalog-only,
-- no table rewrite, brief AccessExclusiveLock). Older server builds ignore the column; an older
-- build that writes list_flags_version = 1 leaves claude_line_count NULL, and the timeline then
-- falls back to counting from the body for that session.
--
-- Rollback: ALTER TABLE session_stats DROP COLUMN IF EXISTS claude_line_count. Readers of the
-- column must be reverted first.

ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS claude_line_count integer;
UPDATE session_stats SET list_flags_version = NULL WHERE list_flags_version IS NOT NULL AND list_flags_version < 2;
