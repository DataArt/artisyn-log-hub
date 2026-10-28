'use strict';
const fs = require('fs');
const path = require('path');
const {getGitRoot} = require('./git-context');
const {hookLog} = require('./hook-log');

const HOOK_FILE = 'env-context.js';

// Config files are anchored at the git repo root, not at the hook install dir,
// so a repo checked out anywhere still resolves the same two files.
const CONFIG_DIR_SEGMENTS = ['.artisyn', 'config'];
const BASE_CONFIG_NAME = 'log-hub.json';
const LOCAL_CONFIG_NAME = 'log-hub.local.json';
const BASE_CONFIG_LABEL = '.artisyn/config/log-hub.json';
const LOCAL_CONFIG_LABEL = '.artisyn/config/log-hub.local.json';

// A transiently-unreadable file (e.g. mid-write on a slow disk) gets one retry
// before being treated as malformed.
const READ_RETRY_DELAY_MS = 50;

// ---------------------------------------------------------------------------
// Config key defaults + type table
//
// | Key                            | Default   | Type     |
// |---------------------------------|-----------|----------|
// | telemetryDir                    | ''        | string   |
// | jsonCompact                     | false     | boolean  |
// | context                         | []        | array    |
// | serverUrl                       | ''        | string   |
// | sendLogsTimeoutMs               | 10000     | number   |
// | sendLogsOnPromptEnabled         | true      | boolean  |
// | sendLogsOnPromptTimeoutMs       | 60000     | number   |
// | otelEnabled                     | true      | boolean  |
// | otelReceiverPort                | 0         | number   |
// | otelReceiverIdleTimeoutMs       | 600000    | number   |
// | otelReceiverMaxBodyKb           | 8192      | number   |
// | otelRetentionDays               | 7         | number   |
// | mcpProbeTimeoutMs               | 3000      | number   |
// | turnEndCostAdvisorModel          | 'sonnet'  | string   |
// | turnEndCostAdvisorLlmTimeoutMs   | 600000    | number   |
// | turnEndCostAdvisorMaxPromptSizeKb| 60        | number   |
// | sessionAttributionMaxPromptSizeKb| 60        | number   |
// | sessionAttributionLlmModel       | 'haiku'   | string   |
// | sessionAttributionLlmTimeoutMs   | 600000    | number   |
// | okf                              | {exclude:[]} | object |
//
// `okf` (hook 2.26.0+) configures the OKF knowledge-base snapshot (`okf-snapshot.js`):
// `okf.exclude` is a list of repo-relative globs (`**`, `*`, `?`) whose files/folders are never
// scanned for bundles. Like every top-level key, `log-hub.local.json`'s `okf` replaces
// `log-hub.json`'s whole object (shallow merge) — the two `exclude` lists are not concatenated.
// A non-array `exclude` is dropped (treated as `[]`) with one warn line. The built-in
// `tmp/**` exclusion lives in `okf-snapshot.js` and is always applied on top of this list.
//
// The 6 keys above configure `post-turn-analysis-worker.js`'s advisor/attribution
// branches — see that file's own header comment for what each gates. Their timeout defaults are
// 10 minutes: both branches run detached, off the interactive path, and their
// `claude -p` evaluation may itself read several files/skills worth of context, so nothing here
// is waiting on a blocked user turn.
//
// The `guardrail*` keys of hooks before 2.19.0 (the removed PreToolUse guardrail) are no longer
// listed: an old config that still carries them gets them merged through as unknown keys, unused.
//
// `apiKey` and any other key not listed above are not subject to this table:
// they are merged through unchanged (no default, no type coercion).
//
// The numeric `otel*` keys accept `0` here (`matchesType` allows it), but `0` is only
// meaningful for `otelReceiverPort` ("not yet allocated by the installer"). For
// `otelReceiverIdleTimeoutMs`, `otelReceiverMaxBodyKb` and `otelRetentionDays` a `0`
// means "use the default" and is resolved by `resolveOtelNumber()` at each consumer,
// not by a second validation layer inside `matchesType`.
// ---------------------------------------------------------------------------
const CONFIG_DEFAULTS = {
  telemetryDir: '',
  jsonCompact: false,
  context: [],
  serverUrl: '',
  sendLogsTimeoutMs: 10000,
  sendLogsOnPromptEnabled: true,
  sendLogsOnPromptTimeoutMs: 60000,
  otelEnabled: true,
  otelReceiverPort: 0,
  otelReceiverIdleTimeoutMs: 600000,
  otelReceiverMaxBodyKb: 8192,
  otelRetentionDays: 7,
  mcpProbeTimeoutMs: 3000,
  turnEndCostAdvisorModel: 'sonnet',
  turnEndCostAdvisorLlmTimeoutMs: 600000,
  turnEndCostAdvisorMaxPromptSizeKb: 60,
  sessionAttributionMaxPromptSizeKb: 60,
  sessionAttributionLlmModel: 'haiku',
  sessionAttributionLlmTimeoutMs: 600000,
  okf: { exclude: [] },
};

