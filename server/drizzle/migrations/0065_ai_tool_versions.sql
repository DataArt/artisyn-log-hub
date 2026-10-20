-- Claude Code version check: two new tables plus two nullable session_stats columns.
--
-- Additive only. No column or table is dropped, renamed or retyped, no existing value is
-- rewritten, and no row is deleted. Every statement is IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS, so the whole file is re-runnable (migrations here are hand-written, never
-- `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md).
--
-- No index is built concurrently here: Drizzle wraps every migration file in a single
-- BEGIN/COMMIT, and a concurrent index build cannot run inside a transaction. The one
-- index below is on a table created empty in this same transaction, so its build is
-- instant.
--
-- Lock/rewrite profile: both ADD COLUMNs are nullable WITH NO DEFAULT, so PostgreSQL
-- records them in the catalog only (metadata-only) -- no full-table rewrite and no long
-- AccessExclusiveLock hold on session_stats.
--
-- NO DATA IS BACKFILLED BY THIS MIGRATION. `ai_tool_version` / `ai_tool_version_history`
-- fill from the hourly npm dist-tags check; `session_stats.claude_version` fills when a
-- session is (re)computed from its transcript and `claude_version_otel` on the next OTEL
-- chunk ingest. Until then both stay NULL, which every surface treats as "unknown".

-- 1) ai_tool_version: one row per AI tool (e.g. 'claude-code') holding the latest fetched
--    npm dist-tags ({ stable, latest }) and the cluster fetch-claim timestamps.
--    version_map is NULL until the first successful fetch.
CREATE TABLE IF NOT EXISTS ai_tool_version (
  tool_name       varchar(64) PRIMARY KEY,
  version_map     jsonb,
  fetched_at      timestamptz,
  last_attempt_at timestamptz
);

-- 2) ai_tool_version_history: append-only history of distinct { stable, latest } maps,
--    effective from the fetch that first observed them.
CREATE TABLE IF NOT EXISTS ai_tool_version_history (
  id             serial PRIMARY KEY,
  tool_name      varchar(64) NOT NULL,
  version_map    jsonb NOT NULL,
  effective_from timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_tool_version_history_tool_effective_idx
  ON ai_tool_version_history (tool_name, effective_from);

-- 3) session_stats: highest Claude Code version seen on the transcript lines, and the
--    OTEL `service.version` fallback.
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS claude_version varchar(64);
ALTER TABLE session_stats ADD COLUMN IF NOT EXISTS claude_version_otel varchar(64);
