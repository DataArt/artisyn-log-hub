-- Session tags (2026-11-24 otel-session-tags).
--
-- New table session_tags: one row per (root session, key, value, source). Tags come from the
-- OTEL resource attributes a session reports (source 'otel', written by the OTEL projection) and,
-- for history, from the hook's old per-prompt `context` labels (source 'config', copied here once).
-- The hook config `context` mechanism is retired: the two tables that stored it (contexts and
-- log_contexts) are dropped after their pairs are copied, so no labelled data is lost.
--
-- Data move: every distinct (session, context_key, context_value) reachable through
-- log_contexts -> contexts -> logs is attached to the session's root (walked up
-- parent_session_id, at most 50 levels, the same walk as 0074). A session whose parent row does
-- not exist is its own root. Pairs of soft-deleted sessions do not exist any more (their logs were
-- purged), so nothing of theirs is copied. Values are copied unchanged (keys <= 255 chars, values
-- <= 4000 chars, both already held by the old btree UNIQUE(context_key, context_value), so they fit
-- the new btree indexes too). On a clean database the INSERT copies nothing.
--
-- Destructive by design (stated in the task requirements): contexts and log_contexts are dropped.
-- Not reversible: the per-log link of a pair is not kept, only the root session.
--
-- Lock profile: the new table is empty. The INSERT reads log_contexts / contexts (small: one row
-- per distinct label pair and per labelled log). DROP TABLE log_contexts briefly locks logs to
-- remove its FK trigger; migrations run at startup before the server takes traffic.
--
-- Compatibility: an older server build would still try to write contexts / log_contexts on a
-- prompt_start with `context` and fail; this migration ships together with the build that stops
-- doing so. Old hooks keep sending `context`; the new server stores the line and ignores it.
--
-- Re-runnable: every DDL statement is guarded, and the copy step only runs while log_contexts
-- still exists.

CREATE TABLE IF NOT EXISTS session_tags (
  id serial PRIMARY KEY,
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  source varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_tags_session_key_value_source_unique UNIQUE (session_id, key, value, source)
);

CREATE INDEX IF NOT EXISTS session_tags_key_value_session_idx
  ON session_tags (key, value, session_id);

COMMENT ON TABLE session_tags IS 'Tags of a root session (key = value pairs): OTEL resource attributes written by the OTEL projection, plus legacy hook-config context labels copied once. A key may have several values per session.';
COMMENT ON COLUMN session_tags.session_id IS 'Always the root session; sub-agents read their root''s tags.';
COMMENT ON COLUMN session_tags.source IS 'Where the pair came from: ''otel'' (OTEL resource attribute) or ''config'' (legacy hook log-hub.json context, read-only history).';

DO $$
BEGIN
  IF to_regclass('public.log_contexts') IS NOT NULL AND to_regclass('public.contexts') IS NOT NULL THEN
    INSERT INTO session_tags (session_id, key, value, source)
    WITH RECURSIVE pairs AS (
      SELECT DISTINCT l.session_id, c.context_key, c.context_value
        FROM log_contexts lc
        JOIN contexts c ON c.id = lc.context_id
        JOIN logs l ON l.id = lc.log_id
    ),
    ancestry AS (
      SELECT s.id AS start_id, s.id AS cur_id, s.parent_session_id, 0 AS depth
        FROM sessions s
       WHERE s.id IN (SELECT session_id FROM pairs)
      UNION ALL
      SELECT a.start_id, p.id, p.parent_session_id, a.depth + 1
        FROM ancestry a
        JOIN sessions p ON p.session_id = a.parent_session_id
       WHERE a.depth < 50
    ),
    root AS (
      SELECT DISTINCT ON (start_id) start_id, cur_id AS root_id
        FROM ancestry
       ORDER BY start_id, depth DESC, cur_id
    )
    SELECT DISTINCT r.root_id, p.context_key, p.context_value, 'config'
      FROM pairs p
      JOIN root r ON r.start_id = p.session_id
    ON CONFLICT (session_id, key, value, source) DO NOTHING;
  END IF;
END $$;

DROP TABLE IF EXISTS log_contexts;
DROP TABLE IF EXISTS contexts;
