-- Re-project OTEL chunks of Claude Desktop sessions (2026-11-25 ad-hoc fix).
--
-- Sessions started from the Claude Desktop app's Code tab report the OTEL resource
-- `service.name = claude-code-desktop`, and their `service.version` is the Desktop app's version
-- (e.g. 5.11492.5), not Claude Code's. Until this fix the projection stored that value in
-- otel_calls.claude_code_version and otel_cost_buckets.cc_version. The projection now takes the
-- Claude Code version of such lines from the logs / metrics `scope.version` instead.
--
-- Data-only: this marks those chunks pending again (otel_projection_version = NULL); the
-- background projection drain re-projects them after startup. Re-projection is an idempotent
-- upsert: a call whose claude_code_version changed moves its cost from the old cc_version bucket
-- to the new one (additive bucket deltas, the old key is zeroed, never deleted). No row is
-- deleted and no other column is touched. Chunks never reach a wrong state: until the drain runs
-- they keep their current facts.
--
-- Which chunks: only those of sessions with at least one OTEL call whose claude_code_version
-- differs from the transcript version (or the transcript version is unknown), and only the ones
-- whose body has a `claude-code-desktop` line. The session filter is materialized first so the
-- JSONB check runs on a handful of chunks instead of the whole table (measured on an installation
-- with 17k chunks: 0.17 s vs 14 s). A Desktop session whose calls all agree with the transcript
-- cannot exist (5.x vs 2.x), so nothing that needs a fix is skipped.
--
-- Lock profile: row locks on the re-marked logs_otel rows only. Older server builds ignore the
-- marker change (they would simply re-project with their old rule). Re-runnable: a second run
-- re-marks the same rows again, which only costs one more idempotent projection.

WITH suspect AS MATERIALIZED (
  SELECT DISTINCT c.session_id
    FROM otel_calls c
    LEFT JOIN session_stats st ON st.session_id = c.session_id
   WHERE c.claude_code_version IS NOT NULL
     AND c.claude_code_version IS DISTINCT FROM st.claude_version
),
candidate AS MATERIALIZED (
  SELECT lo.id, lo.body
    FROM logs_otel lo
    JOIN suspect s ON s.session_id = lo.session_id
   WHERE lo.otel_projection_version IS NOT NULL
)
UPDATE logs_otel
   SET otel_projection_version = NULL
 WHERE id IN (
         SELECT candidate.id
           FROM candidate
          WHERE jsonb_path_exists(
                  candidate.body,
                  '$[*].resource."service.name" ? (@ == "claude-code-desktop")',
                  '{}',
                  true
                )
       );
