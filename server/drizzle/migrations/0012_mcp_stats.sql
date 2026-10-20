ALTER TABLE session_stats
  ADD COLUMN mcp_calls_total  integer NOT NULL DEFAULT 0,
  ADD COLUMN mcp_calls_by_server jsonb  NOT NULL DEFAULT '{}';
