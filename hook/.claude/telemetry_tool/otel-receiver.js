#!/usr/bin/env node
'use strict';
/**
 * Claude Code Hook helper — loopback OTLP/JSON receiver (not a hook entry point itself).
 *
 * Spawned detached (see spawn-hidden.js) by `lifecycle-hook.js` on `SessionStart` and re-armed by
 * `telemetry-hook.js` on `UserPromptSubmit`. It binds `127.0.0.1:<port>` — loopback only, so no
 * firewall prompt — and accepts the OTLP/HTTP JSON traffic Claude Code exports when the
 * `CLAUDE_CODE_ENABLE_TELEMETRY` env block is installed:
 *
 *   POST /v1/logs           OTLP/JSON ExportLogsServiceRequest
 *   POST /v1/metrics        OTLP/JSON ExportMetricsServiceRequest
 *   POST /v1/traces         OTLP/JSON ExportTraceServiceRequest (hook 2.29.0+, `signal:"spans"` lines)
 *   POST /artisyn/register  the hook announcing itself (owner check)
 *
 * Records are demultiplexed by their `session.id` attribute and written as NDJSON to
 * `<otelDir>/<session-id>/<epochMs>-<seq>.jsonl` (see writeBatch for why the session id is a
 * directory), which `send-logs-hook.js` later uploads as `type=otel`. Every line carries the
 * receiver's `hookVersion` (hook 2.29.0+; an older server ignores the field).
 *
 * **Realtime channel** (hook 2.29.0+, see the "realtime channel" section): after a chunk is written,
 * its `logs` and `spans` lines are also queued in memory and POSTed to the Log Hub server's
 * `/api/v2/otel-realtime` at most once per `otelRealtimeIntervalMs` per session. It is best-effort
 * only — a realtime failure never touches the chunk files, which stay the durable copy.
 *
 * Invocation (every parameter is available as **both** argv and env — argv first, env fallback,
 * kept for hooks <= 2.5.1, which pass env only):
 *
 *   node otel-receiver.js --dir <path> --owner <json>
 *                        [--port <n>] [--idleTimeoutMs <n>] [--maxBodyBytes <n>]
 *
 *   ARTISYN_OTEL_DIR / ARTISYN_OTEL_OWNER_JSON / ARTISYN_OTEL_PORT /
 *   ARTISYN_OTEL_IDLE_TIMEOUT_MS / ARTISYN_OTEL_MAX_BODY_BYTES
 *
 * `--dir` and `--owner` are required and have no defaults on purpose: the project directory is
 * the unit, so a receiver with no directory and no owner is meaningless — it logs and exits 1
 * rather than guessing.
 *
 * **Shared mode** (hook 2.30.0+, DD-7): one receiver per OS user, serving every repo of that user:
 *
 *   node otel-receiver.js --shared --owner-home <home> --state-dir <dir> --port <n>
 *                        --idle-timeout-ms <ms> --max-body-bytes <n>
 *
 *   ARTISYN_OTEL_SHARED=1 / ARTISYN_OTEL_OWNER_HOME / ARTISYN_OTEL_STATE_DIR (+ the env above)
 *
 * `--shared` together with `--owner` or `--dir` exits 2. Shared mode reads `<stateDir>/token` at
 * start (no token ⇒ one receiver.log line and exit 0), serves `POST /artisyn/hello` (DD-9 HMAC
 * handshake), accepts `register`/`session-status`/`shutdown` only with a valid `x-artisyn-auth`
 * header, keeps the session registry in `<stateDir>/registry.json` and logs to
 * `<stateDir>/receiver.log`. Each record is routed on its own (DD-18): to its session's registered
 * repo, else to the repo its `artisyn.repo` resource tag names in `<stateDir>/repos.json`, else into
 * an in-memory pending spool that is re-routed when the session registers. Uploads (the sweep) and
 * the realtime channel run per repo (DD-19), with the registered uploader and realtime target.
 * When `<stateDir>/forward.json` says `mode:'proxy'`, each OTLP request of a listed signal is also
 * queued before routing and re-sent to that signal's upstream URL (DD-20), bounded and retried.
 *
 * Deliberate constraints:
 *   - **Node built-ins only** (`http`, `https`, `fs`, `path`, `zlib`, `os`, `crypto`,
 *     `child_process`) and **no
 *     `require` of any other hook module**: `env-context.js` and `hook-log.js` both resolve a git root from a cwd, and this
 *     process has no meaningful cwd (it is detached and long-lived). Everything it needs is
 *     passed in. Diagnostics therefore go to `<otelDir>/receiver.log`, not `hook.log`.
 *   - One receiver per project directory. A second instance for the same project fails to bind
 *     and exits 0 — the first one already serves every session of that project.
 *   - It self-exits after `idleTimeoutMs` without a request of any kind, so a closed editor never
 *     leaves a listener behind.
 *   - It runs with a neutral working directory (`os.tmpdir()`): the launcher passes it as the spawn
 *     cwd and `main()` also `chdir`s there first, so this long-lived process never pins the project
 *     folder (on Windows a directory that is some process's cwd cannot be deleted or renamed).
 *   - **Telemetry tail upload.** The hook uploads chunks only when a hook event fires, so whatever
 *     arrives after the last one would sit on disk until the next session. Every
 *     `SWEEP_INTERVAL_MS` (and once more right before the idle exit), when no request has arrived
 *     for `SWEEP_QUIET_MS` and a `<otelDir>/<session>/<chunk>.jsonl` is pending, it spawns
 *     `send-logs-hook.js --otel-sweep --cwd <owner gitRoot>` detached — by path, not by `require`,
 *     so the module constraint above still holds.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

// Mirrors `OTEL_FALLBACK_PORT` in env-context.js — the two files cannot require each other
// (see the module constraint above), so this value is duplicated deliberately and pinned by a
// test. The installer normally allocates a random per-project port; this applies only when it
// never did.
const DEFAULT_PORT = 25317;

// No request of any kind for this long ⇒ exit. Mirrors `otelReceiverIdleTimeoutMs`'s default.
const DEFAULT_IDLE_TIMEOUT_MS = 600000;

// Wire bytes, before decompression. Mirrors `otelReceiverMaxBodyKb`'s default (8192 KiB); the
// spawning hook does the KiB→bytes conversion, so this side is always in bytes.
const DEFAULT_MAX_BODY_BYTES = 8388608;

// `receiver.log` is truncated to empty once it grows past this. It is a diagnostics file with no
// consumer that needs history, and the receiver cannot read a project config to make it tunable.
const RECEIVER_LOG_MAX_BYTES = 1048576;

// Telemetry tail upload (see the header): how often the sweep check runs, and how long the
// receiver must have been quiet before a tick spawns the uploader. Quiet-only, so a sweep never
// races the chunks of an active export burst.
const SWEEP_INTERVAL_MS = 60000;
const SWEEP_QUIET_MS = 60000;

// The uploader the sweep launches — a sibling of this file both in the dev tree and in the shipped
// plugin's `scripts/` directory. Spawned by path; never `require`d.
const UPLOADER_SCRIPT = 'send-logs-hook.js';

// `session.id` becomes a filename, so this allow-list is the sole path-traversal defence:
// absolute paths (`/etc/…`, `C:\…`), separators, encoded traversal (`..%2f`) and over-length ids
// are all rejected by construction rather than by blacklisting.
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

// The OTLP attribute that identifies the Claude Code session. Verified against a real capture
// (see the task's notes.md): Claude Code puts it on the **record / datapoint** level, not on the
// resource — the resource carries only host/os/service attributes.
const SESSION_ID_ATTR = 'session.id';

// The OTLP routes served, plus the hook's own announce endpoint. Anything else is a 404.
const OTLP_LOGS_PATH = '/v1/logs';
const OTLP_METRICS_PATH = '/v1/metrics';
const OTLP_TRACES_PATH = '/v1/traces';
const REGISTER_PATH = '/artisyn/register';
const SHUTDOWN_PATH = '/artisyn/shutdown';
const KNOWN_PATHS = [OTLP_LOGS_PATH, OTLP_METRICS_PATH, OTLP_TRACES_PATH, REGISTER_PATH, SHUTDOWN_PATH];
// Shared mode only (DD-9): the unauthenticated handshake. A legacy receiver answers it 404.
const HELLO_PATH = '/artisyn/hello';
// Shared mode only (DD-11): the authenticated per-session counters the hook's otel-status reads.
const SESSION_STATUS_PATH = '/artisyn/session-status';
const SHARED_KNOWN_PATHS = [...KNOWN_PATHS, HELLO_PATH, SESSION_STATUS_PATH];
// The header every authenticated shared-mode route requires: `v1 <serverNonce> <hmac>` (DD-9).
const AUTH_HEADER = 'x-artisyn-auth';
const AUTH_SCHEME = 'v1';

// ---- shared mode (hook 2.30.0+, DD-32). JS/TS twins repeat a value with a comment naming the twin.

// Fixed idle timeout of the shared launch (DD-8). Twin: `SHARED_IDLE_TIMEOUT_MS` in otel-register.js
// and otel-ensure-receiver.js.
const SHARED_IDLE_TIMEOUT_MS = 600000;
// The register contract version (DD-10). Twin: `REGISTER_CONTRACT` in otel-register.js.
const REGISTER_CONTRACT = 1;
// What a shared receiver can do, answered by hello and register (DD-10).
const CAPABILITIES = ['shared', 'auth-v1', 'spans', 'realtime', 'forward', 'session-status'];
// Hello server nonces: single-use, this long, at most this many outstanding (oldest evicted).
const NONCE_TTL_MS = 30000;
const NONCE_MAX = 256;
// A registry entry expires this long after its `lastSeenAt`; the file is persisted with this debounce.
const REGISTRY_TTL_MS = 86400000;
const REGISTRY_PERSIST_DEBOUNCE_MS = 5000;
// The pending spool for records of unregistered sessions (DD-18).
const PENDING_TTL_MS = 300000;
const PENDING_MAX_RECORDS = 5000;
// Upstream forwarding (DD-20), per signal.
const FORWARD_QUEUE_MAX_REQUESTS = 1000;
const FORWARD_QUEUE_MAX_BYTES = 33554432;
const FORWARD_BACKOFF_MIN_MS = 1000;
const FORWARD_BACKOFF_MAX_MS = 60000;
const FORWARD_MAX_ATTEMPTS = 6;
const FORWARD_DEGRADED_WINDOW_MS = 300000;
// The OTEL resource attribute carrying the repoKey (DD-5). Twins: `REPO_ATTR_KEY` in user-state.js
// and otel-env.ts.
const REPO_ATTR_KEY = 'artisyn.repo';

// State files under `--state-dir` (DD-4).
const STATE_TOKEN_FILE = 'token';
const STATE_REGISTRY_FILE = 'registry.json';
const STATE_LOG_FILE = 'receiver.log';
const REGISTRY_FILE_VERSION = 1;
// Same shape as `TOKEN_RE` in user-state.js: 64 lowercase hex chars.
const TOKEN_RE = /^[0-9a-f]{64}$/;
const CLIENT_NONCE_RE = /^[0-9a-f]{32}$/;
const SERVER_NONCE_RE = /^[0-9a-f]{32}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const REPO_KEY_RE = /^[0-9a-f]{16}$/;
// The only uploader a register may name (DD-10): the hook's own sweep entry point.
const SHARED_UPLOADER_NAME = 'send-logs-hook.js';
// The plugin root under the owner's home a registered uploader may live in, besides the git root.
const PLUGINS_DIR_SEGMENTS = ['.claude', 'plugins'];
// Exit code for a contradictory invocation (`--shared` with `--owner`/`--dir`, DD-7).
const EXIT_USAGE = 2;

// Realtime channel (DD-13). The server route, and the limits that keep one batch under the shared
// 1 MiB hook body limit and the receiver's memory bounded. A line or a batch that does not fit is
// never lost: every line is also in a chunk file, which the regular upload ships.
const RT_ROUTE = '/api/v2/otel-realtime';
// Floor and default of `otelRealtimeIntervalMs`; the server's `minIntervalMs` can only raise it.
const RT_MIN_INTERVAL_MS = 5000;
const RT_REQUEST_TIMEOUT_MS = 5000;
// Uncompressed bytes of the `lines` of one batch; the rest waits for the next send.
const RT_MAX_BATCH_BYTES = 786432;
// One line over this is never sent in realtime — counted in `droppedLines`, it arrives by chunk.
const RT_MAX_LINE_BYTES = 262144;
// Queued lines over all sessions of this receiver; on overflow the oldest are dropped and counted.
const RT_BUFFER_MAX_LINES = 2000;
// A body over this is gzipped.
const RT_GZIP_MIN_BYTES = 8192;
// Backoff after a 5xx, timeout or network error: min(RT_BACKOFF_BASE_MS·2^failures, RT_BACKOFF_MAX_MS).
const RT_BACKOFF_BASE_MS = 5000;
const RT_BACKOFF_MAX_MS = 60000;
// 404 (old server), 401 or 403 stop realtime for this long, or until a config file's mtime changes.
const RT_DISABLE_MS = 3600000;
// The bound on the final send on idle exit.
const RT_SHUTDOWN_FLUSH_MS = 2000;
// The server's `minIntervalMs` is honoured up to this value, so a bogus answer cannot stall the channel.
const RT_SERVER_INTERVAL_CAP_MS = 3600000;
// The OTLP signals the realtime channel carries; `metrics` stay chunk-only.
const RT_SIGNALS = ['logs', 'spans'];

// The only body encoding this receiver accepts, checked before the body is read. The installer
// writes `OTEL_EXPORTER_OTLP_COMPRESSION=none`, but gzip/deflate stay supported so a user who
// overrides it is not silently dropped.
const SUPPORTED_ENCODINGS = ['gzip', 'deflate'];

// An OTLP metric carries its datapoints in exactly one of these containers. All five are walked
// so that a payload using an unexpected one is not silently dropped.
const METRIC_CONTAINERS = ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary'];

// Attribute value fields in OTLP/JSON, in the order they are resolved. Note that
// `intValue` arrives as a real JSON number and can legitimately be `0` (`event.sequence`), so
// presence — not truthiness — decides.
const ATTR_VALUE_FIELDS = ['stringValue', 'intValue', 'boolValue', 'doubleValue'];

// argv flag → parsed field name. Unknown flags are ignored rather than rejected, so a newer hook
// can pass a parameter an older receiver does not understand without breaking it.
const ARGV_FLAGS = {
  '--port': 'port',
  '--idleTimeoutMs': 'idleTimeoutMs',
  '--maxBodyBytes': 'maxBodyBytes',
  '--dir': 'dir',
  '--owner': 'owner',
  // Shared launch (DD-7), kebab-case spelling.
  '--idle-timeout-ms': 'idleTimeoutMs',
  '--max-body-bytes': 'maxBodyBytes',
  '--owner-home': 'ownerHome',
  '--state-dir': 'stateDir',
};

// Value-less argv switches → parsed field name.
const ARGV_SWITCHES = {
  '--shared': 'shared',
};

const ENV_FALLBACKS = {
  port: 'ARTISYN_OTEL_PORT',
  idleTimeoutMs: 'ARTISYN_OTEL_IDLE_TIMEOUT_MS',
  maxBodyBytes: 'ARTISYN_OTEL_MAX_BODY_BYTES',
  dir: 'ARTISYN_OTEL_DIR',
  owner: 'ARTISYN_OTEL_OWNER_JSON',
  shared: 'ARTISYN_OTEL_SHARED',
  ownerHome: 'ARTISYN_OTEL_OWNER_HOME',
  stateDir: 'ARTISYN_OTEL_STATE_DIR',
};

// ---------------------------------------------------------------------------
// argv/env parsing
// ---------------------------------------------------------------------------

/**
 * Parse a positive-integer parameter, falling back to `fallback` for anything absent, blank,
 * non-numeric, non-integer, zero, negative or out of range. There is no error path: a malformed
 * parameter must never stop the receiver from starting.
 * @param {*} value
 * @param {number} fallback
 * @param {number} [max]
 * @returns {number}
 */
function parsePositiveInt(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return fallback;
  if (max !== undefined && num > max) return fallback;
  return num;
}

/**
 * Parse the owner payload `{"gitRoot":"…","repo":"…"}`. `gitRoot` is the project identity used by
 * the `/artisyn/register` owner check; `repo` is carried only to make the mismatch warning
 * readable. Anything unparseable or lacking a `gitRoot` yields `null`, which the startup path
 * treats as "no owner" and exits 1 on.
 * @param {*} raw
 * @returns {{ gitRoot: string, repo: string }|null}
 */
function parseOwner(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const gitRoot = typeof parsed.gitRoot === 'string' ? parsed.gitRoot.trim() : '';
  if (!gitRoot) return null;
  const repo = typeof parsed.repo === 'string' ? parsed.repo.trim() : '';
  return { gitRoot, repo };
}

/**
 * Parse the five receiver parameters, argv first with an env fallback for each — mirroring
 * `prompt-upload-hook.js`'s `parseArgs`, and required for the same reason (the Windows hidden
 * launch path carries no argv).
 *
 * `dir` and `owner` come back `null` when absent; the caller logs and exits 1 rather than
 * guessing a project.
 *
 * Shared mode (DD-7): `shared` is set by the `--shared` switch or `ARTISYN_OTEL_SHARED=1|true`;
 * `ownerHome`/`stateDir` come back `null` when absent. `conflict` is true when `shared` is combined
 * with `--owner` or `--dir` (argv or env) — the caller exits 2.
 * @param {string[]} argv - typically `process.argv.slice(2)`
 * @param {Record<string, *>} env - typically `process.env`
 * @returns {{ port: number, idleTimeoutMs: number, maxBodyBytes: number, dir: string|null,
 *   owner: { gitRoot: string, repo: string }|null, shared: boolean, ownerHome: string|null,
 *   stateDir: string|null, conflict: boolean }}
 */
function parseArgs(argv, env) {
  const source = env || {};
  const raw = {};
  const list = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < list.length; i++) {
    const switchField = ARGV_SWITCHES[list[i]];
    if (switchField) {
      raw[switchField] = '1';
      continue;
    }
    const field = ARGV_FLAGS[list[i]];
    if (field && i + 1 < list.length) {
      raw[field] = list[i + 1];
      i++;
    }
  }

  const pick = (field) => (raw[field] !== undefined ? raw[field] : source[ENV_FALLBACKS[field]]);
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

  const dir = text(pick('dir'));
  const ownerRaw = text(pick('owner'));
  const sharedRaw = pick('shared');
  const shared = sharedRaw === '1' || (typeof sharedRaw === 'string' && sharedRaw.trim().toLowerCase() === 'true');

  return {
    port: parsePositiveInt(pick('port'), DEFAULT_PORT, 65535),
    idleTimeoutMs: parsePositiveInt(pick('idleTimeoutMs'), DEFAULT_IDLE_TIMEOUT_MS),
    maxBodyBytes: parsePositiveInt(pick('maxBodyBytes'), DEFAULT_MAX_BODY_BYTES),
    dir,
    owner: parseOwner(ownerRaw),
    shared,
    ownerHome: text(pick('ownerHome')),
    stateDir: text(pick('stateDir')),
    conflict: shared && (dir !== null || ownerRaw !== null),
  };
}

