-- Team repo config lives with the team-repository link (2026-10-16 team-vs-personal-config).
--
-- Before: a team-scoped repo_config row (team_id set, user_id NULL) hung off one member's
-- `repositories` row, so a team could carry several configs for one URL (one per member row,
-- read in undefined order) and lost it when that member's row was deleted.
--
-- After: one config per team_repositories link in the new team_repo_config table (PK = FK to
-- the link, ON DELETE CASCADE, so every link-delete path removes it). repo_config keeps
-- personal rows only: team_id is dropped and user_id becomes NOT NULL.
--
-- Data move: each team row is matched to its link by (repo_config.team_id, repositories.repo_url
-- of repo_config.repo_id) = (team_repositories.team_id, team_repositories.repo_url). Of several
-- rows per link the newest updated_at wins, ties go to the lowest repo_id. Team rows with no
-- link are dropped (the count is reported by RAISE NOTICE). Links with no team row get no
-- config (teamConfig = null). The config jsonb is copied verbatim, never parsed.
--
-- Guarded: the DO block runs only while repo_config.team_id still exists in current_schema()
-- (tests run migrations in per-run schemas of one shared DB), CREATE TABLE IF NOT EXISTS and
-- ON CONFLICT DO NOTHING make the file a no-op on an already migrated schema.
--
-- Lock profile: ALTER TABLE repo_config takes a brief ACCESS EXCLUSIVE lock; the table is small
-- (one row per configured repo per scope) and SET NOT NULL scans it once. The new table is
-- empty when created.
--
-- Irreversible: the team_id column, its CHECK and its partial unique index are dropped. No team
-- config value is lost — each surviving value now lives in team_repo_config.

CREATE TABLE IF NOT EXISTS team_repo_config (
  team_repository_id integer PRIMARY KEY REFERENCES team_repositories(id) ON DELETE CASCADE,
  config             jsonb       NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'repo_config'
      AND column_name = 'team_id'
  ) THEN
    INSERT INTO team_repo_config (team_repository_id, config, updated_at)
    SELECT DISTINCT ON (tr.id) tr.id, rc.config, rc.updated_at
    FROM repo_config rc
    JOIN repositories r ON r.id = rc.repo_id
    JOIN team_repositories tr ON tr.team_id = rc.team_id AND tr.repo_url = r.repo_url
    WHERE rc.team_id IS NOT NULL
    ORDER BY tr.id, rc.updated_at DESC, rc.repo_id ASC
    ON CONFLICT (team_repository_id) DO NOTHING;

    SELECT COUNT(*) INTO orphan_count
    FROM repo_config rc
    WHERE rc.team_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM repositories r
        JOIN team_repositories tr ON tr.repo_url = r.repo_url AND tr.team_id = rc.team_id
        WHERE r.id = rc.repo_id
      );
    RAISE NOTICE '0072: % team repo_config rows had no team_repositories link and were dropped', orphan_count;

    DELETE FROM repo_config WHERE team_id IS NOT NULL;

    ALTER TABLE repo_config DROP CONSTRAINT IF EXISTS repo_config_scope_check;
    ALTER TABLE repo_config DROP COLUMN team_id;
    ALTER TABLE repo_config ALTER COLUMN user_id SET NOT NULL;
  END IF;
END $$;
