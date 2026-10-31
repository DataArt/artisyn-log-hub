'use strict';
/**
 * Claude Code Hook helper — shared throttle-state files (not a hook entry point itself).
 *
 * A throttle is one small JSON file under the work dir holding `{ lastAttemptAt }`. It exists so a
 * hook that fires on a high-frequency event can still do periodic background work (spawn an
 * uploader, re-arm the OTEL receiver) without doing it on *every* event.
 *
 * Extracted out of `telemetry-hook.js` when the OTEL re-arm gained two more call sites
 * (`lifecycle-hook.js` on its twelve events and `send-logs-hook.js` on `Stop`). All three MUST
 * share one state file per concern — with a copy of the window per hook, three hooks firing inside
 * the same minute would each pass their own check and spawn.
 *
 * Every operation fails open: a missing or corrupt file reads as "no prior attempt" so a hook can
 * never get stuck throttled forever, and a write failure is swallowed because throttling is
 * best-effort and must never fail the hook.
 */

const fs = require('fs');
const path = require('path');

const { getWorkDirPath, ensureWorkDir } = require('./git-context');

/**
 * How long to wait between OTEL receiver re-arm attempts, and the file that records the last one.
 *
 * Shared by all three re-arm call sites. 60 s bounds the cost — at worst one short-lived node
 * process per minute per project — while keeping the window in which a dead receiver goes
 * unnoticed to about a minute. The announce itself is safe to repeat: the register POST is
 * non-blocking and a second receiver exits 0 on `EADDRINUSE`.
 */
const OTEL_RESPAWN_THROTTLE_MS = 60000;
const OTEL_SPAWN_STATE_FILE = 'otel-receiver-spawn.json';

/**
 * Resolve <workDir>/<fileName>, following the same anchoring convention as recommendations.js.
 * @param {string|null} cwd
 * @param {string} fileName - the throttle state file, e.g. `prompt-upload-throttle.json`
 * @returns {string}
 */
function throttleStatePath(cwd, fileName) {
  return path.join(getWorkDirPath(cwd), fileName);
}

/**
 * Read one throttle state file. Fail-open: any missing/corrupt file reads as "no prior attempt",
 * which lets the caller proceed rather than getting stuck throttled forever.
 * @param {string|null} cwd
 * @param {string} fileName
 * @returns {{ lastAttemptAt: string|null }}
 */
function readThrottleState(cwd, fileName) {
  try {
    const raw = fs.readFileSync(throttleStatePath(cwd, fileName), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.lastAttemptAt === 'string') return parsed;
    return { lastAttemptAt: null };
  } catch {
    return { lastAttemptAt: null };
  }
}

/**
 * Persist one throttle state file. Best-effort — a write failure must never block/fail the hook.
 * @param {string|null} cwd
 * @param {string} fileName
 * @param {{ lastAttemptAt: string }} state
 */
function writeThrottleState(cwd, fileName, state) {
  try {
    ensureWorkDir(cwd);
    fs.writeFileSync(throttleStatePath(cwd, fileName), JSON.stringify(state), 'utf8');
  } catch {
    // throttling is best-effort; must never cause hook failures
  }
}

/**
 * Whether a prior attempt recorded in `fileName` is still inside its throttle window.
 * @param {string|null} cwd
 * @param {string} fileName
 * @param {number} thresholdMs
 * @returns {boolean}
 */
function withinThrottleWindow(cwd, fileName, thresholdMs) {
  const state = readThrottleState(cwd, fileName);
  const lastAttemptMs = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : NaN;
  return !Number.isNaN(lastAttemptMs) && (Date.now() - lastAttemptMs) < thresholdMs;
}

/**
 * Claim the next slot of a throttle window: returns `true` when the caller may proceed, and
 * records the attempt before returning so a burst of near-simultaneous hooks cannot all pass.
 * @param {string|null} cwd
 * @param {string} fileName
 * @param {number} thresholdMs
 * @returns {boolean}
 */
function claimThrottleSlot(cwd, fileName, thresholdMs) {
  if (withinThrottleWindow(cwd, fileName, thresholdMs)) return false;
  // Optimistic update, written synchronously before the caller acts, so two hooks firing in the
  // same tick don't both see an empty window.
  writeThrottleState(cwd, fileName, { lastAttemptAt: new Date().toISOString() });
  return true;
}

/**
 * The per-session "otel-status already written" marks (DD-15): which state the last `otel-status`
 * event of a session carried, so Stop/SessionEnd write it once and again only when it improves.
 * One map in one work-dir file, `{ otelStatusWritten: { [sessionId]: { state, at } } }`; entries
 * older than `OTEL_STATUS_MARK_TTL_MS` are pruned on every write.
 */
const OTEL_STATUS_STATE_FILE = 'otel-status-written.json';
const OTEL_STATUS_MARK_TTL_MS = 86400000;

/**
 * @param {string|null} cwd
 * @returns {Record<string, { state: string, at: string }>}
 */