const CONFIG_TYPES = {
  telemetryDir: 'string',
  jsonCompact: 'boolean',
  context: 'array',
  serverUrl: 'string',
  sendLogsTimeoutMs: 'number',
  sendLogsOnPromptEnabled: 'boolean',
  sendLogsOnPromptTimeoutMs: 'number',
  otelEnabled: 'boolean',
  otelReceiverPort: 'number',
  otelReceiverIdleTimeoutMs: 'number',
  otelReceiverMaxBodyKb: 'number',
  otelRetentionDays: 'number',
  mcpProbeTimeoutMs: 'number',
  turnEndCostAdvisorModel: 'string',
  turnEndCostAdvisorLlmTimeoutMs: 'number',
  turnEndCostAdvisorMaxPromptSizeKb: 'number',
  sessionAttributionMaxPromptSizeKb: 'number',
  sessionAttributionLlmModel: 'string',
  sessionAttributionLlmTimeoutMs: 'number',
  okf: 'object',
};

function matchesType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      // A plain JSON object: not null, not an array.
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'number':
      // Reject NaN/Infinity and negative numbers (a negative timeout/size is
      // never meaningful for any of today's numeric keys).
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    default:
      return true;
  }
}

/**
 * Coerce a single merged raw value against the documented default/type table.
 * `null`/`undefined` -> default, silently (an "absent" key is expected and not a
 * misconfiguration). Present-but-wrong-type/out-of-range -> default + one
 * `hookLog(..., 'warn', ...)` line naming `fileLabel` and `key`. Keys that are not
 * part of `CONFIG_DEFAULTS` (e.g. `apiKey`) are returned unchanged, uncoerced.
 * @param {string} key
 * @param {*} value - the merged raw value for this key (before defaulting)
 * @param {string} fileLabel - display label of the file this value came from
 * @param {string|null} cwd
 * @returns {*}
 */
function coerceConfigValue(key, value, fileLabel, cwd) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) return value;
  if (value === null || value === undefined) return cloneDefault(key);

  const type = CONFIG_TYPES[key];
  if (matchesType(value, type)) {
    return key === 'okf' ? normalizeOkfConfig(value, fileLabel, cwd) : value;
  }

  let shown;
  try {
    shown = JSON.stringify(value);
  } catch {
    shown = String(value);
  }
  hookLog(
    HOOK_FILE,
    null,
    'warn',
    `${fileLabel}: invalid value for "${key}" (${shown}) — falling back to default ${JSON.stringify(CONFIG_DEFAULTS[key])}`,
    cwd,
  );
  return cloneDefault(key);
}

/**
 * The default for `key`; object/array defaults are cloned so a caller mutating its config can
 * never change `CONFIG_DEFAULTS` for the rest of the process.
 * @param {string} key
 * @returns {*}
 */
function cloneDefault(key) {
  const value = CONFIG_DEFAULTS[key];
  if (value !== null && typeof value === 'object') return JSON.parse(JSON.stringify(value));
  return value;
}

