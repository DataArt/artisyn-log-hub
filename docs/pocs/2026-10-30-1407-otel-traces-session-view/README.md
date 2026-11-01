# PoC: OTEL tabs (repository + session) with Jaeger-style traces, near-realtime

Task: none yet — ad-hoc research (2026-10-30), prompted by an external write-up on Claude Code's
`agent_summary` side query. A task gets scratched from this PoC's result.

## Questions

1. Which Claude Code API calls never reach a transcript, how much do they cost, and can Log Hub
   show them per repository and per session from data it already stores?
2. Does Claude Code emit OTEL **traces**, what is in them, and can they be tied to a Log Hub session
   and drawn as a Jaeger-style waterfall?
3. How fresh can the OTEL views be — can they update every 5–15 s?

## How to run (from this folder)

```sh
node capture.js 4399            # OTLP/HTTP-JSON receiver + prototype server (keep running)
node build.js                   # facts.sql against a Log Hub Postgres container -> out/otel-tabs.html
                                # (POC_DB_CONTAINER, default artisyn-log-hub-db)
# capture a trace: run Claude Code in out/sample/ (no .claude folder there) with
#   CLAUDE_CODE_ENABLE_TELEMETRY=1 CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
#   OTEL_TRACES_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp
#   OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4399
node spans.js [--keys]          # captured span tree / attribute keys per span name
node lag.js [session-prefix]    # receive time minus record end time, per signal
# open http://127.0.0.1:4399/   # the prototype; the session tab polls /spans every 2 s
```

Files: `capture.js` (receiver + server), `otlp.js` (shared OTLP decoding), `facts.sql` (read-only
fact rows), `build.js` (page builder), `template.html` (the prototype UI), `spans.js`, `lag.js`.
`out/` (captures, generated page, sample project) is ignored — it holds real session data.

## Result

### 1. Hidden calls — the data is already there

Every `claude_code.api_request` is stored in `otel_api_calls` with `query_source`; nothing is
filtered on the way (the receiver only drops records without `session.id`). Classifying a call as
hidden = its `request_id` is in no transcript (`session_request_ids`), the same rule
`utilityCostsCte` uses.

Local prod, 2026-10-22..29, main repository ($964 OTEL cost):

| query_source | share of cost | hidden | context : output |
|---|---|---|---|
| `repl_main_thread` | 46.6 % | — | 286 : 1 |
| `agent:builtin:workflow-subagent` | 33.1 % | — | 156 : 1 |
| `agent:builtin:general-purpose` | 12.2 % | — | 126 : 1 |
| **`prompt_suggestion`** | **4.2 %** | 100 % | **9 900 : 1** |
| `agent_summary` | 1.9 % | 100 % | 3 500 : 1 |
| `web_search_tool`, `compact`, `web_fetch_apply`, `generate_session_title` | < 0.1 % each | 100 % | |

Hidden total 6.1 %. `prompt_suggestion` (re-sends the context to the session model for one grey
suggestion line) costs more than twice `agent_summary`. The context:output ratio is the generic
"expensive call for a tiny result" marker. Sources present in the 2.1.314 binary but not yet seen in
our data: `side_question`, `auto_mode*`, `hook_prompt`, `hook_agent`, `extract_memories`,
`auto_dream`, `away_summary`, `memdir_relevance`, `insights`, `agent_namer`, `agent_classifier`,
`tool_use_summary_generation`, `artifact_*`, `plugin_eval_*` — the UI must show unknown sources as
is and flag them as new.

Attribution: every hidden call carries `session.id` (root session) and `prompt.id`; transcript user
lines carry the same `promptId`, so each call can be placed in its turn. `agent_summary` has no
agent id in the log event.

### 2. Traces exist and carry everything needed

With `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and `OTEL_TRACES_EXPORTER=otlp`, Claude Code 2.1.314
exports one trace per user turn:

```
claude_code.interaction                (root, interaction.sequence, user_prompt_length)
├─ claude_code.llm_request             (model, tokens, ttft_ms, request_id, query_source_safe)
├─ claude_code.tool  tool_name=Bash    (tool_use_id, bash_command_class)
│  ├─ claude_code.tool.blocked_on_user (decision, source)  — time waiting for permission
│  └─ claude_code.tool.execution       (success)
└─ claude_code.tool  tool_name=Agent
   └─ claude_code.tool.execution
      ├─ claude_code.llm_request  agent_id=a432dc…  (sub-agent calls nest here)
      └─ claude_code.tool  tool_name=Glob  agent_id=a432dc…
