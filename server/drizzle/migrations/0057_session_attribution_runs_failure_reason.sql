-- T-101 Part B (Chunk 8 follow-on): session_attribution_runs was missing a failure_reason
-- column even though the API changes spec (GET :repoId/sessions' lastRun.failureReason and
-- the POST body's own failureReason field) always required one -- turn_end_advisor_runs
-- (migration 0055) already has its own failure_reason column, this brings the mirror table
-- in line so getRepositorySessions() can surface the reason a session's latest attribution
-- run failed.
--
-- Additive only: nullable column, no default, no rewrite -- safe on a table that (per the
-- append-only recordRun() contract) has existed for one deploy cycle at most.
ALTER TABLE session_attribution_runs ADD COLUMN IF NOT EXISTS failure_reason TEXT;
