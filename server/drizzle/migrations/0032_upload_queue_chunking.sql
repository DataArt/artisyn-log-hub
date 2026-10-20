ALTER TYPE upload_queue_status ADD VALUE IF NOT EXISTS 'partially_uploaded' BEFORE 'failed';

ALTER TABLE upload_queue
    ADD COLUMN IF NOT EXISTS upload_id VARCHAR (255);
ALTER TABLE upload_queue
    ADD COLUMN IF NOT EXISTS chunks_received INTEGER;
ALTER TABLE upload_queue
    ADD COLUMN IF NOT EXISTS total_chunks INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_upload_queue_upload_id ON upload_queue (upload_id) WHERE upload_id IS NOT NULL;
