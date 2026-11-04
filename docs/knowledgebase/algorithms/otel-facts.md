---
reviewed: no
reviewer: none
---

# OTEL facts: call structure, event time, call key, buckets, intervals, spans, query sources

## Purpose

The OTEL tabs (repository, session, team) show what Claude Code's telemetry reports: every API
call with its cost, where it came from (main thread, sub-agent, or a hidden call no transcript
records), when it happened, and the trace spans of each turn. The server turns the hook's raw
OTEL lines into `otel_calls`, `otel_spans` and 5-minute `otel_cost_buckets` rows. These pure
rules decide each row's values, so the realtime channel and the regular chunk upload produce
the same rows, and a call never lands in the wrong structure or bucket.

## Code

- Implementation:
  - `server/src/logs/otel/otel-classify.ts` — `classifyOtelCall`, `isOtelCallProvisional`,
    `bucketStart5m` (`OTEL_BUCKET_MS`), `pickOtelInterval`, `isValidOtelTimeZone`;
  - `server/src/logs/otel/otel-records.ts` — `resolveOtelEventTime`, `otelCallKey`,
    `extractOtelCalls`, `extractOtelSpans` (`OTEL_SPAN_ATTRIBUTES_MAX_BYTES` from
    `otel-facts.constants.ts`);
  - `server/src/logs/otel/otel-query-source-dictionary.ts` — `OTEL_VISIBLE_QUERY_SOURCES`,
    `lookupQuerySource`; `TRANSCRIPT_QUERY_SOURCES` and `TRANSCRIPT_QUERY_SOURCE_PREFIX` come from
    `server/src/logs/otel-cost.sql.ts`.
- Twins: none. The hook only forwards the lines; the client renders the server's rows.
- Test: `server/src/logs/otel/otel-facts.algo.spec.ts`.

## Input and output

A **line** is the object the hook's OTEL receiver writes to a chunk file and sends in a realtime
batch: `{ signal, receivedAt, resource, record }`. `resource` is a flat map of strings
(`service.version`). For `signal: "logs"` the `record` is an OTLP log record
(`body.stringValue`, `timeUnixNano`, `attributes`); for `signal: "spans"` it is an OTLP span
(`traceId`, `spanId`, `parentSpanId`, `name`, `startTimeUnixNano`, `endTimeUnixNano`,
`attributes`). OTLP attributes are a list of `{ key, value: { stringValue | intValue |
doubleValue | boolValue } }`. Times are ISO strings in the examples; `*UnixNano` values are digit
strings.

Every example row has `input.kind`, which picks the rule:

| `kind` | Input | Expected |
|---|---|---|
| `classify` | `inTree`, `inSubagentTranscript`, `querySource`, `treeHasRequestIds`, `provisional` | `{ structure }` |
| `provisional` | `firstSeq`, `transcriptSeq` (number or null) | `{ provisional }` |
| `eventTime` | `line` | `{ eventTime }` (ISO or null) |
| `callKey` | `calls: [{ requestId, record }]` | `{ keys }`, one per call |
| `bucket5m` | `time` | `{ bucketStart }` |
| `interval` | `from`, `to`, `scope` (`repository` / `session`) | `{ interval }` |
| `tz` | `tz` | `{ valid }` |
| `calls` | `lines` | `{ calls }`: every extracted call, listed fields only; `costUsdMicros` as a decimal string |
| `spans` | `lines` | `{ spans, skipped }`: every extracted span, listed fields only |
| `dictionary` | — | `{ visible, transcript }` |
| `querySource` | `name` | `{ description, hidden, known }` |

In a `spans` row an attribute value `{"$repeat": ["x", 70000]}` stands for the string of 70000
`x` characters (the test expands it), so a large attribute map fits in the doc.

## Rules

1. **Structure** (`classifyOtelCall`, DD-4). `agent` = `querySource` starts with `agent:`.
   - `inTree` (the call's request id is one of the tree's transcript request ids):
     `subagent` when `inSubagentTranscript` or `agent`, else `main`.
   - Else, when `treeHasRequestIds` is false **or** the call is `provisional` (the transcript
     has not caught up yet), the transcript fallback: `agent` → `subagent`; `querySource` in
     `TRANSCRIPT_QUERY_SOURCES` = `repl_main_thread`, `sdk` → `main`; anything else, `null`
     included → `hidden`.
   - Else (the transcript is complete and does not hold the call) → `hidden`, whatever the
     `querySource`. This is "equality at rest": once nothing is provisional, `hidden` is exactly
     the set of calls missing from the transcript.
2. **Provisional** (`isOtelCallProvisional`): `transcriptSeq` is null, or `firstSeq >
   transcriptSeq`.
3. **Event time** (`resolveOtelEventTime`, DD-8): the record's `event.timestamp` attribute if it
   parses as a date; else the record's `timeUnixNano` if it is a non-zero digit string
   (milliseconds = nanoseconds / 1 000 000, cut); else the line's `receivedAt`; else null.
4. **Call key** (`otelCallKey`, DD-9): the `request_id` when present. Otherwise `rec:` + the
   hex sha1 of the canonical JSON of `{ attributes, timeUnixNano }` of the record — object keys
   sorted at every level, no spaces, a missing value written as `null`. The same record sent
   twice (realtime, then in a chunk) gives the same key whatever the key order of the objects.
