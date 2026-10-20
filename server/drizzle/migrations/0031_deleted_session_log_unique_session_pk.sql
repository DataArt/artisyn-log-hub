-- Deduplicate any pre-existing rows before adding the uniqueness constraint —
-- keeps the earliest (lowest id) audit row per session_pk, discards the rest.
DELETE FROM deleted_session_log a
USING deleted_session_log b
WHERE a.session_pk = b.session_pk
  AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS deleted_session_log_session_pk_unique
  ON deleted_session_log (session_pk);