/**
 * A `session.id` is usable as a filename only when it matches the allow-list — this is the only
 * path-traversal defence and is applied both in the OTLP walkers and in the register handler.
 * @param {*} value
 * @returns {boolean}
 */
function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

// ---------------------------------------------------------------------------
// OTLP/JSON attribute helpers
// ---------------------------------------------------------------------------

/**
 * Read one OTLP/JSON attribute. Attributes are `[{key, value:{stringValue|intValue|…}}]`, and
 * 64-bit ints are encoded as strings while smaller ones arrive as JSON numbers — so every value is
 * normalised to a `String`.
 *
 * The first entry matching `key` wins; a value with none of the four recognised fields yields
 * `null` (an `arrayValue`/`kvlistValue` is not usable as a session id or a flat resource value).
 * @param {*} attributes - the OTLP attribute array, or anything at all
 * @param {string} key
 * @returns {string|null}
 */
function attrValue(attributes, key) {
  if (!Array.isArray(attributes)) return null;
  for (const entry of attributes) {
    if (!entry || typeof entry !== 'object' || entry.key !== key) continue;
    const value = entry.value;
    if (!value || typeof value !== 'object') return null;
    for (const field of ATTR_VALUE_FIELDS) {
      // Presence, not truthiness: `{"intValue": 0}` and `{"boolValue": false}` are real values.
      if (value[field] !== undefined && value[field] !== null) return String(value[field]);
    }
    return null;
  }
  return null;
}

/**
 * Flatten an OTLP attribute array into `{key: value}` so an output line is self-contained without
 * repeating the OTLP envelope. First occurrence of a key wins; unreadable values are skipped.
 * @param {*} attributes
 * @returns {Record<string, string>}
 */
function flattenAttributes(attributes) {
  const flat = {};
  if (!Array.isArray(attributes)) return flat;
  for (const entry of attributes) {
    if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string') continue;
    if (flat[entry.key] !== undefined) continue;
    const value = attrValue([entry], entry.key);
    if (value !== null) flat[entry.key] = value;
  }
  return flat;
}

/**
 * Normalise an OTLP instrumentation scope down to the two fields the output line carries.
 * @param {*} scope
 * @returns {{ name: string, version: string }}
 */
function normalizeScope(scope) {
  const source = scope && typeof scope === 'object' ? scope : {};
  return {
    name: typeof source.name === 'string' ? source.name : '',
    version: typeof source.version === 'string' ? source.version : '',
  };
}

/**
 * Resolve the session a record belongs to: record/datapoint level first, resource level second.
 * The record level is the one Claude Code actually populates (verified against a real capture);
 * the resource fallback is kept in case a future version promotes the attribute.
 * @param {*} recordAttributes
 * @param {*} resourceAttributes
 * @returns {string|null} a *validated* session id, or null when it is missing or unusable
 */
function resolveSessionId(recordAttributes, resourceAttributes) {
  const found = attrValue(recordAttributes, SESSION_ID_ATTR) ?? attrValue(resourceAttributes, SESSION_ID_ATTR);
  return isValidSessionId(found) ? found : null;
}

/**
 * Append one serialised NDJSON line to its session's group.
 * @param {Map<string, string[]>} groups
 * @param {string} sessionId
 * @param {*} line
 */
function pushLine(groups, sessionId, line) {
  const existing = groups.get(sessionId);
  const serialised = `${JSON.stringify(line)}\n`;
  if (existing) existing.push(serialised);
  else groups.set(sessionId, [serialised]);
}

/**
 * @typedef {object} CollectedRecord
 * @property {string|null} sessionId  the validated session id, or null when it does not resolve
 * @property {string|null} repoAttr   the resource attribute `artisyn.repo` (DD-18 tag routing), or null
 * @property {'logs'|'metrics'|'spans'} signal
 * @property {Record<string, *>} line the chunk line, not yet stamped with any version
 */

/**
 * Collect every log record of an `ExportLogsServiceRequest` as one unstamped `signal:"logs"` line,
 * with its session id (null when unresolvable) and its `artisyn.repo` tag. `invalid` counts the
 * entries that are not records at all.
 *
 * Every level is defensively typed: this is unauthenticated input.
 * @param {*} payload
 * @param {string} receivedAt - ISO receive time; never substituted for the record's own timestamps
 * @returns {{ records: CollectedRecord[], invalid: number }}
 */
function collectLogs(payload, receivedAt) {
  const records = [];
  let invalid = 0;

  const resourceLogs = payload && Array.isArray(payload.resourceLogs) ? payload.resourceLogs : [];
  for (const resourceEntry of resourceLogs) {
    if (!resourceEntry || typeof resourceEntry !== 'object') continue;
    const resourceAttributes = resourceEntry.resource ? resourceEntry.resource.attributes : null;
    const resource = flattenAttributes(resourceAttributes);
    const repoAttr = attrValue(resourceAttributes, REPO_ATTR_KEY);
    const scopeLogs = Array.isArray(resourceEntry.scopeLogs) ? resourceEntry.scopeLogs : [];

    for (const scopeEntry of scopeLogs) {
      if (!scopeEntry || typeof scopeEntry !== 'object') continue;
      const scope = normalizeScope(scopeEntry.scope);
      const logRecords = Array.isArray(scopeEntry.logRecords) ? scopeEntry.logRecords : [];

      for (const record of logRecords) {
        if (!record || typeof record !== 'object') {
          invalid++;
          continue;
        }
        records.push({
          sessionId: resolveSessionId(record.attributes, resourceAttributes),
          repoAttr,
          signal: 'logs',
          line: { signal: 'logs', receivedAt, resource, scope, record },
        });
      }
    }
  }

  return { records, invalid };
}

/**
 * Collect every datapoint of an `ExportMetricsServiceRequest` as one unstamped `signal:"metrics"`
 * line. A metric carries its datapoints in exactly one of `METRIC_CONTAINERS`; all five are checked,
 * and the container name is carried through as the line's `metric.type`.
 * @param {*} payload
 * @param {string} receivedAt
 * @returns {{ records: CollectedRecord[], invalid: number }}
 */
function collectMetrics(payload, receivedAt) {
  const records = [];
  let invalid = 0;

  const resourceMetrics = payload && Array.isArray(payload.resourceMetrics) ? payload.resourceMetrics : [];
  for (const resourceEntry of resourceMetrics) {
    if (!resourceEntry || typeof resourceEntry !== 'object') continue;
    const resourceAttributes = resourceEntry.resource ? resourceEntry.resource.attributes : null;
    const resource = flattenAttributes(resourceAttributes);
    const repoAttr = attrValue(resourceAttributes, REPO_ATTR_KEY);
    const scopeMetrics = Array.isArray(resourceEntry.scopeMetrics) ? resourceEntry.scopeMetrics : [];

    for (const scopeEntry of scopeMetrics) {
      if (!scopeEntry || typeof scopeEntry !== 'object') continue;
      const scope = normalizeScope(scopeEntry.scope);
      const metrics = Array.isArray(scopeEntry.metrics) ? scopeEntry.metrics : [];

      for (const metric of metrics) {
        if (!metric || typeof metric !== 'object') {
          invalid++;
          continue;
        }
        for (const container of METRIC_CONTAINERS) {
          const holder = metric[container];
          if (!holder || typeof holder !== 'object') continue;
          const dataPoints = Array.isArray(holder.dataPoints) ? holder.dataPoints : [];

          const envelope = {
            name: typeof metric.name === 'string' ? metric.name : '',
            unit: typeof metric.unit === 'string' ? metric.unit : '',
            description: typeof metric.description === 'string' ? metric.description : '',
            type: container,
          };

          for (const dataPoint of dataPoints) {
            if (!dataPoint || typeof dataPoint !== 'object') {
              invalid++;
              continue;
            }
            records.push({
              sessionId: resolveSessionId(dataPoint.attributes, resourceAttributes),
              repoAttr,
              signal: 'metrics',
              line: { signal: 'metrics', receivedAt, resource, scope, metric: envelope, dataPoint },
            });
          }
        }
      }
    }
  }

  return { records, invalid };
}

/**
 * Collect every span of an `ExportTraceServiceRequest` as one unstamped `signal:"spans"` line — the
 * same shape as `collectLogs`, with the raw OTLP span as `record`. Claude Code puts `session.id` on
 * the span attributes; the resource fallback is kept as for logs.
 * @param {*} payload
 * @param {string} receivedAt
 * @returns {{ records: CollectedRecord[], invalid: number }}
 */
function collectSpans(payload, receivedAt) {
  const records = [];
  let invalid = 0;

  const resourceSpans = payload && Array.isArray(payload.resourceSpans) ? payload.resourceSpans : [];
  for (const resourceEntry of resourceSpans) {
    if (!resourceEntry || typeof resourceEntry !== 'object') continue;
    const resourceAttributes = resourceEntry.resource ? resourceEntry.resource.attributes : null;
    const resource = flattenAttributes(resourceAttributes);
    const repoAttr = attrValue(resourceAttributes, REPO_ATTR_KEY);
    const scopeSpans = Array.isArray(resourceEntry.scopeSpans) ? resourceEntry.scopeSpans : [];

    for (const scopeEntry of scopeSpans) {
      if (!scopeEntry || typeof scopeEntry !== 'object') continue;
      const scope = normalizeScope(scopeEntry.scope);
      const spans = Array.isArray(scopeEntry.spans) ? scopeEntry.spans : [];

      for (const record of spans) {
        if (!record || typeof record !== 'object') {
          invalid++;
          continue;
        }
        records.push({
          sessionId: resolveSessionId(record.attributes, resourceAttributes),
          repoAttr,
          signal: 'spans',
          line: { signal: 'spans', receivedAt, resource, scope, record },
        });
      }
    }
  }

  return { records, invalid };
}

/**
 * Collect the records of one OTLP request by its chunk-line signal.
 * @param {'logs'|'metrics'|'spans'} signal
 * @param {*} payload
 * @param {string} receivedAt
 * @returns {{ records: CollectedRecord[], invalid: number }}
 */
function collectSignal(signal, payload, receivedAt) {
  if (signal === 'metrics') return collectMetrics(payload, receivedAt);
  if (signal === 'spans') return collectSpans(payload, receivedAt);
  return collectLogs(payload, receivedAt);
}

/**
 * The legacy (per-project) grouping of collected records: one NDJSON line per record with a resolved
 * session id, grouped by that id. Records whose session id does not resolve are counted and dropped —
 * never written to a shared "unknown" file, since a line must belong to exactly one session.
 * @param {{ records: CollectedRecord[], invalid: number }} collected
 * @param {string|null} [hookVersion]
 * @returns {{ groups: Map<string, string[]>, kept: number, dropped: number }}
 */
function groupCollected(collected, hookVersion) {
  const groups = new Map();
  let kept = 0;
  let dropped = collected.invalid;
  for (const item of collected.records) {
    if (!item.sessionId) {
      dropped++;
      continue;
    }
    pushLine(groups, item.sessionId, withHookVersion(item.line, hookVersion));
    kept++;
  }
  return { groups, kept, dropped };
}

/**
 * Walk an `ExportLogsServiceRequest`, producing one `signal:"logs"` line per log record grouped by
 * session id (legacy mode; shared mode routes `collectLogs` records instead, see `routeRecord`).
 * @param {*} payload
 * @param {string} receivedAt
 * @param {string|null} [hookVersion] - stamped on every line when given (hook 2.29.0+)
 * @returns {{ groups: Map<string, string[]>, kept: number, dropped: number }}
 */
function walkLogs(payload, receivedAt, hookVersion) {
  return groupCollected(collectLogs(payload, receivedAt), hookVersion);
}

/**
 * Walk an `ExportMetricsServiceRequest`, producing one `signal:"metrics"` line per datapoint.
 * @param {*} payload
 * @param {string} receivedAt
 * @param {string|null} [hookVersion] - stamped on every line when given (hook 2.29.0+)
 * @returns {{ groups: Map<string, string[]>, kept: number, dropped: number }}
 */
function walkMetrics(payload, receivedAt, hookVersion) {
  return groupCollected(collectMetrics(payload, receivedAt), hookVersion);
}

/**
 * Walk an `ExportTraceServiceRequest`, producing one `signal:"spans"` line per span.
 * @param {*} payload
 * @param {string} receivedAt
 * @param {string|null} [hookVersion] - stamped on every line when given
 * @returns {{ groups: Map<string, string[]>, kept: number, dropped: number }}
 */
function walkSpans(payload, receivedAt, hookVersion) {
  return groupCollected(collectSpans(payload, receivedAt), hookVersion);
}

/**
 * Stamp a chunk line with `hookVersion` and, in shared mode, `receiverVersion` (DD-19). Each field is
 * absent (not null) when unknown, so a line of a receiver without a readable `version.json` looks
 * exactly like a pre-2.29.0 line, and a legacy line stays byte-identical to hook 2.29.0.
 *
 * Legacy mode stamps the receiver's own version as `hookVersion` and no `receiverVersion`; shared mode
 * stamps the registering hook's `hookVersion` (the `repos.json` one for a tag-routed repo) plus the
 * receiver's own version as `receiverVersion`.
 * @param {Record<string, *>} line
 * @param {*} hookVersion
 * @param {*} [receiverVersion]
 * @returns {Record<string, *>}
 */
function withHookVersion(line, hookVersion, receiverVersion) {
  if (typeof hookVersion === 'string' && hookVersion) line.hookVersion = hookVersion;
  if (typeof receiverVersion === 'string' && receiverVersion) line.receiverVersion = receiverVersion;
  return line;
}

// Monotonic counter making two chunks written inside the same millisecond distinct. Process-local
// is sufficient: one receiver owns the project directory, so nothing else writes these names.
let chunkSeq = 0;

/**
 * Write each session's group as its OWN chunk file — one inbound OTLP request produces one file
 * per session it carries, never an append to a shared file.
 *
 * Layout is `<otelDir>/<sessionId>/<epochMs>-<seq>.jsonl`. The session id is a directory rather
 * than a filename prefix because session ids are UUIDs containing hyphens, so packing both into
 * one name could not be parsed back apart unambiguously by the uploader. As a side effect,
 * lexicographic filename order equals write order, which is the order the uploader ships in.
 *
 * Each chunk is written to a `.tmp` sibling and then `renameSync`d into place. Rename within one
 * directory is atomic, so the uploader — which only ever picks up `.jsonl` — cannot observe a
 * half-written chunk. That removes the trailing-partial-line hazard of the appending design
 * outright rather than compensating for it on the reader side. A process killed mid-write leaves
 * only an inert `.tmp`, which the prune sweeps.
 *
 * Session ids are already validated against the allow-list by the walkers, which is what makes
 * `path.join` safe here.
 * The target names the repo the groups belong to: in legacy mode the receiver's own project, in
 * shared mode the repo `routeRecord` resolved (DD-18). The `dir-gone` check is per target, so a
 * deleted repo never stops the other repos of a shared receiver (AC-A5).
 * @param {Map<string, string[]>} groups
 * @param {{ otelDir: string, gitRoot: string, hookVersion?: string|null }} target
 * @returns {{ sessions: number, failed: number, written: string[], dirGone: boolean }} `written` = the
 *   session ids whose chunk landed on disk
 */
function writeGroups(groups, target) {
  let sessions = 0;
  let failed = 0;
  const written = [];
  const otelDir = target && typeof target.otelDir === 'string' ? target.otelDir : '';
  // The repo's otel directory vanished under a running receiver (the project folder was deleted or
  // moved). Recreating it recursively would resurrect a ghost project tree, so the groups are dropped
  // instead; the idle timer still retires this receiver once traffic stops. Shared mode logs its own
  // `dir-gone repo=<repoKey>` line (once per repo) in the caller, without the path.
  if (!otelDir || !fs.existsSync(otelDir)) {
    if (!runtime.shared) {
      let lineCount = 0;
      for (const lines of groups.values()) lineCount += lines.length;
      receiverLog('dir-gone',
        `otel directory ${otelDir} no longer exists — dropped ${groups.size} session group(s), ${lineCount} line(s)`);
    }
    return { sessions: 0, failed: groups.size, written, dirGone: true };
  }
  const stamp = Date.now();
  for (const [sessionId, lines] of groups) {
    const sessionDir = path.join(otelDir, sessionId);
    const base = `${stamp}-${String(chunkSeq++).padStart(6, '0')}`;
    const tempPath = path.join(sessionDir, `${base}.tmp`);
    const target = path.join(sessionDir, `${base}.jsonl`);
    try {
      // Non-recursive on purpose: only the session level may be created here, never a missing
      // parent (that is the dir-gone case above, or a race with it).
      try {
        fs.mkdirSync(sessionDir);
      } catch (mkdirErr) {
        if (!mkdirErr || mkdirErr.code !== 'EEXIST') throw mkdirErr;
      }
      fs.writeFileSync(tempPath, lines.join(''), 'utf8');
      fs.renameSync(tempPath, target);
      sessions++;
      written.push(sessionId);
    } catch (err) {
      failed++;
      receiverLog('write-error', `cannot write ${lines.length} line(s) to ${target}: ${err && err.message ? err.message : String(err)}`);
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // best effort — a stray .tmp is inert and the prune sweeps it
      }
    }
  }
  return { sessions, failed, written, dirGone: false };
}

// ---------------------------------------------------------------------------
// receiver version — the version.json sibling of __dirname
// ---------------------------------------------------------------------------

let versionCache;

/**
 * Read this receiver's version from the `version.json` beside it — present both in the dev tree and
 * in the shipped plugin tree, where the build writes `scripts/version.json` alongside every hook
 * script. Reported to the hook by `/artisyn/register` so it can warn about a stale receiver.
 * @returns {string|null}
 */
function getReceiverVersion() {
  if (versionCache !== undefined) return versionCache;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8');
    const parsed = JSON.parse(raw);
    versionCache = typeof parsed.version === 'string' && parsed.version ? parsed.version : null;
  } catch {
    versionCache = null;
  }
  return versionCache;
}

/**
 * Normalise a git root for comparison: absolute, no trailing separator, and case-insensitive on
 * Windows, where the same checkout is reachable as `D:\repo` and `d:/repo`.
 * @param {*} value
 * @returns {string}
 */
