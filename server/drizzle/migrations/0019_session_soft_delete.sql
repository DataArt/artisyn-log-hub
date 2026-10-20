ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS sessions_deleted_idx ON sessions(session_id) WHERE deleted = true;
