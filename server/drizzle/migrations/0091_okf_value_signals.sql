-- OKF View: tell what to change in the KB and where (2026-11-03 okf-view-kb-value).
--
-- Two derived per-node tables join session_okf_access:
--   * session_okf_event   -- the code-side tool calls of a node (read / search / write of non-KB
--                            paths), ordered by the node's tool-call ordinal (`ord`), with the
--                            read range and the search pattern. Feeds the article area
--                            "searched after reading" / "routing miss" signals.
--   * session_okf_pointer -- the back-ticked path pointers found in each KB article read of a
--                            node (is_new / followed / partial). Feeds the article area, pointer
--                            yield and dead pointers. A partial read with no pointers stores one
--                            row with pointer = '' so it can be counted.
-- Both are rebuilt delete-then-insert per node by the OKF writer, like session_okf_access.
--
-- session_okf_access gains ranged_calls / ranged_bytes (section reads; also included in
-- calls / bytes) and search_hits (grep / list calls whose result was a hit).
--
-- sessions gains okf_extract_version (NULL = the node's OKF rows were built before this
-- extractor version, or never; the writer sets OKF_EXTRACT_VERSION on every node it rebuilds)
-- and okf_events_truncated (the per-node event / pointer cap was hit).
--
-- Additive only: no existing column, table or row is changed or deleted. Every statement is
-- guarded (IF NOT EXISTS), so the file is re-runnable (migrations here are hand-written, never
-- `drizzle-kit generate`). Older server builds never read or write the new tables and columns;
-- the new access columns have defaults, so their inserts keep working. A row an older build
-- writes leaves okf_extract_version as it was, which the newer read side shows as "no OKF
-- analysis yet" until a recompute.
--
-- Implicit backfill: none. Existing session_okf_access rows get 0 in the new counters, existing
-- sessions get okf_extract_version NULL ("no OKF analysis yet") and okf_events_truncated false.
-- Nothing is re-queued at startup.
--
-- Lock/rewrite profile: ADD COLUMN with a constant DEFAULT (or nullable) is a metadata-only
-- change on PostgreSQL 11+ (no table rewrite), taking a brief ACCESS EXCLUSIVE lock on sessions
-- and session_okf_access. The new tables are empty on creation.
--
-- Rollback: drop the two tables and the five columns; nothing else depends on them.

CREATE TABLE IF NOT EXISTS session_okf_event (
  id serial PRIMARY KEY,
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ord integer NOT NULL,
  op varchar(8) NOT NULL,
  path varchar(1024) NOT NULL,
  range_from integer NULL,
  range_to integer NULL,
  pattern varchar(200) NULL,
  CONSTRAINT session_okf_event_op_check CHECK (op IN ('read', 'search', 'write')),
  CONSTRAINT session_okf_event_session_ord_op_path_key UNIQUE (session_id, ord, op, path)
);

CREATE TABLE IF NOT EXISTS session_okf_pointer (
  id serial PRIMARY KEY,
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  article_path varchar(1024) NOT NULL,
  article_hash varchar(128) NULL,
  read_ord integer NOT NULL,
  pointer varchar(512) NOT NULL,
  is_new boolean NOT NULL,
  followed boolean NOT NULL,
  partial boolean NOT NULL DEFAULT false,
  CONSTRAINT session_okf_pointer_session_ord_article_pointer_key UNIQUE (session_id, read_ord, article_path, pointer)
);

ALTER TABLE session_okf_access ADD COLUMN IF NOT EXISTS ranged_calls integer NOT NULL DEFAULT 0;
ALTER TABLE session_okf_access ADD COLUMN IF NOT EXISTS ranged_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE session_okf_access ADD COLUMN IF NOT EXISTS search_hits integer NOT NULL DEFAULT 0;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS okf_extract_version smallint NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS okf_events_truncated boolean NOT NULL DEFAULT false;

COMMENT ON TABLE session_okf_event IS 'Code-side tool calls (read / search / write of non-KB paths) of each session node, used for OKF article-area value signals; rebuilt delete-then-insert by the OKF writer.';
COMMENT ON COLUMN session_okf_event.ord IS '1-based ordinal of the tool call among the node''s tool calls; shared with session_okf_pointer.read_ord.';
COMMENT ON COLUMN session_okf_event.op IS 'read | search (grep / list) | write.';
COMMENT ON COLUMN session_okf_event.path IS 'Repo-relative path, folders end in / (repo root = /); build/vendor folders are skipped.';
COMMENT ON COLUMN session_okf_event.range_from IS 'First line of a ranged read (negative = from the end, tail -n N); NULL for a whole-file read.';
COMMENT ON COLUMN session_okf_event.range_to IS 'Last line of a ranged read; NULL when open-ended or not ranged.';
COMMENT ON COLUMN session_okf_event.pattern IS 'Search pattern of a grep call, cut to 200 characters; NULL otherwise.';

COMMENT ON TABLE session_okf_pointer IS 'Back-ticked path pointers found in each KB article read of a session node; rebuilt delete-then-insert by the OKF writer.';
COMMENT ON COLUMN session_okf_pointer.article_path IS 'Repo-relative path of the KB article that was read.';
COMMENT ON COLUMN session_okf_pointer.article_hash IS 'Hash of the article in the session''s bound OKF snapshot; NULL when unknown.';
COMMENT ON COLUMN session_okf_pointer.read_ord IS 'Tool-call ordinal of the read (same counter as session_okf_event.ord).';
COMMENT ON COLUMN session_okf_pointer.pointer IS 'Normalised repo-relative path pointer; empty string marks a partial read with no pointers.';
COMMENT ON COLUMN session_okf_pointer.is_new IS 'The pointer did not appear in the node''s earlier text.';
COMMENT ON COLUMN session_okf_pointer.followed IS 'A later call of the same node touched the pointer path or something under it.';
COMMENT ON COLUMN session_okf_pointer.partial IS 'The read result was an error, empty or persisted-output (article not fully seen).';

COMMENT ON COLUMN session_okf_access.ranged_calls IS 'Read calls with a line range (section reads); also counted in calls.';
COMMENT ON COLUMN session_okf_access.ranged_bytes IS 'Result bytes of the ranged read calls; also counted in bytes.';
COMMENT ON COLUMN session_okf_access.search_hits IS 'Grep / list calls on this path whose result was a hit (non-empty, not an error).';

COMMENT ON COLUMN sessions.okf_extract_version IS 'OKF extractor version the node''s OKF rows were built with; NULL = built by an older extractor or never.';
COMMENT ON COLUMN sessions.okf_events_truncated IS 'The per-node OKF event or pointer cap was hit during extraction.';