/**
 * Normalise an `okf` object (already known to be a plain object): `exclude` absent -> `[]`;
 * present but not an array -> `[]` plus one warn line; non-string or blank entries are dropped.
 * Other sub-keys are kept as they are (an older hook ignores them, a newer one may read them).
 * @param {Record<string, *>} value
 * @param {string} fileLabel
 * @param {string|null} cwd
 * @returns {Record<string, *> & {exclude: string[]}}
 */
function normalizeOkfConfig(value, fileLabel, cwd) {
  const raw = value.exclude;
  let exclude = [];
  if (Array.isArray(raw)) {
    exclude = raw.filter((p) => typeof p === 'string' && p.trim() !== '');
  } else if (raw !== undefined && raw !== null) {
    let shown;
    try {
      shown = JSON.stringify(raw);
    } catch {
      shown = String(raw);
    }
    hookLog(HOOK_FILE, null, 'warn',
      `${fileLabel}: invalid value for "okf.exclude" (${shown}) — expected an array of globs, ignoring it`, cwd);
  }
  return {...value, exclude};
}

// ---------------------------------------------------------------------------
// Synchronous sleep (used only for the single read retry below)
// ---------------------------------------------------------------------------
function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable in this runtime — fall back to a busy-wait.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

/**
 * Read + parse one JSON config file, with:
 *  - a missing file (ENOENT) treated as silently absent (no warn)
 *  - any other read error retried once after ~50ms, then treated as malformed
 *  - malformed JSON, or a non-object JSON root, treated as malformed
 * A malformed file logs exactly one [warn] line and is treated as an empty object
 * (every key it would have contributed instead falls through to its default, unless
 * the other config file supplies that key).
 * @param {string} filePath
 * @param {string} fileLabel
 * @param {string|null} cwd
 * @returns {{data: Record<string, *>, found: boolean}}
 */
function readRawConfigFile(filePath, fileLabel, cwd) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {data: {}, found: false};
    }
    sleepSync(READ_RETRY_DELAY_MS);
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err2) {
      if (err2 && err2.code === 'ENOENT') {
        return {data: {}, found: false};
      }
      hookLog(HOOK_FILE, null, 'warn',
        `${fileLabel} could not be read (${err2.message}) — using defaults for this file`, cwd);
      return {data: {}, found: true};
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    hookLog(HOOK_FILE, null, 'warn',
      `${fileLabel} is not valid JSON (${err.message}) — using defaults for this file`, cwd);
    return {data: {}, found: true};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    hookLog(HOOK_FILE, null, 'warn',
      `${fileLabel} root is not a JSON object — using defaults for this file`, cwd);
    return {data: {}, found: true};
  }
  return {data: parsed, found: true};
}

/**
 * Shallow-merge local over base: local overrides base per top-level key, except that
 * `null` in local means "absent" and falls through to base's own value for that key.
 * @param {Record<string, *>} base
 * @param {Record<string, *>} local
 * @returns {Record<string, *>}
 */
