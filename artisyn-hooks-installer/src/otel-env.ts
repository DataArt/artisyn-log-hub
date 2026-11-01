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

// Opt-in trace export (the `--otel-traces` install answer, stored as `otelTraces` in
// `log-hub.json`). Kept out of `OTEL_ENV_KEYS` on purpose: the dev-container provisioning imports
// that function and must stay unaffected. Merged into the same `env` block only when the answer is
// yes; stripped (only while still Artisyn-owned) when it is no and on uninstall.
export function OTEL_TRACE_ENV_KEYS(port: number): Record<string, string> {
  return {
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
  };
}

// The trace env key that carries a receiver endpoint (and therefore a port).
export const OTEL_TRACE_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT';

// The OTLP resource attribute that carries a repo's `repoKey` (DD-5). Twins: `REPO_ATTR_KEY` in
// hook/.claude/telemetry_tool/otel-receiver.js and user-state.js.
export const REPO_ATTR_KEY = 'artisyn.repo';

// The env key whose value the repo tag rides in.
export const OTEL_RESOURCE_ATTRIBUTES_KEY = 'OTEL_RESOURCE_ATTRIBUTES';

// Parse an `OTEL_RESOURCE_ATTRIBUTES` value (`k=v,k2=v2`) into `[key, entry]` pairs, dropping empty
// and key-less items. The entry is kept verbatim (trimmed) so values are never re-encoded.
function parseResourceAttributes(value: unknown): Array<[string, string]> {
  if (typeof value !== 'string') return [];
  const out: Array<[string, string]> = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    out.push([entry.slice(0, eq).trim(), entry]);
  }
  return out;
}

// The `.claude/settings.local.json` `OTEL_RESOURCE_ATTRIBUTES` value (DD-23): the user-scope value
// (if any), then the existing local value, then `artisyn.repo=<repoKey>`, comma-joined and deduped
// by attribute key. A local value replaces the user value in Claude Code, so the user's attributes
// are carried over; on a key clash the local entry wins over the user one, and any earlier
// `artisyn.repo` entry (a moved repo) is replaced by this repo's tag.
export function buildResourceAttributes(userValue: unknown, localValue: unknown, repoKey: string): string {
  const merged = new Map<string, string>();
  for (const [key, entry] of [...parseResourceAttributes(userValue), ...parseResourceAttributes(localValue)]) {
    if (key === REPO_ATTR_KEY) continue;
    merged.set(key, entry);
  }
  merged.set(REPO_ATTR_KEY, `${REPO_ATTR_KEY}=${repoKey}`);
  return [...merged.values()].join(',');
}
