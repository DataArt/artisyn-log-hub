CREATE TABLE IF NOT EXISTS user_favorite_sessions (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, session_id)
);
