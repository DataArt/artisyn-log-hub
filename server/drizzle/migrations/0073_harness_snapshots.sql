-- Harness snapshot table + session/upload_queue binding columns (2026-10-16 sysctx-skill-source).
--
-- harness_snapshots holds one row per (owner user_id, snapshot_id), with the whole DD-1 snapshot
-- body in `body jsonb`. The hook computes snapshot_id itself (sha256 of a canonical subset of the
-- snapshot, see DD-2); the server only validates its format and never recomputes it. UNIQUE
-- (user_id, snapshot_id) makes the ingest-time insert an upsert (`ON CONFLICT DO NOTHING`), and
-- the plain index on snapshot_id alone backs the cross-owner "is this id known anywhere" lookups
-- used by orphan cleanup.
--
-- sessions.harness_snapshot_id and upload_queue.harness_snapshot_id are plain nullable columns,
-- no FK: the referenced harness_snapshots row is looked up by (owning user_id, id) in application
-- code (COALESCE-bound at bind time, never overwritten -- see DD-9), and an orphan sweep can
-- delete the harness_snapshots row out from under a session's column by design (DD-11, DD-21).
-- sessions gets its own index since the read path looks up a session's snapshot by this column
-- on every session-logs request; upload_queue does not need one (it is only matched together
-- with user_id and status in the DD-8 "known" check, which stays a table scan on a bounded-size
-- queue table).
--
-- Additive only: no existing column, table or row is altered, renamed or deleted. Every
-- statement is guarded (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS), so the file
-- is re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). No backfill: both new columns start NULL on every
-- existing row, which is the correct "no snapshot known yet" state.
--
-- Lock/rewrite profile: harness_snapshots is a new, empty table, so its CREATE TABLE and CREATE
-- INDEX take only the instant catalog locks of an empty relation. Both ADD COLUMNs are nullable
-- WITH NO DEFAULT, so PostgreSQL only updates the catalog (no table rewrite, no AccessExclusiveLock
-- held for existing-row scanning). The CREATE INDEX on sessions.harness_snapshot_id takes a brief
-- ShareLock to build over currently all-NULL values; CONCURRENTLY is never used here, since
-- Drizzle wraps every migration file in BEGIN/COMMIT and Postgres forbids CONCURRENTLY inside a
-- transaction.

CREATE TABLE IF NOT EXISTS harness_snapshots (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_id varchar(64) NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT harness_snapshots_user_id_snapshot_id_key UNIQUE (user_id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_snapshots_snapshot_id ON harness_snapshots (snapshot_id);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS harness_snapshot_id varchar(64);

CREATE INDEX IF NOT EXISTS sessions_harness_snapshot_id_idx ON sessions (harness_snapshot_id);

ALTER TABLE upload_queue ADD COLUMN IF NOT EXISTS harness_snapshot_id varchar(64);
