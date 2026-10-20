-- Make logs_otel.session_id cascade on session delete.
--
-- 0041 created the FK without ON DELETE CASCADE, which blocks every existing path that removes a
-- session: the retention purge (`hardPurgeExpiredSessions`), repo/session deletion, and the e2e
-- cleanup helper all delete `sessions` rows and would now fail with
-- `violates foreign key constraint "logs_otel_session_id_fkey"`.
--
-- Cascade rather than teaching each of those paths about the new table: an OTEL chunk has no
-- meaning without its session, it is derived data reproducible by re-upload, and relying on every
-- current and future delete path to remember a new table is exactly how orphan-blocking bugs get
-- reintroduced. `user_id` already cascades for the same reason.

ALTER TABLE logs_otel DROP CONSTRAINT IF EXISTS logs_otel_session_id_fkey;

ALTER TABLE logs_otel
  ADD CONSTRAINT logs_otel_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
