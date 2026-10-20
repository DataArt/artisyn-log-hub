-- Backfill session_stats for existing claude-subagent logs (token counts only).
-- Future uploads are handled by logs.service.ts which now creates stats for subagents too.
INSERT INTO session_stats (
  session_id, model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  work_time_ms, code_files, code_bytes, doc_files, doc_bytes,
  files_edited_written, lines_changed, image_count, image_total_bytes
)
SELECT
  l.session_id,
  MIN(CASE WHEN (evt->>'type') = 'assistant' AND (evt->'message'->>'model') IS NOT NULL
           THEN evt->'message'->>'model' ELSE NULL END),
  SUM(CASE WHEN (evt->>'type') = 'assistant'
           THEN COALESCE((evt->'message'->'usage'->>'input_tokens')::bigint, 0) ELSE 0 END),
  SUM(CASE WHEN (evt->>'type') = 'assistant'
           THEN COALESCE((evt->'message'->'usage'->>'output_tokens')::bigint, 0) ELSE 0 END),
  SUM(CASE WHEN (evt->>'type') = 'assistant'
           THEN COALESCE((evt->'message'->'usage'->>'cache_read_input_tokens')::bigint, 0) ELSE 0 END),
  SUM(CASE WHEN (evt->>'type') = 'assistant'
           THEN COALESCE((evt->'message'->'usage'->>'cache_creation_input_tokens')::bigint, 0) ELSE 0 END),
  0, 0, 0, 0, 0, 0, 0, 0, 0
FROM logs l
CROSS JOIN LATERAL jsonb_array_elements(l.body) AS evt
WHERE l.log_type = 'claude-subagent'
  AND NOT EXISTS (SELECT 1 FROM session_stats ss WHERE ss.session_id = l.session_id)
GROUP BY l.session_id
ON CONFLICT (session_id) DO NOTHING;
