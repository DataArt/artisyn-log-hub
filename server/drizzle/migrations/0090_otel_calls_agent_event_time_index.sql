-- OTEL Live view follow-up (2026-11-04 otel-live-view, indexes check).
--
-- The Live view's per-agent reads of a sub-agent (latest calls, latest events, cost per minute,
-- 5-minute buckets, top models, Sankey) filter otel_calls on session_id = ? AND agent_id = ? and
-- then order by event_time DESC with a LIMIT, or narrow by an event_time window. With only
-- idx_otel_calls_session_agent (session_id, agent_id) PostgreSQL fetched and sorted every call of
-- the agent before the LIMIT. The new partial index adds event_time as the third column, so those
-- reads walk the index in event_time order (a backward scan) and stop at the LIMIT / window edge.
-- call_key is not added: idx_otel_calls_session_event_time (the all-agents twin) has no tiebreaker
-- either, event_time ties within one agent are rare, and the ORDER BY ... call_key DESC tiebreak
-- is an incremental sort over the few tied rows, cheaper than widening every index entry by a
-- varchar(255) key.
--
-- idx_otel_calls_session_agent (migration 0088) is dropped: it is a strict prefix of the new
-- index with the same partial predicate (WHERE agent_id IS NOT NULL), so every query it served --
-- the sub-agent OTEL cost sum (subagentOtelCostSql, agent_id = <id>) and the Live agent filter --
-- is served by the new one through its (session_id, agent_id) prefix.
--
-- No column, table or row changes. Older server builds never name an index, so they read the
-- same through the new one. Both statements are guarded (IF NOT EXISTS / IF EXISTS), so the file
-- is re-runnable (migrations here are hand-written, never `drizzle-kit generate` -- see
-- docs/knowledgebase/db-schema-code.md). The new index is created before the old one is dropped,
-- so no moment is left without an index on (session_id, agent_id).
--
-- Lock/rewrite profile: no table rewrite. CREATE INDEX takes a SHARE lock on otel_calls while it
-- builds over the rows with agent_id set (writes wait, reads continue); DROP INDEX takes a short
-- ACCESS EXCLUSIVE lock on the table. CONCURRENTLY is never used here, since Drizzle wraps every
-- migration file in BEGIN/COMMIT.
--
-- Rollback: recreate idx_otel_calls_session_agent ON otel_calls (session_id, agent_id)
-- WHERE agent_id IS NOT NULL, then drop idx_otel_calls_session_agent_event_time.

CREATE INDEX IF NOT EXISTS idx_otel_calls_session_agent_event_time
  ON otel_calls (session_id, agent_id, event_time)
  WHERE agent_id IS NOT NULL;

DROP INDEX IF EXISTS idx_otel_calls_session_agent;