function normalizeGitRoot(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let resolved;
  try {
    resolved = path.resolve(value.trim());
  } catch {
    resolved = value.trim();
  }
  resolved = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The path form `repoKey`/`ownerHash` hash: resolved, forward slashes, no trailing slash (except a
 * bare root), lowercased on win32. Twin of `normalizeForKey` in `user-state.js` (also copied into
 * `otel-ensure-receiver.js`) — duplicated because this file must not `require` any hook module.
 * @param {string} value
 * @param {string} [platform]
 * @returns {string}
 */
function normalizeForKey(value, platform = process.platform) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let resolved = impl.resolve(String(value)).replace(/\\/g, '/');
  if (resolved.length > 1 && !/^[A-Za-z]:\/$/.test(resolved)) resolved = resolved.replace(/\/+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * First 16 hex chars of sha256(normalized git root) — the `artisyn.repo` resource attribute value
 * (DD-5). Twin of `repoKey` in `user-state.js`; keep identical.
 * @param {string} gitRoot
 * @param {string} [platform]
 * @returns {string}
 */
function repoKey(gitRoot, platform = process.platform) {
  return crypto.createHash('sha256').update(normalizeForKey(gitRoot, platform)).digest('hex').slice(0, 16);
}

/**
 * sha256 hex of the normalized home dir — the hello `ownerHash` (DD-9). Twin of `ownerHash` in
 * `user-state.js` and `otel-ensure-receiver.js`; keep identical.
 * @param {string} home
 * @param {string} [platform]
 * @returns {string}
 */
function ownerHash(home, platform = process.platform) {
  return crypto.createHash('sha256').update(normalizeForKey(home, platform)).digest('hex');
}

// ---------------------------------------------------------------------------
// runtime state
// ---------------------------------------------------------------------------

// Populated by `main()`. Kept at module scope so the request handler and the diagnostics appender
// do not have to thread it through every call.
const runtime = {
  otelDir: null,
  logFilePath: null,
  port: DEFAULT_PORT,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  owner: null,
  // Epoch ms of the most recent request on any route; a sweep tick fires only once this is
  // `SWEEP_QUIET_MS` in the past.
  lastRequestAt: Date.now(),
  // Shared mode (DD-7): the per-user receiver. `ownerHome` is never logged — only `ownerHash`.
  shared: false,
  ownerHome: null,
  ownerHash: null,
  stateDir: null,
  token: null,
};

let idleTimer = null;
let sweepTimer = null;

// ---------------------------------------------------------------------------
// diagnostics — <otelDir>/receiver.log
// ---------------------------------------------------------------------------

/**
 * Append one `<ISO> <event> <message>` line to `<otelDir>/receiver.log`, truncating the file to
 * empty once it grows past `RECEIVER_LOG_MAX_BYTES`. Named `receiver.log`, not `.jsonl`, so the
 * uploader's `listJsonlFiles` never picks it up; one receiver per directory, so no per-port
 * suffix is needed.
 *
 * Never throws: diagnostics must not be able to take the receiver down. Before the directory is
 * resolved (and if the append itself fails) the line goes to stderr instead, which the detached
 * launch discards but a foreground run shows.
 * @param {string} event
 * @param {string} message
 */
function receiverLog(event, message) {
  const line = formatLogLine(event, message);

  if (!runtime.logFilePath) {
    try {
      process.stderr.write(line);
    } catch {
      // stderr may be closed on the detached launch path — nothing else to try
    }
    return;
  }

  if (!appendLogLine(runtime.logFilePath, line)) {
    try {
      process.stderr.write(line);
    } catch {
      // best effort only
    }
  }
}

/**
 * One `<ISO> <event> <message>` line, the message flattened to a single line.
 * @param {string} event
 * @param {*} message
 * @returns {string}
 */
function formatLogLine(event, message) {
  const flat = String(message === undefined || message === null ? '' : message)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();
  return `${new Date().toISOString()} ${event} ${flat}\n`;
}

/**
 * The event name of the last line in `receiver.log`, or `null` when there is none or it cannot be
 * read. Reads only the file's tail.
 * @returns {string|null}
 */
function lastLogEvent() {
  if (!runtime.logFilePath) return null;
  let fd = null;
  try {
    fd = fs.openSync(runtime.logFilePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    return last ? last.split(' ')[1] || null : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Append one line to a log file, truncating it to empty once it is past `RECEIVER_LOG_MAX_BYTES`.
 * @param {string} file
 * @param {string} line
 * @returns {boolean} whether the append succeeded
 */
function appendLogLine(file, line) {
  try {
    try {
      const stat = fs.statSync(file);
      if (stat.size >= RECEIVER_LOG_MAX_BYTES) fs.writeFileSync(file, '', 'utf8');
    } catch {
      // not created yet — the append below creates it
    }
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared mode (DD-19): write one line to the shared `<stateDir>/receiver.log` and mirror the same
 * line into the target repo's `<otelDir>/receiver.log` — today's per-repo path, so a user looking at
 * one repo sees its slice of the traffic. The mirror never creates a missing `otelDir`. Never throws.
 * @param {string} otelDir
 * @param {string} event
 * @param {string} message
 */
function receiverLogMirrored(otelDir, event, message) {
  receiverLog(event, message);
  if (!otelDir) return;
  try {
    if (!fs.statSync(otelDir).isDirectory()) return;
  } catch {
    return;
  }
  appendLogLine(path.join(otelDir, 'receiver.log'), formatLogLine(event, message));
}

/**
 * Report a fatal startup problem to both `receiver.log` (when the directory is already known) and
 * stderr, then exit 1.
 * @param {string} message
 */
function exitStartupFailure(message) {
  receiverLog('fatal', message);
  if (runtime.logFilePath) {
    try {
      process.stderr.write(`otel-receiver: ${message}\n`);
    } catch {
      // best effort only
    }
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// idle timer
// ---------------------------------------------------------------------------

/**
 * (Re-)arm the idle timer. Called at the *start* of every request on any route, including
 * rejected ones — any traffic at all means the session is still alive.
 *
 * Deliberately **not** `unref()`'d: it is what keeps this detached process in the event loop
 * between requests, and the whole point is that it eventually fires.
 */
function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Shared mode: persist the session registry before anything else (a no-op in legacy mode).
    flushRegistry();
    // One last tail upload, so chunks written after the session's final hook event do not wait for
    // the next session. The uploader is detached and unref()'d, so exiting right after is safe.
    if (runtime.shared) sweepSharedRepos('idle-exit', true);
    else if (hasPendingChunks(runtime.otelDir)) spawnOtelSweep('idle-exit');
    else receiverLog('sweep-skip', 'idle-exit: no pending otel chunks');
    // Shared mode: the DD-19 idle-exit line (counts since start), plus the spool counters.
    if (runtime.shared) {
      prunePendingSpool(Date.now());
      receiverLog('idle-exit',
        `idleMs=${runtime.idleTimeoutMs} ingests=${shared.ingests} sessions=${registry.size} ` +
        `pending=${pendingSpool.records.length} pendingExpired=${pendingSpool.expired} ` +
        `pendingOverflow=${pendingSpool.overflow} droppedSignal=${shared.droppedSignal}`);
      if (shared.ingests === 0) {
        // The receiver was up for a whole idle period and no Claude Code process sent it anything —
        // the usual cause is OTEL env that Claude Code does not apply.
        receiverLog('no-data',
          `no OTLP request since start on 127.0.0.1:${runtime.port} — Claude Code is not exporting here. ` +
          'Check: the OTEL env is in ~/.claude/settings.json (Claude Code 2.1.282+ ignores it in a project\'s ' +
          '.claude/settings*.json), it points at this port, managed settings do not disable telemetry; ' +
          'then restart Claude Code');
      }
      logForwardSummary();
    }
    // One final realtime send for whatever is still queued, bounded by RT_SHUTDOWN_FLUSH_MS; the
    // chunk files cover anything it does not get through.
    if (hasQueuedRealtime()) {
      if (!runtime.shared) receiverLog('idle-exit', `no request for ${runtime.idleTimeoutMs}ms — final realtime send, then exiting`);
      flushRealtime(RT_SHUTDOWN_FLUSH_MS).then(() => process.exit(0), () => process.exit(0));
      return;
    }
    if (!runtime.shared) receiverLog('idle-exit', `no request for ${runtime.idleTimeoutMs}ms — exiting`);
    process.exit(0);
  }, runtime.idleTimeoutMs);
}

// ---------------------------------------------------------------------------
// telemetry tail upload — the periodic sweep
// ---------------------------------------------------------------------------

/**
 * Whether any finished chunk (`<otelDir>/<session>/*.jsonl`) is waiting to be uploaded. `.tmp`
 * files are in-flight writes and do not count. Never throws.
 * @param {string|null} otelDir
 * @returns {boolean}
 */
function hasPendingChunks(otelDir) {
  if (!otelDir) return false;
  let entries;
  try {
    entries = fs.readdirSync(otelDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(path.join(otelDir, entry.name));
    } catch {
      continue;
    }
    if (files.some((name) => name.endsWith('.jsonl'))) return true;
  }
  return false;
}

/**
 * Legacy mode: launch this receiver's sibling `send-logs-hook.js --otel-sweep --cwd <owner gitRoot>`.
 * @param {string} reason - `tick` or `idle-exit`, for receiver.log
 */
function spawnOtelSweep(reason) {
  if (!runtime.owner || !runtime.owner.gitRoot) {
    receiverLog('sweep-skip', `${reason}: no owner gitRoot`);
    return;
  }
  spawnUploader(reason, path.join(__dirname, UPLOADER_SCRIPT), runtime.owner.gitRoot, '');
}

/**
 * Launch `<script> --otel-sweep --cwd <gitRoot>` as a detached, hidden, unref()'d Node process with a
 * neutral cwd. Fire-and-forget: the uploader takes the hook lock itself and simply exits when it is
 * busy, so the next tick retries. Never throws.
 * @param {string} reason - `tick` or `idle-exit`, for receiver.log
 * @param {string} script - the uploader's absolute path
 * @param {string} gitRoot
 * @param {string} label - `repo=<repoKey> ` in shared mode, empty in legacy mode
 */
function spawnUploader(reason, script, gitRoot, label) {
  if (!fs.existsSync(script)) {
    receiverLog('sweep-skip', `${label}${reason}: uploader ${runtime.shared ? UPLOADER_SCRIPT : script} not found`);
    return;
  }
  try {
    const child = childProcess.spawn(process.execPath, [script, '--otel-sweep', '--cwd', gitRoot], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: os.tmpdir(),
    });
    child.on('error', (err) => {
      receiverLog('sweep-error', `${label}${reason}: spawn of ${UPLOADER_SCRIPT} failed: ${err && err.message ? err.message : String(err)}`);
    });
    child.unref();
    receiverLog('sweep-spawn', `${label}${reason}: launched ${UPLOADER_SCRIPT} --otel-sweep pid=${child.pid}`);
  } catch (err) {
    receiverLog('sweep-error', `${label}${reason}: spawn of ${UPLOADER_SCRIPT} failed: ${err && err.message ? err.message : String(err)}`);
  }
}

/**
 * @typedef {object} SweepRepo
 * @property {string} gitRoot
 * @property {string} otelDir
 * @property {string} repoKey
 * @property {string|null} uploader  the latest registered uploader; null for a tag-routed repo
 * @property {number} lastWriteAt    epoch ms of the last chunk written for this repo
 */

/**
 * Shared mode (DD-19): one quiet-timer per `gitRoot` with routed data, keyed by `normalizeGitRoot`.
 * @type {Map<string, SweepRepo>}
 */
const sweepRepos = new Map();

/**
 * Note a chunk write for a repo, so its quiet-timer restarts. A registered uploader replaces the
 * remembered one; a tag-routed write (no uploader) keeps it.
 * @param {RouteTarget} target
 * @param {number} now
 */
function noteRepoWrite(target, now) {
  const key = normalizeGitRoot(target.gitRoot);
  const existing = sweepRepos.get(key);
  sweepRepos.set(key, {
    gitRoot: target.gitRoot,
    otelDir: target.otelDir,
    repoKey: target.repoKey,
    uploader: target.uploader || (existing ? existing.uploader : null),
    lastWriteAt: now,
  });
}

/**
 * The uploader a repo's sweep spawns (DD-19): the registered one, else the `repos.json` one of a
 * tag-routed repo. Both are re-checked with `isAllowedUploader`, so nothing but the hook's own
 * `send-logs-hook.js` under the repo or the plugins dir is ever spawned. Null when there is none.
 * @param {SweepRepo} repo
 * @returns {string|null}
 */
function resolveSweepUploader(repo) {
  const candidates = [repo.uploader];
  const listed = findRepoByKey(readReposCached(), repo.repoKey);
  if (listed) candidates.push(listed.uploader);
  for (const candidate of candidates) {
    if (candidate && isAllowedUploader(candidate, repo.gitRoot, runtime.ownerHome)) return candidate;
  }
  return null;
}

/**
 * Shared mode: spawn each repo's uploader whose repo has been quiet for `SWEEP_QUIET_MS` (or every
 * repo, on idle exit) and has a pending chunk. A repo whose `otelDir` is gone is retired: its sweep
 * and realtime timers stop (AC-A5).
 * @param {string} reason
 * @param {boolean} ignoreQuiet
 */
function sweepSharedRepos(reason, ignoreQuiet) {
  const now = Date.now();
  let withChunks = 0;
  for (const [key, repo] of sweepRepos) {
    if (!ignoreQuiet && now - repo.lastWriteAt < SWEEP_QUIET_MS) continue;
    if (!fs.existsSync(repo.otelDir)) {
      retireRepo(key, repo.repoKey);
      continue;
    }
    if (!hasPendingChunks(repo.otelDir)) continue;
    withChunks++;
    const uploader = resolveSweepUploader(repo);
    if (!uploader) {
      receiverLog('sweep-skip', `repo=${repo.repoKey} ${reason}: no registered or listed uploader`);
      continue;
    }
    spawnUploader(reason, uploader, repo.gitRoot, `repo=${repo.repoKey} `);
  }
  if (ignoreQuiet && withChunks === 0) receiverLog('sweep-skip', `${reason}: no pending otel chunks`);
}

/**
 * One sweep tick: spawn the uploader once the receiver (legacy) or the repo (shared) has been quiet
 * for `SWEEP_QUIET_MS` and a chunk is pending. Silent when there is nothing to do, so receiver.log
 * is not written once a minute. Shared mode also expires the pending spool here.
 */
function sweepTick() {
  if (runtime.shared) {
    prunePendingSpool(Date.now());
    sweepSharedRepos('tick', false);
    return;
  }
  if (Date.now() - runtime.lastRequestAt < SWEEP_QUIET_MS) return;
  if (!hasPendingChunks(runtime.otelDir)) return;
  spawnOtelSweep('tick');
}

/**
 * Start the periodic sweep. `unref()`'d: the idle timer, not this interval, decides how long the
 * receiver lives.
 */
function startSweepTimer() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(sweepTick, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

// ---------------------------------------------------------------------------
// realtime channel (hook 2.29.0+, DD-13; per repo since hook 2.30.0, DD-19)
//
// After each chunk write the same `logs`/`spans` lines go into an in-memory per-session queue. A
// per-session timer sends at most one batch every `max(otelRealtimeIntervalMs, serverMinIntervalMs)`
// to `POST <serverUrl>/api/v2/otel-realtime`, with at most one request in flight per channel.
// Best-effort only: the queue is memory, a failure never touches a chunk file, and anything not
// sent arrives later through the regular chunk upload.
//
// A channel holds the queues, timers, backoff and auto-disable of one target. Legacy mode has one
// channel (key `''`) whose target comes from the project config files (`readRealtimeTarget`). Shared
// mode keys a channel by `normalizeGitRoot(gitRoot)` and takes its target from the latest
// registration of that repo (DD-19); `RT_BUFFER_MAX_LINES` applies per channel.
// ---------------------------------------------------------------------------

// The two config files the target is read from, under `<gitRoot>/.artisyn/config/` — the same pair
// and the same "local wins, null means absent" shallow merge as env-context.js's `loadConfig`,
// re-implemented here because this file may not require hook modules. Legacy mode only.
const RT_CONFIG_DIR_SEGMENTS = ['.artisyn', 'config'];
const RT_CONFIG_FILES = ['log-hub.json', 'log-hub.local.json'];

const rt = {
  // A random id per receiver process: a restart is a new receiver with an empty buffer.
  receiverId: crypto.randomBytes(12).toString('hex'),
  /** @type {Map<string, RealtimeChannel>} */
  channels: new Map(),
  // Global insertion counter: tells which session holds the oldest queued line on overflow.
  entrySeq: 0,
  // Set during the final send on idle exit, so a timer cannot start a second request.
  flushing: false,
};

/**
 * @typedef {object} RealtimeTarget
 * @property {string} serverUrl
 * @property {string} apiKey
 * @property {boolean} enabled
 * @property {number} intervalMs
 * @property {string} signature  changes when the target changes (ends an auto-disable early)
 *
 * @typedef {object} RealtimeEntry
 * @property {string} text  the serialized chunk line, without its newline
 * @property {number} bytes UTF-8 size of `text`
 * @property {number} n     position in `rt.entrySeq`
 *
 * @typedef {object} RealtimeSession
 * @property {string} id
 * @property {RealtimeEntry[]} queue
 * @property {number} dropped    lines not sent in realtime since the last accepted batch
 * @property {number} batchSeq   the highest batchSeq used for this session
 * @property {number|null} retrySeq the batchSeq a requeued batch must reuse
 * @property {ReturnType<typeof setTimeout>|null} timer
 * @property {number} lastSendAt
 * @property {boolean} stopped   409 (foreign session) or a deleted session: no more realtime
 * @property {boolean} halved    the next batch uses half the byte limit (after one 413)
 *
 * @typedef {object} RealtimeChannel
 * @property {string} key           `''` in legacy mode, `normalizeGitRoot(gitRoot)` in shared mode
 * @property {string} label         `''` in legacy mode, `repo=<repoKey> ` in shared mode (log prefix)
 * @property {() => RealtimeTarget} resolveTarget
 * @property {string|null} hookVersion the batch head's `hookVersion` (shared: the latest registration's)
 * @property {Map<string, RealtimeSession>} sessions
 * @property {number} queuedLines   lines queued over this channel's sessions (in-flight excluded)
 * @property {Promise<void>|null} inFlight
 * @property {string[]} ready       session ids whose timer fired while a request was in flight
 * @property {number} failures      consecutive 5xx/timeout/network failures
 * @property {number} backoffUntil
 * @property {number} serverMinIntervalMs the latest `minIntervalMs` the server answered (0 = none)
 * @property {number} disabledUntil 404/401/403 or a bad URL stop realtime until this time
 * @property {string|null} lastSignature
 * @property {boolean} failureLogged whether the current failure streak has been logged
 */

/**
 * Backoff before the next realtime send after `failures` consecutive 5xx / timeout / network
 * errors: `min(RT_BACKOFF_BASE_MS · 2^failures, RT_BACKOFF_MAX_MS)`. Pure. A success resets the
 * failure count to 0.
 * @param {number} failures
 * @returns {number} milliseconds
 */
function nextRealtimeDelay(failures) {
  const n = typeof failures === 'number' && Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
  // 2^30 is far past the cap already; bounding the exponent keeps the arithmetic finite.
  return Math.min(RT_BACKOFF_BASE_MS * 2 ** Math.min(n, 30), RT_BACKOFF_MAX_MS);
}

/**
 * `otelRealtimeIntervalMs` clamped to at least `RT_MIN_INTERVAL_MS`; absent, `0` or invalid ⇒ the
 * floor (the documented default).
 * @param {*} value
 * @returns {number}
 */
function clampRealtimeInterval(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return RT_MIN_INTERVAL_MS;
  return Math.max(Math.floor(value), RT_MIN_INTERVAL_MS);
}

/**
 * A JSON config file as a plain object; absent, unreadable, malformed or non-object ⇒ `{}`.
 * @param {string} file
 * @returns {Record<string, *>}
 */
function readConfigObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The mtime+size signature of the config files (`-` for an absent one).
 * @param {string[]} files
 * @returns {string}
 */
function configSignature(files) {
  return files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return '-';
    }
  }).join('|');
}

let rtTargetCache = null;

/**
 * Legacy mode only (DD-19): where and whether to send realtime batches, from the project's
 * `.artisyn/config/log-hub.json` and `log-hub.local.json` under `gitRoot` (never `cwd`: this process
 * `chdir`s to `os.tmpdir()`). Shallow merge, local wins, a local `null` falls through — as
 * env-context.js's `loadConfig`. The files are re-read only when their mtime/size signature changes.
 * A shared receiver never reads repo files: its target comes with the registration.
 * @param {string} gitRoot
 * @returns {RealtimeTarget}
 */
function readRealtimeTarget(gitRoot) {
  const root = typeof gitRoot === 'string' ? gitRoot.trim() : '';
  if (!root) return { serverUrl: '', apiKey: '', enabled: false, intervalMs: RT_MIN_INTERVAL_MS, signature: '' };
  const files = RT_CONFIG_FILES.map((name) => path.join(root, ...RT_CONFIG_DIR_SEGMENTS, name));
  const signature = configSignature(files);
  if (rtTargetCache && rtTargetCache.root === root && rtTargetCache.signature === signature) {
    return rtTargetCache.target;
  }

  const merged = { ...readConfigObject(files[0]) };
  for (const [key, value] of Object.entries(readConfigObject(files[1]))) {
    if (value !== null) merged[key] = value;
  }
  const target = {
    serverUrl: typeof merged.serverUrl === 'string' ? merged.serverUrl.trim().replace(/\/+$/, '') : '',
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey.trim() : '',
    enabled: merged.otelRealtime !== false,
    intervalMs: clampRealtimeInterval(merged.otelRealtimeIntervalMs),
    signature,
  };
  rtTargetCache = { root, signature, target };
  return target;
}

/**
 * Shared mode: the latest registration's realtime target and hook version per repo channel key.
 * @type {Map<string, { realtime: { enabled: boolean, serverUrl: string, apiKey: string, intervalMs: number }|null, hookVersion: string|null }>}
 */
const sharedRealtimeTargets = new Map();

/**
 * Remember the realtime target of a registry-routed repo (DD-19). Called on register and on every
 * registry-routed write, so a registry loaded from disk has a target too. A tag-routed repo has no
 * registration, so it has no realtime (its chunks still upload).
 * @param {RouteTarget} target
 */
function setSharedRealtimeTarget(target) {
  if (!target || target.via !== 'registry') return;
  const key = normalizeGitRoot(target.gitRoot);
  sharedRealtimeTargets.set(key, { realtime: target.realtime || null, hookVersion: target.hookVersion || null });
  const channel = rt.channels.get(key);
  if (channel) channel.hookVersion = target.hookVersion || null;
}

/**
 * A shared channel's target, from the latest registration. The signature covers every field (the
 * key only as a hash), so a re-register with a fixed URL or key ends an auto-disable early.
 * @param {string} key
 * @returns {RealtimeTarget}
 */
function sharedRealtimeTarget(key) {
  const known = sharedRealtimeTargets.get(key);
  const realtime = known ? known.realtime : null;
  if (!realtime) return { serverUrl: '', apiKey: '', enabled: false, intervalMs: RT_MIN_INTERVAL_MS, signature: '' };
  const keyHash = crypto.createHash('sha256').update(realtime.apiKey).digest('hex').slice(0, 12);
  return {
    serverUrl: realtime.serverUrl,
    apiKey: realtime.apiKey,
    enabled: realtime.enabled,
    intervalMs: realtime.intervalMs,
    signature: `${realtime.enabled}|${realtime.serverUrl}|${realtime.intervalMs}|${keyHash}`,
  };
}

/**
 * The channel for a key, created on first use.
 * @param {string} key
 * @param {string} label
 * @param {() => RealtimeTarget} resolveTarget
 * @returns {RealtimeChannel}
 */
function realtimeChannel(key, label, resolveTarget) {
  let channel = rt.channels.get(key);
  if (!channel) {
    channel = {
      key,
      label,
      resolveTarget,
      hookVersion: null,
      sessions: new Map(),
      queuedLines: 0,
      inFlight: null,
      ready: [],
      failures: 0,
      backoffUntil: 0,
      serverMinIntervalMs: 0,
      disabledUntil: 0,
      lastSignature: null,
      failureLogged: false,
    };
    rt.channels.set(key, channel);
  }
  return channel;
}

/**
 * The legacy receiver's single channel: the owner project's config files.
 * @returns {RealtimeChannel}
 */
function legacyRealtimeChannel() {
  return realtimeChannel('', '', () => readRealtimeTarget(runtime.owner ? runtime.owner.gitRoot : ''));
}

/**
 * A shared receiver's channel for one repo (DD-19).
 * @param {RouteTarget} target
 * @returns {RealtimeChannel}
 */
function sharedRealtimeChannel(target) {
  const key = normalizeGitRoot(target.gitRoot);
  const channel = realtimeChannel(key, `repo=${target.repoKey} `, () => sharedRealtimeTarget(key));
  const known = sharedRealtimeTargets.get(key);
  if (known) channel.hookVersion = known.hookVersion;
  return channel;
}

/**
 * Stop and forget a shared repo's channel: its timers are cleared and queued lines dropped (they are
 * in the chunk files, or the repo is gone). Used when the repo's `otelDir` disappears (AC-A5).
 * @param {string} key
 */
function retireRealtimeChannel(key) {
  const channel = rt.channels.get(key);
  if (!channel) return;
  for (const session of channel.sessions.values()) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    session.queue = [];
  }
  channel.queuedLines = 0;
  channel.ready = [];
  rt.channels.delete(key);
}

/**
 * The current target of a channel. A target change (new signature) ends an auto-disable early, so
 * fixing the server URL or the key takes effect without a restart.
 * @param {RealtimeChannel} channel
 * @returns {RealtimeTarget}
 */
function currentRealtimeTarget(channel) {
  const target = channel.resolveTarget();
  if (channel.lastSignature !== null && target.signature !== channel.lastSignature && channel.disabledUntil > 0) {
    channel.disabledUntil = 0;
    channel.failures = 0;
    channel.backoffUntil = 0;
    receiverLog('rt-enable', `${channel.label}${runtime.shared ? 'registration changed' : 'project config changed'} — realtime channel re-enabled`);
  }
  channel.lastSignature = target.signature;
  return target;
}

/**
 * @param {RealtimeTarget} target
 * @returns {boolean}
 */
function realtimeUsable(target) {
  return target.enabled && !!target.serverUrl && !!target.apiKey;
}

/**
 * @param {RealtimeChannel} channel
 * @returns {boolean}
 */
function realtimeDisabled(channel) {
  return channel.disabledUntil > Date.now();
}

/**
 * The state of one session in a channel, created on first use.
 * @param {RealtimeChannel} channel
 * @param {string} sessionId
 * @returns {RealtimeSession}
 */
function realtimeSession(channel, sessionId) {
  let session = channel.sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      queue: [],
      dropped: 0,
      batchSeq: 0,
      retrySeq: null,
      timer: null,
      // The first batch of a session waits one interval, so the logs and spans of Claude Code's
      // first export travel together.
      lastSendAt: Date.now(),
      stopped: false,
      halved: false,
    };
    channel.sessions.set(sessionId, session);
  }
  return session;
}

