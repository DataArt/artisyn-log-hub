-- turn_end_advisor_runs index cleanup after migration 0067 (open-source readiness).
--
-- 1) idx_turn_end_advisor_runs_session_id (session_id) is a leading-column prefix of 0067's
--    turn_end_advisor_runs_session_user_idx (session_id, user_id, started_at DESC). Every
--    session_id-only lookup (the run-log scan, the orphan-cleanup anti-join, the executive
--    summary join) can use the composite, so the single-column index only costs writes.
-- 2) 0067's FK turn_end_advisor_runs.user_id -> users(id) ON DELETE CASCADE has no index
--    leading with user_id (it is the 2nd column of the composite), so deleting a user scans
--    the whole table for the cascade.
--
-- Index-only: no column, constraint or row is touched, so no data can be lost. Both
-- statements are guarded (DROP INDEX IF EXISTS / CREATE INDEX IF NOT EXISTS), so the file is
-- re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). The composite is guaranteed to exist: 0067 runs
-- before this file.
--
-- Lock profile: plain DROP/CREATE INDEX (no CONCURRENTLY: Drizzle wraps every migration file
-- in BEGIN/COMMIT). turn_end_advisor_runs holds one row per advisor evaluation (small), so
-- the AccessExclusiveLock of the DROP and the ShareLock of the CREATE are brief.

DROP INDEX IF EXISTS idx_turn_end_advisor_runs_session_id;

CREATE INDEX IF NOT EXISTS idx_turn_end_advisor_runs_user_id
  ON turn_end_advisor_runs (user_id);