function shallowMergeConfigs(base, local) {
  const merged = {...base};
  for (const [key, value] of Object.entries(local)) {
    if (value === null) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Whether local's own value should be treated as the source for `key` (present, non-null).
 * @param {Record<string, *>} local
 * @param {string} key
 * @returns {boolean}
 */
function localOwnsKey(local, key) {
  return Object.prototype.hasOwnProperty.call(local, key) && local[key] !== null;
}

/**
 * Load and merge `.artisyn/config/log-hub.json` + `.artisyn/config/log-hub.local.json`,
 * anchored at the git repo root for `cwd`. Returns one plain config object with every
 * documented key present (defaulted/coerced per `CONFIG_DEFAULTS`/`CONFIG_TYPES`) plus
 * any unrecognized keys (e.g. `apiKey`) passed through unchanged. No memoisation: each
 * call re-reads from disk.
 * @param {string|null} [cwd]
 * @returns {Record<string, *>}
 */
function loadConfig(cwd) {
  const base = cwd || process.cwd();
  const root = getGitRoot(base);
  const configDir = path.join(root, ...CONFIG_DIR_SEGMENTS);
  const baseFilePath = path.join(configDir, BASE_CONFIG_NAME);
  const localFilePath = path.join(configDir, LOCAL_CONFIG_NAME);

  const baseResult = readRawConfigFile(baseFilePath, BASE_CONFIG_LABEL, cwd);
  const localResult = readRawConfigFile(localFilePath, LOCAL_CONFIG_LABEL, cwd);

  if (!baseResult.found && !localResult.found) {
    hookLog(HOOK_FILE, null, 'warn',
      `neither ${BASE_CONFIG_LABEL} nor ${LOCAL_CONFIG_LABEL} was found under the git root — ` +
      'running on hook defaults; telemetryDir/serverUrl settings are unconfigured', cwd);
  }

  const merged = shallowMergeConfigs(baseResult.data, localResult.data);

  const config = {};
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    const fileLabel = localOwnsKey(localResult.data, key) ? LOCAL_CONFIG_LABEL : BASE_CONFIG_LABEL;
    config[key] = coerceConfigValue(key, merged[key], fileLabel, cwd);
  }
  // Unrecognized keys (e.g. apiKey) survive unchanged.
  for (const key of Object.keys(merged)) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
      config[key] = merged[key];
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Telemetry directory resolution
// ---------------------------------------------------------------------------
function resolveTelemetryDir(cwd, config) {
  const configVal = (config && typeof config.telemetryDir === 'string' ? config.telemetryDir : '').trim();
  const root = getGitRoot(cwd || process.cwd());
  if (configVal) {
    return path.isAbsolute(configVal) ? configVal : path.resolve(root, configVal);
  }
  return path.resolve(root, '.artisyn', 'ai_work_dir', 'telemetry');
}

// ---------------------------------------------------------------------------
// OTEL receiver: directory, port and numeric-key resolution
// ---------------------------------------------------------------------------

// Never-installed / probe-exhausted fallback for the loopback receiver port. The
// installer normally allocates a random port per project and writes it into both
// `log-hub.json` (`otelReceiverPort`) and `.claude/settings.local.json`'s endpoint URLs
// (older installs wrote them to `.claude/settings.json`);
// this value only applies when it never did. Mirrored (not imported — these files
// cannot require each other) in `otel-receiver.js` and the installer.
const OTEL_FALLBACK_PORT = 25317;

// Only loopback endpoints are ours; anything else means Claude Code is exporting
// somewhere we must not bind.
const OTEL_LOGS_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})\/v1\/logs$/;
const OTEL_METRICS_ENDPOINT_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})\/v1\/metrics$/;

/**
 * The OTEL directory for this project: always `<telemetryDir>/otel`.
 *
 * The project directory is the unit — there is no shared location, no machine-wide
 * mode and deliberately **no env override** (`ARTISYN_OTEL_DIR` exists only as the
 * transport twin of the receiver's `--dir` argv and is never an input here), so two
 * projects can never resolve to the same directory unless the user deliberately
 * points both `telemetryDir`s at one path.
 * @param {string|null} cwd
 * @param {Record<string, *>|null} config
 * @returns {string}
 */
function resolveOtelDir(cwd, config) {
  return path.join(resolveTelemetryDir(cwd, config), 'otel');
}

/**
 * Parse a loopback OTLP endpoint URL into its port.
 * @param {*} value
 * @param {RegExp} re
 * @returns {number|null} a valid 1-65535 port, or null
 */
function parseEndpointPort(value, re) {
  if (typeof value !== 'string') return null;
  const match = re.exec(value.trim());
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * A configured port is usable only when it is a positive integer in range.
 * @param {*} value
 * @returns {number|null}
 */
function normalizeConfiguredPort(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > 65535) return null;
  return value;
}

