# Notes: Shared Per-User OTEL Receiver

## 2026-10-30: Investigation evidence (moved from requirements.md)

- **Symptom.** Local prod (`:5003`), session `6e924d06-…`, OTEL tab empty. `receiver.log`: the
  receiver (pid alive on `127.0.0.1:58603`) logged its last real `ingest` on 2026-10-29 16:01Z and
  none since, across many sessions. A manual empty OTLP POST was ingested, so the receiver works.
  `hook.log` reported `otel endpoints point at the receiver` — the check only reads the settings
  file. The session's process env had no `OTEL_*` / `CLAUDE_CODE_ENABLE_TELEMETRY` although
  `.claude/settings.local.json` (valid JSON) carries them and the process started after the file
  was written. Claude Code was updated to 2.1.314 on 2026-10-30 09:49Z, the minute before the first
  receiver of the day started.
- **Restriction history.** The restrictions have tightened monotonically (2.1.217 managed endpoint
  dominance, 2.1.251 launcher pinning / `OTEL_LOG_RAW_API_BODIES` project-ignored, 2.1.282 project
  scope cannot enable). The same "repository cannot X" pattern is applied to other keys
  (`modelPicker`, footer badges).
- **Community practice:** move the non-secret telemetry env to `~/.claude/settings.json` and keep
  per-project tagging via project-level `OTEL_RESOURCE_ATTRIBUTES` (sw-cortex PR #142); one
  collector routing by a resource attribute (Arize claude-code-otlp-collector). Known issues:
  Desktop app drops project `OTEL_RESOURCE_ATTRIBUTES` (anthropics/claude-code #93338, #95269);
  local `OTEL_RESOURCE_ATTRIBUTES` replaces rather than merges the user value.
