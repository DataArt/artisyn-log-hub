-- T-117 change surface: two new fact tables plus six nullable columns.
--
-- Additive only. No column or table is dropped, renamed or retyped, no existing value is
-- rewritten, and no row is deleted. Every statement is IF NOT EXISTS / ADD COLUMN IF NOT
-- EXISTS, so the whole file is re-runnable (migrations here are hand-written, never
-- `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md).
--
-- No index is built concurrently here. Drizzle wraps every migration file in a single
-- BEGIN/COMMIT, and a concurrent index build cannot run inside a transaction (it raises
-- 25001 and crashes startup), which is why `migration-validator.ts` rejects that pattern
-- outright. It costs nothing: the two indexed tables are created empty in this same
-- transaction, so their index builds are instant, and the ALTERs below add columns only,
-- never an index.
--
-- Lock/rewrite profile: all six ADD COLUMNs are nullable WITH NO DEFAULT, so PostgreSQL
-- records them in the catalog only -- no full-table rewrite and no long
-- AccessExclusiveLock hold, which matters because `logs` is the largest table here.
-- Migrations run before the NestJS context (and so before the scheduler or any request)
-- exists.
--
-- NO DATA IS BACKFILLED BY THIS MIGRATION. Historical values come from
-- `POST /api/v1/repositories/:repoId/recompute-all-sessions` (FR-7), which is idempotent
-- and already walks every session of a repo; `repo_code_inventory` fills from each repo's
-- next hook upload. Until a session is recomputed its `session_stats.cs_computed_at` stays
-- NULL, which is exactly the "not recomputed yet" signal that every change-surface surface
-- renders as "no data" rather than as a fabricated 0.

-- 1) session_changed_paths: per-session changed-path facts, one row per
--    (session_id, path_key) -- one *logical* changed path per session. See the
--    `sessionChangedPaths` doc comment in server/src/database/schema/index.ts for the
--    path_key / raw_path / *_key semantics (Design Decisions 3-5).
--
--    No surrogate primary key, matching session_tool_stats / session_harness_usage /
--    session_file_stats: the unique index below is the key. The FK cascades on session
--    delete, so the existing retention purge, repo/session delete and e2e cleanup paths
--    keep working unchanged and can never be blocked by an orphan row.
--
--    path_key/raw_path are varchar(1024) and are truncated to that length at write time,
--    so a (session_id, path_key) btree row can never exceed Postgres' 2704-byte index-row
--    limit. Every normalised column is nullable: they are all NULL when the path could not
--    be resolved against a repo root, and outside_repo distinguishes "outside the repo"
--    from "repo root never learned".
CREATE TABLE IF NOT EXISTS session_changed_paths (
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path_key varchar(1024) NOT NULL,     -- row identity: case-folded rel path, else the repo-root-less raw path
  raw_path varchar(1024) NOT NULL,     -- first raw spelling seen; lets renormalisation skip re-parsing
  rel_path text,                       -- NULL when out-of-repo or repo root unknown; original case (display)
  rel_path_key text,                   -- case-folded rel_path -- the distinctness key
  folder text,                         -- display; '.' for a repo-root file
  folder_key text,                     -- case-folded folder -- the GROUP BY key
  top_module_key text,                 -- case-folded first segment; '.' for a repo-root file
  depth integer,                       -- segment count of folder (0 for '.')
  file_kind varchar(16),               -- 'source' | 'test' | 'config' | 'docs' | 'other'
  extension varchar(32),               -- lowercased, no dot; '' when none
  outside_repo boolean NOT NULL DEFAULT false,
  change_kind varchar(16) NOT NULL,    -- 'added' | 'modified' ('deleted' reserved, never written)
  edit_calls integer NOT NULL DEFAULT 0,
  diff_covered_calls integer NOT NULL DEFAULT 0,
  lines_added integer NOT NULL DEFAULT 0,
  lines_removed integer NOT NULL DEFAULT 0
);

-- Unique *index* rather than a table constraint: ALTER TABLE ... ADD CONSTRAINT has no
-- IF NOT EXISTS form and every migration here must be re-runnable. Same guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS session_changed_paths_session_path_key_unique
  ON session_changed_paths (session_id, path_key);

CREATE INDEX IF NOT EXISTS idx_session_changed_paths_session_id
  ON session_changed_paths (session_id);

CREATE INDEX IF NOT EXISTS idx_session_changed_paths_session_folder
  ON session_changed_paths (session_id, folder_key);

-- 2) repo_code_inventory: repository code-size snapshots -- the denominator for
--    "share of the codebase touched". A history rather than one current row per repo,
--    because a report divides by the newest snapshot at or before its period end, not by
--    today's. Growth is bounded by the writer, which prunes to the newest
--    REPO_CODE_INVENTORY_KEEP rows for that repo after each insert.
--
--    branch is NOT NULL DEFAULT '' rather than nullable on purpose: Postgres treats NULLs
--    as distinct in a unique index, so a nullable branch would make the unique index below
--    never collide and a re-uploaded snapshot would insert a duplicate instead of being
--    idempotent.
CREATE TABLE IF NOT EXISTS repo_code_inventory (
  id serial PRIMARY KEY,
  repo_id integer NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL,
  branch varchar(255) NOT NULL DEFAULT '',
  commit_sha varchar(40),
  tracked_files integer NOT NULL,
  tracked_lines bigint NOT NULL,
  tracked_binary_files integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS repo_code_inventory_repo_captured_branch_unique
  ON repo_code_inventory (repo_id, captured_at, branch);

CREATE INDEX IF NOT EXISTS idx_repo_code_inventory_repo_captured_at
  ON repo_code_inventory (repo_id, captured_at);

-- 3) logs: the two git roots of the machine the session ran on, stored exactly as
--    git_branch already is and populated from the `artisyn` upload only. git_repo_root is
--    the hook's --git-common-dir root (the *primary* checkout even for a linked worktree);
--    git_worktree_root is `rev-parse --show-toplevel`, so a session run inside a linked
--    worktree still resolves its paths instead of having them classified out-of-repo.
--    Both stay NULL for every existing row and for uploads from an un-updated hook.
ALTER TABLE logs
  ADD COLUMN IF NOT EXISTS git_repo_root text;
ALTER TABLE logs
  ADD COLUMN IF NOT EXISTS git_worktree_root text;

-- 4) session_stats: own-scope change-surface counters. All four nullable with NO DEFAULT,
--    following the telemetry_cost precedent -- NULL means "not recomputed yet" and drives
--    the "no data, never 0" render. cs_computed_at is the marker: it is set whenever the
--    extractor ran, INCLUDING when it found zero changed paths (the three counters are
--    then 0, not NULL), which is what separates a genuine zero-change session from a
--    never-recomputed one.
--
--    Concentration is deliberately not stored: it is not composable across sessions, so it
--    is always recomputed from session_changed_paths at read time.
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS cs_changed_files integer;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS cs_folders_touched integer;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS cs_outside_repo_files integer;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS cs_computed_at timestamptz;
