-- Background queue for the team-scope recompute that follows adding a repository to a team
-- (2026-10-31 session-list-slow-jsonb follow-up).
--
-- POST /api/v1/teams/:teamId/repositories used to recompute the team's derived stats
-- (session_cause_stats / session_file_stats over every session of the URL) inside the request:
-- ~30 s for a repository with a hundred sessions, with nothing on screen. The request now links
-- the URL, seeds its config and enqueues one row here; TeamRepoRecomputeService drains the queue
-- in the background, and GET /api/v1/teams/:teamId/repositories reports `recomputePending` while a
-- row exists, so the team page shows "Adding…" even after a reload.
--
-- One row per team link (team_repository_id is the primary key; a re-add while pending reuses it).
-- status: 'pending' (waiting), 'processing' (claimed by a worker; reclaimed when its updated_at is
-- stale, e.g. after a restart), 'failed' (gave up after the retry limit; last_error says why). The
-- row is deleted when the recompute succeeds. ON DELETE CASCADE drops it with the link (unlink,
-- remove, team delete).
--
-- Additive only: a new table, no existing table, column or row changed. Older server builds ignore
-- it (they still recompute inside the request). Re-runnable (IF NOT EXISTS).
--
-- Rollback: DROP TABLE IF EXISTS team_repo_recompute_queue (after reverting its readers/writers).

CREATE TABLE IF NOT EXISTS team_repo_recompute_queue (
  team_repository_id integer PRIMARY KEY REFERENCES team_repositories(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  enqueued_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
