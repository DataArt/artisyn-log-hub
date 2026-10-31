'use strict';
/**
 * Claude Code Hook helper — reader of the admin-managed Claude Code settings that touch OTEL (not a
 * hook entry point itself).
 *
 * Managed settings win over every other scope, key by key. When an admin pins an OTLP endpoint or
 * switches telemetry off there, nothing the installer writes can bring OTEL data to Log Hub, and the
 * session's `otel-status` must say so (`managed-endpoint` / `managed-disabled`, see otel-status.js).
 *
 * Sources, highest precedence first (DD-12):
 *
 *   remote   `<claudeConfigDir>/remote-settings.json` — the server-managed settings cache
 *   policy   win32: `reg query HKLM\SOFTWARE\Policies\ClaudeCode /v Settings` (a JSON string)
 *            darwin: `/Library/Managed Preferences/com.anthropic.claudecode.plist` via `plutil`
 *   file     win32: `%ProgramFiles%\ClaudeCode\managed-settings.json`
 *            darwin: `/Library/Application Support/ClaudeCode/managed-settings.json`
 *            linux: `/etc/claude-code/managed-settings.json`
 *   policy   win32 only: `HKCU\SOFTWARE\Policies\ClaudeCode` value `Settings` (lowest)
 *
 * `ARTISYN_MANAGED_SETTINGS_DIR` (test-only) replaces the file location with
 * `<dir>/managed-settings.json` and disables both OS-policy reads.
 *
 * Per-signal rules, verified by the PoC (docs/pocs/2026-10-30-2327-otel-user-scope-behaviour, items
 * 7–8): a managed endpoint overrides per key, so a managed logs-only endpoint takes logs while
 * metrics and traces still reach the receiver.
 *  - pinned:   the managed scope sets the signal's endpoint, or the generic
 *              `OTEL_EXPORTER_OTLP_ENDPOINT` (assumed to cover every signal).
 *  - disabled: managed `CLAUDE_CODE_ENABLE_TELEMETRY` is `0`/`false` (every signal), or the signal's
 *              managed exporter is `none`. A disabled signal is never also reported as pinned.
 *
 * Fail-silent per source: a missing, unreadable or malformed source is just absent. Never throws.
 * Node built-ins only. TS twin: `artisyn-hooks-installer/src/managed-settings.ts`.
 */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each OS-policy probe is bounded so a slow `reg`/`plutil` can never stall a hook. Twin:
// `managed-settings.ts`.
const OS_POLICY_TIMEOUT_MS = 1500;

const MANAGED_FILE_NAME = 'managed-settings.json';
const REMOTE_SETTINGS_FILE_NAME = 'remote-settings.json';
const WIN_POLICY_KEY_SUFFIX = 'SOFTWARE\\Policies\\ClaudeCode';
const DARWIN_POLICY_PLIST = '/Library/Managed Preferences/com.anthropic.claudecode.plist';

// The OTEL signals, named like the receiver's `received` counters.
const SIGNALS = ['logs', 'metrics', 'spans'];

const SIGNAL_ENDPOINT_KEYS = {
  logs: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  metrics: 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  spans: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
};
const SIGNAL_EXPORTER_KEYS = {
  logs: 'OTEL_LOGS_EXPORTER',
  metrics: 'OTEL_METRICS_EXPORTER',
  spans: 'OTEL_TRACES_EXPORTER',
};
const GENERIC_ENDPOINT_KEY = 'OTEL_EXPORTER_OTLP_ENDPOINT';
const ENABLE_TELEMETRY_KEY = 'CLAUDE_CODE_ENABLE_TELEMETRY';

/**
 * Whether an env key is one this reader reports: every `OTEL_*` key plus the telemetry switch.
 * @param {string} key
 * @returns {boolean}
 */
function isOtelKey(key) {
  return key === ENABLE_TELEMETRY_KEY || key.startsWith('OTEL_');
}

/**
 * The OTEL subset of a settings object's `env`, string values only (numbers/booleans stringified).
 * @param {*} settings
 * @returns {Record<string, string>}
 */