/**
 * Resolve the loopback port this project's receiver must bind, in precedence order:
 *  1. the port in `env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` — the authority, because
 *     binding anything else means receiving nothing;
 *  2. `config.otelReceiverPort`, when it is a positive integer;
 *  3. `OTEL_FALLBACK_PORT`.
 *
 * Emits at most one `warn` line per case when (1) and (2) disagree, and when the
 * metrics endpoint names a different port than (1) — only one port is bound, and
 * logs win because they carry the events.
 * @param {Record<string, *>|null} config
 * @param {Record<string, *>} [env] - defaults to `process.env`
 * @param {string|null} [cwd] - present solely so the warnings reach `hookLog`
 * @returns {number}
 */
function resolveOtelPort(config, env = process.env, cwd = null) {
  const source = env || {};
  const endpointPort = parseEndpointPort(source.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_LOGS_ENDPOINT_RE);
  const configPort = normalizeConfiguredPort(config ? config.otelReceiverPort : undefined);

  if (endpointPort !== null) {
    if (configPort !== null && configPort !== endpointPort) {
      hookLog(HOOK_FILE, null, 'warn',
        `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT points at port ${endpointPort} but config "otelReceiverPort" is ` +
        `${configPort} — using ${endpointPort}, the port Claude Code actually exports to`, cwd);
    }
    const metricsPort = parseEndpointPort(source.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, OTEL_METRICS_ENDPOINT_RE);
    if (metricsPort !== null && metricsPort !== endpointPort) {
      hookLog(HOOK_FILE, null, 'warn',
        `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT points at port ${metricsPort} but the logs endpoint uses ` +
        `${endpointPort} — only one port is bound, so metrics will not be captured`, cwd);
    }
    return endpointPort;
  }

  if (configPort !== null) return configPort;
  return OTEL_FALLBACK_PORT;
}

// The numeric otel keys for which `0` means "use the default". `otelReceiverPort` is
// deliberately absent: there `0` means "not yet allocated by the installer" and is
// resolved by `resolveOtelPort` instead.
const OTEL_ZERO_MEANS_DEFAULT_KEYS = [
  'otelReceiverIdleTimeoutMs',
  'otelReceiverMaxBodyKb',
  'otelRetentionDays',
];

/**
 * Resolve one of the numeric otel config keys, applying the "`0` means default" rule.
 * `matchesType` accepts `0` for every numeric key, so this is where the three keys for
 * which `0` is meaningless fall back to their documented default. Use this at every
 * consumer of `otelReceiverIdleTimeoutMs` / `otelReceiverMaxBodyKb` / `otelRetentionDays`;
 * do **not** use it for `otelReceiverPort` (see `resolveOtelPort`).
 * @param {Record<string, *>|null} config
 * @param {'otelReceiverIdleTimeoutMs'|'otelReceiverMaxBodyKb'|'otelRetentionDays'} key
 * @returns {number}
 */
function resolveOtelNumber(config, key) {
  const fallback = CONFIG_DEFAULTS[key];
  const value = config ? config[key] : undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

// ---------------------------------------------------------------------------
// context extraction
// ---------------------------------------------------------------------------
function getEnvContext(config) {
  const entries = config && Array.isArray(config.context) ? config.context : null;
  if (!entries || entries.length === 0) return null;

  const ctx = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const rawKey = entry.key;
    if (typeof rawKey !== 'string' || !rawKey.trim()) {
      hookLog(HOOK_FILE, null, 'warn', 'context entry skipped: missing or blank "key"', null);
      continue;
    }
    const key = rawKey.trim().toLowerCase();
    const rawValue = entry.value;
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue);
    ctx[key] = value; // last entry wins on duplicate keys
  }
  return Object.keys(ctx).length ? ctx : null;
}

// ---------------------------------------------------------------------------
// JSON formatting
// ---------------------------------------------------------------------------
function isCompactJson(config) {
  return !!(config && config.jsonCompact === true);
}

module.exports = {
  loadConfig,
  resolveTelemetryDir,
  resolveOtelDir,
  resolveOtelPort,
  resolveOtelNumber,
  getEnvContext,
  isCompactJson,
  CONFIG_DEFAULTS,
  coerceConfigValue,
  OTEL_FALLBACK_PORT,
  OTEL_ZERO_MEANS_DEFAULT_KEYS,
};
