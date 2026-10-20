-- Generic per-user key/value settings store: (user, setting name, setting value) and nothing
-- else. Deliberately domain-agnostic — the server neither interprets `setting_name` nor parses
-- `setting_value`; callers own the meaning of both. `setting_value` is TEXT (not VARCHAR(n)) so
-- a future setting can hold a large payload; the request-size cap lives in the DTO, not here.

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setting_name VARCHAR(100) NOT NULL,
  setting_value TEXT,
  PRIMARY KEY (user_id, setting_name)
);
