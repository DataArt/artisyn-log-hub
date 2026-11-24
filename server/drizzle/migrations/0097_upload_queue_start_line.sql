-- Append uploads (POST /api/v2/logs/append): the 0-based record index a staged delta starts at.
--
-- Additive only: a nullable column without a default, so existing rows and rows staged by older
-- hooks stay NULL (= whole-file upload) and no backfill or table rewrite is needed. No index.
-- Lock profile: a brief ACCESS EXCLUSIVE lock on upload_queue (catalog-only change).
-- Re-runnable: IF NOT EXISTS. Rollback: ALTER TABLE upload_queue DROP COLUMN start_line.

ALTER TABLE upload_queue ADD COLUMN IF NOT EXISTS start_line integer;

COMMENT ON COLUMN upload_queue.start_line IS 'Append upload: the 0-based record index the staged delta starts at (POST /api/v2/logs/append); NULL = whole-file upload.';
