-- Admin "new Log Hub release" badge: one new single-row table caching the latest GitHub release.
--
-- Additive only. No existing table or column is touched, no value is rewritten and no row is
-- deleted. CREATE TABLE IF NOT EXISTS and COMMENT ON are both re-runnable (migrations here are
-- hand-written, never `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md).
--
-- Lock profile: the table is created empty in this transaction; nothing else is locked.
--
-- NO DATA IS BACKFILLED BY THIS MIGRATION. The single row (id = 1) is inserted by the daily
-- release check (LogHubReleaseCheckService) on its first run; until then the table is empty,
-- which every surface treats as "no newer release known". Older server builds ignore the table.
--
-- Rollback: DROP TABLE log_hub_release_check (cache only, nothing else references it).

CREATE TABLE IF NOT EXISTS log_hub_release_check (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  latest_tag      varchar(64),
  release_url     text,
  fetched_at      timestamptz,
  last_attempt_at timestamptz
);

COMMENT ON TABLE log_hub_release_check IS 'Single-row cache (id = 1) of the latest published Log Hub GitHub release, used for the admin new-release badge; written by LogHubReleaseCheckService once per 24 h per cluster.';
COMMENT ON COLUMN log_hub_release_check.id IS 'Always 1 (CHECK constraint): the table holds at most one row.';
COMMENT ON COLUMN log_hub_release_check.latest_tag IS 'Last validated release tag, e.g. v1.3.0; NULL until the first successful fetch.';
COMMENT ON COLUMN log_hub_release_check.release_url IS 'Validated html_url of that release on GitHub; NULL until the first successful fetch.';
COMMENT ON COLUMN log_hub_release_check.fetched_at IS 'Time of the last successful fetch; NULL = never succeeded.';
COMMENT ON COLUMN log_hub_release_check.last_attempt_at IS 'Cluster claim: time of the last fetch attempt (success or failure); one attempt per 24 h across all instances.';