function otelEnvOf(settings) {
  const env = settings && typeof settings === 'object' ? settings.env : null;
  const out = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return out;
  for (const [key, value] of Object.entries(env)) {
    if (!isOtelKey(key)) continue;
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

/**
 * Parse JSON text into a plain object, else `null`.
 * @param {string} text
 * @returns {Record<string, *>|null}
 */
function parseObject(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} file
 * @returns {Record<string, *>|null}
 */
function readSettingsFile(file) {
  try {
    return parseObject(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The `Settings` value out of `reg query … /v Settings` output, parsed as JSON.
 * @param {string} output
 * @returns {Record<string, *>|null}
 */
function parseRegQueryOutput(output) {
  const match = /^\s*Settings\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/m.exec(String(output || ''));
  return match ? parseObject(match[1].trim()) : null;
}

/**
 * @param {'HKLM'|'HKCU'} hive
 * @returns {Record<string, *>|null}
 */
function readWindowsPolicy(hive) {
  try {
    const output = childProcess.execFileSync('reg', ['query', `${hive}\\${WIN_POLICY_KEY_SUFFIX}`, '/v', 'Settings'], {
      encoding: 'utf8',
      timeout: OS_POLICY_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRegQueryOutput(output);
  } catch {
    return null;
  }
}

/**
 * @returns {Record<string, *>|null}
 */
function readDarwinPolicy() {
  try {
    if (!fs.existsSync(DARWIN_POLICY_PLIST)) return null;
    const output = childProcess.execFileSync('plutil', ['-convert', 'json', '-o', '-', DARWIN_POLICY_PLIST], {
      encoding: 'utf8',
      timeout: OS_POLICY_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseObject(output);
  } catch {
    return null;
  }
}

/**
 * The managed-settings.json location for this platform.
 * @param {string} platform
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function managedFilePath(platform, env) {
  const override = typeof env.ARTISYN_MANAGED_SETTINGS_DIR === 'string' ? env.ARTISYN_MANAGED_SETTINGS_DIR.trim() : '';
  if (override) return path.join(path.resolve(override), MANAGED_FILE_NAME);
  if (platform === 'win32') {
    const programFiles = (env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files').trim();
    return path.win32.join(programFiles, 'ClaudeCode', MANAGED_FILE_NAME);
  }
  if (platform === 'darwin') return path.posix.join('/Library/Application Support/ClaudeCode', MANAGED_FILE_NAME);
  if (platform === 'linux') return path.posix.join('/etc/claude-code', MANAGED_FILE_NAME);
  return null;
}

/**
 * `$CLAUDE_CONFIG_DIR` when set, else `<homeDir>/.claude`.
 * @param {string|undefined} homeDir
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function claudeDirFor(homeDir, env) {
  const custom = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return custom ? path.resolve(custom) : path.join(homeDir || os.homedir(), '.claude');
}

/**
 * Whether a value switches telemetry off.
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isFalsy(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '0' || v === 'false';
}

/**
 * Pinned and disabled signals of a merged managed OTEL env (pure; table-tested).
 * @param {Record<string, string>} managedEnv
 * @returns {{ pinnedSignals: string[], disabledSignals: string[] }}
 */
function classifyManagedEnv(managedEnv) {
  const env = managedEnv || {};
  const allOff = isFalsy(env[ENABLE_TELEMETRY_KEY]);
  const disabledSignals = SIGNALS.filter((signal) => {
    if (allOff) return true;
    const exporter = env[SIGNAL_EXPORTER_KEYS[signal]];
    return typeof exporter === 'string' && exporter.trim().toLowerCase() === 'none';
  });
  const hasValue = (key) => typeof env[key] === 'string' && env[key].trim() !== '';
  const pinnedSignals = SIGNALS.filter((signal) => !disabledSignals.includes(signal)
    && (hasValue(SIGNAL_ENDPOINT_KEYS[signal]) || hasValue(GENERIC_ENDPOINT_KEY)));
  return { pinnedSignals, disabledSignals };
}

/**
 * Read every managed source and merge their OTEL keys (higher source wins per key).
 * @param {{ homeDir?: string, env?: Record<string, string|undefined>, platform?: string }} [opts]
 * @returns {{
 *   sources: { kind: 'remote'|'policy'|'file', label: string, env: Record<string, string> }[],
 *   env: Record<string, string>,
 *   pinnedSignals: string[],
 *   disabledSignals: string[],
 * }}
 */
function readManagedOtel(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const override = typeof env.ARTISYN_MANAGED_SETTINGS_DIR === 'string' && env.ARTISYN_MANAGED_SETTINGS_DIR.trim() !== '';
  const sources = [];
  const add = (kind, label, settings) => {
    try {
      if (!settings) return;
      const otel = otelEnvOf(settings);
      if (Object.keys(otel).length > 0) sources.push({ kind, label, env: otel });
    } catch {
      // fail-silent per source
    }
  };

  add('remote', `${REMOTE_SETTINGS_FILE_NAME} (server-managed)`,
    readSettingsFile(path.join(claudeDirFor(opts.homeDir, env), REMOTE_SETTINGS_FILE_NAME)));
  if (!override && platform === 'win32') add('policy', 'HKLM policy', readWindowsPolicy('HKLM'));
  if (!override && platform === 'darwin') add('policy', 'macOS managed preferences', readDarwinPolicy());
  const file = managedFilePath(platform, env);
  if (file) add('file', MANAGED_FILE_NAME, readSettingsFile(file));
  if (!override && platform === 'win32') add('policy', 'HKCU policy', readWindowsPolicy('HKCU'));

  const merged = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.env)) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return { sources, env: merged, ...classifyManagedEnv(merged) };
}

module.exports = {
  OS_POLICY_TIMEOUT_MS,
  SIGNALS,
  SIGNAL_ENDPOINT_KEYS,
  SIGNAL_EXPORTER_KEYS,
  GENERIC_ENDPOINT_KEY,
  ENABLE_TELEMETRY_KEY,
  isOtelKey,
  otelEnvOf,
  parseRegQueryOutput,
  managedFilePath,
  classifyManagedEnv,
  readManagedOtel,
};
