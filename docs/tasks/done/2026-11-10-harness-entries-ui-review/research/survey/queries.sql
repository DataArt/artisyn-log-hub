-- Read-only queries of the harness-entries survey (FR-6). Run by scan.mjs, never by hand.
--
-- The file holds three named sections, each starting with a `-- @query <name>` line. scan.mjs
-- sends one section per psql call (`psql --csv -q`) and passes these psql variables:
--   :'until'  ISO timestamp, the LOGHUB_SURVEY_UNTIL cutoff (every section)
--   :'roots'  int array literal such as {12,13,14}: the root sessions of one batch (`lines` only)
-- Every section runs inside its own READ ONLY transaction with a 60 s statement timeout, so no
-- statement can write and no statement can run long. `lines` is sent in batches of root
-- sessions for the same reason.

-- @query roots
-- Root sessions of the sample: no parent, not deleted, and the `claude` log row was created at or
-- before the cutoff.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT s.id AS root_id
FROM sessions s
JOIN logs l ON l.session_id = s.id AND l.log_type = 'claude'
WHERE s.parent_session_id IS NULL
  AND NOT s.deleted
  AND l.created_at <= :'until'::timestamptz
ORDER BY s.id;
COMMIT;

-- @query lines
-- One row per transcript line of the batch's root sessions and of all their sub-agent
-- sessions. Sub-agent sessions are attributed to their root through parent_session_id, which
-- holds the immediate parent's session_id string (not always the root). Lines whose own
-- `timestamp` is after the cutoff are left out, so a re-run with the same cutoff reads the same
-- lines even when a session was appended to later.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH RECURSIVE tree AS (
  SELECT s.id AS root_id, s.id AS sid, s.session_id
  FROM sessions s
  WHERE s.id = ANY (:'roots'::int[])
  UNION
  SELECT t.root_id, c.id, c.session_id
  FROM sessions c
  JOIN tree t ON c.parent_session_id = t.session_id
  WHERE NOT c.deleted
)
SELECT
  t.root_id,
  l.log_type,
  t.sid AS session_key,
  e.ord AS line_index,
  e.elem ->> 'timestamp' AS ts,
  e.elem ->> 'type' AS line_type,
  e.elem ->> 'subtype' AS subtype,
  e.elem -> 'attachment' ->> 'type' AS attachment_type,
  (
    e.elem ->> 'type' = 'user'
    AND COALESCE(e.elem ->> 'isMeta', 'false') <> 'true'
    AND NOT (
      jsonb_typeof(e.elem -> 'message' -> 'content') = 'array'
      AND jsonb_array_length(e.elem -> 'message' -> 'content') > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(e.elem -> 'message' -> 'content') c
        WHERE c ->> 'type' IS DISTINCT FROM 'tool_result'
      )
    )
  ) AS is_prompt,
  length(e.elem::text) AS line_chars,
  -- Payload shape: field names only, never values.
  CASE
    WHEN jsonb_typeof(e.elem -> 'attachment') = 'object'
      THEN (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(e.elem -> 'attachment') k)
    WHEN jsonb_typeof(e.elem) = 'object'
      THEN (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(e.elem) k)
  END AS payload_keys,
  -- Facet fields (Design Decision 4).
  e.elem ->> 'entrypoint' AS entrypoint,
  e.elem ->> 'version' AS cc_version,
  e.elem ->> 'cwd' AS cwd,
  CASE WHEN e.elem -> 'attachment' ->> 'type' LIKE '%\_in\_ide'
    THEN COALESCE(e.elem -> 'attachment' ->> 'ideName', '') END AS ide_name,
  CASE WHEN e.elem -> 'attachment' ->> 'type' = 'diagnostics' THEN (
    SELECT jsonb_agg(COALESCE(d ->> 'source', ''))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.elem -> 'attachment' -> 'files') = 'array'
                                   THEN e.elem -> 'attachment' -> 'files' ELSE '[]'::jsonb END) f,
         jsonb_array_elements(CASE WHEN jsonb_typeof(f -> 'diagnostics') = 'array'
                                   THEN f -> 'diagnostics' ELSE '[]'::jsonb END) d
  ) END AS diag_sources,
  CASE
    WHEN e.elem -> 'attachment' ->> 'type' = 'hook_success'
      THEN jsonb_build_array(COALESCE(e.elem -> 'attachment' ->> 'command', ''))
    WHEN e.elem ->> 'subtype' = 'stop_hook_summary' AND jsonb_typeof(e.elem -> 'hookInfos') = 'array'
      THEN (SELECT jsonb_agg(COALESCE(h ->> 'command', '')) FROM jsonb_array_elements(e.elem -> 'hookInfos') h)
  END AS hook_cmds,
  CASE WHEN e.elem -> 'attachment' ->> 'type' = 'hook_success'
    THEN COALESCE(e.elem -> 'attachment' ->> 'hookEvent', e.elem -> 'attachment' ->> 'hookName') END AS hook_event,
  CASE WHEN e.elem -> 'attachment' ->> 'type' = 'auto_mode'
    THEN (e.elem -> 'attachment') - 'type' END AS auto_mode
FROM tree t
JOIN logs l ON l.session_id = t.sid AND l.log_type IN ('claude', 'claude-subagent')
CROSS JOIN LATERAL jsonb_array_elements(l.body) WITH ORDINALITY AS e(elem, ord)
WHERE l.created_at <= :'until'::timestamptz
  AND jsonb_typeof(l.body) = 'array'
  AND (
    e.elem ->> 'timestamp' IS NULL
    OR e.elem ->> 'timestamp' !~ '^\d{4}-\d{2}-\d{2}T'
    OR (e.elem ->> 'timestamp')::timestamptz <= :'until'::timestamptz
  )
ORDER BY t.root_id, l.log_type, t.sid, e.ord;
COMMIT;

-- @query repos
-- Current hook version per repository (no per-session hook version is stored anywhere).
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
SELECT r.id AS repo_id, r.hook_version
FROM repositories r
ORDER BY r.id;
COMMIT;
