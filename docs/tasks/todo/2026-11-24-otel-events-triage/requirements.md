---
type: "Task"
title: "Claude Code OTEL Events Triage"
description: "Find out which Claude Code OTEL events and attributes Log Hub ignores today (compaction, retries, skills, hooks, subagents, classifier verdict, mid-turn prompts, gen_ai.* span attributes), check on a real upload which ones arrive, and decide per item: surface, store or ignore."
---

# 2026-11-24: Claude Code OTEL Events Triage

**Status:** todo
**Priority:** medium
**Type:** feature
**Module(s):** server | client | hook
**Owner:** denis.tsyplakov
**Created:** 2026-11-24
**Tracker:** GH-170 https://github.com/DataArt/artisyn-log-hub/issues/170

## Description

Raw idea (from the morning check 2026-11-24, `docs/morning-check/daily/2026-11-24-1438.md`):

Triage Claude Code OTEL events and attributes that Log Hub does not track yet. Log Hub's OTEL tabs
read only `claude_code.api_request` logs (cost, `otel_calls`) and spans (`claude_code.interaction`
/ `llm_request` / `tool`); every other log event arrives in the raw claude-otel chunks but is not
projected or shown ([otel-tabs.md](../../../knowledgebase/otel-tabs.md): `api_error` /
`user_prompt` are not stored in any table; Code Mode note in the compatibility matrix).

Untracked documented events (grep of `server/src`, `client/src`, `hook` found no reference):
`compaction`, `api_retries_exhausted`, `api_refusal`, `skill_activated`, `subagent_completed`,
`hook_registered`, `hook_execution_start`, `hook_execution_complete` (now with output size
counts), `hook_plugin_metrics`, `permission_mode_changed`, `plugin_installed`, `internal_error`,
`at_mention`, `feedback_survey`, `managed_settings_resolved`, `retention_sweep`.

Untracked attributes:

| Claude Code | Item |
|---|---|
| 2.1.301 | `tool_decision`: `classifier_verdict`, `classifier_category`, `permission_mode` |
| 2.1.325 | `user_prompt`: `delivery.mode: "mid_turn"` for messages sent mid-turn |
| 2.1.331 | `claude_code.llm_request` span: `gen_ai.response.model`, `gen_ai.operation.name`, `gen_ai.usage.*` |

Already handled, out of scope: `anthropic.plan` / `seat_type` / `provider` / `custom_base_url`
(2.1.317), the 5-minute / 1-hour cache-write split.

Important semantic trap: `gen_ai.usage.input_tokens` (semconv) **includes** prompt-cache tokens,
while the native `input_tokens` excludes them. Today Log Hub stores these attributes in
`otel_spans.attributes` and never reads them, so nothing is double-counted.

Sources: https://code.claude.com/docs/en/monitoring-usage, the Claude Code CHANGELOG.

## Functional Requirements

- **FR-1 Inventory.** Capture OTEL output of a real session on the current Claude Code (logs and,
  with tracing on, spans) and list which of the events / attributes above actually arrive, with
  their attribute keys and sample values. The documented `gen_ai.usage.*` sub-keys are not settled
  yet, so check them on a real span.
- **FR-2 Decision per item.** For every event / attribute record a decision: *surface* (name the
  place: session OTEL tab, Live view, session cost diagnosis / antipatterns, hook overhead view),
  *store only*, or *ignore*, with a one-line reason. Candidates with likely product value:
  `compaction`, `api_retries_exhausted` / `api_refusal`, `skill_activated`, `hook_execution_*`
  (including our own hook's overhead), `subagent_completed`, `delivery.mode`,
  `classifier_verdict`.
- **FR-3 Model fallback.** `otelSpanModel`
  (`client/src/viewer/pages/repository/session-log/otel/otel-span-format.ts`) uses
  `gen_ai.response.model` as a fallback after the matched call's model and before the `model`
  attribute.
- **FR-4 Token rule in the KB.** `docs/knowledgebase/otel-tabs.md` (span attributes) and
  `docs/knowledgebase/llm-call-math.md` say that `gen_ai.usage.input_tokens` already includes
  cache tokens and must never be added to `cache_read_tokens` / `cache_creation_tokens` again.
- **FR-5 Implement the "surface" decisions** that FR-2 selects (may be split into follow-up tasks
  if large).
- **FR-6 Compatibility.** Old Claude Code versions (which don't send these) and old hooks keep
  working; the compatibility matrix in `otel-tabs.md` gets a row per new item.

## Acceptance Criteria

- [ ] FR-1: the task folder holds an inventory table (event / attribute · arrives yes/no · CC
      version checked · sample attributes), built from a real capture, not from docs alone.
- [ ] FR-2: every item in the Description has a decision and a reason; "surface" items name the
      UI place.
- [ ] FR-3: a span without a matching `otel_calls` row but with `gen_ai.response.model` shows that
      model; a span from an older Claude Code without it shows the same model as before.
- [ ] FR-4: both KB articles state the `gen_ai.usage.input_tokens` rule.
- [ ] FR-5: each surfaced item is visible in the named place and covered by a step in an existing
      scenario (`tests/scenarios/`, e.g. `s-otel-01`).
- [ ] FR-6: the compatibility matrix lists the new items; `s-compat-01` (frozen old hook) still
      passes.

## Notes

<!-- Append timestamped notes here as work progresses -->
