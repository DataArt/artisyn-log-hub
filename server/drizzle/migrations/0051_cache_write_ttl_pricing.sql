-- T-87 cache-write pricing split by TTL, plus web-search and fast-mode billing inputs.
--
-- Additive only: no column or table is dropped, renamed or retyped. price_cache_w is
-- deliberately KEPT (it carries the 5m rate) so this migration is non-destructive;
-- every reader moves to the new columns in T-87 and dropping the old one is a separate,
-- later cleanup. Every new column is NOT NULL with a constant DEFAULT, which
-- PostgreSQL 11+ records in the catalog instead of rewriting the table, so none of these
-- ALTERs takes a blocking full-table lock (same pattern as 0049_cache_ratio_stats.sql
-- and 0050_usage_analytics.sql).
--
-- Re-runnable: every statement is IF NOT EXISTS / an idempotent UPDATE whose result is a
-- function of pre-existing columns only.

-- 1) model_pricing gains the two TTL cache-write rates and the web-search rate.
--
--    A 5m cache write costs 1.25x the input rate, a 1h one 2x — which is why the flat
--    price_cache_w (always 1.25x price_in in this table) under-charged every 1h write by
--    exactly 1.6x. price_web_search is USD PER REQUEST, not per million tokens.
--
--    IMPORTANT for future migrations: any new model_pricing row must populate all three
--    of these columns explicitly. The DEFAULT 0 exists only so these ALTERs can add the
--    columns without a table rewrite — a new Claude row left on the defaults would
--    silently price 1h cache writes and web searches at zero.
ALTER TABLE model_pricing
  ADD COLUMN IF NOT EXISTS price_cache_w_5m NUMERIC(10, 6) NOT NULL DEFAULT 0;
ALTER TABLE model_pricing
  ADD COLUMN IF NOT EXISTS price_cache_w_1h NUMERIC(10, 6) NOT NULL DEFAULT 0;
ALTER TABLE model_pricing
  ADD COLUMN IF NOT EXISTS price_web_search NUMERIC(10, 6) NOT NULL DEFAULT 0;

--    The 5m rate is exactly today's flat cache-write rate, so no 5m figure changes.
UPDATE model_pricing SET price_cache_w_5m = price_cache_w;

--    The 1h rate is 1.6x that (= 2x price_in, verified to hold for all 26 existing rows,
--    where price_cache_w = 1.25 x price_in). Derived from price_cache_w rather than from
--    price_cache_w_5m so the statement stays independent of the one above:
--      claude-opus-5   6.25 -> 10.00, claude-sonnet-5 3.75 -> 6.00,
--      claude-haiku-4-5 1.25 -> 2.00, claude-fable-5 12.50 -> 20.00.
--    Third-party rows sit at 0.000000 for cache write and stay 0.000000 (0 x 1.6).
UPDATE model_pricing SET price_cache_w_1h = price_cache_w * 1.6;

