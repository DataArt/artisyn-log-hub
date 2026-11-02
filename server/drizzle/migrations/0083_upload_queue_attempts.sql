-- Upload queue retries and error kinds.
-- `attempts`: processing attempts so far; a transient database error (deadlock, serialization
-- failure, lock timeout, lost connection) sends the row back to `pending` until the limit.
-- `error_kind`: `server` (Log Hub could not process a good file) or `file` (the body is broken);
-- NULL for rows written before this migration. Both are additive: no rewrite, no data change.
ALTER TABLE "upload_queue" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "upload_queue" ADD COLUMN IF NOT EXISTS "error_kind" varchar(16);