```

Join keys to what Log Hub already has: `session.id` → session; `request_id` → transcript
`requestId` and `otel_api_calls`; `tool_use_id` → transcript `tool_use` block; `agent_id` →
sub-agent transcript `agent-<id>`. So traces attach to the session without heuristics, and
sub-agent work is attributed by `agent_id`. A `TRACEPARENT` env var is honoured, so `claude -p`
started from a parent can join the parent's trace. The `hook` span type also exists (not exercised
here). `user_prompt` is `<REDACTED>` unless `OTEL_LOG_USER_PROMPTS` is set.

**Cost in traces.** Spans carry tokens, model and `request_id` but no cost. The `api_request` log
event with the same `request_id` carries `cost_usd`, so each `llm_request` span gets its cost by that
join (in the product: `otel_api_calls`), and tool / agent / interaction rows show the rolled-up cost
of everything under them.

**Hidden calls are in traces too, attributed to their cause.** In a run with WebFetch and WebSearch
all 16 API calls of the session's logs were found as spans by `request_id`, including the hidden
`web_fetch_apply` and `web_search_tool`; they nest under the `WebFetch` / `WebSearch` tool span
(`llm_request.context=tool`). Not verified yet (they only fire in interactive sessions):
`prompt_suggestion` and `agent_summary`, which run outside a tool — by the span code they should be
`llm_request.context=interaction` or `standalone` spans; the task must check this interactively.

The prototype (`template.html`) shows both tabs. Repository — on top a classic **cost over time**
chart: stacked bars (stack by structure = main thread / sub-agents / hidden calls, or by
query_source, model, Claude Code version), interval auto / 5 min / 1 h / 1 day, absolute or 100 %,
a cumulative line on the right axis, per-bar tooltip with the breakdown; then KPIs; below, the
"cost structure & hidden calls" section (share bars where `prompt_suggestion` 4.2 % is visible at
once, hidden-calls bars, source table with descriptions, sessions table). Filters: period, model,
Claude Code version, hidden/visible, metric (cost/calls/tokens). Session — the same cost-over-time
chart for one session, KPIs, cost by source, and a Jaeger-style waterfall (minimap, collapsible
service & operation tree, duration labels, per-span cost and rolled-up cost, span details on
click). Buckets use each call's own `event.timestamp` from the stored OTLP record, not the chunk
ingest time.

### 3. Freshness — 5 s is reachable, the current pipeline is the bottleneck

Measured with Claude Code's **default** export settings (34 s `claude -p` run):

| signal | delivery | lag from record end to receiver |
|---|---|---|
| traces | batch every 5 s (`OTEL_BSP_SCHEDULE_DELAY` default) | median 3.9 s, max 5.0 s |
| logs | batch every 5 s | median 3.9 s, max 5.6 s |
| metrics | every `OTEL_METRIC_EXPORT_INTERVAL` (hook sets 10 s) | — |

Spans are exported when they **end**: a running turn streams its finished LLM and tool spans, and
the `interaction` root arrives last. The live page (polling every 2 s) showed a half-finished turn
correctly, with children drawn at top level until the root arrived.

Today Log Hub lands OTEL chunks on disk and uploads them at `Stop` or in the receiver's 60 s tail
sweep, so data is up to a whole turn (minutes) behind. For 5–15 s the receiver has to forward
batches itself (every ~5 s), the server has to ingest them incrementally, and the UI has to poll or
subscribe (SSE) — see the next steps.

## Next steps (for the task)

- Hook: add `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
  `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` to the env block (per-key ownership as today); receiver
  accepts `/v1/traces`; receiver ships pending chunks every ~5 s while traffic flows, keeping the
  `Stop`/sweep path as the fallback. Older servers must ignore the new kind; older hooks simply send
  no traces.
- Server: `otel_spans` table (session, trace, span, parent, name, start/end, attrs), incremental
  ingest, routes for the repository facts and a session's traces, and an SSE or `since=` poll route.
- Client: repository and session OTEL tabs (Recharts/d3, already in the client), source dictionary
  served by the server, unknown sources flagged.
- Beta flag: traces depend on `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`; its shape may change between
  versions, so the ingest stores raw attributes and the UI degrades to logs-only views.
