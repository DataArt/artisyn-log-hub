// Pure OTEL env definitions shared by the installer (`install.ts`) and the dev-container
// provisioning script (`docker-dev/provision.mjs`), which imports this file at runtime through
// Node's type stripping. Keep it free of imports and use erasable TypeScript syntax only (no
// enums, namespaces or parameter properties), or that runtime import breaks.

// The `env` block the installer writes into the gitignored `.claude/settings.local.json` (never the
// committed `.claude/settings.json`: the port is per-checkout, so a committed endpoint would point
// every other checkout at a port that is not theirs). Claude Code exposes these to the hook
// process as real env vars, which is how the spawning hook learns the endpoint the exporter
// actually posts to. Older installers wrote them into `.claude/settings.json`; `mergeOtelEnv`
// moves the ones that are still ours.
//
// `OTEL_EXPORTER_OTLP_COMPRESSION` is set explicitly so the payload encoding never depends on an
// exporter default; the receiver still handles gzip/deflate, so a user who overrides it is not
// silently dropped.
//
// `OTEL_METRIC_EXPORT_INTERVAL` overrides Claude Code's 60 s metrics default. Metrics use delta
// temporality, so a shorter interval does not change any total — it only shrinks the unexported
// tail lost when a session stops mid-window (the Stop upload can land seconds after the last
// export). 10 s bounds that loss while staying 6x cheaper in volume than the 5 s logs stream.
// Per-request cost still comes from the `api_request` log events, which are unaffected by this.
export function OTEL_ENV_KEYS(port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${port}/v1/logs`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
  };
}

// The two OTEL env keys that carry a receiver endpoint (and therefore a port). Every other key of
// `OTEL_ENV_KEYS` has a port-independent value.
export const OTEL_ENDPOINT_KEYS = ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] as const;
