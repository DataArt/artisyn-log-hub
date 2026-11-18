'use strict';
/**
 * Claude Code Hook helper — the Node.js version advisory (FR-16, DD-15; not a hook entry point).
 *
 * Claude Code runs the hooks with the user's own `node` from PATH. Node 18/20 (and every odd line)
 * are end-of-life, and the supported lines (22/24/26) have a security release (`NODE_ADVISORY`) whose
 * patched minimums are in `NODE_PATCHED_MINIMUMS`. `lifecycle-hook.js` shows the warning text on
 * `SessionStart` via `systemMessage`, at most once per 24 h per Node version
 * (`~/.artisyn/node-check.json` `{nodeVersion, shownAt}`). The hooks keep working either way — this
 * only advises.
 *
 * `ARTISYN_NODE_VERSION_OVERRIDE` (test-only) replaces `process.versions.node`.
 *
 * TS twin: `artisyn-hooks-installer/src/node-version.ts` (same table, classification, text and
 * override env; no throttle). Keep both identical.
 *
 * Node built-ins only. Nothing here throws.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Patched minimum per supported even line. */
const NODE_PATCHED_MINIMUMS = Object.freeze({ 22: '22.23.5', 24: '24.22.3', 26: '26.13.1' });

/** The security release the minimums come from. */
const NODE_ADVISORY = 'November 2026';

/** Test-only env var that replaces `process.versions.node`. */
const NODE_VERSION_OVERRIDE_ENV = 'ARTISYN_NODE_VERSION_OVERRIDE';

/** Throttle window for the `SessionStart` warning. */
const NODE_WARNING_INTERVAL_MS = 86400000;

const NODE_CHECK_FILE = 'node-check.json';

const HIGHEST_KNOWN_MAJOR = 26;

/**
 * The Node version to judge: the override env var when set, else `process.versions.node`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function effectiveNodeVersion(env = process.env) {
  const override = env && typeof env[NODE_VERSION_OVERRIDE_ENV] === 'string'
    ? env[NODE_VERSION_OVERRIDE_ENV].trim()
    : '';
  const raw = override || process.versions.node;
  return String(raw).replace(/^v/i, '');
}

/**
 * `[major, minor, patch]` of a version string, or null when it does not start with `N.N.N`
 * (missing minor/patch count as 0).
 * @param {string} v
 * @returns {number[]|null}
 */
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** @returns {number} negative, 0 or positive */
function compareParts(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Classify a Node version.
 *  - major < 22, or an odd major ≤ 26 → `eol`;
 *  - a major in `NODE_PATCHED_MINIMUMS` below its minimum → `unpatched`;
 *  - major > 26 (or an unparsable version) → `unknown`;
 *  - otherwise `ok`.
 * @param {string} v
 * @returns {{ status: 'ok'|'unpatched'|'eol'|'unknown', line: number|null, target: string|null }}
 */
function classifyNodeVersion(v) {
  const parts = parseVersion(v);
  if (!parts) return { status: 'unknown', line: null, target: null };
  const major = parts[0];
  const target = Object.prototype.hasOwnProperty.call(NODE_PATCHED_MINIMUMS, major)
    ? NODE_PATCHED_MINIMUMS[major]
    : null;
  if (major < 22 || (major % 2 === 1 && major <= HIGHEST_KNOWN_MAJOR)) {
    return { status: 'eol', line: major, target: null };
  }
  if (major > HIGHEST_KNOWN_MAJOR) return { status: 'unknown', line: major, target: null };
  if (target && compareParts(parts, parseVersion(target)) < 0) {
    return { status: 'unpatched', line: major, target };
  }
  return { status: 'ok', line: major, target };
}

/** `22.23.5, 24.22.3 or 26.13.1` */
function targetVersionsText() {
  const list = Object.keys(NODE_PATCHED_MINIMUMS)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => NODE_PATCHED_MINIMUMS[k]);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`;
}

/**
 * The warning text for a version, or null when its status is `ok` or `unknown`.
 * @param {string} v
 * @returns {string|null}
 */
function nodeWarningText(v) {
  const { status } = classifyNodeVersion(v);
  let problem;
  if (status === 'eol') problem = 'is end-of-life';
  else if (status === 'unpatched') problem = `misses the ${NODE_ADVISORY} security fixes`;
  else return null;
  return `Log Hub: Node.js ${v} ${problem} — upgrade to Node.js ${targetVersionsText()} or newer.`
    + ' Log Hub hooks keep working.';
}

/**
 * Throttle: show when there is no state, the Node version changed, or the last show is at least
 * 24 h old (a `shownAt` in the future or unparsable counts as stale).
 * @param {{ nodeVersion?: unknown, shownAt?: unknown }|null} state
 * @param {string} version
 * @param {number} now epoch ms
 * @returns {boolean}
 */
function shouldShowNodeWarning(state, version, now) {
  if (!state || typeof state !== 'object') return true;
  if (state.nodeVersion !== version) return true;
  const shownAt = typeof state.shownAt === 'number' ? state.shownAt : Date.parse(String(state.shownAt));
  if (!Number.isFinite(shownAt) || shownAt > now) return true;
  return now - shownAt >= NODE_WARNING_INTERVAL_MS;
}

/** `<home>/.artisyn/node-check.json` */
function nodeCheckPath(home) {
  return path.join(home || os.homedir(), '.artisyn', NODE_CHECK_FILE);
}

function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStateAtomic(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * The `SessionStart` check: the warning text when the running Node is `eol`/`unpatched` and the
 * throttle allows it (and then records the show), else null. Never throws.
 * @param {{ now?: number, home?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string|null}
 */
function checkNodeVersion(opts = {}) {
  try {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const version = effectiveNodeVersion(opts.env || process.env);
    const text = nodeWarningText(version);
    if (!text) return null;
    const file = nodeCheckPath(opts.home);
    if (!shouldShowNodeWarning(readState(file), version, now)) return null;
    writeStateAtomic(file, { nodeVersion: version, shownAt: now });
    return text;
  } catch {
    return null;
  }
}

module.exports = {
  NODE_PATCHED_MINIMUMS,
  NODE_ADVISORY,
  NODE_VERSION_OVERRIDE_ENV,
  NODE_WARNING_INTERVAL_MS,
  effectiveNodeVersion,
  classifyNodeVersion,
  nodeWarningText,
  shouldShowNodeWarning,
  checkNodeVersion,
};
