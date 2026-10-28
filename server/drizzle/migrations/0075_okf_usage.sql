-- OKF usage tables + session/upload_queue binding columns (2026-10-27 okf-usage-tab).
--
-- okf_snapshots holds one row per (owner user_id, snapshot_id), with the whole DD-13 OKF
-- snapshot body (the repo's knowledge-base bundles and their files) in `body jsonb`. The hook
-- computes snapshot_id itself (sha256 of a canonical subset, DD-14); the server only validates
-- its format and never recomputes it. UNIQUE (user_id, snapshot_id) makes the ingest-time
-- insert an upsert (`ON CONFLICT DO NOTHING`) and also serves the per-owner lookups.
--
-- sessions.okf_snapshot_id and upload_queue.okf_snapshot_id are plain nullable columns, no FK,
-- exactly like harness_snapshot_id (0073): the referenced okf_snapshots row is looked up by
-- (owning user_id, id) in application code, bound only while NULL and never overwritten
-- (DD-21), and an orphan sweep may delete the okf_snapshots row out from under the column by
-- design. sessions gets its own index for the read path and the orphan sweep; upload_queue
-- does not (it is only matched together with user_id and status on a bounded-size table).
--
-- session_okf_access holds the per-node (sessions row = one agent/tree node) OKF access facts
-- extracted from the transcript: one row per (path_key, op, after_own_edit). It is derived
-- data, rebuilt delete-then-insert per node on ingest/import/heal/recompute (DD-9), and
-- cascades away with its sessions row. The UNIQUE index's leading session_id serves both the
-- per-node delete and the tree read, so no extra session_id index is added.
--
-- Additive only: no existing column, table or row is altered, renamed or deleted. Every
-- statement is guarded (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS), so the file
-- is re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). No backfill: both new columns start NULL on every
-- existing row, the correct "no OKF snapshot known" state, and session_okf_access starts empty;
-- history is filled on demand by POST :repoId/recompute-all-sessions (FR-5). Old hooks never
-- send OKF lines, so their sessions simply stay NULL / without access rows.
--
-- Lock/rewrite profile: both new tables are new and empty, so their CREATE TABLE takes only
-- instant catalog locks. Both ADD COLUMNs are nullable WITH NO DEFAULT, so PostgreSQL only
-- updates the catalog (no table rewrite). The CREATE INDEX on sessions.okf_snapshot_id takes a
-- brief ShareLock to build over all-NULL values; CONCURRENTLY is never used here, since Drizzle
-- wraps every migration file in BEGIN/COMMIT and Postgres forbids CONCURRENTLY in a transaction.

CREATE TABLE IF NOT EXISTS okf_snapshots (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  snapshot_id varchar(64) NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT okf_snapshots_user_id_snapshot_id_key UNIQUE (user_id, snapshot_id)
);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS okf_snapshot_id varchar(64);

CREATE INDEX IF NOT EXISTS sessions_okf_snapshot_id_idx ON sessions (okf_snapshot_id);

ALTER TABLE upload_queue ADD COLUMN IF NOT EXISTS okf_snapshot_id varchar(64);

CREATE TABLE IF NOT EXISTS session_okf_access (
  id serial PRIMARY KEY,
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path_key varchar(1024) NOT NULL,
  op varchar(8) NOT NULL,
  after_own_edit boolean NOT NULL DEFAULT false,
  bytes bigint NOT NULL DEFAULT 0,
  calls integer NOT NULL DEFAULT 0,
  seq integer NOT NULL,
  CONSTRAINT session_okf_access_op_check CHECK (op IN ('read', 'grep', 'list', 'write')),
  CONSTRAINT session_okf_access_session_path_op_edit_key UNIQUE (session_id, path_key, op, after_own_edit)
);
