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

```examples
[
  {
    "id": "OF-01",
    "input": {"kind": "classify", "inTree": true, "inSubagentTranscript": false, "querySource": "repl_main_thread", "treeHasRequestIds": true, "provisional": false},
    "expected": {"structure": "main"},
    "note": "Rule 1: in the tree, not a sub-agent transcript, no agent: prefix -> main"
  },
  {
    "id": "OF-02",
    "input": {"kind": "classify", "inTree": true, "inSubagentTranscript": true, "querySource": "repl_main_thread", "treeHasRequestIds": true, "provisional": false},
    "expected": {"structure": "subagent"},
    "note": "Rule 1: in the tree and in a sub-agent transcript -> subagent"
  },
  {
    "id": "OF-03",
    "input": {"kind": "classify", "inTree": true, "inSubagentTranscript": false, "querySource": "agent:Explore", "treeHasRequestIds": true, "provisional": false},
    "expected": {"structure": "subagent"},
    "note": "Rule 1: in the tree, query source starts with agent: -> subagent"
  },
  {
    "id": "OF-04",
    "input": {"kind": "classify", "inTree": true, "inSubagentTranscript": false, "querySource": "prompt_suggestion", "treeHasRequestIds": true, "provisional": false},
    "expected": {"structure": "main"},
    "note": "Rule 1: the tree decides first; a utility query source in the tree is still main"
  },
  {
    "id": "OF-05",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "repl_main_thread", "treeHasRequestIds": false, "provisional": false},
    "expected": {"structure": "main"},
    "note": "Rule 1 fallback (no tree request ids): repl_main_thread is a transcript source -> main"
  },
  {
    "id": "OF-06",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "sdk", "treeHasRequestIds": false, "provisional": false},
    "expected": {"structure": "main"},
    "note": "Rule 1 fallback: sdk is a transcript source -> main"
  },
  {
    "id": "OF-07",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "prompt_suggestion", "treeHasRequestIds": false, "provisional": false},
    "expected": {"structure": "hidden"},
    "note": "Rule 1 fallback: prompt_suggestion is neither a transcript source nor agent: -> hidden"
  },
  {
    "id": "OF-08",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": null, "treeHasRequestIds": false, "provisional": false},
    "expected": {"structure": "hidden"},
    "note": "Rule 1 fallback: a null query source is not a transcript source -> hidden"
  },
  {
    "id": "OF-09",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "agent:general-purpose", "treeHasRequestIds": false, "provisional": false},
    "expected": {"structure": "subagent"},
    "note": "Rule 1 fallback: agent: prefix -> subagent"
  },
  {
    "id": "OF-10",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "repl_main_thread", "treeHasRequestIds": true, "provisional": true},
    "expected": {"structure": "main"},
    "note": "AC-18: the tree has request ids but the call is provisional -> fallback; repl_main_thread -> main"
  },
  {
    "id": "OF-11",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "prompt_suggestion", "treeHasRequestIds": true, "provisional": true},
    "expected": {"structure": "hidden"},
    "note": "AC-18: provisional -> fallback; prompt_suggestion -> hidden"
  },
  {
    "id": "OF-12",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "repl_main_thread", "treeHasRequestIds": true, "provisional": false},
    "expected": {"structure": "hidden"},
    "note": "Rule 1 last step (at rest): transcript complete, call not in it -> hidden even for repl_main_thread"
  },
  {
    "id": "OF-13",
    "input": {"kind": "classify", "inTree": false, "inSubagentTranscript": false, "querySource": "agent:Explore", "treeHasRequestIds": true, "provisional": false},
    "expected": {"structure": "hidden"},
    "note": "Rule 1 last step (at rest): the agent: prefix only counts in the fallback -> hidden"
  },
  {
    "id": "OF-14",
    "input": {"kind": "provisional", "firstSeq": 5, "transcriptSeq": null},
    "expected": {"provisional": true},
    "note": "Rule 2: no transcript seen yet -> provisional"
  },
  {
    "id": "OF-15",
    "input": {"kind": "provisional", "firstSeq": 5, "transcriptSeq": 5},
    "expected": {"provisional": false},
    "note": "Rule 2: 5 > 5 is false -> not provisional"
  },
  {
    "id": "OF-16",
    "input": {"kind": "provisional", "firstSeq": 6, "transcriptSeq": 5},
    "expected": {"provisional": true},
    "note": "Rule 2: 6 > 5 -> provisional"
  },
  {
    "id": "OF-17",
    "input": {"kind": "eventTime", "line": {"signal": "logs", "receivedAt": "2026-10-30T10:09:00.000Z", "record": {"timeUnixNano": "1793354550000000000", "attributes": [{"key": "event.timestamp", "value": {"stringValue": "2026-10-30T10:01:00.000Z"}}]}}},
    "expected": {"eventTime": "2026-10-30T10:01:00.000Z"},
    "note": "Rule 3: the event.timestamp attribute parses -> 10:01:00, the record and line times are ignored"
  },
  {
    "id": "OF-18",
    "input": {"kind": "eventTime", "line": {"signal": "logs", "receivedAt": "2026-10-30T10:09:00.000Z", "record": {"timeUnixNano": "1793354550123456789", "attributes": []}}},
    "expected": {"eventTime": "2026-10-30T10:02:30.123Z"},
    "note": "Rule 3: no attribute; 1793354550123456789 ns / 1e6 = 1793354550123 ms (cut) = 10:02:30.123"
  },
  {
    "id": "OF-19",
    "input": {"kind": "eventTime", "line": {"signal": "logs", "receivedAt": "2026-10-30T10:09:00.000Z", "record": {"timeUnixNano": "0", "attributes": []}}},
    "expected": {"eventTime": "2026-10-30T10:09:00.000Z"},
    "note": "Rule 3: zero nanos means unset -> the line's receivedAt 10:09:00"
  },
  {
    "id": "OF-20",
    "input": {"kind": "eventTime", "line": {"signal": "logs", "record": {"attributes": []}}},
    "expected": {"eventTime": null},
    "note": "Rule 3: no attribute, no record time, no receivedAt -> null"
  },
  {
    "id": "OF-21",
    "input": {"kind": "eventTime", "line": {"signal": "logs", "receivedAt": "2026-10-30T10:09:00.000Z", "record": {"timeUnixNano": "1793354400000000000", "attributes": [{"key": "event.timestamp", "value": {"stringValue": "not a date"}}]}}},
    "expected": {"eventTime": "2026-10-30T10:00:00.000Z"},
    "note": "Rule 3: the attribute does not parse -> timeUnixNano 1793354400000 ms = 10:00:00"
  },
  {
    "id": "OF-22",
    "input": {"kind": "callKey", "calls": [{"requestId": "req_011", "record": {"timeUnixNano": "1793354550000000000", "attributes": []}}]},
    "expected": {"keys": ["req_011"]},
    "note": "Rule 4: a request id is the key as is"
  },
  {
    "id": "OF-23",
    "input": {"kind": "callKey", "calls": [
      {"requestId": null, "record": {"timeUnixNano": "1793354550000000000", "attributes": [{"key": "query_source", "value": {"stringValue": "prompt_suggestion"}}]}},
      {"requestId": null, "record": {"attributes": [{"value": {"stringValue": "prompt_suggestion"}, "key": "query_source"}], "timeUnixNano": "1793354550000000000"}}
    ]},
    "expected": {"keys": ["rec:883865b059c9ea1b16f3546274bb3a1fae75553b", "rec:883865b059c9ea1b16f3546274bb3a1fae75553b"]},
    "note": "Rule 4: both records canonicalise to {\"attributes\":[{\"key\":\"query_source\",\"value\":{\"stringValue\":\"prompt_suggestion\"}}],\"timeUnixNano\":\"1793354550000000000\"} (key order does not matter); sha1 of that text (computed with a separate sha1 tool) = 883865b0...553b, so the realtime and chunk copies share one key"
  },
  {
    "id": "OF-24",
    "input": {"kind": "callKey", "calls": [
      {"requestId": null, "record": {"timeUnixNano": "1793354550000000000", "attributes": [{"key": "query_source", "value": {"stringValue": "prompt_suggestion"}}]}},
      {"requestId": null, "record": {"timeUnixNano": "1793354551000000000", "attributes": [{"key": "query_source", "value": {"stringValue": "prompt_suggestion"}}]}}
    ]},
    "expected": {"keys": ["rec:883865b059c9ea1b16f3546274bb3a1fae75553b", "rec:585049cee7c8baac569934489a70eea880f02ae7"]},
    "note": "Rule 4: the second record's timeUnixNano ends in ...551..., so its canonical text and sha1 (585049ce...02ae7) differ: two calls, two keys"
  },
  {
    "id": "OF-25",
    "input": {"kind": "bucket5m", "time": "2026-10-30T10:02:30.123Z"},
    "expected": {"bucketStart": "2026-10-30T10:00:00.000Z"},
    "note": "Rule 5: 10:02:30.123 floors to the 10:00 five-minute bucket"
  },
  {
    "id": "OF-26",
    "input": {"kind": "bucket5m", "time": "2026-10-30T10:04:59.999Z"},
    "expected": {"bucketStart": "2026-10-30T10:00:00.000Z"},
    "note": "Rule 5: 1 ms before 10:05 is still the 10:00 bucket"
  },
  {
    "id": "OF-27",
    "input": {"kind": "bucket5m", "time": "2026-10-30T10:05:00.000Z"},
    "expected": {"bucketStart": "2026-10-30T10:05:00.000Z"},
    "note": "Rule 5: exactly 10:05 starts the next bucket"
  },
  {
    "id": "OF-28",
    "input": {"kind": "interval", "from": "2026-10-29T00:00:00.000Z", "to": "2026-10-30T00:00:00.000Z", "scope": "repository"},
    "expected": {"interval": "5m"},
    "note": "Rule 6: span = 24 h exactly -> 5m"
  },
  {
    "id": "OF-29",
    "input": {"kind": "interval", "from": "2026-10-29T00:00:00.000Z", "to": "2026-10-30T00:00:00.001Z", "scope": "repository"},
    "expected": {"interval": "1h"},
    "note": "Rule 6: 24 h + 1 ms, repository, <= 14 d -> 1h"
  },
  {
    "id": "OF-30",
    "input": {"kind": "interval", "from": "2026-10-16T00:00:00.000Z", "to": "2026-10-30T00:00:00.000Z", "scope": "repository"},
    "expected": {"interval": "1h"},
    "note": "Rule 6: span = 14 d exactly -> 1h"
  },
  {
    "id": "OF-31",
    "input": {"kind": "interval", "from": "2026-10-16T00:00:00.000Z", "to": "2026-10-30T00:00:00.001Z", "scope": "repository"},
    "expected": {"interval": "1d"},
    "note": "Rule 6: 14 d + 1 ms, repository -> 1d"
  },
  {
    "id": "OF-32",
    "input": {"kind": "interval", "from": "2026-10-29T00:00:00.000Z", "to": "2026-10-30T00:00:00.000Z", "scope": "session"},
    "expected": {"interval": "5m"},
    "note": "Rule 6: session, span = 24 h -> 5m"
  },
  {
    "id": "OF-33",
    "input": {"kind": "interval", "from": "2026-09-30T00:00:00.000Z", "to": "2026-10-30T00:00:00.000Z", "scope": "session"},
    "expected": {"interval": "1h"},
    "note": "Rule 6: session, 30 d > 24 h -> 1h (a session never gets 1d)"
  },
  {
    "id": "OF-34",
    "input": {"kind": "tz", "tz": "UTC"},
    "expected": {"valid": true},
    "note": "Rule 7: UTC is accepted"
  },
  {
    "id": "OF-35",
    "input": {"kind": "tz", "tz": "Europe/Berlin"},
    "expected": {"valid": true},
    "note": "Rule 7: an IANA zone name is accepted"
  },
  {
    "id": "OF-36",
    "input": {"kind": "tz", "tz": "Mars/Olympus"},
    "expected": {"valid": false},
    "note": "Rule 7: an unknown zone is rejected (the route answers 400)"
  },
  {
    "id": "OF-37",
    "input": {"kind": "tz", "tz": "  "},
    "expected": {"valid": false},
    "note": "Rule 7: blank -> invalid"
  },
  {
    "id": "OF-38",
    "input": {"kind": "calls", "lines": [
      {"signal": "logs", "receivedAt": "2026-10-30T10:03:00.000Z", "resource": {"service.version": " 2.1.99 "}, "record": {"timeUnixNano": "1793354550000000000", "body": {"stringValue": "claude_code.api_request"}, "attributes": [
        {"key": "request_id", "value": {"stringValue": "req_038"}},
        {"key": "query_source", "value": {"stringValue": "repl_main_thread"}},
        {"key": "model", "value": {"stringValue": "claude-opus-5-5"}},
        {"key": "prompt.id", "value": {"stringValue": "p-1"}},
        {"key": "input_tokens", "value": {"intValue": "1200"}},
        {"key": "output_tokens", "value": {"intValue": 300}},
        {"key": "cache_read_tokens", "value": {"doubleValue": 4000.4}},
        {"key": "cache_creation_tokens", "value": {"stringValue": "500"}},
        {"key": "cost_usd", "value": {"doubleValue": 0.0123}}
      ]}},
      {"signal": "logs", "receivedAt": "2026-10-30T10:03:00.000Z", "record": {"timeUnixNano": "1793354550000000000", "body": {"stringValue": "claude_code.user_prompt"}, "attributes": []}},
      {"signal": "metrics", "receivedAt": "2026-10-30T10:03:00.000Z", "record": {"name": "claude_code.cost.usage"}}
    ]},
    "expected": {"calls": [{"callKey": "req_038", "requestId": "req_038", "querySource": "repl_main_thread", "model": "claude-opus-5-5", "claudeCodeVersion": "2.1.99", "promptId": "p-1", "agentId": null, "eventTime": "2026-10-30T10:02:30.000Z", "inputTokens": 1200, "outputTokens": 300, "cacheReadTokens": 4000, "cacheWriteTokens": 500, "costUsdMicros": "12300"}]},
    "note": "Rule 8: only the api_request log line counts (user_prompt and metrics skipped); time from timeUnixNano = 10:02:30; version trimmed; 4000.4 rounds to 4000; no cost_usd_micros -> round(0.0123 * 1e6) = 12300"
  },
  {
    "id": "OF-39",
    "input": {"kind": "calls", "lines": [
      {"signal": "logs", "record": {"timeUnixNano": "1793354550000000000", "body": {"stringValue": "claude_code.api_request"}, "attributes": [{"key": "request_id", "value": {"stringValue": "req_039"}}, {"key": "cost_usd_micros", "value": {"intValue": "1000"}}]}},
      {"signal": "logs", "record": {"timeUnixNano": "1793354550000000000", "body": {"stringValue": "claude_code.api_request"}, "attributes": [{"key": "request_id", "value": {"stringValue": "req_039"}}, {"key": "cost_usd_micros", "value": {"intValue": "2500"}}]}}
    ]},
    "expected": {"calls": [{"callKey": "req_039", "costUsdMicros": "2500", "claudeCodeVersion": null, "inputTokens": 0}]},
    "note": "Rule 8: the same key twice -> one call, the last occurrence (2500) wins; no resource -> version null; no tokens -> 0"
  },
  {
    "id": "OF-40",
    "input": {"kind": "calls", "lines": [
      {"signal": "logs", "record": {"body": {"stringValue": "claude_code.api_request"}, "attributes": [{"key": "request_id", "value": {"stringValue": "req_040"}}]}}
    ]},
    "expected": {"calls": []},
    "note": "Rules 3 and 8: no attribute time, no record time, no receivedAt -> no event time -> skipped"
  },
  {
    "id": "OF-41",
    "input": {"kind": "spans", "lines": [
      {"signal": "spans", "record": {"traceId": "aaaa0000aaaa0000aaaa0000aaaa0000", "spanId": "bbbb0000bbbb0001", "parentSpanId": "bbbb0000bbbb0000", "name": "claude_code.llm_request", "startTimeUnixNano": "1793354400000000000", "endTimeUnixNano": "1793354550000000000", "attributes": [
        {"key": "request_id", "value": {"stringValue": "req_041"}},
        {"key": "agent_id", "value": {"stringValue": "agent-7"}},
        {"key": "query_source", "value": {"stringValue": "agent:Explore"}},
        {"key": "query_source_safe", "value": {"stringValue": "agent:custom"}},
        {"key": "llm_request.context", "value": {"stringValue": "interaction-context-with-a-very-long-name"}},
        {"key": "attempt", "value": {"intValue": "1"}}
      ]}},
      {"signal": "logs", "record": {"body": {"stringValue": "claude_code.api_request"}}}
    ]},
    "expected": {"skipped": 0, "spans": [{"traceId": "aaaa0000aaaa0000aaaa0000aaaa0000", "spanId": "bbbb0000bbbb0001", "parentSpanId": "bbbb0000bbbb0000", "name": "claude_code.llm_request", "startTime": "2026-10-30T10:00:00.000Z", "endTime": "2026-10-30T10:02:30.000Z", "requestId": "req_041", "agentId": "agent-7", "querySource": "agent:custom", "context": "interaction-context-with-a-very-", "attributes": {"request_id": "req_041", "agent_id": "agent-7", "query_source": "agent:Explore", "query_source_safe": "agent:custom", "llm_request.context": "interaction-context-with-a-very-long-name", "attempt": "1"}}]},
    "note": "Rule 9: the logs line is ignored; query_source_safe wins over query_source; the 41-character context is cut to its first 32 characters; attributes are flattened to key -> unwrapped value (intValue \"1\" stays the string \"1\")"
  },
  {
    "id": "OF-42",
    "input": {"kind": "spans", "lines": [
      {"signal": "spans", "record": {"traceId": "t-42", "spanId": "s-42", "parentSpanId": "", "name": "claude_code.some_future_span", "startTimeUnixNano": "1793354400000000000", "attributes": [{"key": "query_source", "value": {"stringValue": "compact"}}]}}
    ]},
    "expected": {"skipped": 0, "spans": [{"traceId": "t-42", "spanId": "s-42", "parentSpanId": null, "name": "claude_code.some_future_span", "startTime": "2026-10-30T10:00:00.000Z", "endTime": null, "requestId": null, "querySource": "compact", "context": null, "attributes": {"query_source": "compact"}}]},
    "note": "Rule 9: empty parent -> null (a root); no end -> null (still open); the unknown name is kept; query_source used when query_source_safe is absent"
  },
  {
    "id": "OF-43",
    "input": {"kind": "spans", "lines": [
      {"signal": "spans", "record": {"traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spanId": "s1", "startTimeUnixNano": "1793354400000000000"}},
      {"signal": "spans", "record": {"traceId": "t1", "spanId": "sssssssssssssssssssssssssssssssss", "startTimeUnixNano": "1793354400000000000"}},
      {"signal": "spans", "record": {"traceId": "t1", "startTimeUnixNano": "1793354400000000000"}},
      {"signal": "spans", "record": {"traceId": "t1", "spanId": "s4"}},
      {"signal": "spans"}
    ]},
    "expected": {"skipped": 5, "spans": []},
    "note": "Rule 9: traceId of 65 characters (> 64), spanId of 33 (> 32), no spanId, no start time, no record -> 5 skipped, none kept"
  },
  {
    "id": "OF-44",
    "input": {"kind": "spans", "lines": [
      {"signal": "spans", "record": {"traceId": "t-44", "spanId": "s-44", "name": "claude_code.tool", "startTimeUnixNano": "1793354400000000000", "attributes": [{"key": "big", "value": {"stringValue": {"$repeat": ["x", 70000]}}}]}}
    ]},
    "expected": {"skipped": 0, "spans": [{"spanId": "s-44", "attributes": {"_truncated": true, "_bytes": 70010}}]},
    "note": "Rule 9: the JSON {\"big\":\"<70000 x>\"} is 8 + 70000 + 2 = 70010 bytes > 65536 -> replaced by the truncation marker with _bytes 70010"
  },
  {
    "id": "OF-45",
    "input": {"kind": "dictionary"},
    "expected": {"visible": ["repl_main_thread", "sdk"], "transcript": ["repl_main_thread", "sdk"]},
    "note": "Rule 10: the dictionary's visible names are exactly the two transcript sources, in the same order"
  },
  {
    "id": "OF-46",
    "input": {"kind": "querySource", "name": "prompt_suggestion"},
    "expected": {"hidden": true, "known": true},
    "note": "Rule 10: a dictionary name marked hidden"
  },
  {
    "id": "OF-47",
    "input": {"kind": "querySource", "name": "agent:Explore"},
    "expected": {"description": "Sub-agent thread (Explore)", "hidden": false, "known": true},
    "note": "Rule 10: agent:<x> -> 'Sub-agent thread (Explore)', visible, known"
  },
  {
    "id": "OF-48",
    "input": {"kind": "querySource", "name": "brand_new_source"},
    "expected": {"description": null, "hidden": true, "known": false},
    "note": "Rule 10: an unseen name -> no description, unknown ('new' chip), hidden because it is not a transcript source"
  },
  {
    "id": "OF-49",
    "input": {"kind": "querySource", "name": "sdk"},
    "expected": {"hidden": false, "known": true},
    "note": "Rule 10: sdk is a visible dictionary name"
  }
]
```

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
