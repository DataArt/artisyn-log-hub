---
type: "Note"
title: "OTEL events inventory (FR-1)"
description: "Which Claude Code OTEL events and attributes arrive on a real capture with the installer's env, on 2.1.325 and 2.1.331."
---

# OTEL events inventory (FR-1)

Captured 2026-11-24 with the PoC [docs/pocs/2026-11-24-1526-otel-events-capture](../../../pocs/2026-11-24-1526-otel-events-capture/README.md)
(`claude -p`, haiku, the installer's OTEL env with tracing on, no extra env flag). Full per-key
samples: the PoC's `results/inventory-<version>.md`.

Result values: **arrived** / **not triggered** (no trigger reproduced, decision from docs).
No item was triggered without being emitted.

| Item | Trigger used | 2.1.325 | 2.1.331 | Key attributes (besides the common session/user/org set) |
|---|---|---|---|---|
| `compaction` | `/compact` | arrived | arrived | `trigger` (manual), `pre_tokens`, `post_tokens`, `duration_ms`, `success`, `precompute_reuse` |
| `api_error` | dead `ANTHROPIC_BASE_URL` | arrived | arrived | `error`, `attempt`, `duration_ms`, `model`, `query_source` |
| `api_retries_exhausted` | dead `ANTHROPIC_BASE_URL`, 2 retries | arrived | arrived | `error`, `total_attempts`, `total_retry_duration_ms`, `model` |
| `api_refusal` | — | not triggered | not triggered | — |
| `skill_activated` | project skill | arrived | arrived | `skill.name`, `skill.source`, `invocation_trigger` |
| `subagent_completed` | general-purpose sub-agent | arrived | arrived | `agent_id`, `agent_type`, `agent.source`, `is_built_in`, `is_async`, `model`, `final_model`, `model_swapped`, `duration_ms`, `total_tokens`, `total_tool_uses` |
| `hook_registered` | 3 project command hooks | arrived | arrived | `hook_event`, `hook_matcher`, `hook_source`, `hook_type` |
| `hook_execution_start` | same | arrived | arrived | `hook_event`, `hook_name` |
| `hook_execution_complete` | same | arrived | arrived | `hook_event`, `hook_name` (`PreToolUse:Skill`), `hook_source` (`merged`), `num_hooks`, `num_success`, `num_blocking`, `num_cancelled`, `num_non_blocking_error`, `total_duration_ms`, `stdout_chars`, `additional_context_chars`, `system_message_chars` — no hook command / plugin name |
| `hook_plugin_metrics` | — | not triggered | not triggered | — |
| `permission_mode_changed` | stream-json `set_permission_mode` | arrived | arrived | `from_mode`, `to_mode` |
| `plugin_installed` | — (install is outside project scope) | not triggered | not triggered | — |
| `internal_error` | — | not triggered | not triggered | — |
| `at_mention` | `@src/app.js` in the prompt | arrived | arrived | `mention_type`, `success` |
| `feedback_survey` | — | not triggered | not triggered | — |
| `managed_settings_resolved` | every startup | arrived | arrived | `managed_settings.sources`, `.trigger`, `.source_behavior`, `.helper.*` |
| `retention_sweep` | — | not triggered | not triggered | — |
| `tool_decision` | allowed / denied / auto-mode tools | arrived | arrived | `decision`, `source`, `tool_name`, `tool_source`, `permission_mode`, `agent_id` |
| `tool_decision.classifier_verdict` | Bash in auto mode | arrived (`allow`) | arrived (`allow`) | — |
| `tool_decision.classifier_category` | Bash in auto mode | not triggered (no category on `allow`) | not triggered | — |
| `tool_decision.permission_mode` | all sessions | arrived | arrived | `default` / `acceptEdits` / `auto` |
| `user_prompt` | every prompt | arrived | arrived | `prompt_length`, `command_name`, `command_source`, `prompt` = `<REDACTED>` |
| `user_prompt.delivery.mode` | second stream-json message during a turn | arrived (`mid_turn`) | arrived (`mid_turn`) | — |
| `tool_result` | every tool call | arrived | arrived | `tool_name`, `success`, `duration_ms`, `tool_input_size_bytes`, `tool_result_size_bytes` |
| `llm_request` span `gen_ai.response.model` | every call | absent | arrived | always equal to the native `model` attribute (11/11) |
| `llm_request` span `gen_ai.operation.name` | every call | absent (only on `interaction` / `tool` spans) | arrived (`chat`) | — |
| `llm_request` span `gen_ai.usage.*` | every call | absent | arrived | `input_tokens`, `output_tokens`, `cache_read.input_tokens`, `cache_write.input_tokens`; `input_tokens` = native input + cache read + cache write (11/11) |

Emitted but not in the task's list: log events `assistant_response`, `mcp_server_connection`,
`plugin_loaded`; spans `claude_code.tool.blocked_on_user`, `claude_code.tool.execution`.
