-- OTEL status per session (2026-10-30 otel-shared-receiver).
--
-- Three nullable session_stats columns carry the latest OTEL status the hook reported for a
-- root session (event `otel-status`): otel_state (e.g. ok / off / broken), otel_reason (short
-- machine reason code, NULL when the state needs none) and otel_status (jsonb detail:
-- {timestamp, detail, received, claudeVersion, forward, hookVersion, receiverVersion}). The
-- server ingest is the sole writer; the latest event timestamp wins.
--
-- Additive only: no existing column, table, constraint or row is altered, renamed or deleted.
-- No backfill: NULL = no status reported (every existing row and every session from an older
-- hook). Every statement is guarded (ADD COLUMN IF NOT EXISTS), so the file is re-runnable
-- (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). Older server builds ignore the new columns.
--
-- Lock/rewrite profile: each ADD COLUMN is nullable WITH NO DEFAULT, so PostgreSQL only updates
-- the catalog (brief AccessExclusiveLock, no table rewrite). No index: coverage reads filter by
-- the already indexed session scope.
--
-- Rollback: drop the three columns (ALTER TABLE session_stats DROP COLUMN IF EXISTS otel_state,
-- DROP COLUMN IF EXISTS otel_reason, DROP COLUMN IF EXISTS otel_status). Nothing else depends on
-- them.

ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS otel_state varchar(16);
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS otel_reason varchar(32);
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS otel_status jsonb;