/**
 * Drop a session's queued lines, counting them in `droppedLines` (they are still in the chunks).
 * @param {RealtimeChannel} channel
 * @param {RealtimeSession} session
 */
function discardRealtimeQueue(channel, session) {
  session.dropped += session.queue.length;
  channel.queuedLines -= session.queue.length;
  session.queue = [];
}

/**
 * Enforce `RT_BUFFER_MAX_LINES` over a channel's sessions by dropping the oldest queued lines.
 * @param {RealtimeChannel} channel
 */
function trimRealtimeBuffer(channel) {
  let trimmed = 0;
  while (channel.queuedLines > RT_BUFFER_MAX_LINES) {
    let oldest = null;
    for (const session of channel.sessions.values()) {
      if (session.queue.length && (!oldest || session.queue[0].n < oldest.queue[0].n)) oldest = session;
    }
    if (!oldest) {
      channel.queuedLines = 0;
      break;
    }
    oldest.queue.shift();
    oldest.dropped++;
    channel.queuedLines--;
    trimmed++;
  }
  if (trimmed > 0) {
    receiverLog('rt-overflow', `${channel.label}realtime buffer over ${RT_BUFFER_MAX_LINES} lines — dropped the oldest ${trimmed} (still in the chunk files)`);
  }
}

/**
 * Queue the serialized `logs`/`spans` lines of one session's freshly written chunk. A no-op when
 * realtime is off or not configured; while it is auto-disabled the lines are only counted as
 * dropped, so the server can flag the gap once the channel is back.
 * @param {RealtimeChannel} channel
 * @param {string} sessionId
 * @param {string[]} serializedLines - the NDJSON lines as written to the chunk (newline-terminated)
 */
function enqueueRealtime(channel, sessionId, serializedLines) {
  if (!Array.isArray(serializedLines) || serializedLines.length === 0) return;
  const target = currentRealtimeTarget(channel);
  if (!realtimeUsable(target)) return;
  const session = realtimeSession(channel, sessionId);
  if (session.stopped) return;
  if (realtimeDisabled(channel)) {
    session.dropped += serializedLines.length;
    return;
  }
  for (const raw of serializedLines) {
    const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > RT_MAX_LINE_BYTES) {
      session.dropped++;
      continue;
    }
    session.queue.push({ text, bytes, n: rt.entrySeq++ });
    channel.queuedLines++;
  }
  trimRealtimeBuffer(channel);
  scheduleRealtime(channel, session, target);
}

/**
 * The effective send interval: the target's value, raised by the server's `minIntervalMs`.
 * @param {RealtimeChannel} channel
 * @param {RealtimeTarget} target
 * @returns {number}
 */
function realtimeIntervalMs(channel, target) {
  return Math.max(target.intervalMs, channel.serverMinIntervalMs);
}

/**
 * Arm the session's timer for its next send, unless one is armed or nothing is queued. The send is
 * due one interval after the previous one, and not before the backoff ends.
 * @param {RealtimeChannel} channel
 * @param {RealtimeSession} session
 * @param {RealtimeTarget} target
 */
function scheduleRealtime(channel, session, target) {
  if (session.timer || session.stopped || session.queue.length === 0) return;
  const now = Date.now();
  const due = Math.max(session.lastSendAt + realtimeIntervalMs(channel, target), channel.backoffUntil, now);
  session.timer = setTimeout(() => {
    session.timer = null;
    if (!channel.ready.includes(session.id)) channel.ready.push(session.id);
    pumpRealtime(channel);
  }, due - now);
  // The idle timer, not this one, decides how long the receiver lives.
  if (typeof session.timer.unref === 'function') session.timer.unref();
}

/**
 * Start the channel's next due send when no request of that channel is in flight.
 * @param {RealtimeChannel} channel
 */
function pumpRealtime(channel) {
  if (channel.inFlight || rt.flushing) return;
  // A retired channel (its repo is gone) sends nothing more.
  if (rt.channels.get(channel.key) !== channel) return;
  while (channel.ready.length) {
    const session = channel.sessions.get(channel.ready.shift());
    if (!session || session.stopped || session.queue.length === 0) continue;
    const target = currentRealtimeTarget(channel);
    if (!realtimeUsable(target) || realtimeDisabled(channel)) {
      discardRealtimeQueue(channel, session);
      continue;
    }
    if (Date.now() < channel.backoffUntil) {
      scheduleRealtime(channel, session, target);
      continue;
    }
    channel.inFlight = sendRealtimeBatch(channel, session, target, RT_REQUEST_TIMEOUT_MS)
      .catch((err) => {
        receiverLog('rt-error', `${channel.label}realtime send failed: ${err && err.message ? err.message : String(err)}`);
      })
      .then(() => {
        channel.inFlight = null;
        scheduleRealtime(channel, session, currentRealtimeTarget(channel));
        pumpRealtime(channel);
      });
    return;
  }
}

/**
 * Take the next batch off the front of a session's queue: whole lines, at most
 * `RT_MAX_BATCH_BYTES` (half of it after a 413) of `lines`, at least one line.
 * @param {RealtimeChannel} channel
 * @param {RealtimeSession} session
 * @returns {RealtimeEntry[]}
 */
function takeRealtimeBatch(channel, session) {
  const limit = session.halved ? Math.floor(RT_MAX_BATCH_BYTES / 2) : RT_MAX_BATCH_BYTES;
  const entries = [];
  let bytes = 0;
  while (session.queue.length) {
    const next = session.queue[0];
    const add = next.bytes + (entries.length ? 1 : 0); // + the comma between lines
    if (entries.length && bytes + add > limit) break;
    entries.push(session.queue.shift());
    channel.queuedLines--;
    bytes += add;
  }
  return entries;
}

/**
 * Send one batch of a session and apply the outcome. Never rejects.
 * Body: `{ sessionId, hookVersion, receiverId, batchSeq, droppedLines, lines }`; a requeued batch
 * reuses its `batchSeq`, which the server treats as a replay.
 * @param {RealtimeChannel} channel
 * @param {RealtimeSession} session
 * @param {RealtimeTarget} target
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function sendRealtimeBatch(channel, session, target, timeoutMs) {
  const entries = takeRealtimeBatch(channel, session);
  if (entries.length === 0) return Promise.resolve();
  const batchSeq = session.retrySeq !== null ? session.retrySeq : session.batchSeq + 1;
  session.batchSeq = Math.max(session.batchSeq, batchSeq);
  session.retrySeq = null;
  session.lastSendAt = Date.now();
  const reportedDropped = session.dropped;

  const head = JSON.stringify({
    sessionId: session.id,
    hookVersion: channel.hookVersion || getReceiverVersion() || 'unknown',
    receiverId: rt.receiverId,
    batchSeq,
    droppedLines: reportedDropped,
  });
  // The lines are already serialized: splice them in rather than parse and re-serialize them.
  const body = Buffer.from(`${head.slice(0, -1)},"lines":[${entries.map((e) => e.text).join(',')}]}`, 'utf8');

  return postRealtime(target, body, timeoutMs).then((result) => {
    applyRealtimeResult(channel, session, entries, batchSeq, reportedDropped, result);
  });
}

/**
 * Put a batch back at the front of its session's queue, to be resent with the same `batchSeq`.
 * @param {RealtimeChannel} channel
 * @param {RealtimeSession} session
 * @param {RealtimeEntry[]} entries
 * @param {number} batchSeq
 */
function requeueRealtimeBatch(channel, session, entries, batchSeq) {
  session.queue.unshift(...entries);
  channel.queuedLines += entries.length;
  session.retrySeq = batchSeq;
  trimRealtimeBuffer(channel);
}

/**
 * Stop realtime for one session (409 foreign session, or a deleted session).
 * @param {RealtimeChannel} channel
 * @param {RealtimeSession} session
 * @param {string} reason
 */
function stopRealtimeSession(channel, session, reason) {
  session.stopped = true;
  channel.queuedLines -= session.queue.length;
  session.queue = [];
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  receiverLog('rt-session-stop', `${channel.label}session ${session.id}: ${reason} — realtime stopped for this session`);
}

/**
 * Stop realtime for the whole channel for `RT_DISABLE_MS` (or until its target changes). Queued
 * lines are dropped and counted; they are in the chunk files.
 * @param {RealtimeChannel} channel
 * @param {string} reason
 */
function disableRealtime(channel, reason) {
  channel.disabledUntil = Date.now() + RT_DISABLE_MS;
  for (const session of channel.sessions.values()) discardRealtimeQueue(channel, session);
  receiverLog('rt-disable',
    `${channel.label}${reason} — realtime channel off for ${RT_DISABLE_MS}ms or until the ` +
    `${runtime.shared ? 'registration' : 'project config'} changes; chunk uploads continue`);
}

/**
 * Apply the server's answer to one batch (DD-13 status handling).
 * @param {RealtimeChannel} channel
 * @param {RealtimeSession} session
 * @param {RealtimeEntry[]} entries
 * @param {number} batchSeq
 * @param {number} reportedDropped - the `droppedLines` this batch carried
 * @param {{ status: number, body?: *, error?: string }} result
 */
function applyRealtimeResult(channel, session, entries, batchSeq, reportedDropped, result) {
  const status = result.status;
  const label = channel.label;

  if (status >= 200 && status < 300) {
    session.dropped = Math.max(0, session.dropped - reportedDropped);
    session.halved = false;
    if (channel.failureLogged) receiverLog('rt-recovered', `${label}realtime channel reachable again after ${channel.failures} failure(s)`);
    channel.failures = 0;
    channel.backoffUntil = 0;
    channel.failureLogged = false;
    const body = result.body && typeof result.body === 'object' ? result.body : {};
    if (typeof body.minIntervalMs === 'number' && Number.isFinite(body.minIntervalMs) && body.minIntervalMs > 0) {
      channel.serverMinIntervalMs = Math.min(body.minIntervalMs, RT_SERVER_INTERVAL_CAP_MS);
    }
    if (body.ignored === 'deleted') stopRealtimeSession(channel, session, 'the session is deleted on the server');
    return;
  }

  if (status === 404 || status === 401 || status === 403) {
    session.dropped += entries.length;
    session.retrySeq = batchSeq;
    disableRealtime(channel, status === 404
      ? 'server answered 404 (older Log Hub without the realtime route)'
      : `server answered ${status} (API key rejected)`);
    return;
  }

  if (status === 409) {
    stopRealtimeSession(channel, session, 'server answered 409 (the session belongs to another user)');
    return;
  }

  if (status === 413) {
    if (!session.halved) {
      session.halved = true;
      requeueRealtimeBatch(channel, session, entries, batchSeq);
      receiverLog('rt-too-large', `${label}session ${session.id}: batch of ${entries.length} line(s) answered 413 — retrying at half size`);
    } else {
      session.halved = false;
      session.dropped += entries.length;
      session.retrySeq = batchSeq;
      receiverLog('rt-too-large', `${label}session ${session.id}: half-size batch of ${entries.length} line(s) answered 413 — dropped (still in the chunk files)`);
    }
    return;
  }

  if (status === 0 && result.error === 'bad-url') {
    session.dropped += entries.length;
    session.retrySeq = batchSeq;
    disableRealtime(channel, 'serverUrl is not a valid URL');
    return;
  }

  if (status === 0 || status >= 500) {
    requeueRealtimeBatch(channel, session, entries, batchSeq);
    channel.backoffUntil = Date.now() + nextRealtimeDelay(channel.failures);
    channel.failures++;
    if (!channel.failureLogged) {
      channel.failureLogged = true;
      receiverLog('rt-fail', `${label}realtime send failed (${status === 0 ? result.error || 'network' : `HTTP ${status}`}) — retrying with backoff`);
    }
    return;
  }

  // Any other 4xx (400 malformed body, …): resending the same lines cannot help.
  session.dropped += entries.length;
  session.retrySeq = batchSeq;
  receiverLog('rt-rejected', `${label}session ${session.id}: batch of ${entries.length} line(s) answered ${status} — dropped (still in the chunk files)`);
}

