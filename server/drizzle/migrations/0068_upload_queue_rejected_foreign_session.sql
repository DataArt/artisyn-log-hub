-- Foreign-session upload rejection (open-source readiness, Design Decisions 10-11): a new
-- terminal `upload_queue_status` value for uploads the worker refused because the session
-- belongs to another user, plus a `warning_delivered` flag so the hook is told about each
-- such rejection exactly once.
--
-- Additive only. No column or table is dropped, renamed or retyped, no existing value is
-- rewritten, and no row is deleted. Both statements are IF NOT EXISTS guarded, so the file is
-- re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md).
--
-- The new enum value is NOT used anywhere in this migration (or in any later migration of the
-- same batch): Drizzle runs pending migrations inside one transaction, and PostgreSQL forbids
-- using an enum value in the transaction that added it. Same pattern as 0032.
--
-- Lock/rewrite profile: `ADD COLUMN ... NOT NULL DEFAULT false` uses a constant default, so on
-- PostgreSQL >= 11 it is metadata-only -- no table rewrite. Existing rows read as false, which
-- is correct: no row can be in the new status yet.

ALTER TYPE upload_queue_status ADD VALUE IF NOT EXISTS 'rejected_foreign_session';

ALTER TABLE upload_queue
  ADD COLUMN IF NOT EXISTS warning_delivered boolean NOT NULL DEFAULT false;
