-- 1. repositories: single-column repo_url lookup (existing unique index leads with user_id)
CREATE INDEX IF NOT EXISTS idx_repositories_repo_url ON repositories(repo_url);

-- 2. log_repositories: composite covering index (repo_id, log_id) replaces single-column index
DROP INDEX IF EXISTS idx_log_repositories_repo_id;
CREATE INDEX IF NOT EXISTS idx_log_repositories_repo_id_log_id ON log_repositories(repo_id, log_id);

-- 3. logs: composite index for timeline queries combining user_id + log_type + start_time range
CREATE INDEX IF NOT EXISTS idx_logs_user_id_log_type_start_time
    ON logs(user_id, log_type, start_time)
    WHERE first_prompt IS NOT NULL;

-- 4. logs: partial index for completed artisyn sessions (session list / summary endpoints)
CREATE INDEX IF NOT EXISTS idx_logs_artisyn_with_prompt
    ON logs(session_id, start_time, user_id)
    WHERE log_type = 'artisyn' AND first_prompt IS NOT NULL;

-- 5. team_repositories: single-column repo_url lookup (existing unique index leads with team_id)
CREATE INDEX IF NOT EXISTS idx_team_repositories_repo_url ON team_repositories(repo_url);
