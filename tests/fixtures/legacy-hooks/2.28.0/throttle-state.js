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

module.exports = {
  OTEL_RESPAWN_THROTTLE_MS,
  OTEL_SPAWN_STATE_FILE,
  claimThrottleSlot,
  readThrottleState,
  throttleStatePath,
  withinThrottleWindow,
  writeThrottleState,
};
