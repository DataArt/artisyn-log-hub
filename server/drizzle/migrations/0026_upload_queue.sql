CREATE TYPE upload_queue_status AS ENUM ('pending', 'processing', 'failed');

CREATE TABLE IF NOT EXISTS upload_queue (
  id SERIAL PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id VARCHAR(255) NOT NULL,
  log_type VARCHAR(50) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_session_id VARCHAR(255),
  workflow_run_id VARCHAR(255),
  status upload_queue_status NOT NULL DEFAULT 'pending',
  error_message TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upload_queue_status_received_at ON upload_queue (status, received_at);
CREATE INDEX IF NOT EXISTS idx_upload_queue_user_id ON upload_queue (user_id);
