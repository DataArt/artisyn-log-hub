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
 *   POST /artisyn/register  the hook announcing itself (owner check)
 *
 * Records are demultiplexed by their `session.id` attribute and written as NDJSON to
 * `<otelDir>/<session-id>/<epochMs>-<seq>.jsonl` (see writeBatch for why the session id is a
 * directory), which `send-logs-hook.js` later uploads as `type=otel`.
 *
 * Invocation (every parameter is available as **both** argv and env — argv first, env fallback.
 * A hook <= 2.5.1 launches this through a Windows VBScript command line that carries env only, so
 * both forms must keep working; see spawn-hidden.js):
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
 * Deliberate constraints:
 *   - **Node built-ins only** (`http`, `fs`, `path`, `zlib`) and **no `require` of any other hook
 *     module**: `env-context.js` and `hook-log.js` both resolve a git root from a cwd, and this
 *     process has no meaningful cwd (it is detached and long-lived). Everything it needs is
 *     passed in. Diagnostics therefore go to `<otelDir>/receiver.log`, not `hook.log`.
 *   - One receiver per project directory. A second instance for the same project fails to bind
 *     and exits 0 — the first one already serves every session of that project.
 *   - It self-exits after `idleTimeoutMs` without a request of any kind, so a closed editor never
 *     leaves a listener behind.
 */

const fs = require('fs');
const http = require('http');
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
const REGISTER_PATH = '/artisyn/register';
const KNOWN_PATHS = [OTLP_LOGS_PATH, OTLP_METRICS_PATH, REGISTER_PATH];

// The only body encoding this receiver accepts, checked before the body is read. The installer
// writes `OTEL_EXPORTER_OTLP_COMPRESSION=none`, but gzip/deflate stay supported so a user who
// overrides it is not silently dropped.
const SUPPORTED_ENCODINGS = ['gzip', 'deflate'];

// An OTLP metric carries its datapoints in exactly one of these containers. All five are walked
// so that a payload using an unexpected one is not silently dropped.
const METRIC_CONTAINERS = ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary'];

// Attribute value fields in OTLP/JSON, in the order Design Decision 7 resolves them. Note that
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
};

