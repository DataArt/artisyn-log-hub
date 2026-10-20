-- T-93 harness elements usage report.
--
-- Additive only: two brand-new tables plus two nullable columns on `repositories` — no
-- column/table is dropped, renamed or retyped, and no existing value is rewritten. The two
-- new `repositories` columns have no DEFAULT (NULL = "never reported"), so this ALTER only
-- updates the catalog, never rewrites the table.
--
-- No backfill: existing sessions get `session_harness_usage` rows the next time their
-- `claude` log is (re-)ingested (e.g. via POST :repoId/recompute-all-sessions);
-- `harness_elements` and the two `repositories` flags populate from each repo's next
-- artisyn upload. Until then, `harness_inventory_reported_at IS NULL` correctly drives the
-- report's empty state for not-yet-recomputed repos.

-- 1) harness_elements: inventory of record. One row per (repo_id, kind, name).
--    See server/src/database/schema/index.ts's `harnessElements` doc comment for the full
--    first_seen/last_seen/removed semantics (Design Decisions 1-3, T-93 impl plan).
CREATE TABLE IF NOT EXISTS harness_elements (
  id serial PRIMARY KEY,
  repo_id integer NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL,        -- 'skill' | 'rule' | 'mcp' | 'tool'
  name varchar(255) NOT NULL,       -- for tool-kind MCP tools: 'mcp__<server>__<tool>'
  mcp_server varchar(128),          -- non-null only for tool-kind rows sourced from an MCP server
  mcp_connected boolean,            -- meaningful only for kind='mcp'; NULL = never reported
  schema_size_tokens integer,       -- meaningful only for tool-kind MCP-sourced rows
  first_seen timestamptz,           -- NULL for built-in tool rows (always-present, never "added")
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS harness_elements_repo_kind_name_unique
  ON harness_elements (repo_id, kind, name);

CREATE INDEX IF NOT EXISTS idx_harness_elements_repo_id ON harness_elements (repo_id);

-- 2) session_harness_usage: per-session usage facts. One row per (session_id, kind, name).
--    Written via delete-then-reinsert per session (session-harness-usage-writer.ts),
--    mirroring session_tool_stats — the unique index below is a correctness guard rather
--    than an ON CONFLICT target for that path; skill/rule rows (written from the artisyn
--    branch) do use ON CONFLICT against it (Design Decision 5).
CREATE TABLE IF NOT EXISTS session_harness_usage (
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind varchar(16) NOT NULL,
  name varchar(255) NOT NULL,
  mcp_server varchar(128),
  uses integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  is_initial boolean               -- kind='tool' only; NULL for skill/rule/mcp
);

CREATE UNIQUE INDEX IF NOT EXISTS session_harness_usage_session_kind_name_unique
  ON session_harness_usage (session_id, kind, name);

CREATE INDEX IF NOT EXISTS idx_session_harness_usage_session_id ON session_harness_usage (session_id);

-- 3) repositories: two nullable capability/self-report flags, "last self-report wins"
--    semantics identical to the existing hook_version column. No DEFAULT -> catalog-only
--    ALTER, no table rewrite.
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS harness_inventory_reported_at timestamptz;
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS harness_mcp_per_tool_supported boolean;