/**
 * POST one realtime body, gzipped when over `RT_GZIP_MIN_BYTES`, with a hard overall timeout.
 * Resolves `{ status, body }` for any HTTP answer and `{ status: 0, error }` for a timeout, a
 * network error or an unusable URL. Never rejects.
 * @param {{ serverUrl: string, apiKey: string }} target
 * @param {Buffer} rawBody
 * @param {number} timeoutMs
 * @returns {Promise<{ status: number, body?: *, error?: string }>}
 */
function postRealtime(target, rawBody, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let url;
    try {
      url = new URL(`${target.serverUrl}${RT_ROUTE}`);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    } catch {
      done({ status: 0, error: 'bad-url' });
      return;
    }

    let payload = rawBody;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-Key': target.apiKey,
    };
    if (rawBody.length > RT_GZIP_MIN_BYTES) {
      try {
        payload = zlib.gzipSync(rawBody);
        headers['Content-Encoding'] = 'gzip';
      } catch {
        payload = rawBody;
      }
    }
    headers['Content-Length'] = String(payload.length);

    try {
      const isHttps = url.protocol === 'https:';
      const req = (isHttps ? https : http).request({
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          // The answer is a small JSON object; never buffer an unexpected large body.
          if (size < 65536) {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        res.on('error', () => done({ status: 0, error: 'network' }));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            parsed = null;
          }
          done({ status: res.statusCode || 0, body: parsed });
        });
      });
      timer = setTimeout(() => {
        done({ status: 0, error: 'timeout' });
        try {
          req.destroy();
        } catch {
          // already gone
        }
      }, Math.max(1, timeoutMs));
      req.on('error', (err) => done({ status: 0, error: err && err.code ? err.code : 'network' }));
      req.end(payload);
    } catch {
      done({ status: 0, error: 'network' });
    }
  });
}

/** @returns {boolean} whether any realtime line is still queued, in any channel */
function hasQueuedRealtime() {
  for (const channel of rt.channels.values()) {
    for (const session of channel.sessions.values()) {
      if (!session.stopped && session.queue.length) return true;
    }
  }
  return false;
}

/**
 * The final send on idle exit: per channel, waits for its in-flight request, then sends one batch per
 * session that still has lines, all within `boundMs`. Resolves when done or when the bound expires;
 * never rejects.
 * @param {number} boundMs
 * @returns {Promise<void>}
 */
