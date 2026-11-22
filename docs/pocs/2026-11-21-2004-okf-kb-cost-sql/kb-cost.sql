-- PoC: FR-0 counting rules and FR-5a KB cost of 2026-11-21-okf-tab-minimal, in one read-only query.
-- psql variables: repo_id (repositories.id), days (period length, counted back from now).
\set ON_ERROR_STOP on
\timing on
BEGIN READ ONLY;

WITH RECURSIVE params AS (SELECT :repo_id::int AS repo_id, :days::int AS days),
roots AS (
  -- Same predicates as loadScopedRootSessions (scoped-sessions.sql.ts), no branch/user/attr filter.
  SELECT s.id, l.user_id, l.start_time, COALESCE(l.git_branch, 'no branch') AS branch,
         s.okf_snapshot_id
  FROM sessions s
  JOIN logs l ON l.session_id = s.id
  JOIN log_repositories lr ON lr.log_id = l.id
  WHERE lr.repo_id = (SELECT repo_id FROM params)
    AND l.log_type = 'artisyn'
    AND l.first_prompt IS NOT NULL
    AND s.deleted = false
    AND EXISTS (SELECT 1 FROM logs cl WHERE cl.session_id = l.session_id AND cl.log_type = 'claude')
    AND l.start_time >= now() - make_interval(days => (SELECT days FROM params))
),
ref AS (
  -- Reference snapshot: newest root on main / master that has one, else newest of all.
  SELECT o.body, r.branch, r.start_time, o.created_at
  FROM roots r
  JOIN okf_snapshots o ON o.user_id = r.user_id AND o.snapshot_id = r.okf_snapshot_id
  ORDER BY (r.branch IN ('main', 'master')) DESC, r.start_time DESC
  LIMIT 1
),
bundle AS (
  SELECT b->>'root' AS root, (b->>'root') || '/' AS prefix
  FROM ref, jsonb_array_elements(ref.body->'bundles') b
),
snap_file AS (
  SELECT f->>'path' AS path
  FROM ref, jsonb_array_elements(ref.body->'bundles') b, jsonb_array_elements(b->'files') f
),
descendant_sessions AS (
  SELECT id, session_id, parent_session_id, id AS root_id, 0 AS depth
  FROM sessions WHERE id IN (SELECT id FROM roots)
  UNION ALL
  SELECT s.id, s.session_id, s.parent_session_id, d.root_id, d.depth + 1
  FROM sessions s JOIN descendant_sessions d ON s.parent_session_id = d.session_id
  WHERE d.depth < 50
),
node AS (SELECT DISTINCT root_id, id FROM descendant_sessions),
-- FR-0 reads: read / grep rows under a bundle root, no glob characters.
kb_row AS (
  SELECT n.root_id, n.id AS node_id, a.path_key, a.bytes, a.calls,
         (SELECT bu.root FROM bundle bu
           WHERE a.path_key LIKE replace(replace(bu.prefix, '\', '\\'), '_', '\_') || '%'
           ORDER BY length(bu.prefix) DESC LIMIT 1) AS bundle_root
  FROM node n
  JOIN session_okf_access a ON a.session_id = n.id
  WHERE a.op IN ('read', 'grep')
    AND a.path_key !~ '[*?{}\[\]]'
),
kb AS (SELECT * FROM kb_row WHERE bundle_root IS NOT NULL),
-- FR-5a per node: context-side cost and the tokens the node put into the context.
node_cost AS (
  SELECT n.id AS node_id,
         COALESCE(ss.input_tokens, 0) + COALESCE(ss.cache_write_tokens, 0) AS ctx_tokens,
         CASE WHEN sc.cost IS NULL THEN NULL ELSE
           COALESCE(sc.cost_input, 0) + COALESCE(sc.cost_cache_write_5m, 0)
           + COALESCE(sc.cost_cache_write_1h, 0) + COALESCE(sc.cost_cache_read, 0) END AS ctx_cost,
         sc.cost AS cost
  FROM node n
  LEFT JOIN session_stats ss ON ss.session_id = n.id
  LEFT JOIN session_costs sc ON sc.session_id = n.id
),
node_kb AS (
  SELECT node_id, SUM(bytes) / 4.0 AS kb_tokens, SUM(calls) AS reads FROM kb GROUP BY node_id
),
node_kb_cost AS (
  SELECT nk.node_id, nk.kb_tokens, nk.reads, nc.ctx_cost, nc.ctx_tokens,
         CASE WHEN nc.ctx_cost IS NULL OR nc.ctx_tokens <= 0 THEN NULL
              ELSE LEAST(1, nk.kb_tokens / nc.ctx_tokens) * nc.ctx_cost END AS kb_cost
  FROM node_kb nk JOIN node_cost nc ON nc.node_id = nk.node_id
),
file_stat AS (
  SELECT k.path_key,
         COUNT(DISTINCT k.root_id) AS sessions,
         SUM(k.calls) AS reads,
         SUM(k.bytes) / 4.0 AS tokens,
         SUM(CASE WHEN nkc.kb_cost IS NULL THEN 0
                  ELSE nkc.kb_cost * (k.bytes / 4.0) / NULLIF(nkc.kb_tokens, 0) END) AS cost
  FROM kb k JOIN node_kb_cost nkc ON nkc.node_id = k.node_id
  GROUP BY k.path_key
)
SELECT * FROM (
  SELECT 1 AS ord, 'M root sessions' AS metric, (SELECT COUNT(*) FROM roots)::text AS value
  UNION ALL SELECT 2, 'N roots with a read', (SELECT COUNT(DISTINCT root_id) FROM kb)::text
  UNION ALL SELECT 3, 'tree nodes', (SELECT COUNT(*) FROM node)::text
  UNION ALL SELECT 4, 'reference snapshot branch / root start',
    (SELECT branch || ' / ' || start_time::text FROM ref)
  UNION ALL SELECT 5, 'snapshot files', (SELECT COUNT(*) FROM snap_file)::text
  UNION ALL SELECT 6, 'KB tokens (bytes/4)', (SELECT ROUND(SUM(bytes) / 4.0)::text FROM kb)
  UNION ALL SELECT 7, 'KB cost, FR-5a', (SELECT ROUND(SUM(kb_cost)::numeric, 2)::text FROM node_kb_cost)
  UNION ALL SELECT 8, 'sum of per-file cost', (SELECT ROUND(SUM(cost)::numeric, 2)::text FROM file_stat)
  UNION ALL SELECT 9, 'reads on nodes without a cost',
    (SELECT COALESCE(SUM(reads), 0)::text FROM node_kb_cost WHERE kb_cost IS NULL)
  UNION ALL SELECT 10, 'T = sum of session_costs.cost over all nodes',
    (SELECT ROUND(SUM(cost)::numeric, 2)::text FROM node_cost)
  UNION ALL SELECT 11, 'nodes without a cost / all nodes',
    (SELECT COUNT(*) FILTER (WHERE cost IS NULL)::text || ' / ' || COUNT(*)::text FROM node_cost)
  UNION ALL SELECT 12, 'files opened (in snapshot)',
    (SELECT COUNT(*)::text FROM file_stat WHERE path_key IN (SELECT path FROM snap_file))
  UNION ALL SELECT 13, 'files read, not in snapshot',
    (SELECT COUNT(*)::text FROM file_stat
      WHERE path_key NOT LIKE '%/' AND path_key NOT IN (SELECT path FROM snap_file))
  UNION ALL SELECT 14, 'folder-level search tokens',
    (SELECT ROUND(COALESCE(SUM(tokens), 0))::text FROM file_stat WHERE path_key LIKE '%/')
  UNION ALL SELECT 15, 'index files (index.md / log.md): count, tokens, cost',
    (SELECT COUNT(*)::text || ', ' || ROUND(SUM(tokens))::text || ', ' || ROUND(SUM(cost)::numeric, 2)::text
      FROM file_stat WHERE path_key ~ '(^|/)(index|log)\.md$')
  UNION ALL SELECT 16, 'glob rows dropped (read / grep, any path)',
    (SELECT COUNT(*)::text FROM node n JOIN session_okf_access a ON a.session_id = n.id
      WHERE a.op IN ('read', 'grep') AND a.path_key ~ '[*?{}\[\]]')
  UNION ALL SELECT 17, 'snapshot-bound roots / roots on main|master with a snapshot',
    (SELECT COUNT(*) FILTER (WHERE okf_snapshot_id IS NOT NULL)::text || ' / ' ||
            COUNT(*) FILTER (WHERE okf_snapshot_id IS NOT NULL AND branch IN ('main', 'master'))::text
       FROM roots)
) t ORDER BY ord;

ROLLBACK;
