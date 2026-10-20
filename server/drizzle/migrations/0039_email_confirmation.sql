ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN email_confirmed_at timestamptz;

CREATE TABLE email_confirmation_tokens (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token varchar NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_confirmation_tokens_token ON email_confirmation_tokens (token);
CREATE INDEX IF NOT EXISTS idx_email_confirmation_tokens_user_id ON email_confirmation_tokens (user_id);