function flushRealtime(boundMs) {
  rt.flushing = true;
  for (const channel of rt.channels.values()) {
    for (const session of channel.sessions.values()) {
      if (session.timer) {
        clearTimeout(session.timer);
        session.timer = null;
      }
    }
  }
  const deadline = Date.now() + boundMs;
  const run = async () => {
    for (const channel of rt.channels.values()) {
      if (channel.inFlight) await channel.inFlight;
      const target = currentRealtimeTarget(channel);
      if (!realtimeUsable(target) || realtimeDisabled(channel)) continue;
      for (const session of channel.sessions.values()) {
        if (session.stopped || session.queue.length === 0) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        await sendRealtimeBatch(channel, session, target, remaining);
        // This channel's server is unreachable: do not spend the rest of the bound on its sessions.
        if (channel.failures > 0) break;
      }
    }
  };
  return new Promise((resolve) => {
    const bound = setTimeout(resolve, boundMs);
    run().catch(() => {}).then(() => {
      clearTimeout(bound);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// shared mode — auth handshake (hook 2.30.0+, DD-9)
//
// The token in `<stateDir>/token` is a secret shared by the installer, the hooks and this receiver
// of one OS user. `POST /artisyn/hello` proves the receiver knows it (the hook checks `proof` before
// it sends anything secret) and issues a single-use server nonce; every authenticated route then
// carries `x-artisyn-auth: v1 <serverNonce> <HMAC(token, "cli\n"+serverNonce+"\n"+path+"\n"+sha256hex(rawBody))>`.
// ---------------------------------------------------------------------------

/**
 * `HMAC(token, "srv\n"+clientNonce+"\n"+serverNonce)` hex — the hello proof. Twin of
 * `computeHelloProof` in otel-ensure-receiver.js and otel-register.js; keep identical.
 * @param {string} token
 * @param {string} clientNonce
 * @param {string} serverNonce
 * @returns {string}
 */
function computeHelloProof(token, clientNonce, serverNonce) {
  return crypto.createHmac('sha256', token).update(`srv\n${clientNonce}\n${serverNonce}`).digest('hex');
}

/**
 * `HMAC(token, "cli\n"+serverNonce+"\n"+urlPath+"\n"+sha256hex(rawBody))` hex — the MAC of one
 * authenticated request. `urlPath` is the request path without query string or trailing slash.
 * @param {string} token
 * @param {string} serverNonce
 * @param {string} urlPath
 * @param {Buffer|string} rawBody - the wire bytes, exactly as sent
 * @returns {string}
 */
function computeAuthMac(token, serverNonce, urlPath, rawBody) {
  const bodyHash = crypto.createHash('sha256').update(rawBody === undefined || rawBody === null ? '' : rawBody).digest('hex');
  return crypto.createHmac('sha256', token).update(`cli\n${serverNonce}\n${urlPath}\n${bodyHash}`).digest('hex');
}

/**
 * Parse an `x-artisyn-auth` header value. Anything but `v1 <32-hex nonce> <64-hex mac>` ⇒ null.
 * @param {*} value
 * @returns {{ nonce: string, mac: string }|null}
 */
function parseAuthHeader(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3 || parts[0] !== AUTH_SCHEME) return null;
  const nonce = parts[1].toLowerCase();
  const mac = parts[2].toLowerCase();
  if (!SERVER_NONCE_RE.test(nonce) || !SHA256_HEX_RE.test(mac)) return null;
  return { nonce, mac };
}

/**
 * Constant-time comparison of two equal-format hex strings.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function hexEqual(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * The outstanding hello nonces: single-use, `ttlMs` each, at most `max` (the oldest is evicted).
 * `now` is injectable so the table tests need no clock.
 * @param {{ ttlMs?: number, max?: number, random?: () => string }} [opts]
 * @returns {{ issue: (now: number) => string, consume: (nonce: string, now: number) => boolean, size: () => number }}
 */
function createNonceStore(opts = {}) {
  const ttlMs = opts.ttlMs || NONCE_TTL_MS;
  const max = opts.max || NONCE_MAX;
  const random = opts.random || (() => crypto.randomBytes(16).toString('hex'));
  /** @type {Map<string, number>} nonce → expiresAt, in issue order */
  const outstanding = new Map();
  const prune = (now) => {
    for (const [nonce, expiresAt] of outstanding) {
      if (expiresAt <= now) outstanding.delete(nonce);
    }
  };
  return {
    issue(now) {
      prune(now);
      while (outstanding.size >= max) outstanding.delete(outstanding.keys().next().value);
      const nonce = random();
      outstanding.set(nonce, now + ttlMs);
      return nonce;
    },
    // A known nonce is used up by any attempt, valid MAC or not, so a nonce can never be probed twice.
    consume(nonce, now) {
      const expiresAt = outstanding.get(nonce);
      if (expiresAt === undefined) return false;
      outstanding.delete(nonce);
      return expiresAt > now;
    },
    size() {
      return outstanding.size;
    },
  };
}

const nonces = createNonceStore();

/**
 * Verify the `x-artisyn-auth` header of one shared-mode request against its raw body. A failure
 * logs one `auth-reject route=… reason=…` line (never the header value); the caller answers
 * `401 {error:'unauthorized'}` and does nothing else.
 * @param {import('http').IncomingMessage} req
 * @param {Buffer} rawBody - the wire bytes
 * @returns {boolean}
 */
function requireAuth(req, rawBody) {
  const route = requestPath(req);
  let reason = null;
  const parsed = parseAuthHeader(req.headers[AUTH_HEADER]);
  if (!runtime.token) reason = 'no-token';
  else if (!parsed) reason = req.headers[AUTH_HEADER] === undefined ? 'missing-header' : 'malformed-header';
  else if (!nonces.consume(parsed.nonce, Date.now())) reason = 'unknown-nonce';
  else if (!hexEqual(parsed.mac, computeAuthMac(runtime.token, parsed.nonce, route, rawBody))) reason = 'bad-mac';
  if (reason === null) return true;
  receiverLog('auth-reject', `route=${route} reason=${reason}`);
  return false;
}

/**
 * Read the shared token from `<stateDir>/token`; absent or malformed ⇒ null.
 * @param {string} stateDir
 * @returns {string|null}
 */
function readSharedToken(stateDir) {
  try {
    const value = fs.readFileSync(path.join(stateDir, STATE_TOKEN_FILE), 'utf8').trim();
    return TOKEN_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// shared mode — session registry (hook 2.30.0+, DD-10)
//
// sessionId → RegistryEntry. Persisted to `<stateDir>/registry.json` with a debounce, at idle-exit
// and on shutdown, and loaded at start, so a receiver restart keeps routing registered sessions.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RegistryEntry
 * @property {string} sessionId
 * @property {string} gitRoot
 * @property {string} otelDir
 * @property {string} hookVersion
 * @property {number} contract
 * @property {string} repoKey
 * @property {{ logs: boolean, metrics: boolean, spans: boolean }} signals
 * @property {string|null} uploader
 * @property {{ enabled: boolean, serverUrl: string, apiKey: string, intervalMs: number }|null} realtime
 * @property {string} registeredAt  ISO
 * @property {string} lastSeenAt    ISO — register and every routed record
 * @property {{ logs: number, metrics: number, spans: number }} received
 * @property {string|null} firstRecordAt ISO
 */

/** @type {Map<string, RegistryEntry>} */
const registry = new Map();
let registryPersistTimer = null;

/**
 * Whether an entry is still alive at `now`: `lastSeenAt` within `REGISTRY_TTL_MS`.
 * @param {*} entry
 * @param {number} now
 * @returns {boolean}
 */
function registryEntryAlive(entry, now) {
  if (!entry || typeof entry !== 'object') return false;
  const seen = Date.parse(entry.lastSeenAt);
  return Number.isFinite(seen) && now - seen < REGISTRY_TTL_MS;
}

/**
 * The live entries of a persisted `sessions` object: valid session id, matching key, the
 * required fields present, not expired. Pure.
 * @param {*} sessions - `registry.json` `sessions`
 * @param {number} now
 * @returns {Map<string, RegistryEntry>}
 */
function pruneRegistry(sessions, now) {
  const live = new Map();
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return live;
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (!isValidSessionId(sessionId) || !entry || typeof entry !== 'object') continue;
    if (entry.sessionId !== sessionId || typeof entry.gitRoot !== 'string' || typeof entry.otelDir !== 'string') continue;
    if (!registryEntryAlive(entry, now)) continue;
    live.set(sessionId, entry);
  }
  return live;
}

/**
 * Load `<stateDir>/registry.json` into the in-memory registry, dropping expired entries. A missing
 * or malformed file is an empty registry.
 */
function loadRegistry() {
  registry.clear();
  if (!runtime.stateDir) return;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(runtime.stateDir, STATE_REGISTRY_FILE), 'utf8'));
  } catch {
    parsed = null;
  }
  const sessions = parsed && typeof parsed === 'object' ? parsed.sessions : null;
  const total = sessions && typeof sessions === 'object' ? Object.keys(sessions).length : 0;
  for (const [sessionId, entry] of pruneRegistry(sessions, Date.now())) registry.set(sessionId, entry);
  if (total > 0) receiverLog('registry-load', `sessions=${registry.size} expired=${total - registry.size}`);
}

/**
 * Write the registry now (tmp + rename, mode 0o600), dropping expired entries first. Cancels a
 * pending debounced write. Never throws.
 */
function flushRegistry() {
  if (registryPersistTimer) {
    clearTimeout(registryPersistTimer);
    registryPersistTimer = null;
  }
  if (!runtime.shared || !runtime.stateDir) return;
  const now = Date.now();
  for (const [sessionId, entry] of registry) {
    if (!registryEntryAlive(entry, now)) registry.delete(sessionId);
  }
  const file = path.join(runtime.stateDir, STATE_REGISTRY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = { version: REGISTRY_FILE_VERSION, savedAt: new Date(now).toISOString(), sessions: Object.fromEntries(registry) };
  try {
    fs.writeFileSync(tmp, JSON.stringify(body), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    receiverLog('registry-error', `cannot persist ${STATE_REGISTRY_FILE}: ${err && err.message ? err.message : String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Persist the registry `REGISTRY_PERSIST_DEBOUNCE_MS` after the first change since the last write.
 * The timer is `unref()`'d: the idle timer decides the lifetime, and idle-exit flushes anyway.
 */
function scheduleRegistryPersist() {
  if (registryPersistTimer) return;
  registryPersistTimer = setTimeout(() => {
    registryPersistTimer = null;
    flushRegistry();
  }, REGISTRY_PERSIST_DEBOUNCE_MS);
  if (typeof registryPersistTimer.unref === 'function') registryPersistTimer.unref();
}

/**
 * Whether `child` is inside (or equal to) `parent`. Callers fold case on win32 first.
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isPathInside(child, parent) {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * `fs.realpathSync`, or null when the path does not exist.
 * @param {string} value
 * @returns {string|null}
 */
function realpathOrNull(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

/**
 * Whether a registered `uploader` may be spawned (DD-10): an absolute path to an existing file named
 * `send-logs-hook.js` whose realpath lies under the realpath of `gitRoot` or of
 * `<ownerHome>/.claude/plugins/`. Anything else could make this receiver run arbitrary code.
 * @param {*} uploader
 * @param {string} gitRoot
 * @param {string|null} ownerHome
 * @returns {boolean}
 */
function isAllowedUploader(uploader, gitRoot, ownerHome) {
  if (typeof uploader !== 'string' || !uploader || !path.isAbsolute(uploader)) return false;
  if (path.basename(uploader) !== SHARED_UPLOADER_NAME) return false;
  const real = realpathOrNull(uploader);
  if (!real || path.basename(real) !== SHARED_UPLOADER_NAME) return false;
  try {
    if (!fs.statSync(real).isFile()) return false;
  } catch {
    return false;
  }
  const roots = [realpathOrNull(gitRoot)];
  if (ownerHome) roots.push(realpathOrNull(path.join(ownerHome, ...PLUGINS_DIR_SEGMENTS)));
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return roots.some((root) => !!root && isPathInside(fold(real), fold(root)));
}

/**
 * A register `signals` object as three booleans: logs and metrics default on, spans default off
 * (the tag-routing default, DD-18).
 * @param {*} value
 * @returns {{ logs: boolean, metrics: boolean, spans: boolean }}
 */
function normalizeSignals(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    logs: source.logs !== false,
    metrics: source.metrics !== false,
    spans: source.spans === true,
  };
}

/**
 * A register `realtime` target, or null when absent or unusable.
 * @param {*} value
 * @returns {{ enabled: boolean, serverUrl: string, apiKey: string, intervalMs: number }|null}
 */
function normalizeRealtime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    enabled: value.enabled !== false,
    serverUrl: typeof value.serverUrl === 'string' ? value.serverUrl.trim().replace(/\/+$/, '') : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    intervalMs: clampRealtimeInterval(value.intervalMs),
  };
}

/**
 * Validate a shared-mode register body (DD-10) into the request part of a `RegistryEntry`. Pure
 * except for the uploader's filesystem check. Unknown fields are ignored.
 * @param {*} payload
 * @param {string|null} ownerHome
 * @returns {{ ok: true, value: Omit<RegistryEntry, 'registeredAt'|'lastSeenAt'|'received'|'firstRecordAt'> }
 *   | { ok: false, reason: string }}
 */
function validateRegisterPayload(payload, ownerHome) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'body invalid' };
  const field = (name) => payload[name];
  const missing = (value) => value === undefined || value === null || value === '';

  if (missing(field('sessionId'))) return { ok: false, reason: 'sessionId missing' };
  if (!isValidSessionId(field('sessionId'))) return { ok: false, reason: 'sessionId invalid' };
  for (const name of ['gitRoot', 'otelDir']) {
    const value = field(name);
    if (missing(value)) return { ok: false, reason: `${name} missing` };
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) return { ok: false, reason: `${name} invalid` };
  }
  if (missing(field('hookVersion'))) return { ok: false, reason: 'hookVersion missing' };
  if (typeof field('hookVersion') !== 'string' || !field('hookVersion').trim()) return { ok: false, reason: 'hookVersion invalid' };

  const gitRoot = field('gitRoot').trim();
  let uploader = null;
  if (!missing(field('uploader'))) {
    if (!isAllowedUploader(field('uploader'), gitRoot, ownerHome)) return { ok: false, reason: 'uploader-not-allowed' };
    uploader = field('uploader');
  }

  const sentKey = typeof field('repoKey') === 'string' ? field('repoKey').toLowerCase() : '';
  return {
    ok: true,
    value: {
      sessionId: field('sessionId'),
      gitRoot,
      otelDir: field('otelDir').trim(),
      hookVersion: field('hookVersion').trim(),
      contract: Number.isInteger(field('contract')) ? field('contract') : REGISTER_CONTRACT,
      repoKey: REPO_KEY_RE.test(sentKey) ? sentKey : repoKey(gitRoot),
      signals: normalizeSignals(field('signals')),
      uploader,
      realtime: normalizeRealtime(field('realtime')),
    },
  };
}

/**
 * Put a validated registration into the registry (DD-10). A re-register replaces the entry but keeps
 * its counters and `firstRecordAt`; a changed `repoKey` is a rebind and logged.
 * @param {object} value - the `value` of a successful `validateRegisterPayload`
 * @param {number} now
 * @returns {{ entry: RegistryEntry, rebound: boolean, previousRepoKey: string|null }}
 */
function upsertRegistryEntry(value, now) {
  const previous = registry.get(value.sessionId) || null;
  const iso = new Date(now).toISOString();
  const entry = Object.assign({}, value, {
    registeredAt: iso,
    lastSeenAt: iso,
    received: previous && previous.received && typeof previous.received === 'object'
      ? {
        logs: Number(previous.received.logs) || 0,
        metrics: Number(previous.received.metrics) || 0,
        spans: Number(previous.received.spans) || 0,
      }
      : { logs: 0, metrics: 0, spans: 0 },
    firstRecordAt: previous && typeof previous.firstRecordAt === 'string' ? previous.firstRecordAt : null,
  });
  registry.set(value.sessionId, entry);
  const rebound = !!previous && previous.repoKey !== value.repoKey;
  return { entry, rebound, previousRepoKey: previous ? previous.repoKey : null };
}

// ---------------------------------------------------------------------------
// shared mode — routing, pending spool, per-repo writes (hook 2.30.0+, DD-18, DD-19)
//
// Every record of an OTLP request is routed on its own (`routeRecord`): to the repo its session
// registered for, else to the repo its `artisyn.repo` resource tag names in `repos.json`, else into
// the in-memory pending spool until its session registers. Records are then written per repo slice,
// each slice with its own `dir-gone` check, sweep quiet-timer and realtime channel.
// ---------------------------------------------------------------------------

// The pending key of a record without a usable session id: it can never be claimed, so it expires.
const PENDING_NO_SESSION_KEY = '__none__';
const STATE_REPOS_FILE = 'repos.json';

// Counters since start, for the idle-exit line.
const shared = {
  // OTLP requests ingested.
  ingests: 0,
  // Records dropped because their repo does not take that signal (DD-18 `dropped-signal`).
  droppedSignal: 0,
};

/**
 * @typedef {object} RouteTarget
 * @property {'registry'|'tag'} via
 * @property {string} otelDir
 * @property {string} gitRoot
 * @property {string|null} hookVersion  the registering hook's (registry) or the `repos.json` one (tag)
 * @property {string} repoKey
 * @property {string|null} uploader     registry only; a tag-routed repo's sweep uses `repos.json`
 * @property {{ enabled: boolean, serverUrl: string, apiKey: string, intervalMs: number }|null} realtime registry only
 *
 * @typedef {object} ListedRepo
 * @property {string} repoKey
 * @property {string} gitRoot
 * @property {string} otelDir
 * @property {string|null} uploader
 * @property {boolean} traces
 * @property {string|null} hookVersion
 *
 * @typedef {{ action: 'route', via: 'registry'|'tag', target: RouteTarget }
 *   | { action: 'drop', reason: 'dropped-signal', target: RouteTarget }
 *   | { action: 'pending', key: string }} RouteDecision
 */

/**
 * The route target of a registry entry.
 * @param {RegistryEntry} entry
 * @returns {RouteTarget}
 */
function targetFromEntry(entry) {
  return {
    via: 'registry',
    otelDir: entry.otelDir,
    gitRoot: entry.gitRoot,
    hookVersion: typeof entry.hookVersion === 'string' && entry.hookVersion ? entry.hookVersion : null,
    repoKey: entry.repoKey,
    uploader: typeof entry.uploader === 'string' && entry.uploader ? entry.uploader : null,
    realtime: entry.realtime && typeof entry.realtime === 'object' ? entry.realtime : null,
  };
}

/**
 * The route target of a `repos.json` entry (tag routing).
 * @param {ListedRepo} repo
 * @returns {RouteTarget}
 */
function targetFromRepo(repo) {
  return {
    via: 'tag',
    otelDir: repo.otelDir,
    gitRoot: repo.gitRoot,
    hookVersion: repo.hookVersion,
    repoKey: repo.repoKey,
    uploader: null,
    realtime: null,
  };
}

/**
 * The `repos.json` entry with this key, or null.
 * @param {ListedRepo[]} repos
 * @param {*} key
 * @returns {ListedRepo|null}
 */
function findRepoByKey(repos, key) {
  if (typeof key !== 'string' || !key) return null;
  const wanted = key.toLowerCase();
  return (Array.isArray(repos) ? repos : []).find((repo) => repo.repoKey === wanted) || null;
}

/**
 * Route one record (DD-18). Pure: the registry entry and the `repos.json` list are passed in.
 *
 *   1. No usable session id ⇒ pending under `"__none__"` (it expires).
 *   2. A live registry entry ⇒ its repo when `entry.signals[signal]` is true, else drop
 *      (`dropped-signal`). A conflicting `artisyn.repo` tag is ignored: register wins.
 *   3. Else an `artisyn.repo` tag matching a `repos.json` entry ⇒ that repo, with logs + metrics,
 *      plus spans when the entry has `traces`; another signal is dropped (`dropped-signal`).
 *   4. Else ⇒ pending under the session id.
 * @param {{ sessionId: string|null, signal: 'logs'|'metrics'|'spans', repoAttr?: string|null,
 *   entry?: RegistryEntry|null, repos?: ListedRepo[] }} ctx
 * @returns {RouteDecision}
 */
function routeRecord(ctx) {
  const sessionId = ctx && isValidSessionId(ctx.sessionId) ? ctx.sessionId : null;
  if (!sessionId) return { action: 'pending', key: PENDING_NO_SESSION_KEY };
  const signal = ctx.signal;

  const entry = ctx.entry && typeof ctx.entry === 'object' ? ctx.entry : null;
  if (entry) {
    const target = targetFromEntry(entry);
    if (!entry.signals || entry.signals[signal] !== true) return { action: 'drop', reason: 'dropped-signal', target };
    return { action: 'route', via: 'registry', target };
  }

  const repo = findRepoByKey(ctx.repos, ctx.repoAttr);
  if (repo) {
    const target = targetFromRepo(repo);
    const allowed = signal === 'logs' || signal === 'metrics' || (signal === 'spans' && repo.traces === true);
    if (!allowed) return { action: 'drop', reason: 'dropped-signal', target };
    return { action: 'route', via: 'tag', target };
  }

  return { action: 'pending', key: sessionId };
}

/**
 * The usable entries of a parsed `repos.json` (DD-4): a 16-hex `repoKey`, absolute `gitRoot` and
 * `otelDir`. Pure.
 * @param {*} parsed
 * @returns {ListedRepo[]}
 */
function parseReposFile(parsed) {
  const list = parsed && typeof parsed === 'object' && Array.isArray(parsed.repos) ? parsed.repos : [];
  const repos = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = typeof item.repoKey === 'string' ? item.repoKey.toLowerCase() : '';
    if (!REPO_KEY_RE.test(key)) continue;
    if (typeof item.gitRoot !== 'string' || !path.isAbsolute(item.gitRoot)) continue;
    if (typeof item.otelDir !== 'string' || !path.isAbsolute(item.otelDir)) continue;
    repos.push({
      repoKey: key,
      gitRoot: item.gitRoot,
      otelDir: item.otelDir,
      uploader: typeof item.uploader === 'string' && item.uploader ? item.uploader : null,
      traces: item.traces === true,
      hookVersion: typeof item.hookVersion === 'string' && item.hookVersion ? item.hookVersion : null,
    });
  }
  return repos;
}

let reposCache = { signature: null, repos: [] };

/**
 * `<stateDir>/repos.json` (written by the installer), re-read only when its mtime/size changes.
 * Absent or malformed ⇒ no repos.
 * @returns {ListedRepo[]}
 */
function readReposCached() {
  if (!runtime.stateDir) return [];
  const file = path.join(runtime.stateDir, STATE_REPOS_FILE);
  const signature = configSignature([file]);
  if (reposCache.signature === signature) return reposCache.repos;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  reposCache = { signature, repos: parseReposFile(parsed) };
  return reposCache.repos;
}

/**
 * The live registry entry of a session, or null. An expired entry is removed on the way.
 * @param {string|null} sessionId
 * @param {number} now
 * @returns {RegistryEntry|null}
 */
function liveRegistryEntry(sessionId, now) {
  if (!sessionId) return null;
  const entry = registry.get(sessionId);
  if (!entry) return null;
  if (registryEntryAlive(entry, now)) return entry;
  registry.delete(sessionId);
  return null;
}

// ---- pending spool (DD-18)

/**
 * @typedef {object} PendingRecord
 * @property {string} key        the session id, or `"__none__"`
 * @property {string|null} sessionId
 * @property {string|null} repoAttr
 * @property {'logs'|'metrics'|'spans'} signal
 * @property {Record<string, *>} line  unstamped; stamped when it is finally routed
 * @property {number} at         epoch ms it was spooled
 */

const pendingSpool = {
  /** @type {PendingRecord[]} oldest first */
  records: [],
  // Records dropped since start: past `PENDING_TTL_MS`, or the oldest on a full spool.
  expired: 0,
  overflow: 0,
};

/**
 * Drop the spooled records older than `PENDING_TTL_MS`, counting them. Records are in arrival
 * order, so only the front is checked.
 * @param {number} now
 */
function prunePendingSpool(now) {
  let n = 0;
  while (pendingSpool.records.length && now - pendingSpool.records[0].at >= PENDING_TTL_MS) {
    pendingSpool.records.shift();
    n++;
  }
  if (n > 0) {
    pendingSpool.expired += n;
    receiverLog('pending-expire', `records=${n} expiredTotal=${pendingSpool.expired} pending=${pendingSpool.records.length}`);
  }
}

/**
 * Spool records of unregistered sessions, dropping (and counting) the oldest beyond
 * `PENDING_MAX_RECORDS`.
 * @param {PendingRecord[]} items
 * @param {number} now
 */
function addPending(items, now) {
  prunePendingSpool(now);
  let dropped = 0;
  for (const item of items) {
    if (pendingSpool.records.length >= PENDING_MAX_RECORDS) {
      pendingSpool.records.shift();
      dropped++;
    }
    pendingSpool.records.push(item);
  }
  if (dropped > 0) {
    pendingSpool.overflow += dropped;
    receiverLog('pending-overflow', `dropped=${dropped} overflowTotal=${pendingSpool.overflow} cap=${PENDING_MAX_RECORDS}`);
  }
}

/**
 * Remove and return the spooled records of one session (still within the TTL).
 * @param {string} sessionId
 * @param {number} now
 * @returns {PendingRecord[]}
 */
function takePending(sessionId, now) {
  prunePendingSpool(now);
  const taken = [];
  const kept = [];
  for (const item of pendingSpool.records) {
    if (item.key === sessionId) taken.push(item);
    else kept.push(item);
  }
  if (taken.length) pendingSpool.records = kept;
  return taken;
}

/**
 * How many records of one session wait in the spool.
 * @param {string} sessionId
 * @returns {number}
 */
function pendingCount(sessionId) {
  let n = 0;
  for (const item of pendingSpool.records) if (item.key === sessionId) n++;
  return n;
}

// ---- per-repo writes

// Repos whose `otelDir` is gone, so `dir-gone` is logged once per repo (AC-A5); key = normalizeGitRoot.
const dirGoneRepos = new Set();

/**
 * Stop a repo whose `otelDir` is gone: its sweep quiet-timer and its realtime channel (AC-A5). The
 * registry and `repos.json` entries stay until their TTL or an uninstall.
 * @param {string} key - normalizeGitRoot(gitRoot)
 * @param {string} key16 - the repoKey, for the log line
 * @param {number} [droppedLines]
 */
function retireRepo(key, key16, droppedLines) {
  sweepRepos.delete(key);
  retireRealtimeChannel(key);
  if (dirGoneRepos.has(key)) return;
  dirGoneRepos.add(key);
  receiverLog('dir-gone',
    `repo=${key16} otel directory no longer exists — records for this repo are dropped` +
    `${droppedLines ? ` (${droppedLines} line(s) now)` : ''}; other repos are unaffected`);
}

/**
 * @typedef {object} RepoSlice
 * @property {RouteTarget} target
 * @property {'logs'|'metrics'|'spans'} signal
 * @property {Map<string, string[]>} groups  sessionId → serialized, stamped lines
 * @property {number} records
 * @property {number} dropped
 */

/**
 * Route, stamp, write and count a batch of collected (or re-routed pending) records. Writes one
 * chunk per session per repo slice, logs one DD-19 `ingest repo=<repoKey> …` line per slice (shared
 * log + the repo's own receiver.log), updates the registry counters, notes the repo for its sweep
 * and queues the realtime lines.
 * @param {Array<{ sessionId: string|null, repoAttr: string|null, signal: 'logs'|'metrics'|'spans', line: Record<string, *> }>} items
 * @param {number} wireBytes
 * @param {number} now
 * @returns {{ pending: PendingRecord[] }} the records that went to the spool
 */
function dispatchRecords(items, wireBytes, now) {
  const repos = readReposCached();
  const receiverVersion = getReceiverVersion();
  /** @type {Map<string, RepoSlice>} */
  const slices = new Map();
  const pending = [];
  const touchedEntries = new Set();

  for (const item of items) {
    const entry = liveRegistryEntry(item.sessionId, now);
    const decision = routeRecord({ sessionId: item.sessionId, signal: item.signal, repoAttr: item.repoAttr, entry, repos });
    if (decision.action === 'pending') {
      pending.push({ key: decision.key, sessionId: item.sessionId, repoAttr: item.repoAttr, signal: item.signal, line: item.line, at: now });
      continue;
    }
    const sliceKey = `${normalizeGitRoot(decision.target.gitRoot)}\n${item.signal}`;
    let slice = slices.get(sliceKey);
    if (!slice) {
      slice = { target: decision.target, signal: item.signal, groups: new Map(), records: 0, dropped: 0 };
      slices.set(sliceKey, slice);
    }
    if (entry) {
      entry.lastSeenAt = new Date(now).toISOString();
      touchedEntries.add(entry);
    }
    if (decision.action === 'drop') {
      slice.dropped++;
      shared.droppedSignal++;
      continue;
    }
    // A registered session's latest registration is the target (register wins).
    if (decision.via === 'registry') slice.target = decision.target;
    pushLine(slice.groups, item.sessionId, withHookVersion(item.line, decision.target.hookVersion, receiverVersion));
    slice.records++;
  }

  const iso = new Date(now).toISOString();
  for (const slice of slices.values()) {
    const target = slice.target;
    const key = normalizeGitRoot(target.gitRoot);
    const written = slice.groups.size ? writeGroups(slice.groups, target) : { sessions: 0, failed: 0, written: [], dirGone: false };

    if (written.dirGone) {
      retireRepo(key, target.repoKey, slice.records);
    } else if (written.written.length) {
      dirGoneRepos.delete(key);
      noteRepoWrite(target, now);
      for (const sessionId of written.written) {
        const lines = slice.groups.get(sessionId) || [];
        const entry = registry.get(sessionId);
        if (entry && normalizeGitRoot(entry.gitRoot) === key) {
          if (!entry.received || typeof entry.received !== 'object') entry.received = { logs: 0, metrics: 0, spans: 0 };
          entry.received[slice.signal] = (Number(entry.received[slice.signal]) || 0) + lines.length;
          if (!entry.firstRecordAt) entry.firstRecordAt = iso;
          touchedEntries.add(entry);
        }
        if (target.via === 'registry' && RT_SIGNALS.includes(slice.signal)) {
          try {
            setSharedRealtimeTarget(target);
            enqueueRealtime(sharedRealtimeChannel(target), sessionId, lines);
          } catch (err) {
            // The realtime channel must never fail a request whose chunk is already on disk.
            receiverLog('rt-error', `repo=${target.repoKey} enqueue failed for session ${sessionId}: ${err && err.message ? err.message : String(err)}`);
          }
        }
      }
    }

    receiverLogMirrored(written.dirGone ? '' : target.otelDir, 'ingest',
      `repo=${target.repoKey} receiverVersion=${receiverVersion || 'unknown'} signal=${slice.signal} ` +
      `bytes=${wireBytes} sessions=${written.sessions} records=${slice.records} dropped=${slice.dropped} ` +
      `writeErrors=${written.failed}`);
  }

  if (touchedEntries.size) scheduleRegistryPersist();
  if (pending.length) addPending(pending, now);
  return { pending };
}

/**
 * Shared-mode OTLP ingest: collect, route per record, write per repo, and log the DD-19 lines —
 * one `ingest repo=<repoKey>` line per repo slice, and one `ingest repo=pending` line (shared log
 * only) for what went to the spool or could not be read at all.
 * @param {'logs'|'metrics'|'spans'} signal
 * @param {*} payload
 * @param {number} wireBytes
 */
function ingestShared(signal, payload, wireBytes) {
  const now = Date.now();
  shared.ingests++;
  const collected = collectSignal(signal, payload, new Date(now).toISOString());
  const { pending } = dispatchRecords(collected.records, wireBytes, now);
  if (pending.length || collected.invalid || collected.records.length === 0) {
    const sessions = new Set(pending.map((item) => item.key)).size;
    receiverLog('ingest',
      `repo=pending receiverVersion=${getReceiverVersion() || 'unknown'} signal=${signal} bytes=${wireBytes} ` +
      `sessions=${sessions} records=${pending.length} dropped=${collected.invalid} writeErrors=0`);
  }
}

/**
 * Re-route a session's spooled records right after it registers (DD-18).
 * @param {string} sessionId
 */
function reroutePending(sessionId) {
  const now = Date.now();
  const taken = takePending(sessionId, now);
  if (!taken.length) return;
  const { pending } = dispatchRecords(taken, 0, now);
  receiverLog('pending-reroute', `session=${sessionId} records=${taken.length} routed=${taken.length - pending.length}`);
}

// ---------------------------------------------------------------------------
// upstream forwarding (DD-20)
//
// When the installer chose `proxy` for a foreign OTLP collector, `<stateDir>/forward.json` names the
// upstream URL of each forwarded signal. Every OTLP request for such a signal is queued *before*
// routing (so unregistered sessions are covered too) and re-sent as is — the raw wire bytes plus
// the incoming headers minus the hop-by-hop ones and our own `x-artisyn-*`. Claude Code gets its
// `200` after the local write; the upstream send is asynchronous, bounded, and retried with
// backoff. Header values are never logged.
// ---------------------------------------------------------------------------

const STATE_FORWARD_FILE = 'forward.json';
const FORWARD_SIGNALS = ['logs', 'metrics', 'spans'];
// Request headers never passed upstream; plus every `x-artisyn-*` header.
const FORWARD_DROPPED_HEADERS = ['host', 'connection', 'content-length', 'transfer-encoding'];
const FORWARD_ARTISYN_HEADER_PREFIX = 'x-artisyn-';
// One upstream send may take at most this long before it counts as a network error.
const FORWARD_REQUEST_TIMEOUT_MS = 10000;
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/**
 * The headers to send upstream for an incoming OTLP request (DD-20): every incoming header except
 * `host`, `connection`, `content-length`, `transfer-encoding` and any `x-artisyn-*`. Names are
 * lower-cased; `undefined`/`null` values are skipped; string and string-array values are kept as is.
 * Pure.
 * @param {Record<string, string|string[]|undefined|null>|null|undefined} incoming
 * @returns {Record<string, string|string[]>}
 */
function forwardHeaders(incoming) {
  /** @type {Record<string, string|string[]>} */
  const out = {};
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return out;
  for (const [rawName, value] of Object.entries(incoming)) {
    const name = String(rawName).toLowerCase();
    if (FORWARD_DROPPED_HEADERS.includes(name) || name.startsWith(FORWARD_ARTISYN_HEADER_PREFIX)) continue;
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) out[name] = value.slice();
  }
  return out;
}

/**
 * Epoch ms of a timestamp given as a number or an ISO string; anything else ⇒ null.
 * @param {*} value
 * @returns {number|null}
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The `forward` health that `session-status` reports (DD-11, DD-20). Pure.
 * - `off` when forwarding is not enabled (mode is not `proxy`, or no signal has a usable upstream);
 * - `degraded` when a request was dropped or retried within the last `FORWARD_DEGRADED_WINDOW_MS`
 *   (5 min) before `now`;
 * - `ok` otherwise.
 * @param {{ enabled?: boolean, lastDropAt?: number|string|null, lastRetryAt?: number|string|null }|null|undefined} stats
 *   timestamps as epoch ms or ISO strings
 * @param {number|string} now - epoch ms or an ISO string
 * @returns {'ok'|'degraded'|'off'}
 */
function forwardHealth(stats, now) {
  if (!stats || typeof stats !== 'object' || stats.enabled !== true) return 'off';
  const nowMs = toEpochMs(now);
  if (nowMs === null) return 'ok';
  for (const at of [toEpochMs(stats.lastDropAt), toEpochMs(stats.lastRetryAt)]) {
    if (at !== null && nowMs - at < FORWARD_DEGRADED_WINDOW_MS) return 'degraded';
  }
  return 'ok';
}

/**
 * Whether an upstream URL would loop back into this receiver.
 * @param {URL} url
 * @param {number} ownPort
 * @returns {boolean}
 */
function isSelfUrl(url, ownPort) {
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  return LOOPBACK_HOSTS.includes(url.hostname.toLowerCase()) && port === ownPort;
}

/**
 * The forwarding config of a parsed `forward.json` (DD-4, DD-20). Only `mode:'proxy'` enables
 * anything; a signal is forwarded only when it carries an absolute `http:`/`https:` `endpoint` that
 * does not point back at this receiver. Malformed input ⇒ disabled.
 * @param {*} parsed
 * @param {number} ownPort
 * @returns {{ mode: string, signals: Partial<Record<'logs'|'metrics'|'spans', { url: URL, protocol: string|null }>> }}
 */
function parseForwardConfig(parsed, ownPort) {
  const config = { mode: 'none', signals: {} };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return config;
  if (typeof parsed.mode === 'string') config.mode = parsed.mode;
  if (config.mode !== 'proxy') return config;
  const signals = parsed.signals && typeof parsed.signals === 'object' && !Array.isArray(parsed.signals) ? parsed.signals : {};
  for (const signal of FORWARD_SIGNALS) {
    const entry = signals[signal];
    if (!entry || typeof entry !== 'object' || typeof entry.endpoint !== 'string') continue;
    let url;
    try {
      url = new URL(entry.endpoint.trim());
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (isSelfUrl(url, ownPort)) continue;
    config.signals[signal] = { url, protocol: typeof entry.protocol === 'string' ? entry.protocol : null };
  }
  return config;
}

/**
 * @typedef {object} ForwardItem
 * @property {Buffer} body      raw wire bytes, as received (still content-encoded)
 * @property {Record<string, string|string[]>} headers  already filtered by `forwardHeaders`
 * @property {number} attempts  failed sends so far
 *
 * @typedef {object} ForwardQueue
 * @property {ForwardItem[]} items
 * @property {number} bytes
 * @property {boolean} sending
 * @property {NodeJS.Timeout|null} timer
 * @property {number} sent
 * @property {number} dropped
 * @property {number} retries
 */

const forwarder = {
  /** @type {ReturnType<typeof parseForwardConfig>} */
  config: { mode: 'none', signals: {} },
  signature: null,
  /** @type {Map<string, ForwardQueue>} */
  queues: new Map(),
  /** @type {number|null} */
  lastDropAt: null,
  /** @type {number|null} */
  lastRetryAt: null,
};

/**
 * Read `<stateDir>/forward.json` when its mtime/size changed since the last read (at start and on
 * every hello, DD-20). A signal that is no longer forwarded loses its queue.
 */
function refreshForwardConfig() {
  if (!runtime.shared || !runtime.stateDir) return;
  const file = path.join(runtime.stateDir, STATE_FORWARD_FILE);
  const signature = configSignature([file]);
  if (forwarder.signature === signature) return;
  forwarder.signature = signature;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  forwarder.config = parseForwardConfig(parsed, runtime.port);
  const enabled = Object.keys(forwarder.config.signals);
  for (const [signal, queue] of forwarder.queues) {
    if (enabled.includes(signal)) continue;
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = null;
    if (queue.items.length) receiverLog('forward-off', `signal=${signal} discarded=${queue.items.length} — no longer forwarded`);
    queue.items = [];
    queue.bytes = 0;
  }
  receiverLog('forward-config', `mode=${forwarder.config.mode} signals=${enabled.length ? enabled.join(',') : 'none'}`);
}

/**
 * The queue of a signal, created on first use.
 * @param {string} signal
 * @returns {ForwardQueue}
 */
function forwardQueue(signal) {
  let queue = forwarder.queues.get(signal);
  if (!queue) {
    queue = { items: [], bytes: 0, sending: false, timer: null, sent: 0, dropped: 0, retries: 0 };
    forwarder.queues.set(signal, queue);
  }
  return queue;
}

/**
 * Count one dropped upstream request.
 * @param {ForwardQueue} queue
 */
function noteForwardDrop(queue) {
  queue.dropped++;
  forwarder.lastDropAt = Date.now();
}

/**
 * Queue one OTLP request for upstream forwarding, if its signal is forwarded. Bounded per signal by
 * `FORWARD_QUEUE_MAX_REQUESTS` and `FORWARD_QUEUE_MAX_BYTES`: the oldest queued requests are dropped
 * to make room (a request bigger than the byte cap on its own is dropped). Never throws.
 * @param {'logs'|'metrics'|'spans'} signal
 * @param {Buffer} body
 * @param {import('http').IncomingHttpHeaders} incomingHeaders
 */
function enqueueForward(signal, body, incomingHeaders) {
  if (!forwarder.config.signals[signal]) return;
  const queue = forwardQueue(signal);
  if (body.length > FORWARD_QUEUE_MAX_BYTES) {
    noteForwardDrop(queue);
    receiverLog('forward', `signal=${signal} status=too-large queued=${queue.items.length} dropped=${queue.dropped}`);
    return;
  }
  let evicted = 0;
  while (queue.items.length && (queue.items.length >= FORWARD_QUEUE_MAX_REQUESTS || queue.bytes + body.length > FORWARD_QUEUE_MAX_BYTES)) {
    // The head may be in flight; its result is ignored once it is gone from the queue.
    const old = queue.items.shift();
    queue.bytes -= old.body.length;
    evicted++;
  }
  if (evicted) {
    for (let i = 0; i < evicted; i++) noteForwardDrop(queue);
    receiverLog('forward', `signal=${signal} status=overflow queued=${queue.items.length} dropped=${queue.dropped}`);
  }
  queue.items.push({ body, headers: forwardHeaders(incomingHeaders), attempts: 0 });
  queue.bytes += body.length;
  pumpForward(signal);
}

/**
 * Backoff before retry number `attempts` (1-based): `min(FORWARD_BACKOFF_MIN_MS · 2^(attempts-1),
 * FORWARD_BACKOFF_MAX_MS)` — 1 s, 2 s, 4 s, … capped at 60 s.
 * @param {number} attempts
 * @returns {number}
 */
function forwardBackoffMs(attempts) {
  const n = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(FORWARD_BACKOFF_MIN_MS * 2 ** n, FORWARD_BACKOFF_MAX_MS);
}

/**
 * Send the head of a signal's queue upstream, one request in flight per signal (FIFO).
 * @param {string} signal
 */
function pumpForward(signal) {
  const queue = forwarder.queues.get(signal);
  if (!queue || queue.sending || queue.timer || !queue.items.length) return;
  const target = forwarder.config.signals[signal];
  if (!target) return;
  const item = queue.items[0];
  queue.sending = true;
  sendForward(target.url, item, (status) => {
    queue.sending = false;
    // Evicted by an overflow (or discarded by a config change) while in flight: nothing to settle.
    if (queue.items[0] !== item) {
      pumpForward(signal);
      return;
    }
    const ok = typeof status === 'number' && status >= 200 && status < 300;
    const retryable = typeof status !== 'number' || status === 429 || status >= 500;
    if (ok) {
      queue.items.shift();
      queue.bytes -= item.body.length;
      queue.sent++;
    } else if (retryable && item.attempts + 1 < FORWARD_MAX_ATTEMPTS) {
      item.attempts++;
      queue.retries++;
      forwarder.lastRetryAt = Date.now();
      queue.timer = setTimeout(() => {
        queue.timer = null;
        pumpForward(signal);
      }, forwardBackoffMs(item.attempts));
      // The idle timer decides the receiver's lifetime, never a pending retry.
      queue.timer.unref();
    } else {
      queue.items.shift();
      queue.bytes -= item.body.length;
      noteForwardDrop(queue);
    }
    receiverLog('forward', `signal=${signal} status=${status} queued=${queue.items.length} dropped=${queue.dropped}`);
    if (!queue.timer) pumpForward(signal);
  });
}

/**
 * POST one queued request to its upstream URL with the `http`/`https` built-ins. Calls `done` once,
 * with the HTTP status code, or `'timeout'` / `'error'` for a network failure. Never throws.
 * @param {URL} url
 * @param {ForwardItem} item
 * @param {(status: number|'timeout'|'error') => void} done
 */
function sendForward(url, item, done) {
  let settled = false;
  const finish = (status) => {
    if (settled) return;
    settled = true;
    done(status);
  };
  try {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: { ...item.headers, 'content-length': String(item.body.length) },
      timeout: FORWARD_REQUEST_TIMEOUT_MS,
    }, (res) => {
      // The body is irrelevant; drain it so the socket is released.
      res.resume();
      res.on('end', () => finish(res.statusCode || 0));
      res.on('error', () => finish(res.statusCode || 0));
    });
    req.on('timeout', () => {
      req.destroy();
      finish('timeout');
    });
    req.on('error', () => finish('error'));
    req.end(item.body);
  } catch {
    finish('error');
  }
}

/**
 * The idle-exit forward summary: one line per signal that was forwarded during this run.
 */
function logForwardSummary() {
  for (const [signal, queue] of forwarder.queues) {
    receiverLog('forward-summary',
      `signal=${signal} sent=${queue.sent} retries=${queue.retries} dropped=${queue.dropped} queued=${queue.items.length}`);
  }
}

/**
 * The upstream forwarding state reported by `session-status` (DD-11, DD-20).
 * @returns {'ok'|'degraded'|'off'}
 */
function forwardStatus() {
  return forwardHealth({
    enabled: Object.keys(forwarder.config.signals).length > 0,
    lastDropAt: forwarder.lastDropAt,
    lastRetryAt: forwarder.lastRetryAt,
  }, Date.now());
}

/**
 * Serve the shared-mode `POST /artisyn/session-status {sessionId}` (DD-11), already authenticated.
 * An unknown session answers `registered:false` with zero counts. `received` excludes pending.
 * @param {*} payload
 * @param {import('http').ServerResponse} res
 */
function handleSessionStatus(payload, res) {
  const sessionId = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.sessionId : undefined;
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    sendJson(res, 400, { error: 'bad-request', reason: 'sessionId missing' });
    return;
  }
  if (!isValidSessionId(sessionId)) {
    sendJson(res, 400, { error: 'bad-request', reason: 'sessionId invalid' });
    return;
  }
  const now = Date.now();
  prunePendingSpool(now);
  const entry = liveRegistryEntry(sessionId, now);
  const received = entry && entry.received && typeof entry.received === 'object' ? entry.received : {};
  sendJson(res, 200, {
    receiverVersion: getReceiverVersion(),
    registered: !!entry,
    received: {
      logs: Number(received.logs) || 0,
      metrics: Number(received.metrics) || 0,
      spans: Number(received.spans) || 0,
    },
    firstRecordAt: entry && typeof entry.firstRecordAt === 'string' ? entry.firstRecordAt : null,
    pending: pendingCount(sessionId),
    forward: forwardStatus(),
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Send a JSON response, tolerating a response whose headers were already sent (e.g. a throw after
 * a partial write) rather than throwing a second time.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {*} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, status, body, extraHeaders) {
  try {
    if (res.headersSent) {
      res.end();
      return;
    }
    const payload = JSON.stringify(body === undefined ? {} : body);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }, extraHeaders || {}));
    res.end(payload);
  } catch {
    try {
      res.destroy();
    } catch {
      // socket already gone
    }
  }
}

/**
 * Drain and discard a request body — required on every rejection path, since leaving an unread
 * request stream paused stalls the connection.
 * @param {import('http').IncomingMessage} req
 */
function discardBody(req) {
  try {
    req.resume();
  } catch {
    // socket already gone
  }
}

/**
 * The request path without its query string or trailing slash — `/v1/logs?x=1` and `/v1/logs/` both
 * route to `/v1/logs`.
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function requestPath(req) {
  const url = typeof req.url === 'string' ? req.url : '';
  const cut = url.indexOf('?');
  const bare = cut === -1 ? url : url.slice(0, cut);
  return bare.length > 1 ? bare.replace(/\/+$/, '') : bare;
}

/**
 * The `Content-Type` media type, lower-cased and without parameters (`application/json;
 * charset=utf-8` ⇒ `application/json`).
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function mediaType(req) {
  return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
}

/**
 * Read the request body, enforcing the cap on **wire** bytes (before any
 * decompression): as soon as the running total exceeds the cap the request is answered `413` and
 * destroyed, so an oversized payload is never buffered in full and never written.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {(body: Buffer) => void} onBody - called once, only when the body arrived within the cap
 */
function readBody(req, res, onBody) {
  const chunks = [];
  let total = 0;
  let rejected = false;

  req.on('data', (chunk) => {
    if (rejected) return;
    total += chunk.length;
    if (total > runtime.maxBodyBytes) {
      rejected = true;
      receiverLog('too-large', `${requestPath(req)} body exceeded maxBodyBytes=${runtime.maxBodyBytes} — rejected, nothing written`);
      // `Connection: close` is required, not cosmetic: the socket is about to be destroyed, and a
      // keep-alive client would otherwise put it back in its pool and see ECONNRESET on its *next*
      // request.
      sendJson(res, 413, { ok: false, error: 'payload-too-large' }, { Connection: 'close' });
      // Tear the connection down so the rest of an oversized upload is never read — but only once
      // the 413 has been flushed, otherwise the client sees a reset instead of the status.
      res.on('finish', () => {
        try {
          req.destroy();
        } catch {
          // socket already gone
        }
      });
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (rejected) return;
    onBody(Buffer.concat(chunks, total));
  });
}

/**
 * Decompress a body according to `Content-Encoding`. The header is validated before the body is
 * read, so only the supported values reach here; a decompression failure is treated as a parse
 * failure by the caller.
 * @param {Buffer} body
 * @param {string} encoding - already lower-cased and trimmed
 * @returns {Buffer}
 */
function decodeBody(body, encoding) {
  if (encoding === 'gzip') return zlib.gunzipSync(body);
  if (encoding === 'deflate') return zlib.inflateSync(body);
  return body;
}

/**
 * Ingest one OTLP payload: walk it, group the resolved records by session id, write one
 * `appendFileSync` per session, and log a single summary line — including the dropped-record
 * count, so unresolvable records never produce one log line each.
 *
 * After the chunk write, the `logs` and `spans` lines of every session whose chunk landed are
 * also queued for the realtime channel (`enqueueRealtime`).
 * @param {string} route - `/v1/logs`, `/v1/metrics` or `/v1/traces`
 * @param {*} payload - the parsed OTLP/JSON request
 * @param {number} wireBytes
 * @param {import('http').ServerResponse} res
 * @param {{ body: Buffer, headers: import('http').IncomingHttpHeaders }} [raw] - the wire bytes and
 *   headers, for upstream forwarding (shared mode, DD-20)
 */
function handleOtlp(route, payload, wireBytes, res, raw) {
  const signal = signalForRoute(route);
  if (runtime.shared) {
    // Forwarding is queued before routing, so every session is covered (DD-20). It must never fail
    // the local write.
    if (raw) {
      try {
        enqueueForward(signal, raw.body, raw.headers);
      } catch (err) {
        receiverLog('forward-error', `enqueue failed: ${err && err.message ? err.message : String(err)}`);
      }
    }
    // Shared mode routes every record on its own (DD-18) and logs per repo slice (DD-19).
    ingestShared(signal, payload, wireBytes);
    sendJson(res, 200, { partialSuccess: {} });
    return;
  }
  const receivedAt = new Date().toISOString();
  const hookVersion = getReceiverVersion();
  let walked;
  if (signal === 'metrics') walked = walkMetrics(payload, receivedAt, hookVersion);
  else if (signal === 'spans') walked = walkSpans(payload, receivedAt, hookVersion);
  else walked = walkLogs(payload, receivedAt, hookVersion);
  const written = writeGroups(walked.groups, {
    otelDir: runtime.otelDir,
    gitRoot: runtime.owner ? runtime.owner.gitRoot : '',
    hookVersion,
  });

  if (RT_SIGNALS.includes(signal)) {
    const channel = legacyRealtimeChannel();
    for (const sessionId of written.written) {
      try {
        enqueueRealtime(channel, sessionId, walked.groups.get(sessionId) || []);
      } catch (err) {
        // The realtime channel must never fail a request whose chunk is already on disk.
        receiverLog('rt-error', `enqueue failed for session ${sessionId}: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }

  receiverLog('ingest',
    `signal=${signal} bytes=${wireBytes} sessions=${written.sessions} records=${walked.kept} ` +
    `dropped=${walked.dropped} writeErrors=${written.failed}`);

  // The OTLP/HTTP success shape. Records dropped for an unresolvable session id are deliberately
  // not reported as a partial success: they are our filing problem, not the exporter's.
  sendJson(res, 200, { partialSuccess: {} });
}

/**
 * The chunk-line `signal` of an OTLP route.
 * @param {string} route
 * @returns {'logs'|'metrics'|'spans'}
 */
function signalForRoute(route) {
  if (route === OTLP_METRICS_PATH) return 'metrics';
  if (route === OTLP_TRACES_PATH) return 'spans';
  return 'logs';
}

/**
 * Serve `POST /artisyn/register` — the hook announcing itself, and the only place a port collision
 * between two projects becomes visible.
 *
 * Detection and logging only: a foreign git root gets `409` with the owning repo so the hook can
 * warn, and nothing is written or taken over.
 * @param {*} payload - the parsed request body
 * @param {import('http').ServerResponse} res
 */
function handleRegister(payload, res) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { ok: false, error: 'invalid-body' });
    return;
  }

  const gitRoot = typeof payload.gitRoot === 'string' ? payload.gitRoot.trim() : '';
  if (!gitRoot) {
    sendJson(res, 400, { ok: false, error: 'missing-git-root' });
    return;
  }

  // Absent is tolerated (an older hook may not send it); present-but-unusable is not, since the
  // same allow-list is what keeps a session id safe as a filename everywhere else.
  const sessionId = payload.sessionId;
  if (sessionId !== undefined && sessionId !== null && !isValidSessionId(sessionId)) {
    sendJson(res, 400, { ok: false, error: 'invalid-session-id' });
    return;
  }

  if (normalizeGitRoot(gitRoot) !== normalizeGitRoot(runtime.owner.gitRoot)) {
    receiverLog('owner-mismatch',
      `register from foreign gitRoot=${gitRoot} rejected — this receiver on port ${runtime.port} ` +
      `belongs to ${runtime.owner.gitRoot} (${runtime.owner.repo})`);
    sendJson(res, 409, { ok: false, error: 'owner-mismatch', ownerRepo: runtime.owner.repo });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    receiverVersion: getReceiverVersion(),
    port: runtime.port,
  });
}

/**
 * Serve `POST /artisyn/shutdown` — a caller (the hook's restart sequence, or the installer's
 * stop-before-install step) asking this receiver to exit so a newer one can take its place on the
 * same port.
 *
 * Validation mirrors `handleRegister` exactly, including the owner-mismatch `409`: a shutdown
 * request is just as capable of coming from a foreign project sharing this port by accident, and
 * must be refused the same way, leaving the receiver running.
 * @param {*} payload - the parsed request body
 * @param {import('http').ServerResponse} res
 */
function handleShutdown(payload, res) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    sendJson(res, 400, { ok: false, error: 'invalid-body' });
    return;
  }

  const gitRoot = typeof payload.gitRoot === 'string' ? payload.gitRoot.trim() : '';
  if (!gitRoot) {
    sendJson(res, 400, { ok: false, error: 'missing-git-root' });
    return;
  }

  const sessionId = payload.sessionId;
  if (sessionId !== undefined && sessionId !== null && !isValidSessionId(sessionId)) {
    sendJson(res, 400, { ok: false, error: 'invalid-session-id' });
    return;
  }

  if (normalizeGitRoot(gitRoot) !== normalizeGitRoot(runtime.owner.gitRoot)) {
    receiverLog('owner-mismatch',
      `shutdown from foreign gitRoot=${gitRoot} rejected — this receiver on port ${runtime.port} ` +
      `belongs to ${runtime.owner.gitRoot} (${runtime.owner.repo})`);
    sendJson(res, 409, { ok: false, error: 'owner-mismatch', ownerRepo: runtime.owner.repo });
    return;
  }

  sendJson(res, 200, { ok: true });
  // Mirrors the 413 respond-then-destroy pattern in readBody: exit only once the response has been
  // flushed to the caller, never before.
  res.on('finish', () => {
    process.exit(0);
  });
}

