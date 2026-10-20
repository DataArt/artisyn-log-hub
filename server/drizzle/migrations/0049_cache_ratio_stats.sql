-- T-83 cache read ratio metric.
--
-- 1) session_stats gains the TTL split of cache creation. These are threshold-independent
--    and therefore live in the unscoped session_stats row.
--    Invariant (test-enforced, not a DB constraint):
--      cache_write_5m_tokens + cache_write_1h_tokens = cache_write_tokens
--    Backfilled by POST :repoId/recompute-all-sessions, not by this migration.
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS cache_write_5m_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0;

-- 2) session_cause_stats: the cache-creation cause decomposition.
--    Scoped (nullable team_id / user_id, exactly as session_file_stats) because the
--    high-cache-creation threshold it is computed with is itself a scoped repo_config
--    field: a team value and a personal override must be able to coexist for the same
--    session. `threshold` records the value the stored totals were computed with.
--    Invariant (test-enforced): compaction_tokens + file_reread_tokens +
--    unattributed_tokens = session_stats.cache_write_tokens for the same session.
CREATE TABLE IF NOT EXISTS session_cause_stats (
  session_id          INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  team_id             INTEGER          REFERENCES teams(id) ON DELETE CASCADE,
  user_id             INTEGER          REFERENCES users(id) ON DELETE CASCADE,
  threshold           INTEGER NOT NULL,
  compaction_tokens   BIGINT  NOT NULL DEFAULT 0,
  file_reread_tokens  BIGINT  NOT NULL DEFAULT 0,
  unattributed_tokens BIGINT  NOT NULL DEFAULT 0,
  compaction_turns    INTEGER NOT NULL DEFAULT 0,
  file_reread_turns   INTEGER NOT NULL DEFAULT 0,
  unattributed_turns  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_cause_stats_session_id
  ON session_cause_stats (session_id);

-- The two ON CONFLICT targets of the scoped upsert. Partial unique indexes cannot be
-- expressed declaratively in Drizzle, so they exist in SQL only.
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_cause_stats_session_team
  ON session_cause_stats (session_id, team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_cause_stats_session_user
  ON session_cause_stats (session_id, user_id) WHERE user_id IS NOT NULL;
