CREATE TABLE repo_config (
  repo_id    integer NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id    integer          REFERENCES users(id) ON DELETE CASCADE,
  team_id    integer          REFERENCES teams(id) ON DELETE CASCADE,
  config     jsonb    NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repo_config_scope_check
    CHECK ((team_id IS NOT NULL AND user_id IS NULL) OR (team_id IS NULL AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX ON repo_config (repo_id, team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX ON repo_config (repo_id, user_id)  WHERE user_id  IS NOT NULL;

CREATE TABLE session_file_stats (
  session_id    integer      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  category_name varchar(64)  NOT NULL,
  file_count    integer      NOT NULL DEFAULT 0,
  byte_count    bigint       NOT NULL DEFAULT 0,
  team_id       integer               REFERENCES teams(id) ON DELETE CASCADE,
  user_id       integer               REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT session_file_stats_scope_check
    CHECK ((team_id IS NOT NULL AND user_id IS NULL) OR (team_id IS NULL AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX ON session_file_stats (session_id, category_name, team_id) WHERE team_id IS NOT NULL;
CREATE UNIQUE INDEX ON session_file_stats (session_id, category_name, user_id) WHERE user_id  IS NOT NULL;

INSERT INTO session_file_stats (session_id, category_name, file_count, byte_count, user_id)
SELECT ss.session_id, 'code', ss.code_files, ss.code_bytes, l.user_id
FROM session_stats ss
JOIN logs l ON l.session_id = ss.session_id AND l.log_type IN ('claude', 'claude-subagent')
WHERE ss.code_files > 0 OR ss.code_bytes > 0
ON CONFLICT DO NOTHING;

INSERT INTO session_file_stats (session_id, category_name, file_count, byte_count, user_id)
SELECT ss.session_id, 'docs', ss.doc_files, ss.doc_bytes, l.user_id
FROM session_stats ss
JOIN logs l ON l.session_id = ss.session_id AND l.log_type IN ('claude', 'claude-subagent')
WHERE ss.doc_files > 0 OR ss.doc_bytes > 0
ON CONFLICT DO NOTHING;

ALTER TABLE session_stats
  DROP COLUMN code_files,
  DROP COLUMN code_bytes,
  DROP COLUMN doc_files,
  DROP COLUMN doc_bytes;
