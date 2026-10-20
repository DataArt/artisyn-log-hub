CREATE INDEX idx_logs_user_id ON logs (user_id);

CREATE INDEX idx_log_repositories_repo_id ON log_repositories (repo_id);

CREATE INDEX idx_team_members_user_id ON team_members (user_id);

CREATE INDEX idx_invitations_invitee_id ON invitations (invitee_id);

CREATE INDEX idx_invitations_inviter_id ON invitations (inviter_id);

CREATE INDEX idx_users_role ON users (role);
