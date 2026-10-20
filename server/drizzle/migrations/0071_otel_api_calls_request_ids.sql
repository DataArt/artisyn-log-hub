-- Per-call OTEL telemetry and transcript request ids (release-check findings, D2 cost).
--
-- otel_api_calls: one row per `claude_code.api_request` OTLP log record, so utility calls --
-- API calls Claude Code makes that never reach the transcript (prompt suggestions, titles, ...)
-- -- can be priced per call. Token columns are named to match session_stats so sessionCostSql
-- prices them unchanged. call_key is the record's request_id, or `<chunk_key>:<1-based line
-- index>` when it has none; UNIQUE (session_id, call_key) makes re-ingest an upsert.
--
-- session_request_ids: the distinct transcript `requestId`s of a session's assistant lines. A
-- call whose request_id is absent from its whole session tree here is a utility call.
--
-- Additive only: two new tables plus a backfill INSERT into them. No existing column, table
-- or row is altered, renamed or deleted. Every statement is guarded (CREATE ... IF NOT EXISTS,
-- INSERT ... ON CONFLICT DO NOTHING), so the file is re-runnable (migrations here are
-- hand-written, never `drizzle-kit generate` -- see docs/knowledgebase/db-schema-code.md).
--
-- Lock profile: the new tables are empty when their indexes are built (plain CREATE INDEX,
-- no CONCURRENTLY: Drizzle wraps every migration file in BEGIN/COMMIT). The backfill only
-- reads logs / logs_otel (AccessShareLock -- concurrent reads and writes are not blocked).
--
-- Backfill robustness: a malformed JSON shape must never abort startup, so
--   * every jsonb_array_elements input is guarded with jsonb_typeof(...) = 'array' (a non-array
--     yields no rows instead of raising);
--   * numeric attributes are cast only when their text matches a plain decimal of at most 18
--     integer digits (fits bigint); anything else becomes 0 (tokens) or NULL (cost);
--   * text values are cut to the varchar(255) column width with LEFT(); empty strings are NULL.
-- Attribute values unwrap in the same order as otel-chunk.ts `attributesOf`
-- (stringValue, intValue, doubleValue); a duplicated key keeps its last occurrence, as the
-- TypeScript Map does (jsonb_object_agg keeps the last value for a repeated key).

-- 1) Tables.
CREATE TABLE IF NOT EXISTS otel_api_calls (
  id                    serial PRIMARY KEY,
  session_id            integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  call_key              varchar(255) NOT NULL,
  request_id            varchar(255),
  query_source          varchar(255),
  model                 varchar(255),
  input_tokens          bigint NOT NULL DEFAULT 0,
  output_tokens         bigint NOT NULL DEFAULT 0,
  cache_read_tokens     bigint NOT NULL DEFAULT 0,
  cache_write_5m_tokens bigint NOT NULL DEFAULT 0,
  cache_write_1h_tokens bigint NOT NULL DEFAULT 0,
  web_search_requests   bigint NOT NULL DEFAULT 0,
  input_tokens_fast     bigint NOT NULL DEFAULT 0,
  output_tokens_fast    bigint NOT NULL DEFAULT 0,
  cost_usd_micros       bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otel_api_calls_session_call_unique UNIQUE (session_id, call_key)
);

-- Utility classification joins calls to session_request_ids by (session, request id).
CREATE INDEX IF NOT EXISTS idx_otel_api_calls_session_request_id
  ON otel_api_calls (session_id, request_id);

CREATE TABLE IF NOT EXISTS session_request_ids (
  session_id integer NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  request_id varchar(255) NOT NULL,
  CONSTRAINT session_request_ids_pk PRIMARY KEY (session_id, request_id)
);

-- Lookup by request id alone (a call matched against any session of its tree).
CREATE INDEX IF NOT EXISTS idx_session_request_ids_request_id
  ON session_request_ids (request_id);

-- 2) Backfill otel_api_calls from the raw chunks already stored in logs_otel.
INSERT INTO otel_api_calls (
  session_id, call_key, request_id, query_source, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens,
  input_tokens_fast, output_tokens_fast, cost_usd_micros
)
SELECT
  c.session_id,
  COALESCE(c.request_id, LEFT(c.chunk_key || ':' || c.line_index, 255)),
  c.request_id,
  c.query_source,
  c.model,
  c.input_tokens,
  c.output_tokens,
  c.cache_read_tokens,
  c.cache_write_tokens,
  CASE WHEN c.speed = 'fast' THEN c.input_tokens ELSE 0 END,
  CASE WHEN c.speed = 'fast' THEN c.output_tokens ELSE 0 END,
  CASE
    WHEN c.cost_micros_raw ~ '^\s*-?[0-9]{1,18}(\.[0-9]+)?\s*$'
      THEN ROUND(btrim(c.cost_micros_raw)::numeric)::bigint
    WHEN c.cost_usd_raw ~ '^\s*-?[0-9]{1,12}(\.[0-9]+)?\s*$'
      THEN ROUND(btrim(c.cost_usd_raw)::numeric * 1000000)::bigint
    ELSE NULL
  END
FROM (
  SELECT
    a.session_id,
    a.chunk_key,
    a.line_index,
    LEFT(NULLIF(a.attrs->>'request_id', ''), 255)   AS request_id,
    LEFT(NULLIF(a.attrs->>'query_source', ''), 255) AS query_source,
    LEFT(NULLIF(a.attrs->>'model', ''), 255)        AS model,
    a.attrs->>'speed'                               AS speed,
    a.attrs->>'cost_usd_micros'                     AS cost_micros_raw,
    a.attrs->>'cost_usd'                            AS cost_usd_raw,
    CASE WHEN a.attrs->>'input_tokens' ~ '^\s*-?[0-9]{1,18}(\.[0-9]+)?\s*$'
      THEN ROUND(btrim(a.attrs->>'input_tokens')::numeric)::bigint ELSE 0 END
      AS input_tokens,
    CASE WHEN a.attrs->>'output_tokens' ~ '^\s*-?[0-9]{1,18}(\.[0-9]+)?\s*$'
      THEN ROUND(btrim(a.attrs->>'output_tokens')::numeric)::bigint ELSE 0 END
      AS output_tokens,
    CASE WHEN a.attrs->>'cache_read_tokens' ~ '^\s*-?[0-9]{1,18}(\.[0-9]+)?\s*$'
      THEN ROUND(btrim(a.attrs->>'cache_read_tokens')::numeric)::bigint ELSE 0 END
      AS cache_read_tokens,
    CASE WHEN a.attrs->>'cache_creation_tokens' ~ '^\s*-?[0-9]{1,18}(\.[0-9]+)?\s*$'
      THEN ROUND(btrim(a.attrs->>'cache_creation_tokens')::numeric)::bigint ELSE 0 END
      AS cache_write_tokens
  FROM (
    SELECT
      lo.session_id,
      lo.chunk_key,
      e.line_index,
      (
        SELECT jsonb_object_agg(
                 attr->>'key',
                 COALESCE(attr#>'{value,stringValue}',
                          attr#>'{value,intValue}',
                          attr#>'{value,doubleValue}')
                 ORDER BY attr_index
               )
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(e.line#>'{record,attributes}') = 'array'
                    THEN e.line#>'{record,attributes}' ELSE '[]'::jsonb END
             ) WITH ORDINALITY AS t(attr, attr_index)
        WHERE jsonb_typeof(attr->'key') = 'string'
          AND COALESCE(attr#>'{value,stringValue}',
                       attr#>'{value,intValue}',
                       attr#>'{value,doubleValue}') IS NOT NULL
          AND jsonb_typeof(COALESCE(attr#>'{value,stringValue}',
                                    attr#>'{value,intValue}',
                                    attr#>'{value,doubleValue}')) <> 'null'
      ) AS attrs
    FROM logs_otel lo
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lo.body) = 'array' THEN lo.body ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS e(line, line_index)
    WHERE e.line->>'signal' = 'logs'
      AND e.line#>>'{record,body,stringValue}' = 'claude_code.api_request'
  ) a
) c
ON CONFLICT (session_id, call_key) DO NOTHING;

-- 3) Backfill session_request_ids from the stored transcripts (main + sub-agent).
INSERT INTO session_request_ids (session_id, request_id)
SELECT DISTINCT l.session_id, LEFT(evt->>'requestId', 255)
FROM logs l
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(l.body) = 'array' THEN l.body ELSE '[]'::jsonb END
) AS evt
WHERE l.log_type IN ('claude', 'claude-subagent')
  AND evt->>'type' = 'assistant'
  AND evt->>'requestId' IS NOT NULL
  AND evt->>'requestId' <> ''
ON CONFLICT DO NOTHING;
