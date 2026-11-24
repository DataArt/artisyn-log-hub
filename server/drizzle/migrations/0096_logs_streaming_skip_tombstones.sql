-- Session logs streaming, ingest skip and deleted-session tombstones.
--
-- logs: a per-body revision (body_rev, from the sequence logs_body_rev_seq, bumped by the
-- logs_body_guard trigger on every body write), the ingest hash and version used to skip
-- unchanged re-uploads, the receive time of the upload that wrote the body (newer upload wins),
-- a gzip copy of the body with the revision it was built from, and the edit-record hashes that
-- tie transcript stats to the tree's artisyn edit records.
-- upload_queue: the hook-declared content hash and a "failure already reported" flag.
-- session_stats: workflows stored at ingest instead of parsed per request.
-- deleted_session_log: the root's repository URL plus lookup indexes for tombstone checks and
-- fresh-start clearing.
-- session_reextract_queue: roots whose transcript stats must be re-extracted.
--
-- No statement breakpoints: the file runs as one multi-statement query in one transaction, so
-- the plpgsql $$ body below is safe.
--
-- Additive only: new columns are nullable without a default, except failure_delivered, whose
-- constant default needs no table rewrite. No data is changed; legacy rows keep NULL revisions,
-- hashes, gzip copies and workflows and are filled by background drains in the server.
--
-- Lock profile: ALTER TABLE takes brief ACCESS EXCLUSIVE locks (catalog-only changes).
-- CREATE INDEX on logs, session_stats and deleted_session_log takes a SHARE lock (blocks writes,
-- not reads) for the duration of the build; the logs index reads only the heap tuples, never the
-- TOASTed bodies. CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on logs.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout.

-- logs --------------------------------------------------------------------------------------

ALTER TABLE logs ADD COLUMN IF NOT EXISTS body_rev bigint;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS body_sha256 varchar(64);
ALTER TABLE logs ADD COLUMN IF NOT EXISTS ingest_version smallint;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS body_received_at timestamptz;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS body_gz bytea;
ALTER TABLE logs ALTER COLUMN body_gz SET STORAGE EXTERNAL;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS body_gz_rev bigint;
ALTER TABLE logs ADD COLUMN IF NOT EXISTS edit_records_sha256 varchar(64);
ALTER TABLE logs ADD COLUMN IF NOT EXISTS stats_edit_sha256 varchar(64);

CREATE SEQUENCE IF NOT EXISTS logs_body_rev_seq AS bigint;

CREATE OR REPLACE FUNCTION logs_body_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.body_rev := nextval('logs_body_rev_seq');
  IF TG_OP = 'UPDATE'
     AND NEW.body_sha256 IS NOT DISTINCT FROM OLD.body_sha256
     AND NEW.body_received_at IS NOT DISTINCT FROM OLD.body_received_at THEN
    NEW.body_sha256 := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS logs_body_guard ON logs;
CREATE TRIGGER logs_body_guard BEFORE INSERT OR UPDATE OF body ON logs
  FOR EACH ROW EXECUTE FUNCTION logs_body_guard();

CREATE INDEX IF NOT EXISTS idx_logs_body_gz_pending ON logs (id)
  WHERE log_type IN ('artisyn', 'claude', 'claude-subagent')
    AND body IS NOT NULL
    AND (body_rev IS NULL OR body_gz_rev IS DISTINCT FROM body_rev);

