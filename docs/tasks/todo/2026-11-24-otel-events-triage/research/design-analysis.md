---
type: "Note"
title: "OTEL events — planning analysis"
description: "Decisions settled during plan-deep step 2.5 for the otel-events-triage task: storage, keys, value coercion, wireframe fixes, collapsible events card."
---

# OTEL events — planning analysis (2026-11-24)

## Storage (owner's choice, 2026-11-24)

Asked in the plan session: where to store surfaced events, given "no new generic events table".
The owner chose **typed tables**: a new `otel_session_events` table closed to the FR-2 surfaced
kinds (no catch-all of every event) instead of synthetic `otel_spans` rows or counters only.

Refinement made while planning: the hook overhead aggregate is **not** stored in its own table.
`hook_execution_complete` reaches the server twice (realtime batch + chunk) and again after a
projection re-mark; a stored additive aggregate would double count unless the raw rows are kept
for dedup anyway. So hook runs are rows of `otel_session_events` (kind `hook_execution_complete`,
dedup by event key) and the per-`hook_name` aggregate is a read-time `GROUP BY` of one root's rows
(index `(session_id, kind)`). One table instead of two; same seq / delta / purge rules.

## Keys and dedup

- Events carry no `request_id`; `event.sequence` restarts per process (not unique across
  `--resume`). Key = `otelCallKey(null, record)` = `rec:` + sha1 of canonical
  `{timeUnixNano, attributes}` (`server/src/logs/otel/otel-records.ts:133`). Realtime and chunk
  lines are the same objects, so both channels give one key.
- Event name: attribute `event.name` (e.g. `compaction`), else `body.stringValue` without the
  `claude_code.` prefix. The capture had both on every record.

## Value types seen in the capture (2.1.325 / 2.1.331)

- Strings for numbers: `compaction.pre_tokens` / `post_tokens` / `duration_ms`, every
  `hook_execution_complete.num_*` (`"0"`, `"1"`, `"2"`). Numbers: `api_error.attempt`,
  `duration_ms`, `subagent_completed.*`. The extractor coerces both (non-negative integer or null).
- `tool_decision.decision`: `accept` / `reject`; `source`: `config` (and classifier sources in
  auto mode); `classifier_verdict`: `allow`; `classifier_category` never emitted.
- `compaction.trigger`: only `manual` seen; `auto` is documented, not observed.
- Sensitive keys never stored: `tool_parameters` (installer sets `OTEL_LOG_TOOL_DETAILS=1`),
  `prompt`, `prompt_text`, every `user.*` / `organization.*` key. `api_error.error` is free text:
  stored capped at 200 chars, dropped for masked callers.

## Wireframe fixes

- Chip counts summed to 24 against "All 31": fixed to All 24 / "7 of 24 shown" / "Show 17 more";
  Permissions = `tool_decision` + `permission_mode_changed`.
- Events toggle: local tab state (the session tab has no URL state, `SessionOtelTab.tsx:14`), not URL.
- Hook overhead card without `hook_execution_*` events: hidden (FR-5), not a "not reported" note.
- Owner request (2026-11-24, during planning): the Session events card is collapsible, collapsed
  by default; collapsed, its header shows "N events · <kind> <count> · …" (zero kinds omitted,
  API failures red). Marker click expands it and scrolls to the row. Added to FR-4 and the SVG.

## Hook share denominator

"% of session wall time" = hook total / (max − min) of `otel_calls.event_time` ∪
`otel_session_events.event_time` of the root (the OTEL route has no transcript wall time).
Wireframe check: 5.4 s / 1408 s = 0.3835 % → "0.4 %".

## Compaction vs `session_cause_stats`

The OTEL tab never shows `CacheRatioCauses.compaction` (transcript-derived, Reports tab), so no
two numbers for the same fact meet on one screen; the KB notes the relation, no cross-link in UI.
