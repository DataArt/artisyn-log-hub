CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_teams_owner_id ON teams (owner_id);
CREATE INDEX IF NOT EXISTS idx_invitations_team_id ON invitations (team_id);
CREATE INDEX IF NOT EXISTS idx_logs_log_type ON logs (log_type);
CREATE INDEX IF NOT EXISTS idx_repo_config_repo_id ON repo_config (repo_id);
CREATE INDEX IF NOT EXISTS idx_session_file_stats_session_id ON session_file_stats (session_id);