/**
 * Serve the shared-mode `POST /artisyn/hello {clientNonce, ownerHash}` (DD-9). A different owner
 * gets `409 {error:'owner-mismatch'}` with no path in it; otherwise a fresh single-use server nonce
 * and the proof that this receiver holds the token.
 * @param {*} payload
 * @param {import('http').ServerResponse} res
 */
function handleHello(payload, res) {
  const clientNonce = payload && typeof payload === 'object' && typeof payload.clientNonce === 'string'
    ? payload.clientNonce.toLowerCase() : '';
  const sentOwner = payload && typeof payload === 'object' && typeof payload.ownerHash === 'string'
    ? payload.ownerHash.toLowerCase() : '';
  if (!CLIENT_NONCE_RE.test(clientNonce) || !SHA256_HEX_RE.test(sentOwner)) {
    sendJson(res, 400, { error: 'bad-request', reason: !CLIENT_NONCE_RE.test(clientNonce) ? 'clientNonce invalid' : 'ownerHash invalid' });
    return;
  }
  if (sentOwner !== runtime.ownerHash) {
    receiverLog('owner-mismatch', `hello from ownerHash=${sentOwner.slice(0, 12)} rejected`);
    sendJson(res, 409, { error: 'owner-mismatch' });
    return;
  }
  // forward.json is re-read on its mtime change at each hello (DD-20).
  refreshForwardConfig();
  const serverNonce = nonces.issue(Date.now());
  sendJson(res, 200, {
    serverNonce,
    proof: computeHelloProof(runtime.token, clientNonce, serverNonce),
    receiverVersion: getReceiverVersion(),
    contract: REGISTER_CONTRACT,
    capabilities: CAPABILITIES,
  });
}

