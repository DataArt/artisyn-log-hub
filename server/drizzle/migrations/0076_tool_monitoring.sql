-- Tools/MCP monitoring: config tables, derived per-session tool usage, rebuild marker and the
-- hook's wrapper status (2026-06-19 mcp-invocation-log-tab, T-26).
--
-- repo_tool_monitor_config / team_repo_tool_monitor_config hold the monitored CLI tool list of a
-- personal repository row (one per user already) and of a team-repository link, as
-- `config jsonb` ({ paused, tools: [{ name, enabled, capture }] }, DD-1). They mirror
-- repo_config / team_repo_config but are separate tables, so the existing settings PUTs (which
-- replace the whole RepoConfigJson blob and recompute file stats) never touch the tool list.
-- Both cascade away with their owning repositories / team_repositories row.
--
-- session_tool_usage holds derived per-node (sessions row = one agent/tree node) MCP and CLI tool
-- usage: one row per (session_id, channel, tool). Three jsonb columns (aggregates, calls,
-- outputs) are TOASTed separately, so the summary query that names only `aggregates` never
-- detoasts the call list or the captured outputs (DD-9). It is rebuilt delete-then-insert per
-- session tree by the background drain (DD-7, DD-8) and cascades away with its sessions row. The
-- UNIQUE index's leading session_id serves the per-node delete and the tree read, so no extra
-- session_id index is added; last_call_at is indexed for the date-range reads.
--
-- sessions.tool_usage_version is the rebuild marker: NULL = rebuild pending, otherwise the
-- extractor version the node's rows were built with. The partial index covers exactly the
-- pending, non-deleted sessions the drain claims (FOR UPDATE SKIP LOCKED).
--
-- repositories.tool_wrap_status is the last wrapper status the hook reported for that repository
-- row (hook version, OS, pre-flight, breaker, last wrapper record per tool; DD-20). NULL = never
-- reported (an old hook, or no wrapper data yet).
--
-- Additive only: no existing column, table, constraint or row is altered, renamed or deleted.
-- Every statement is guarded (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS), so the
-- file is re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). Older server builds ignore the new tables and columns.
--
-- Implicit backfill: tool_usage_version starts NULL on every existing session, which marks every
-- existing non-deleted session as pending. After deploy the background drain walks them in
-- batches (TOOL_USAGE_REBUILD_BATCH per TOOL_USAGE_REBUILD_INTERVAL_MS), each tree in its own
-- transaction, never blocking ingest (SKIP LOCKED). No data is rewritten by this file itself.
--
-- Lock/rewrite profile: the three new tables are new and empty, so their CREATE TABLE takes only
-- instant catalog locks. Both ADD COLUMNs are nullable WITH NO DEFAULT, so PostgreSQL only
-- updates the catalog (no table rewrite). The partial index on sessions takes a brief ShareLock
-- to build over every non-deleted session (all NULL at first) -- the same profile as
-- sessions_okf_snapshot_id_idx in 0075. CONCURRENTLY is never used here, since Drizzle wraps
-- every migration file in BEGIN/COMMIT and Postgres forbids CONCURRENTLY in a transaction.

CREATE TABLE IF NOT EXISTS repo_tool_monitor_config (
  repo_id integer PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_repo_tool_monitor_config (
  team_repository_id integer PRIMARY KEY REFERENCES team_repositories(id) ON DELETE CASCADE,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_tool_usage (
  id serial PRIMARY KEY,
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel varchar(8) NOT NULL,
  tool text NOT NULL,
  call_count integer NOT NULL DEFAULT 0,
  first_call_at timestamptz,
  last_call_at timestamptz,
  has_wrapper_data boolean NOT NULL DEFAULT false,
  aggregates jsonb NOT NULL,
  calls jsonb NOT NULL,
  outputs jsonb,
  CONSTRAINT session_tool_usage_channel_check CHECK (channel IN ('mcp', 'cli')),
  CONSTRAINT session_tool_usage_session_channel_tool_key UNIQUE (session_id, channel, tool)
);

CREATE INDEX IF NOT EXISTS idx_session_tool_usage_last_call_at ON session_tool_usage (last_call_at);

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tool_usage_version smallint;

CREATE INDEX IF NOT EXISTS idx_sessions_tool_usage_pending ON sessions (id) WHERE tool_usage_version IS NULL AND NOT deleted;

ALTER TABLE repositories ADD COLUMN IF NOT EXISTS tool_wrap_status jsonb;
