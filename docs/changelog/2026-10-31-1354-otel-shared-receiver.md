# Shared per-user OTEL receiver

- OTEL telemetry works again on Claude Code 2.1.282+, which ignores telemetry settings in project files: the hook now runs one receiver per OS user, configured in `~/.claude/settings.json`, and routes each record to its repository.
- Sessions and the OTEL tab explain why OTEL data is missing (e.g. disabled by managed settings) instead of showing empty charts.
- On install, an existing OTEL collector can be proxied, kept or replaced.
