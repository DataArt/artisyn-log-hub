-- Schema documentation fix: the table comment from migration 0086 names the writer as
-- LogHubReleaseCheckService, but the service class is LogHubReleaseService. Migrations are
-- immutable, so the corrected comment ships as a new migration.
--
-- Metadata only: no table, column, constraint, index or row changes. Older server builds ignore
-- comments. Re-runnable: COMMENT ON replaces any previous text. The table exists after
-- migration 0086.
--
-- Rollback: not needed (COMMENT ON ... IS NULL removes a comment).

COMMENT ON TABLE log_hub_release_check IS 'Single-row cache (id = 1) of the latest published Log Hub GitHub release, used for the admin new-release badge; written by LogHubReleaseService once per 24 h per cluster.';
