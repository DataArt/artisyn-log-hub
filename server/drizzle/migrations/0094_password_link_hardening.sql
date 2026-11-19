-- Password-link hardening (2026-11-05 auth-mode-admin-invite, review fixes).
--
-- 1. password_reset_tokens.token now holds sha256(<link token>) as 64 lowercase hex chars, never
--    the token itself: a DB read (backup, dump) no longer yields usable reset / set-password
--    links. Existing rows are hashed in place, so links already sitting in mailboxes keep working
--    (the server hashes the token from the link and looks that up). The WHERE clause skips values
--    that already look like a hash, so a re-run never hashes twice; real tokens are 43-char
--    base64url and never match it.
-- 2. password_reset_tokens.purpose: 'set' for admin-issued set-password links (strict-managed
--    bootstrap, create user, resend link), 'reset' for "Forgot password?". "Forgot password?"
--    retires only earlier 'reset' links, so an anonymous request cannot cancel an admin-issued
--    link. Existing rows become 'reset' (the default), which only matters for the resend cooldown.
-- 3. email_send_counters: fixed one-hour windows for the strict-managed email limit, shared by
--    every cluster worker (the old in-memory limiter counted per worker).
--
-- Data: no row is deleted. Older server builds look tokens up by their plain value, so after a
-- rollback the links issued before it stop working and users request new ones; nothing else in
-- older builds reads the new column or table.
--
-- Lock/rewrite profile: one UPDATE over password_reset_tokens (a small table: one row per issued
-- link) and ADD COLUMN with a constant default (no rewrite). The new table is empty.
--
-- Rollback: drop email_send_counters and password_reset_tokens.purpose; hashed tokens cannot be
-- turned back, so outstanding links are lost.

UPDATE password_reset_tokens
SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
WHERE token !~ '^[0-9a-f]{64}$';
--> statement-breakpoint
ALTER TABLE password_reset_tokens
  ADD COLUMN IF NOT EXISTS purpose varchar(16) NOT NULL DEFAULT 'reset';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS email_send_counters (
  key varchar(320) PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
--> statement-breakpoint
COMMENT ON COLUMN password_reset_tokens.token IS 'sha256 of the link token, 64 lowercase hex chars; the token itself is never stored';
--> statement-breakpoint
COMMENT ON COLUMN password_reset_tokens.purpose IS '''set'' = admin-issued set-password link (strict-managed), ''reset'' = "Forgot password?" link';
--> statement-breakpoint
COMMENT ON TABLE email_send_counters IS 'strict-managed email limit: one fixed one-hour window per key (ip:<addr> or admin:<user id>), shared by all cluster workers';