5. **5-minute bucket** (`bucketStart5m`): `floor(ms / 300000) * 300000`, in UTC.
6. **Interval** (`pickOtelInterval`, DD-18), `span = to - from`: `span <= 24 h` → `5m`. Above
   that the session scope gives `1h`; the repository (and team) scope gives `1h` up to
   `span <= 14 d` and `1d` above.
7. **Time zone** (`isValidOtelTimeZone`): valid when non-blank and `Intl.DateTimeFormat`
   accepts it as `timeZone`.
8. **Calls** (`extractOtelCalls`, DD-8): only `signal: "logs"` lines whose `record.body.stringValue`
   is `claude_code.api_request`; a record without an event time (rule 3) is skipped.
   - `requestId`, `querySource`, `model`, `agentId`: the attribute string (empty → null);
     `promptId` = `prompt.id`, else `prompt_id`.
   - `claudeCodeVersion` = resource `service.version`, trimmed, cut to 64, blank → null.
   - Tokens: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`
     (→ `cacheWriteTokens`), as rounded numbers; missing → 0.
   - `costUsdMicros` = `cost_usd_micros` rounded, else `round(cost_usd * 1 000 000)`, else null.
   - One call per key (rule 4): a key repeated in the lines keeps the **last** occurrence.
9. **Spans** (`extractOtelSpans`, DD-10): only `signal: "spans"` lines.
   - Skipped and counted in `skipped`: no record, a missing or empty `traceId` / `spanId`,
     `traceId` longer than 64, `spanId` or `parentSpanId` longer than 32, or no start time.
   - `parentSpanId` empty or missing → null; `endTime` missing → null.
   - `name` as sent (cut to 255; an unknown name is kept); `requestId`, `agentId` from their
     attributes; `querySource` = `query_source_safe`, else `query_source`; `context` =
     `llm_request.context` cut to 32.
   - `attributes` = the flattened attribute map (`key → unwrapped value`). When its JSON is
     larger than `OTEL_SPAN_ATTRIBUTES_MAX_BYTES` = 65536 bytes it becomes
     `{ "_truncated": true, "_bytes": <that size> }`.
10. **Query-source dictionary** (DD-21): the names the dictionary marks visible equal
    `TRANSCRIPT_QUERY_SOURCES`. `lookupQuerySource(name)`: a dictionary name → its description
    and `hidden`, `known: true`; `agent:<x>` → `"Sub-agent thread (<x>)"`, visible, known; any
    other name → `description: null`, `known: false`, `hidden` unless it is a transcript source.

## Edge cases

- In the tree beats the query source: OF-04; sub-agent by transcript or by prefix: OF-02, OF-03.
- Fallback without tree request ids: OF-05..OF-09; null query source: OF-08.
- AC-18 provisional: a transcript source stays visible, a utility source is hidden: OF-10, OF-11.
- Equality at rest: a transcript-source or agent call missing from a complete transcript is
  hidden: OF-12, OF-13.
- Provisional boundary `firstSeq = transcriptSeq`: OF-15 vs OF-16; no transcript: OF-14.
- Event time fallbacks: OF-17..OF-21 (unparsable attribute OF-21, zero nanos OF-19, nothing OF-20).
- Call key: request id OF-22; realtime vs chunk of the same record OF-23; different records OF-24.
- Bucket boundaries: OF-25..OF-27. Interval boundaries on both sides: OF-28..OF-33.
- Time zones: OF-34..OF-37 (blank OF-37).
- Calls: field extraction and filtering OF-38, duplicate key keeps the last OF-39, no time OF-40.
- Spans: full row OF-41, empty parent / open span / unknown name OF-42, every skip reason OF-43,
  oversized attributes OF-44.
- Dictionary: OF-45..OF-49 (unknown name OF-48).

## Examples

Rows (49): [`docs/algorithm-examples/otel-facts.json`](../../algorithm-examples/otel-facts.json) — test data for the table test; the rules above are enough to understand the algorithm.

## Mutations

- "Check the query source before the tree" (a utility source in the tree becomes hidden) -> OF-04.
- "Keep the fallback at rest" (`!treeHasRequestIds || provisional` dropped to `!treeHasRequestIds`
  only for provisional) -> OF-10, OF-11; (fallback applied always) -> OF-12, OF-13.
- "Provisional uses `>=`" -> OF-15.
- "Event time prefers the record time over the attribute" -> OF-17; "zero nanos accepted" -> OF-19.
- "Key hashes the raw JSON without sorting keys" -> OF-23.
- "Bucket rounds instead of floors" -> OF-25, OF-26.
- "Interval boundaries exclusive" (`<` instead of `<=`) -> OF-28, OF-30.
- "Duplicate key keeps the first occurrence" -> OF-39.
- "query_source wins over query_source_safe" -> OF-41.
- "Unknown query source is visible" -> OF-48.

## Where the result is visible

The OTEL tabs: the structure of every call (stack "structure", the hidden-cost KPI, the
`calls=hidden|transcript` filter), the chart buckets and their interval, the session's call
list and trace waterfall, and the query-source table with its "new" chip
(`GET /api/v1/repositories/:repoId/otel/facts`, `GET /api/v1/repositories/:repoId/sessions/:sessionId/otel`,
`GET /api/v1/teams/:teamId/otel/facts`).
