-- Turn-end advisor run ownership: a nullable `user_id` on turn_end_advisor_runs, so every
-- read can filter runs to the session owner (open-source readiness, Design Decision 9).
--
-- Additive only. No column or table is dropped, renamed or retyped, and no row is deleted.
-- Every statement is guarded (ADD COLUMN IF NOT EXISTS, a pg_constraint check around the FK,
-- CREATE INDEX IF NOT EXISTS, and the backfill only touches rows still NULL), so the whole
-- file is re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md).
--
-- Lock/rewrite profile:
--   * `ADD COLUMN user_id integer` is nullable with NO default -- catalog-only, no rewrite.
--   * The backfill UPDATE rewrites the rows it sets. turn_end_advisor_runs holds one row per
--     advisor evaluation (small), so the RowExclusiveLock is short.
--   * The FK is added NOT VALID (no scan under the AccessExclusiveLock), then validated with
--     VALIDATE CONSTRAINT, which takes only a ShareUpdateExclusiveLock.
--   * The index is a plain CREATE INDEX IF NOT EXISTS (no CONCURRENTLY: Drizzle wraps every
--     migration file in BEGIN/COMMIT). The ShareLock is brief on this small table.
--
-- Backfill: user_id = the user_id of the session's `artisyn` log (the session owner), matched
-- through sessions.session_id (varchar) = turn_end_advisor_runs.session_id (varchar) and
-- logs.session_id (integer FK) = sessions.id. logs has UNIQUE (session_id, log_type), so at
-- most one owner row matches per run. Runs whose session was never ingested (or has no
-- `artisyn` log) stay NULL; NULL rows never match an owner-filtered read.

-- 1) The column.
ALTER TABLE turn_end_advisor_runs ADD COLUMN IF NOT EXISTS user_id integer;

-- 2) Backfill from the session owner.
UPDATE turn_end_advisor_runs r
SET user_id = l.user_id
FROM sessions s
JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
WHERE s.session_id = r.session_id
  AND r.user_id IS NULL;

-- 3) FK to users, ON DELETE CASCADE: added NOT VALID, then validated. The existence check is
--    scoped to this table via `conrelid = ...::regclass` (resolved through search_path), not by
--    name alone: pg_constraint is database-wide, so a name-only check would see the constraint
--    in another schema (e.g. `public` while migrating a per-run test schema) and skip the ADD.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'turn_end_advisor_runs_user_id_fk'
      AND conrelid = 'turn_end_advisor_runs'::regclass
  ) THEN
    ALTER TABLE turn_end_advisor_runs
      ADD CONSTRAINT turn_end_advisor_runs_user_id_fk
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE turn_end_advisor_runs VALIDATE CONSTRAINT turn_end_advisor_runs_user_id_fk;

-- 4) Owner-filtered "latest run for this session" lookup:
--    WHERE session_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT 1.
CREATE INDEX IF NOT EXISTS turn_end_advisor_runs_session_user_idx
  ON turn_end_advisor_runs (session_id, user_id, started_at DESC);