/**
 * Create a registered repo's `otelDir`. The legacy receiver creates its one `--dir` at start; a
 * shared receiver has none, so without this the first record of a fresh install hits `dir-gone`.
 * Done only here, where an authenticated hook has just reported the repo as live — never in the
 * write path, which must not resurrect a deleted project (see `writeGroups`) — and only when the
 * repo root exists and `otelDir` lies inside it. A repo that comes back is no longer `dir-gone`.
 * @param {RegistryEntry} entry
 */
function ensureRegisteredOtelDir(entry) {
  const rel = path.relative(entry.gitRoot, entry.otelDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  try {
    if (!fs.existsSync(entry.gitRoot)) return;
    fs.mkdirSync(entry.otelDir, { recursive: true });
    dirGoneRepos.delete(normalizeGitRoot(entry.gitRoot));
  } catch (err) {
    receiverLog('error', `cannot create the otel directory of repo ${entry.repoKey}: ${err && err.message ? err.message : String(err)}`);
  }
}

/**
 * Serve the shared-mode `POST /artisyn/register` (DD-10), already authenticated.
 * @param {*} payload
 * @param {import('http').ServerResponse} res
 */
function handleSharedRegister(payload, res) {
  const checked = validateRegisterPayload(payload, runtime.ownerHome);
  if (!checked.ok) {
    receiverLog('register-reject', `reason=${checked.reason}`);
    sendJson(res, 400, { error: 'bad-request', reason: checked.reason });
    return;
  }
  const { entry, rebound, previousRepoKey } = upsertRegistryEntry(checked.value, Date.now());
  ensureRegisteredOtelDir(entry);
  if (rebound) receiverLog('register-rebind', `session=${entry.sessionId} from=${previousRepoKey} to=${entry.repoKey}`);
  else receiverLog('register', `session=${entry.sessionId} repo=${entry.repoKey} hookVersion=${entry.hookVersion} sessions=${registry.size}`);
  setSharedRealtimeTarget(targetFromEntry(entry));
  try {
    // Records that arrived before the registration now have a repo (DD-18).
    reroutePending(entry.sessionId);
  } catch (err) {
    receiverLog('error', `pending re-route failed for session ${entry.sessionId}: ${err && err.message ? err.message : String(err)}`);
  }
  scheduleRegistryPersist();
  sendJson(res, 200, {
    ok: true,
    receiverVersion: getReceiverVersion(),
    contract: REGISTER_CONTRACT,
    capabilities: CAPABILITIES,
    rebound,
  });
}

/**
 * Serve the shared-mode `POST /artisyn/shutdown`, already authenticated: flush the registry, answer,
 * then exit once the answer is flushed.
 * @param {import('http').ServerResponse} res
 */
function handleSharedShutdown(res) {
  receiverLog('shutdown', `authenticated shutdown request — sessions=${registry.size}`);
  flushRegistry();
  sendJson(res, 200, { ok: true });
  res.on('finish', () => {
    process.exit(0);
  });
}

/**
 * Route and serve one request, per the status-code table below.
 *
 * Order matters: an unknown path (`404`) and a wrong method (`405`) are answered before anything is
 * read, then the browser-origin defence, then the encoding checks, and only then the body. Every
 * rejection discards the body and writes nothing.
 *
 * The `Origin`/`Referer` rejection and the `application/json` requirement are the defence that
 * makes this unauthenticated local write API safe: without them a page in the developer's browser
 * could inject NDJSON that this project then uploads under the user's real API key. Requiring
 * `application/json` means the request is not a CORS *simple* request, so a browser must preflight,
 * and no CORS headers are ever sent — so the preflight fails.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handleRequest(req, res) {
  const route = requestPath(req);

  if (!(runtime.shared ? SHARED_KNOWN_PATHS : KNOWN_PATHS).includes(route)) {
    discardBody(req);
    sendJson(res, 404, { ok: false, error: 'not-found' });
    return;
  }

  if (req.method !== 'POST') {
    discardBody(req);
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }

  if (req.headers.origin || req.headers.referer) {
    discardBody(req);
    receiverLog('rejected-origin', `${route} carried an Origin/Referer header — refused, nothing written`);
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  if (mediaType(req) !== 'application/json') {
    discardBody(req);
    sendJson(res, 415, { ok: false, error: 'unsupported-media-type' });
    return;
  }

  const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
  if (encoding && encoding !== 'identity' && !SUPPORTED_ENCODINGS.includes(encoding)) {
    discardBody(req);
    sendJson(res, 415, { ok: false, error: 'unsupported-content-encoding' });
    return;
  }

  readBody(req, res, (body) => {
    // The body arrives asynchronously, so this callback is outside the caller's try/catch.
    try {
      // Shared mode: authenticate before parsing, over the exact wire bytes; nothing else happens on
      // a failure (DD-9).
      const needsAuth = runtime.shared && (route === REGISTER_PATH || route === SHUTDOWN_PATH || route === SESSION_STATUS_PATH);
      if (needsAuth && !requireAuth(req, body)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(decodeBody(body, encoding).toString('utf8'));
      } catch {
        // A gunzip failure is deliberately treated the same as unparseable JSON.
        sendJson(res, 400, { ok: false, error: 'invalid-json' });
        return;
      }

      if (runtime.shared && route === HELLO_PATH) handleHello(payload, res);
      else if (runtime.shared && route === REGISTER_PATH) handleSharedRegister(payload, res);
      else if (runtime.shared && route === SHUTDOWN_PATH) handleSharedShutdown(res);
      else if (runtime.shared && route === SESSION_STATUS_PATH) handleSessionStatus(payload, res);
      else if (route === REGISTER_PATH) handleRegister(payload, res);
      else if (route === SHUTDOWN_PATH) handleShutdown(payload, res);
      else handleOtlp(route, payload, body.length, res, { body, headers: req.headers });
    } catch (err) {
      receiverLog('error', `request handler failed on ${route}: ${err && err.message ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, error: 'internal-error' });
    }
  });
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

function main() {
  // Neutral working directory first, so this long-lived detached process never pins the project
  // folder. The launcher already spawns with this cwd; the chdir also covers older hooks that do
  // not. receiver.log is not resolved yet, so a failure goes to stderr.
  try {
    process.chdir(os.tmpdir());
  } catch (err) {
    receiverLog('chdir-failed', `cannot chdir to ${os.tmpdir()}: ${err && err.message ? err.message : String(err)}`);
  }

  const args = parseArgs(process.argv.slice(2), process.env);

  if (args.conflict) {
    try {
      process.stderr.write('otel-receiver: --shared cannot be combined with --owner or --dir\n');
    } catch {
      // best effort only
    }
    process.exit(EXIT_USAGE);
  }

  if (args.shared) {
    startShared(args);
    return;
  }

  if (!args.dir) {
    exitStartupFailure('missing required --dir / ARTISYN_OTEL_DIR — refusing to start without a project otel directory');
  }

  try {
    fs.mkdirSync(args.dir, { recursive: true });
  } catch (err) {
    exitStartupFailure(`cannot create otel directory ${args.dir}: ${err.message}`);
  }

  runtime.otelDir = args.dir;
  runtime.logFilePath = path.join(args.dir, 'receiver.log');
  runtime.port = args.port;
  runtime.idleTimeoutMs = args.idleTimeoutMs;
  runtime.maxBodyBytes = args.maxBodyBytes;

  if (!args.owner) {
    exitStartupFailure('missing or invalid --owner / ARTISYN_OTEL_OWNER_JSON (expected {"gitRoot":"…","repo":"…"}) — refusing to start ownerless');
  }
  runtime.owner = args.owner;

  listen(() => {
    receiverLog('start',
      `listening on 127.0.0.1:${runtime.port} dir=${runtime.otelDir} owner=${runtime.owner.gitRoot} ` +
      `ownerRepo=${runtime.owner.repo} idleTimeoutMs=${runtime.idleTimeoutMs} ` +
      `maxBodyBytes=${runtime.maxBodyBytes} pid=${process.pid} rtReceiverId=${rt.receiverId}`);
  });
}

/**
 * Shared-mode startup (DD-7): owner home and state dir required, the token loaded once, the
 * registry loaded with expired entries dropped. Logs go to `<stateDir>/receiver.log`, and no line
 * names the home path — only the `ownerHash` prefix (FR-A2).
 * @param {ReturnType<typeof parseArgs>} args
 */
function startShared(args) {
  if (!args.ownerHome || !args.stateDir) {
    exitStartupFailure('shared mode needs --owner-home / ARTISYN_OTEL_OWNER_HOME and --state-dir / ARTISYN_OTEL_STATE_DIR — refusing to start');
  }
  runtime.shared = true;
  runtime.ownerHome = path.resolve(args.ownerHome);
  runtime.ownerHash = ownerHash(runtime.ownerHome);
  runtime.stateDir = path.resolve(args.stateDir);
  runtime.logFilePath = path.join(runtime.stateDir, STATE_LOG_FILE);
  runtime.port = args.port;
  runtime.idleTimeoutMs = args.idleTimeoutMs;
  runtime.maxBodyBytes = args.maxBodyBytes;

  runtime.token = readSharedToken(runtime.stateDir);
  if (!runtime.token) {
    // Not an error: the installer has not written the token yet (or it was removed by an
    // uninstall). Nothing can authenticate, so there is nothing to serve.
    receiverLog('no-token', `no valid ${STATE_TOKEN_FILE} in the state dir — shared receiver not started`);
    process.exit(0);
  }

  loadRegistry();
  refreshForwardConfig();

  listen(() => {
    receiverLog('start',
      `listening on 127.0.0.1:${runtime.port} mode=shared ownerHash=${runtime.ownerHash.slice(0, 12)} ` +
      `receiverVersion=${getReceiverVersion() || 'unknown'} sessions=${registry.size} ` +
      `idleTimeoutMs=${runtime.idleTimeoutMs} maxBodyBytes=${runtime.maxBodyBytes} pid=${process.pid} ` +
      `rtReceiverId=${rt.receiverId}`);
  });
}

/**
 * Bind `127.0.0.1:<runtime.port>` and start serving; `onListening` logs the start line. Common to
 * both modes.
 * @param {() => void} onListening
 */
function listen(onListening) {
  // Logging and continuing is the right trade: an unexpected throw somewhere outside a request
  // handler must not silently take down a receiver that the rest of the session depends on.
  process.on('uncaughtException', (err) => {
    receiverLog('uncaught', err && err.stack ? err.stack : String(err));
  });

  const server = http.createServer((req, res) => {
    runtime.lastRequestAt = Date.now();
    armIdleTimer();
    // A client that vanishes mid-request emits 'error' on the request stream; without a listener
    // that is an uncaught exception.
    req.on('error', () => {
      discardBody(req);
    });
    try {
      handleRequest(req, res);
    } catch (err) {
      receiverLog('error', `request handler failed: ${err && err.message ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, error: 'internal-error' });
    }
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      // The normal path when a second session of the same project starts: one receiver already
      // serves every session of its project. Logged once per run of such exits: a repeat right
      // after another `addr-in-use` line carries no news and only buries the useful lines.
      if (lastLogEvent() !== 'addr-in-use') {
        receiverLog('addr-in-use', `port ${runtime.port} already bound — another receiver is serving this project, exiting (repeats suppressed until the next other line)`);
      }
      process.exit(0);
    }
    receiverLog('listen-error', `cannot listen on 127.0.0.1:${runtime.port}: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });

  server.listen({ host: '127.0.0.1', port: runtime.port }, () => {
    onListening();
    armIdleTimer();
    startSweepTimer();
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  parseOwner,
  isValidSessionId,
  attrValue,
  flattenAttributes,
  walkLogs,
  walkMetrics,
  walkSpans,
  getReceiverVersion,
  readRealtimeTarget,
  nextRealtimeDelay,
  OTLP_TRACES_PATH,
  RT_ROUTE,
  RT_MIN_INTERVAL_MS,
  RT_REQUEST_TIMEOUT_MS,
  RT_MAX_BATCH_BYTES,
  RT_MAX_LINE_BYTES,
  RT_BUFFER_MAX_LINES,
  RT_GZIP_MIN_BYTES,
  RT_BACKOFF_BASE_MS,
  RT_BACKOFF_MAX_MS,
  RT_DISABLE_MS,
  RT_SHUTDOWN_FLUSH_MS,
  normalizeGitRoot,
  normalizeForKey,
  repoKey,
  ownerHash,
  SHUTDOWN_PATH,
  DEFAULT_PORT,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  RECEIVER_LOG_MAX_BYTES,
  METRIC_CONTAINERS,
  SESSION_ID_ATTR,
  SWEEP_INTERVAL_MS,
  SWEEP_QUIET_MS,
  // shared mode (hook 2.30.0+)
  computeHelloProof,
  computeAuthMac,
  parseAuthHeader,
  createNonceStore,
  pruneRegistry,
  isAllowedUploader,
  normalizeSignals,
  validateRegisterPayload,
  collectLogs,
  collectMetrics,
  collectSpans,
  withHookVersion,
  routeRecord,
  parseReposFile,
  // pending spool; exported as the test seam of the otel-shared-routing table test
  addPending,
  takePending,
  pendingSpool,
  PENDING_NO_SESSION_KEY,
  SESSION_STATUS_PATH,
  HELLO_PATH,
  REGISTER_PATH,
  AUTH_HEADER,
  EXIT_USAGE,
  SHARED_IDLE_TIMEOUT_MS,
  REGISTER_CONTRACT,
  CAPABILITIES,
  NONCE_TTL_MS,
  NONCE_MAX,
  REGISTRY_TTL_MS,
  REGISTRY_PERSIST_DEBOUNCE_MS,
  PENDING_TTL_MS,
  PENDING_MAX_RECORDS,
  FORWARD_QUEUE_MAX_REQUESTS,
  FORWARD_QUEUE_MAX_BYTES,
  FORWARD_BACKOFF_MIN_MS,
  FORWARD_BACKOFF_MAX_MS,
  FORWARD_MAX_ATTEMPTS,
  FORWARD_DEGRADED_WINDOW_MS,
  REPO_ATTR_KEY,
  forwardHeaders,
  forwardHealth,
  parseForwardConfig,
  forwardBackoffMs,
};
