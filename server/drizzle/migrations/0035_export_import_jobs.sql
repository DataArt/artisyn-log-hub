CREATE TYPE export_import_job_kind AS ENUM ('export', 'import', 'staged_upload');
CREATE TYPE export_import_job_status AS ENUM ('staged', 'running', 'done', 'error');

CREATE TABLE IF NOT EXISTS export_import_jobs (
  id VARCHAR(36) PRIMARY KEY,
  kind export_import_job_kind NOT NULL,
  status export_import_job_status NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  result_file_path VARCHAR,
  result_file_name VARCHAR,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_import_jobs_status_updated_at ON export_import_jobs (status, updated_at);
