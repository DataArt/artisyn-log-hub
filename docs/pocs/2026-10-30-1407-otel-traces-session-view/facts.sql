-- Fact rows for the prototype: one row per (5-minute bucket of the call's own event time, root
-- session, query_source, model, Claude Code version) with call count, tokens, Claude Code's own
-- cost estimate and the hidden (not in any transcript) part. Read-only. The call time comes from
-- the stored OTLP record (`event.timestamp`), not from the ingest time of its chunk.
\pset format csv
set statement_timeout = '120s';
with sr as (
  select distinct l.session_id as sid, lr.repo_id
  from logs l join log_repositories lr on lr.log_id = l.id
), api as (
  select o.session_id, e->'record'->'attributes' as attrs
  from logs_otel o, jsonb_array_elements(o.body) e
  where e->'record'->'body'->>'stringValue' = 'claude_code.api_request'
), calls as (
  -- one timestamp per (session, request_id); duplicates of a re-uploaded record collapse here
  select session_id, request_id, min(ts) as ts
  from (
    select a.session_id,
      (select x->'value'->>'stringValue' from jsonb_array_elements(a.attrs) x where x->>'key' = 'event.timestamp')::timestamptz as ts,
      (select x->'value'->>'stringValue' from jsonb_array_elements(a.attrs) x where x->>'key' = 'request_id') as request_id
    from api a
  ) r
  group by 1, 2
), timed as (
  select c.*, k.ts
  from otel_api_calls c
  left join calls k on k.session_id = c.session_id and k.request_id = c.request_id
)
select
  sr.repo_id                                   as repo,
  to_char(date_trunc('hour', coalesce(t.ts, t.created_at))
    + floor(extract(minute from coalesce(t.ts, t.created_at)) / 5) * interval '5 minutes',
    'YYYY-MM-DD"T"HH24:MI')                    as bucket,
  s.session_id                                 as session,
  coalesce(t.query_source, '<none>')           as source,
  regexp_replace(coalesce(t.model, '?'), '^claude-', '') as model,
  coalesce(st.claude_version, st.claude_version_otel, '?') as version,
  count(*)                                     as calls,
  sum(t.input_tokens)                          as input,
  sum(t.output_tokens)                         as output,
  sum(t.cache_read_tokens)                     as cache_read,
  sum(t.cache_write_5m_tokens)                 as cache_write,
  sum(coalesce(t.cost_usd_micros, 0))          as micros,
  sum(case when h.hidden then coalesce(t.cost_usd_micros, 0) else 0 end) as hidden_micros,
  sum(case when h.hidden then 1 else 0 end)    as hidden_calls
from timed t
cross join lateral (select (t.request_id is null
  or not exists (select 1 from session_request_ids r where r.request_id = t.request_id)) as hidden) h
join sessions s on s.id = t.session_id
join sr on sr.sid = t.session_id
left join session_stats st on st.session_id = t.session_id
group by 1, 2, 3, 4, 5, 6
order by 1, 2;
