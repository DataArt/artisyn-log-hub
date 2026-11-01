# OTEL for organization admins

This page is for admins who manage Claude Code for an organization through **managed settings**.
Managed settings win over every user and project setting. When they set Claude Code's telemetry
(OTEL) keys, the Log Hub installer cannot configure telemetry for your users, and their
[OTEL tabs](otel-tab.md) stay empty unless the managed settings themselves send the data to Log Hub.

Everything else in Log Hub — sessions, prompts, tools, files, attribution and Log Hub's own cost —
does not depend on OTEL and keeps working either way.

## How OTEL reaches Log Hub

Log Hub has no central OTEL endpoint. Each user's Log Hub hook runs a small **local receiver** on
`127.0.0.1`, one per OS user, which sorts the telemetry per repository and uploads it with the
session (see [What Log Hub collects and how](otel-tab.md#what-log-hub-collects-and-how)). So the
telemetry of a machine has to end up at that machine's local receiver. You have three options:

1. **Leave telemetry to user settings** (simplest). Do not set the OTEL keys in managed settings.
   The Log Hub installer then writes them into each user's `~/.claude/settings.json`; if a user
   already sends telemetry to your collector there, the installer can forward it to that collector
   unchanged (the **proxy** choice).
2. **Point the managed endpoint at the local receiver.** Install the hook on every machine with the
   same fixed port (`--otel-port <n>`, for example `--otel-port 47318`), and set the endpoint keys
   below to `http://127.0.0.1:<n>/…` in managed settings.
3. **Keep your own collector and fan out to Log Hub.** Point the managed endpoint at your
   collector (for example an OpenTelemetry Collector running on each machine) and add an exporter
   to it that sends OTLP/HTTP **JSON** to `http://127.0.0.1:<n>/v1/logs`, `/v1/metrics` and
   `/v1/traces` — the local receiver on the fixed port `<n>` from option 2. The receiver accepts only
   OTLP/HTTP JSON (uncompressed or gzip), not gRPC or protobuf.

## Where managed settings live

Claude Code reads managed settings from these places; Log Hub's hook and installer read the same
ones to tell your users what is going on:

| OS | File | OS policy |
|---|---|---|
| Windows | `%ProgramFiles%\ClaudeCode\managed-settings.json` | registry `HKLM\SOFTWARE\Policies\ClaudeCode` (or `HKCU\…`), value `Settings` holding the settings JSON as a string (group policy) |
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` | configuration profile for `com.anthropic.claudecode` (MDM), read from `/Library/Managed Preferences/com.anthropic.claudecode.plist` |
| Linux | `/etc/claude-code/managed-settings.json` | — |
| all | server-managed settings from the Claude admin console, cached by Claude Code in `~/.claude/remote-settings.json` | — |

The keys go into the `env` object of the managed settings JSON:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:47318/v1/logs"
  }
}
```

## The keys to set

For option 2 (or the export side of option 3), with `<n>` the fixed receiver port:

| Key | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `OTEL_LOGS_EXPORTER` | `otlp` |
| `OTEL_METRICS_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_COMPRESSION` | `none` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `http://127.0.0.1:<n>/v1/logs` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | `http://127.0.0.1:<n>/v1/metrics` |
| `OTEL_LOG_TOOL_DETAILS` | `1` (adds tool names and parameters to the tool events) |
| `OTEL_METRIC_EXPORT_INTERVAL` | `10000` (export metrics every 10 s, so little is lost when a session stops) |

Optional, for the trace waterfall of the session OTEL tab:

| Key | Value |
|---|---|
| `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` | `1` |
| `OTEL_TRACES_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://127.0.0.1:<n>/v1/traces` |

Do not set prompt-logging keys for Log Hub: it collects no prompt or response content through
OTEL.

Managed settings work **per key**. When you pin only some endpoints (for example only logs to your
collector), the other signals still follow user settings and reach Log Hub; users then see partial
OTEL data. Setting `CLAUDE_CODE_ENABLE_TELEMETRY` to `0`, or an exporter to `none`, turns that
telemetry off for everyone.

## How to verify

On a user's machine, after the change reached it:

1. Start a new Claude Code session (running sessions keep the settings they started with) and run
   `/status`: it lists the settings sources in effect, including managed settings.
   `claude doctor` reports managed and remote settings and any project keys Claude Code ignores.
2. Finish a turn, then open that session in Log Hub and pick its **OTEL** tab: model calls and
   costs appear. The repository's OTEL tab shows how many sessions have OTEL data.
3. If the tab stays empty, look in `~/.artisyn/otel/receiver.log` on that machine for
   `ingest repo=…` lines (data arrived) and in the project's `.artisyn/ai_work_dir/hook.log` for
   `otel` warnings and the `otel-status state=… reason=…` line.

## What users see

The hook (2.30.0 or newer) detects managed telemetry keys and reports, per session, why OTEL data
is missing. The installer writes no user telemetry keys and says
`OTEL is managed by your organization — OTEL tabs are unavailable, everything else works`.

- **OTEL is managed by your organization** (red, `managed-endpoint`) — managed settings send at
  least one signal to another collector and nothing reached Log Hub for it.
- **Telemetry is disabled by your organization** (red, `managed-disabled`) — managed settings turn
  telemetry off.
- A partial-data banner when only some signals reach Log Hub.

Both messages tell the user that nothing can be fixed on their side and link to
[Admin-managed OTEL](otel-tab.md#admin-managed-otel). Session cost is then marked as excluding
utility calls (the calls that never appear in a transcript). When the data reaches Log Hub through
option 2 or 3, none of these messages appear.
