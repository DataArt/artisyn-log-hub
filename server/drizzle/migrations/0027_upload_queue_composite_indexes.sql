CREATE INDEX IF NOT EXISTS idx_upload_queue_user_id_status ON upload_queue (user_id, status);
CREATE INDEX IF NOT EXISTS idx_upload_queue_session_id_received_at ON upload_queue (session_id, received_at);
