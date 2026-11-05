-- OTEL cost attribution (2026-11-03 otel-cost-attribution, GH-89).
--
-- otel_calls gains the per-call OTEL attributes Claude Code 2.1.300+ sends on api_request
-- records: the 5-minute / 1-hour cache-write split, effort, speed (fast mode), and the skill,
-- plugin, agent, MCP server and MCP tool names. All nullable: NULL = not reported (older Claude
-- Code, a default value, or OTEL_LOG_TOOL_DETAILS unset).
--
-- otel_cost_buckets gains four more grain dimensions (skill, mcp_server, effort, speed), stored
-- like the existing ones as NOT NULL DEFAULT '' with '' = not reported, and its primary key is
-- recreated over all nine grain columns so the rollups can be stacked by them.
--
-- otel_session_state gains the account facts of the root session (plan, seat type, provider,
-- sanitised custom base URL) and the event time of the record that last set them
-- (latest-wins merge in otel-facts-writer.ts).
--
-- A partial index on otel_calls (session_id, agent_id) serves the per-sub-agent OTEL cost sum of
-- the session cost tree.
--
-- Additive only: no column, table or row is renamed or deleted; existing values are unchanged.
-- Every ADD COLUMN / CREATE INDEX is guarded (IF NOT EXISTS) and the primary-key recreate drops
-- and re-adds the same constraint name, so the file is re-runnable (migrations here are
-- hand-written, never `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md).
-- Older server builds ignore the new columns: the bucket columns default to '' on insert and the
-- wider primary key still holds every row an older writer produces.
--
-- Implicit backfill: none here. Existing bucket rows read as '' (not reported). The server bumps
-- OTEL_PROJECTION_VERSION, so the projection drain re-projects every OTEL chunk after deploy and
-- fills the new columns from the stored raw records.
--
-- Lock/rewrite profile: the nullable ADD COLUMNs without default and the NOT NULL DEFAULT ''
-- ADD COLUMNs are catalog-only on PostgreSQL 11+ (no table rewrite). The primary-key recreate on
-- otel_cost_buckets takes an ACCESS EXCLUSIVE lock and rebuilds that index once (a per-hour
-- projection table, acceptable). The partial index on otel_calls takes a SHARE lock while it
-- builds over the rows with agent_id set: writes wait, reads continue. CONCURRENTLY is never used
-- here, since Drizzle wraps every migration file in BEGIN/COMMIT.
--
-- Rollback: drop the new columns and the index, and recreate otel_cost_buckets_pk over
-- (session_id, bucket_start, structure, query_source, model, cc_version) after zero-summing rows
-- that collide on that narrower key.

ALTER TABLE otel_calls
  ADD COLUMN IF NOT EXISTS cache_write_5m_tokens bigint,
  ADD COLUMN IF NOT EXISTS cache_write_1h_tokens bigint,
  ADD COLUMN IF NOT EXISTS effort varchar(64),
  ADD COLUMN IF NOT EXISTS speed varchar(64),
  ADD COLUMN IF NOT EXISTS skill_name varchar(255),
  ADD COLUMN IF NOT EXISTS plugin_name varchar(255),
  ADD COLUMN IF NOT EXISTS agent_name varchar(255),
  ADD COLUMN IF NOT EXISTS mcp_server_name varchar(255),
  ADD COLUMN IF NOT EXISTS mcp_tool_name varchar(255);

ALTER TABLE otel_cost_buckets
  ADD COLUMN IF NOT EXISTS skill varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS mcp_server varchar(255) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS effort varchar(64) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS speed varchar(64) NOT NULL DEFAULT '';

ALTER TABLE otel_cost_buckets
  DROP CONSTRAINT IF EXISTS otel_cost_buckets_pk,
  ADD CONSTRAINT otel_cost_buckets_pk PRIMARY KEY
    (session_id, bucket_start, structure, query_source, model, cc_version, skill, mcp_server, effort, speed);

ALTER TABLE otel_session_state
  ADD COLUMN IF NOT EXISTS plan varchar(64),
  ADD COLUMN IF NOT EXISTS seat_type varchar(64),
  ADD COLUMN IF NOT EXISTS provider varchar(64),
  ADD COLUMN IF NOT EXISTS custom_base_url varchar(1024),
  ADD COLUMN IF NOT EXISTS account_event_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_otel_calls_session_agent
  ON otel_calls (session_id, agent_id)
  WHERE agent_id IS NOT NULL;

COMMENT ON COLUMN otel_calls.cache_write_5m_tokens IS 'Cache-write tokens at the 5-minute TTL (OTEL cache_creation_5m_tokens); NULL = split not reported.';
COMMENT ON COLUMN otel_calls.cache_write_1h_tokens IS 'Cache-write tokens at the 1-hour TTL (OTEL cache_creation_1h_tokens); NULL = split not reported.';
COMMENT ON COLUMN otel_calls.effort IS 'Reasoning effort of the call (OTEL effort); NULL = not reported.';
COMMENT ON COLUMN otel_calls.speed IS 'Speed mode of the call, e.g. fast (OTEL speed); NULL = not reported.';
COMMENT ON COLUMN otel_calls.skill_name IS 'Skill active for the call (OTEL skill.name); NULL = not reported.';
COMMENT ON COLUMN otel_calls.plugin_name IS 'Plugin of the active skill or agent (OTEL plugin.name); NULL = not reported.';
COMMENT ON COLUMN otel_calls.agent_name IS 'Sub-agent type name (OTEL agent.name), unlike agent_id which is the instance id; NULL = not reported.';
COMMENT ON COLUMN otel_calls.mcp_server_name IS 'MCP server of the tool call that led to this request (OTEL mcp_server.name); NULL = not reported.';
COMMENT ON COLUMN otel_calls.mcp_tool_name IS 'MCP tool of that tool call (OTEL mcp_tool.name); NULL = not reported.';

COMMENT ON COLUMN otel_cost_buckets.skill IS 'Grain dimension from otel_calls.skill_name; empty string = not reported.';
COMMENT ON COLUMN otel_cost_buckets.mcp_server IS 'Grain dimension from otel_calls.mcp_server_name; empty string = not reported.';
COMMENT ON COLUMN otel_cost_buckets.effort IS 'Grain dimension from otel_calls.effort; empty string = not reported.';
COMMENT ON COLUMN otel_cost_buckets.speed IS 'Grain dimension from otel_calls.speed; empty string = not reported.';

COMMENT ON COLUMN otel_session_state.plan IS 'Claude account plan reported by OTEL (anthropic.plan), latest event wins; NULL = never reported.';
COMMENT ON COLUMN otel_session_state.seat_type IS 'Account seat type reported by OTEL (anthropic.seat_type); NULL = never reported.';
COMMENT ON COLUMN otel_session_state.provider IS 'API provider reported by OTEL (anthropic.provider); NULL = never reported.';
COMMENT ON COLUMN otel_session_state.custom_base_url IS 'Custom API base URL reported by OTEL (anthropic.custom_base_url), stored without userinfo, query and fragment; NULL = never reported.';
COMMENT ON COLUMN otel_session_state.account_event_at IS 'Event time of the newest OTEL record that set plan, seat_type, provider or custom_base_url; a field is overwritten only by a record at least this new.';
