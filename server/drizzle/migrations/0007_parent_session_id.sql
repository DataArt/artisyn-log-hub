ALTER TABLE sessions ADD COLUMN parent_session_id varchar(255);
CREATE INDEX sessions_parent_session_id_idx ON sessions (parent_session_id);
