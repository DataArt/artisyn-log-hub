-- Sub-agent labels from the agent's .meta.json: the Task tool `description` and the workflow
-- `phase`. The hook sends them as upload query params; the server keeps them on the queued upload
-- and on the sub-agent's sessions row so the UI can label agents by what they do.
-- Additive and nullable: no rewrite, no backfill. Rows written before this migration, or by an
-- older hook that does not send the params, stay NULL and the UI falls back to the prompt.
-- Older server builds never read or write these columns.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "agent_description" varchar(255);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "workflow_phase" varchar(255);
--> statement-breakpoint
ALTER TABLE "upload_queue" ADD COLUMN IF NOT EXISTS "agent_description" varchar(255);
--> statement-breakpoint
ALTER TABLE "upload_queue" ADD COLUMN IF NOT EXISTS "workflow_phase" varchar(255);
--> statement-breakpoint
COMMENT ON COLUMN sessions.agent_description IS 'Sub-agent Task description from its .meta.json, trimmed and capped at 255 characters; NULL for main sessions and for agents uploaded without one.';
--> statement-breakpoint
COMMENT ON COLUMN sessions.workflow_phase IS 'Workflow phase from a workflow sub-agent''s .meta.json, trimmed and capped at 255 characters; NULL otherwise.';
--> statement-breakpoint
COMMENT ON COLUMN upload_queue.agent_description IS 'Sub-agent Task description sent with the upload, copied to sessions.agent_description when the row is processed; NULL otherwise.';
--> statement-breakpoint
COMMENT ON COLUMN upload_queue.workflow_phase IS 'Workflow phase sent with the upload, copied to sessions.workflow_phase when the row is processed; NULL otherwise.';
