-- Rename the `otel` log type to `claude-otel`.
--
-- OTEL is not Claude-specific: other AI agents (Codex, Copilot, ...) can export OTLP too, and a
-- bare `otel` discriminator would collide the moment a second producer appears. The log type now
-- names the producer, matching the existing `claude` / `claude-subagent` convention.
--
-- `logs_otel` keeps its generic name on purpose: it is the raw OTLP chunk store for ANY producer,
-- and the producing agent is identified by the `logs.log_type` of the normalized row, not by a
-- separate table per agent.
--
-- log_type is a free-form varchar with no CHECK constraint or enum, so this is a pure data update.

UPDATE logs SET log_type = 'claude-otel' WHERE log_type = 'otel';