function readOtelStatusMarks(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(throttleStatePath(cwd, OTEL_STATUS_STATE_FILE), 'utf8'));
    const map = parsed && parsed.otelStatusWritten;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {};
  }
}

/**
 * The mark of the last `otel-status` written for `sessionId`, or `null`. Fail-open.
 * @param {string} sessionId
 * @param {string|null} [cwd]
 * @returns {{ state: string, at: string }|null}
 */
function readOtelStatusMark(sessionId, cwd = null) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const mark = readOtelStatusMarks(cwd)[sessionId];
  return mark && typeof mark === 'object' && typeof mark.state === 'string' ? mark : null;
}

/**
 * Record that an `otel-status` with `state` was written for `sessionId`, pruning marks older than
 * 24 h. Best-effort — a write failure must never fail the hook.
 * @param {string} sessionId
 * @param {string} state
 * @param {string|null} [cwd]
 */
function writeOtelStatusMark(sessionId, state, cwd = null) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  try {
    const now = Date.now();
    const marks = readOtelStatusMarks(cwd);
    const kept = {};
    for (const [id, mark] of Object.entries(marks)) {
      const at = mark && typeof mark.at === 'string' ? Date.parse(mark.at) : NaN;
      if (!Number.isNaN(at) && now - at < OTEL_STATUS_MARK_TTL_MS) kept[id] = mark;
    }
    kept[sessionId] = { state, at: new Date(now).toISOString() };
    ensureWorkDir(cwd);
    fs.writeFileSync(throttleStatePath(cwd, OTEL_STATUS_STATE_FILE), JSON.stringify({ otelStatusWritten: kept }), 'utf8');
  } catch {
    // best-effort
  }
}

/**
 * Per-session "this warning was already written" marks (hook 2.30.0+): the shared-receiver client
 * writes some `warn` lines at most once per session (port conflict, missing receiver capabilities,
 * legacy per-project receiver, port mismatch), while the code that may write them runs on every
 * throttled re-arm. One map in one work-dir file, `{ [sessionId]: { [key]: at } }`; sessions whose
 * newest mark is older than `OTEL_SESSION_WARNING_TTL_MS` are pruned on every write.
 */
const OTEL_SESSION_WARNINGS_FILE = 'otel-session-warnings.json';
const OTEL_SESSION_WARNING_TTL_MS = 86400000;

/**
 * @param {string|null} cwd
 * @returns {Record<string, Record<string, string>>}
 */
function readSessionWarnings(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(throttleStatePath(cwd, OTEL_SESSION_WARNINGS_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Whether the warning `key` was already written for `sessionId`. Read-only, fail-open (`false`).
 * @param {string|null} sessionId
 * @param {string} key
 * @param {string|null} [cwd]
 * @returns {boolean}
 */
function hasSessionWarning(sessionId, key, cwd = null) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const marks = readSessionWarnings(cwd)[sessionId];
  return !!marks && typeof marks === 'object' && typeof marks[key] === 'string';
}

/**
 * Claim the one write of warning `key` for `sessionId`: `true` when the caller should write it
 * (and the claim is recorded), `false` when it was already written. Without a session id nothing
 * can be deduplicated, so the caller always writes. Best-effort: a failed record still returns
 * `true`, so a warning is never lost to a read-only work dir.
 * @param {string|null} sessionId
 * @param {string} key
 * @param {string|null} [cwd]
 * @returns {boolean}
 */
function claimSessionWarning(sessionId, key, cwd = null) {
  if (typeof sessionId !== 'string' || !sessionId) return true;
  const all = readSessionWarnings(cwd);
  const current = all[sessionId] && typeof all[sessionId] === 'object' ? all[sessionId] : {};
  if (typeof current[key] === 'string') return false;
  try {
    const now = Date.now();
    const kept = {};
    for (const [id, marks] of Object.entries(all)) {
      if (!marks || typeof marks !== 'object') continue;
      const newest = Math.max(...Object.values(marks).map((at) => (typeof at === 'string' ? Date.parse(at) : NaN))
        .filter((at) => !Number.isNaN(at)), -Infinity);
      if (now - newest < OTEL_SESSION_WARNING_TTL_MS) kept[id] = marks;
    }
    kept[sessionId] = { ...current, [key]: new Date(now).toISOString() };
    ensureWorkDir(cwd);
    fs.writeFileSync(throttleStatePath(cwd, OTEL_SESSION_WARNINGS_FILE), JSON.stringify(kept), 'utf8');
  } catch {
    // best-effort
  }
  return true;
}

module.exports = {
  OTEL_RESPAWN_THROTTLE_MS,
  OTEL_SPAWN_STATE_FILE,
  OTEL_STATUS_STATE_FILE,
  OTEL_STATUS_MARK_TTL_MS,
  OTEL_SESSION_WARNINGS_FILE,
  OTEL_SESSION_WARNING_TTL_MS,
  claimSessionWarning,
  hasSessionWarning,
  readOtelStatusMark,
  writeOtelStatusMark,
  claimThrottleSlot,
  readThrottleState,
  throttleStatePath,
  withinThrottleWindow,
  writeThrottleState,
};