--    $0.01 per web-search request for every Anthropic model; third-party rows
--    (deepseek/*, moonshotai/*, qwen/*) offer no server tools and stay at 0.000000, so
--    an unpriced or tool-less model yields no web-search cost through the same path as
--    its token cost.
UPDATE model_pricing
SET price_web_search = CASE WHEN model_id LIKE 'claude%' THEN 0.010000 ELSE 0.000000 END;

-- 2) session_stats gains the web-search request count and the fast-mode token split.
--
--    web_search_requests is the per-session sum of
--    usage.server_tool_use.web_search_requests over deduped assistant messages
--    (web_fetch_requests is not billed and is not counted).
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS web_search_requests BIGINT NOT NULL DEFAULT 0;

--    input_tokens_fast / output_tokens_fast hold the usage.speed = 'fast' portion OF
--    input_tokens / output_tokens, which keep their existing "grand total" semantics.
--    Invariant (test-enforced, not a DB constraint):
--      input_tokens_fast <= input_tokens AND output_tokens_fast <= output_tokens
--    so fast + standard = today's per-category total by construction and no existing
--    consumer shifts. Fast tokens bill at FAST_MODE_MULTIPLIER x the standard rate
--    (server/src/logs/cost.sql.ts); no distinct fast cache rate exists, so only input
--    and output are speed-split.
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS input_tokens_fast BIGINT NOT NULL DEFAULT 0;
ALTER TABLE session_stats
  ADD COLUMN IF NOT EXISTS output_tokens_fast BIGINT NOT NULL DEFAULT 0;

-- 3) Backfill the new session_stats columns (and repair the T-83 TTL split) by
--    re-aggregating logs.body for the WHOLE corpus in ONE pass — no batching, no
--    watermark, no DO loop.
--
--    Why unbatched: Drizzle wraps every migration file in a single BEGIN/COMMIT
--    (server/src/database/migration-validator.ts), so a batched loop could never have
--    committed incrementally anyway; and the corpus is small (~5 MB of claude /
--    claude-subagent bodies, a few thousand assistant events). Shape precedent:
--    0011_subagent_stats_backfill.sql.
--
--    Why cache_write_5m_tokens / cache_write_1h_tokens are written too, even though
--    T-83 added them: rows ingested before T-83 have 5m = 1h = 0 while
--    cache_write_tokens > 0, so the TTL split has to be re-derived here or T-87 would
--    price those sessions' cache writes at zero. The stored TOTAL is never touched.
--
--    Idempotent: every written value is a function of logs.body and of columns this
--    statement does not write, so re-running produces the same rows.

--    The mismatch report sink (Decision 9): sessions whose re-aggregated 5m + 1h does
--    not equal the stored cache_write_tokens. ON COMMIT DROP keeps it scoped to this
--    migration's transaction. IF NOT EXISTS is checked against pg_temp only, and
--    pg_temp is searched before public, so the unqualified references below always
--    resolve to this table.
CREATE TEMP TABLE IF NOT EXISTS t87_cache_write_backfill_mismatch (
  session_id INTEGER PRIMARY KEY,
  stored_cache_write_tokens BIGINT NOT NULL,
  reaggregated_5m BIGINT NOT NULL,
  reaggregated_1h BIGINT NOT NULL
) ON COMMIT DROP;

WITH assistant_lines AS (
  -- Mirrors extractClaudeStats() (server/src/logs/claude-extractor.ts) exactly:
  --   * only type = 'assistant' lines carry usage;
  --   * isSidechain = true lines are sub-agent proxy events embedded in the MAIN
  --     session log and must be skipped there — but in a claude-subagent log every
  --     line is a sidechain line (they are that sub-agent's real API calls), so the
  --     filter is applied only when log_type = 'claude';
  --   * one API response can be split over several transcript lines (one per content
  --     block), each repeating the SAME message.usage, so DISTINCT ON keeps exactly
  --     one line per real response. A line without message.id falls back to its own
  --     uuid, which is unique per line and can never collide. Lines with no usage
  --     object never participate (the extractor only records the dedupe key inside
  --     `if (usage !== null)`), so they cannot win the DISTINCT ON over a real one.
  -- The ::bigint casts are the same ones the live sessions-list query already runs
  -- over this data (repositories.controller.ts), so any value that would break them
  -- here already breaks that endpoint. jsonb_typeof() guards a non-array body, which
  -- would otherwise abort the whole migration.
  SELECT DISTINCT ON (l.session_id, COALESCE(evt->'message'->>'id', evt->>'uuid'))
    l.session_id AS session_id,
    evt->'message'->'usage' AS usage
  FROM logs l
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.body) = 'array' THEN l.body ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS t(evt, ord)
  WHERE l.log_type IN ('claude', 'claude-subagent')
    AND (evt->>'type') = 'assistant'
    AND (l.log_type <> 'claude' OR (evt->>'isSidechain') IS DISTINCT FROM 'true')
    AND (evt->'message'->'usage') IS NOT NULL
  ORDER BY l.session_id, COALESCE(evt->'message'->>'id', evt->>'uuid'), ord
),
log_agg AS (
  SELECT
    session_id,
    -- usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens is authoritative
    -- when present; older transcripts only carry the flat
    -- cache_creation_input_tokens, whose tokens all go to the 5m bucket — the exact
    -- rule splitCacheCreationTokens() applies per usage object.
    SUM(
      CASE
        WHEN COALESCE((usage->'cache_creation'->>'ephemeral_5m_input_tokens')::bigint, 0)
           + COALESCE((usage->'cache_creation'->>'ephemeral_1h_input_tokens')::bigint, 0) > 0
        THEN COALESCE((usage->'cache_creation'->>'ephemeral_5m_input_tokens')::bigint, 0)
        ELSE COALESCE((usage->>'cache_creation_input_tokens')::bigint, 0)
      END
    ) AS write_5m,
    SUM(
      CASE
        WHEN COALESCE((usage->'cache_creation'->>'ephemeral_5m_input_tokens')::bigint, 0)
           + COALESCE((usage->'cache_creation'->>'ephemeral_1h_input_tokens')::bigint, 0) > 0
        THEN COALESCE((usage->'cache_creation'->>'ephemeral_1h_input_tokens')::bigint, 0)
        ELSE 0
      END
    ) AS write_1h,
    -- web_fetch_requests is deliberately NOT counted: it is not billed per request.
    SUM(COALESCE((usage->'server_tool_use'->>'web_search_requests')::bigint, 0)) AS web_search_requests,
    -- Fast-mode portions OF the grand totals (usage.speed = 'fast'); absent or
    -- 'standard' contributes 0, so fast <= total always holds.
    SUM(CASE WHEN (usage->>'speed') = 'fast'
             THEN COALESCE((usage->>'input_tokens')::bigint, 0) ELSE 0 END) AS input_tokens_fast,
    SUM(CASE WHEN (usage->>'speed') = 'fast'
             THEN COALESCE((usage->>'output_tokens')::bigint, 0) ELSE 0 END) AS output_tokens_fast
  FROM assistant_lines
  GROUP BY session_id
),
agg AS (
  -- Every session_stats row is covered, including one whose claude log row is gone:
  -- there the aggregate is all-zero, the 5m+1h check below fails and the documented
  -- column-split fallback applies, so the TTL invariant holds table-wide.
  SELECT
    ss.session_id,
    COALESCE(la.write_5m, 0) AS write_5m,
    COALESCE(la.write_1h, 0) AS write_1h,
    COALESCE(la.web_search_requests, 0) AS web_search_requests,
    COALESCE(la.input_tokens_fast, 0) AS input_tokens_fast,
    COALESCE(la.output_tokens_fast, 0) AS output_tokens_fast
  FROM session_stats ss
  LEFT JOIN log_agg la ON la.session_id = ss.session_id
),
updated AS (
  UPDATE session_stats ss
  SET
    web_search_requests = agg.web_search_requests,
    input_tokens_fast = agg.input_tokens_fast,
    output_tokens_fast = agg.output_tokens_fast,
    -- The re-aggregation must never move the stored total: when 5m + 1h disagrees
    -- with cache_write_tokens the split is not trustworthy, so all of it goes to the
    -- 5m bucket (the cheaper, historical behaviour) and the session is reported
    -- below instead of being silently repriced.
    cache_write_5m_tokens = CASE
      WHEN agg.write_5m + agg.write_1h = ss.cache_write_tokens THEN agg.write_5m
      ELSE ss.cache_write_tokens
    END,
    cache_write_1h_tokens = CASE
      WHEN agg.write_5m + agg.write_1h = ss.cache_write_tokens THEN agg.write_1h
      ELSE 0
    END
  FROM agg
  WHERE ss.session_id = agg.session_id
  RETURNING
    ss.session_id AS session_id,
    ss.cache_write_tokens AS stored_cache_write_tokens,
    agg.write_5m AS write_5m,
    agg.write_1h AS write_1h
)
INSERT INTO t87_cache_write_backfill_mismatch (
  session_id, stored_cache_write_tokens, reaggregated_5m, reaggregated_1h
)
SELECT session_id, stored_cache_write_tokens, write_5m, write_1h
FROM updated
WHERE write_5m + write_1h <> stored_cache_write_tokens
ON CONFLICT (session_id) DO NOTHING;

-- 4) Report the sessions where the re-aggregation could not reproduce the stored
--    cache-write total (NFR: the migration discloses where it fell back instead of
--    silently guessing). Notices reach the server log / psql; node-postgres does not
--    print them by default, so `npm run migrate` staying quiet is expected.
DO $$
DECLARE
  mismatch_count INTEGER;
  mismatch_ids TEXT;
BEGIN
  SELECT COUNT(*), COALESCE(STRING_AGG(session_id::text, ', ' ORDER BY session_id), '')
    INTO mismatch_count, mismatch_ids
  FROM t87_cache_write_backfill_mismatch;

  IF mismatch_count = 0 THEN
    RAISE NOTICE '0051 cache-write TTL backfill: re-aggregated 5m + 1h matched session_stats.cache_write_tokens on every row.';
  ELSE
    RAISE NOTICE '0051 cache-write TTL backfill: % session(s) where re-aggregated 5m + 1h <> stored cache_write_tokens. Total preserved; applied 5m = cache_write_tokens, 1h = 0. session_id(s): %', mismatch_count, mismatch_ids;
  END IF;
END $$;
