ALTER TABLE sessions ADD COLUMN workflow_run_id varchar(255);
CREATE INDEX IF NOT EXISTS sessions_workflow_run_id_idx ON sessions (workflow_run_id);
