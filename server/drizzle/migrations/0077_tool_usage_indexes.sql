-- Tools/MCP monitoring index follow-up (2026-06-19 mcp-invocation-log-tab, post-impl index audit).
--
-- idx_session_tool_usage_last_call_at (0076) is dropped: every Tools/MCP read reaches
-- session_tool_usage through the scoped session tree (`u.session_id = d.id`, served by the UNIQUE
-- (session_id, channel, tool) index) and applies the last_call_at range only as a residual
-- filter, so the index was never read while the drain's delete-then-insert rebuilds paid for it.
--
-- idx_sessions_tool_usage_version serves the startup re-queue in initializeDatabase()
-- (`UPDATE sessions SET tool_usage_version = NULL WHERE tool_usage_version < $1`), which
-- otherwise scans all of sessions on every start under the migration lock. Partial on
-- `IS NOT NULL` (implied by the `<` predicate), so pending rows stay out of it.
--
-- Index-only: no data is rewritten. Re-runnable (`IF EXISTS` / `IF NOT EXISTS`). Older server
-- builds neither read nor need either index, so a rollback keeps working.

DROP INDEX IF EXISTS idx_session_tool_usage_last_call_at;

CREATE INDEX IF NOT EXISTS idx_sessions_tool_usage_version ON sessions (tool_usage_version) WHERE tool_usage_version IS NOT NULL;