const ENV_FALLBACKS = {
  port: 'ARTISYN_OTEL_PORT',
  idleTimeoutMs: 'ARTISYN_OTEL_IDLE_TIMEOUT_MS',
  maxBodyBytes: 'ARTISYN_OTEL_MAX_BODY_BYTES',
  dir: 'ARTISYN_OTEL_DIR',
  owner: 'ARTISYN_OTEL_OWNER_JSON',
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
 * @param {string[]} argv - typically `process.argv.slice(2)`
 * @param {Record<string, *>} env - typically `process.env`
 * @returns {{ port: number, idleTimeoutMs: number, maxBodyBytes: number, dir: string|null,
 *   owner: { gitRoot: string, repo: string }|null }}
 */
function parseArgs(argv, env) {
  const source = env || {};
  const raw = {};
  const list = Array.isArray(argv) ? argv : [];

  for (let i = 0; i < list.length; i++) {
    const field = ARGV_FLAGS[list[i]];
    if (field && i + 1 < list.length) {
      raw[field] = list[i + 1];
      i++;
    }
  }

  const pick = (field) => (raw[field] !== undefined ? raw[field] : source[ENV_FALLBACKS[field]]);

  const dir = pick('dir');

  return {
    port: parsePositiveInt(pick('port'), DEFAULT_PORT, 65535),
    idleTimeoutMs: parsePositiveInt(pick('idleTimeoutMs'), DEFAULT_IDLE_TIMEOUT_MS),
    maxBodyBytes: parsePositiveInt(pick('maxBodyBytes'), DEFAULT_MAX_BODY_BYTES),
    dir: typeof dir === 'string' && dir.trim() ? dir.trim() : null,
    owner: parseOwner(pick('owner')),
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
 * Walk an `ExportLogsServiceRequest`, producing one `signal:"logs"` line per log record grouped by
 * session id. Records whose session id does not resolve are counted and dropped — never written
 * to a shared "unknown" file, since a line must belong to exactly one session.
 *
 * Every level is defensively typed: this is unauthenticated input.
 * @param {*} payload
 * @param {string} receivedAt - ISO receive time; never substituted for the record's own timestamps
 * @returns {{ groups: Map<string, string[]>, kept: number, dropped: number }}
 */
function walkLogs(payload, receivedAt) {
  const groups = new Map();
  let kept = 0;
  let dropped = 0;

  const resourceLogs = payload && Array.isArray(payload.resourceLogs) ? payload.resourceLogs : [];
  for (const resourceEntry of resourceLogs) {
    if (!resourceEntry || typeof resourceEntry !== 'object') continue;
    const resourceAttributes = resourceEntry.resource ? resourceEntry.resource.attributes : null;
    const resource = flattenAttributes(resourceAttributes);
    const scopeLogs = Array.isArray(resourceEntry.scopeLogs) ? resourceEntry.scopeLogs : [];

    for (const scopeEntry of scopeLogs) {
      if (!scopeEntry || typeof scopeEntry !== 'object') continue;
      const scope = normalizeScope(scopeEntry.scope);
      const records = Array.isArray(scopeEntry.logRecords) ? scopeEntry.logRecords : [];

      for (const record of records) {
        if (!record || typeof record !== 'object') {
          dropped++;
          continue;
        }
        const sessionId = resolveSessionId(record.attributes, resourceAttributes);
        if (!sessionId) {
          dropped++;
          continue;
        }
        pushLine(groups, sessionId, { signal: 'logs', receivedAt, resource, scope, record });
        kept++;
      }
    }
  }

  return { groups, kept, dropped };
}

/**
 * Walk an `ExportMetricsServiceRequest`, producing one `signal:"metrics"` line per datapoint.
 * A metric carries its datapoints in exactly one of `METRIC_CONTAINERS`; all five are checked, and
 * the container name is carried through as the line's `metric.type`.
 * @param {*} payload
 * @param {string} receivedAt
 * @returns {{ groups: Map<string, string[]>, kept: number, dropped: number }}
 */
function walkMetrics(payload, receivedAt) {
  const groups = new Map();
  let kept = 0;
  let dropped = 0;

  const resourceMetrics = payload && Array.isArray(payload.resourceMetrics) ? payload.resourceMetrics : [];
  for (const resourceEntry of resourceMetrics) {
    if (!resourceEntry || typeof resourceEntry !== 'object') continue;
    const resourceAttributes = resourceEntry.resource ? resourceEntry.resource.attributes : null;
    const resource = flattenAttributes(resourceAttributes);
    const scopeMetrics = Array.isArray(resourceEntry.scopeMetrics) ? resourceEntry.scopeMetrics : [];

    for (const scopeEntry of scopeMetrics) {
      if (!scopeEntry || typeof scopeEntry !== 'object') continue;
      const scope = normalizeScope(scopeEntry.scope);
      const metrics = Array.isArray(scopeEntry.metrics) ? scopeEntry.metrics : [];

      for (const metric of metrics) {
        if (!metric || typeof metric !== 'object') {
          dropped++;
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
              dropped++;
              continue;
            }
            const sessionId = resolveSessionId(dataPoint.attributes, resourceAttributes);
            if (!sessionId) {
              dropped++;
              continue;
            }
            pushLine(groups, sessionId, {
              signal: 'metrics',
              receivedAt,
              resource,
              scope,
              metric: envelope,
              dataPoint,
            });
            kept++;
          }
        }
      }
    }
  }

  return { groups, kept, dropped };
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
 * @param {Map<string, string[]>} groups
 * @returns {{ sessions: number, failed: number }}
 */
function writeGroups(groups) {
  let sessions = 0;
  let failed = 0;
  const stamp = Date.now();
  for (const [sessionId, lines] of groups) {
    const sessionDir = path.join(runtime.otelDir, sessionId);
    const base = `${stamp}-${String(chunkSeq++).padStart(6, '0')}`;
    const tempPath = path.join(sessionDir, `${base}.tmp`);
    const target = path.join(sessionDir, `${base}.jsonl`);
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(tempPath, lines.join(''), 'utf8');
      fs.renameSync(tempPath, target);
      sessions++;
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
  return { sessions, failed };
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
};

let idleTimer = null;

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
  const flat = String(message === undefined || message === null ? '' : message)
    .replace(/\s*\r?\n\s*/g, ' ')
    .trim();
  const line = `${new Date().toISOString()} ${event} ${flat}\n`;

  if (!runtime.logFilePath) {
    try {
      process.stderr.write(line);
    } catch {
      // stderr may be closed on the detached launch path — nothing else to try
    }
    return;
  }

  try {
    try {
      const stat = fs.statSync(runtime.logFilePath);
      if (stat.size >= RECEIVER_LOG_MAX_BYTES) fs.writeFileSync(runtime.logFilePath, '', 'utf8');
    } catch {
      // not created yet — the append below creates it
    }
    fs.appendFileSync(runtime.logFilePath, line, 'utf8');
  } catch {
    try {
      process.stderr.write(line);
    } catch {
      // best effort only
    }
  }
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
    receiverLog('idle-exit', `no request for ${runtime.idleTimeoutMs}ms — exiting`);
    process.exit(0);
  }, runtime.idleTimeoutMs);
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
 * Read the request body, enforcing Design Decision 5's cap on **wire** bytes (before any
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
 * @param {string} route - `/v1/logs` or `/v1/metrics`
 * @param {*} payload - the parsed OTLP/JSON request
 * @param {number} wireBytes
 * @param {import('http').ServerResponse} res
 */
function handleOtlp(route, payload, wireBytes, res) {
  const receivedAt = new Date().toISOString();
  const signal = route === OTLP_METRICS_PATH ? 'metrics' : 'logs';
  const walked = signal === 'metrics' ? walkMetrics(payload, receivedAt) : walkLogs(payload, receivedAt);
  const written = writeGroups(walked.groups);

  receiverLog('ingest',
    `signal=${signal} bytes=${wireBytes} sessions=${written.sessions} records=${walked.kept} ` +
    `dropped=${walked.dropped} writeErrors=${written.failed}`);

  // The OTLP/HTTP success shape. Records dropped for an unresolvable session id are deliberately
  // not reported as a partial success: they are our filing problem, not the exporter's.
  sendJson(res, 200, { partialSuccess: {} });
}

/**
 * Serve `POST /artisyn/register` — the hook announcing itself, and the only place a port collision
 * between two projects becomes visible (Design Decision 6).
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
 * Route and serve one request, per Design Decision 5's status-code table.
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

  if (!KNOWN_PATHS.includes(route)) {
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
      let payload;
      try {
        payload = JSON.parse(decodeBody(body, encoding).toString('utf8'));
      } catch {
        // A gunzip failure is deliberately treated the same as unparseable JSON.
        sendJson(res, 400, { ok: false, error: 'invalid-json' });
        return;
      }

      if (route === REGISTER_PATH) handleRegister(payload, res);
      else handleOtlp(route, payload, body.length, res);
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
  const args = parseArgs(process.argv.slice(2), process.env);

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

  // Logging and continuing is the right trade: an unexpected throw somewhere outside a request
  // handler must not silently take down a receiver that the rest of the session depends on.
  process.on('uncaughtException', (err) => {
    receiverLog('uncaught', err && err.stack ? err.stack : String(err));
  });

  const server = http.createServer((req, res) => {
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
      // serves every session of its project.
      receiverLog('addr-in-use', `port ${runtime.port} already bound — another receiver is serving this project, exiting`);
      process.exit(0);
    }
    receiverLog('listen-error', `cannot listen on 127.0.0.1:${runtime.port}: ${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  });

  server.listen({ host: '127.0.0.1', port: runtime.port }, () => {
    receiverLog('start',
      `listening on 127.0.0.1:${runtime.port} dir=${runtime.otelDir} owner=${runtime.owner.gitRoot} ` +
      `ownerRepo=${runtime.owner.repo} idleTimeoutMs=${runtime.idleTimeoutMs} ` +
      `maxBodyBytes=${runtime.maxBodyBytes} pid=${process.pid}`);
    armIdleTimer();
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
  getReceiverVersion,
  normalizeGitRoot,
  DEFAULT_PORT,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  RECEIVER_LOG_MAX_BYTES,
  METRIC_CONTAINERS,
  SESSION_ID_ATTR,
};
