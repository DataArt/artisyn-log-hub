-- T-107: turn_end_advisor_runs.session_id switches from an integer FK into sessions(id) to the
-- raw string session UUID (VARCHAR(255), no FK) -- mirrors upload_queue's session_id shape. This
-- lets a run be recorded for a session the server has never ingested yet (advisor-lost-new-session
-- fix), which an integer FK could never represent.
--
-- Add-column/backfill/rename pattern (NOT an in-place ALTER COLUMN TYPE): an INTEGER->VARCHAR
-- change is not cast-free, so ALTER COLUMN TYPE would force a full-table rewrite under an
-- AccessExclusiveLock. This sequence keeps every step either lock-free or a plain metadata change:
--   1. ADD COLUMN with no default -- metadata-only, instant.
--   2. Backfill via UPDATE ... FROM sessions -- the ONLY step that scans/rewrites rows, and it's a
--      plain UPDATE (RowExclusiveLock), not a schema change.
--   3. SET NOT NULL -- table scan to verify, no rewrite.
--   4. DROP COLUMN old + RENAME new -- both metadata-only.
--
-- Backfill correctness: the pre-migration column is `session_id INTEGER NOT NULL REFERENCES
-- sessions(id) ON DELETE CASCADE`, a hard DB-level constraint enforced since the table's creation
-- (migration 0055) -- every existing row's session_id is GUARANTEED to reference a live sessions.id
-- row today (an orphan is structurally impossible: any sessions row delete would have cascaded and
-- removed the child row instead of leaving a dangling reference). sessions.session_id is itself
-- `VARCHAR(255) NOT NULL UNIQUE`, so the backfilled value can never be NULL and never overflows the
-- new column's length (same 255 cap, copied verbatim, no truncation).
--
-- DROP COLUMN session_id cascades to drop its own FK constraint and the index defined solely on it
-- (idx_turn_end_advisor_runs_session_id from migration 0055), so no separate DROP CONSTRAINT/DROP
-- INDEX step is needed before recreating the index below on the renamed column.
ALTER TABLE turn_end_advisor_runs ADD COLUMN session_id_new VARCHAR(255);

UPDATE turn_end_advisor_runs t
  SET session_id_new = s.session_id
  FROM sessions s
  WHERE s.id = t.session_id;

ALTER TABLE turn_end_advisor_runs ALTER COLUMN session_id_new SET NOT NULL;

ALTER TABLE turn_end_advisor_runs DROP COLUMN session_id;

ALTER TABLE turn_end_advisor_runs RENAME COLUMN session_id_new TO session_id;

CREATE INDEX IF NOT EXISTS idx_turn_end_advisor_runs_session_id
  ON turn_end_advisor_runs (session_id);