COMMENT ON SEQUENCE logs_body_rev_seq IS 'Source of logs.body_rev; has gaps, so revisions are compared only for equality or order';
COMMENT ON FUNCTION logs_body_guard() IS 'Trigger function for logs: sets body_rev from logs_body_rev_seq on every body write and clears body_sha256 on an UPDATE that changes neither body_sha256 nor body_received_at (a writer that does not know the hash)';
COMMENT ON TRIGGER logs_body_guard ON logs IS 'BEFORE INSERT OR UPDATE OF body: keeps body_rev and body_sha256 in step with the body (see logs_body_guard())';
COMMENT ON COLUMN logs.body_rev IS 'Body revision from logs_body_rev_seq, set by the logs_body_guard trigger on every body write; NULL on rows written before it until the gzip builder assigns one. Compare only for equality or order (the sequence has gaps)';
COMMENT ON COLUMN logs.body_sha256 IS 'sha256 hex of the raw uploaded body (UTF-8) that produced this row, used to skip unchanged re-uploads; NULL = unknown (legacy row, zip import, or a writer that did not supply it)';
COMMENT ON COLUMN logs.ingest_version IS 'Server ingest pipeline version (INGEST_VERSION) that processed body_sha256; a different version forces re-processing of an identical upload';
COMMENT ON COLUMN logs.body_received_at IS 'upload_queue.received_at of the upload that wrote the body (now() for zip import); an older upload never overwrites a newer one. NULL = legacy, always overwritable';
COMMENT ON COLUMN logs.body_gz IS 'gzip (level 6) of body::text as UTF-8, served directly to clients that accept gzip; valid only when body_gz_rev = body_rev. Kept for artisyn, claude and claude-subagent only. Storage EXTERNAL (already compressed)';
COMMENT ON COLUMN logs.body_gz_rev IS 'body_rev the gzip copy in body_gz was built from; the copy is stale when it differs from body_rev';
COMMENT ON COLUMN logs.edit_records_sha256 IS 'artisyn rows only: sha256 of the JSON of the edit-result records extracted from the body; a change re-extracts the tree''s transcript stats';
COMMENT ON COLUMN logs.stats_edit_sha256 IS 'claude / claude-subagent rows only: the tree''s artisyn edit_records_sha256 the stats were extracted with ('''' = no artisyn edit records); NULL = unknown';

-- upload_queue ------------------------------------------------------------------------------

ALTER TABLE upload_queue ADD COLUMN IF NOT EXISTS content_sha256 varchar(64);
ALTER TABLE upload_queue ADD COLUMN IF NOT EXISTS failure_delivered boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN upload_queue.content_sha256 IS 'sha256 hex the hook declared for the whole body (contentSha256 query param, single upload or chunk 0); a mismatch with the staged body fails the row with content-hash-mismatch. NULL = not declared (older hooks)';
COMMENT ON COLUMN upload_queue.failure_delivered IS 'Set true once this failed row (error_kind server) has been reported to the hook in failedUploads, so each failure is reported once';

-- upload_queue_measurements -----------------------------------------------------------------

COMMENT ON COLUMN upload_queue_measurements.outcome IS 'success | failure | skipped (identical body, server hash skip) | superseded (a newer pending upload of the same session and type replaced it); only success and failure feed the admin stats';

-- session_stats -----------------------------------------------------------------------------

ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS workflows jsonb;
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS workflows_version smallint;

CREATE INDEX IF NOT EXISTS idx_session_stats_workflows_pending ON session_stats (session_id)
  WHERE workflows_version IS NULL;

COMMENT ON COLUMN session_stats.workflows IS 'Workflow runs extracted from the session''s own claude transcript at ingest (WorkflowRun[] JSON), so readers never parse the body; NULL for sub-agent sessions or when not computed yet';
COMMENT ON COLUMN session_stats.workflows_version IS 'WORKFLOWS_VERSION the workflows column was computed with; NULL = not computed yet (filled by the workflows backfill)';

-- deleted_session_log -----------------------------------------------------------------------

ALTER TABLE deleted_session_log ADD COLUMN IF NOT EXISTS repository_url varchar(2048);

CREATE INDEX IF NOT EXISTS idx_deleted_session_log_session_id ON deleted_session_log (session_id);
CREATE INDEX IF NOT EXISTS idx_deleted_session_log_owner ON deleted_session_log (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_deleted_session_log_repo_url ON deleted_session_log (repository_url);

COMMENT ON COLUMN deleted_session_log.repository_url IS 'repositories.repo_url of the deleted tree''s root (lowest repo_id linked to its artisyn log), copied to descendant rows; lets a repository deletion clear its tombstones. NULL on rows written before it or when the root had no repository';

-- session_reextract_queue -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS session_reextract_queue (
  session_pk   integer     PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE session_reextract_queue IS 'Session tree roots whose claude / claude-subagent stats must be re-extracted because the tree''s artisyn edit records changed; written by LogsService on artisyn ingest, drained by SessionReextractService';
COMMENT ON COLUMN session_reextract_queue.requested_at IS 'Time of the latest request; an old value marks the session''s derived figures as lagging';
