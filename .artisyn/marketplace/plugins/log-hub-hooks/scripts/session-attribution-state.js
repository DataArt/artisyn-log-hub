'use strict';
/**
 * Claude Code Hook helper — session-attribution 3-consecutive-failure cap state (not a hook entry
 * point itself).
 *
 * NOT a reuse of `throttle-state.js` — that module tracks a time
 * window ("don't retry within N ms"), while this tracks a per-session COUNT of consecutive
 * evaluation failures, tied to the `promptWatermark` each failure occurred at (so a burst of
 * failed retries at the SAME watermark doesn't inflate the count past what a single failed
 * attempt would). One small JSON file, one entry per session, read/write is fail-open throughout
 * (a missing/corrupt file or a write failure must never block the attribution branch) — same
 * fail-open shape `throttle-state.js` already established for its own state file.
 *
 * Consulted/updated ONLY by the attribution branch, and only around a real evaluation attempt:
 *   - `recordFailure()` on `outcome: 'failed'` — increments the streak (once per distinct
 *     watermark).
 *   - `recordSuccess()` on `outcome: 'applied'` — resets the streak.
 *   - A `2xx {applied:false}` response (not-yet-ingested session, or a stale watermark the
 *     server's own conditional upsert ignored) is NEITHER of the above — the caller simply never
 *     calls into this module for that outcome, so the counter is untouched either way.
 *
 * Also resets the streak whenever the resolved attribute definitions change (a new/edited
 * attribute set is a materially different classification task — past failures against the old
 * set shouldn't count against it), tracked via a caller-supplied `definitionsSignature` (the
 * simplest stable signature is `JSON.stringify(attributes)`; the caller decides how to derive it,
 * this module only compares it for equality).
 */
const fs = require('fs');
const path = require('path');

const { getWorkDirPath, ensureWorkDir } = require('./git-context');

const STATE_FILE = 'session-attribution-state.json';

/** 3 consecutive failures blocks further evaluation attempts until either a
 * success or a definitions change resets the streak. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * @param {string|null} cwd
 * @returns {string}
 */
function statePath(cwd) {
  return path.join(getWorkDirPath(cwd), STATE_FILE);
}

/**
 * Read the whole state file. Fail-open: a missing/corrupt file, or a non-object root, reads as
 * "no sessions recorded yet" rather than throwing.
 * @param {string|null} cwd
 * @returns {Record<string, { lastFailedWatermark: number|null, consecutiveFailures: number, definitionsSignature: string|null }>}
 */
function loadState(cwd) {
  try {
    const raw = fs.readFileSync(statePath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

/**
 * Persist the whole state file. Best-effort — a write failure must never block the attribution
 * branch (fail-open, same convention as `throttle-state.js`'s `writeThrottleState`).
 * @param {string|null} cwd
 * @param {Record<string, *>} state
 */
function writeState(cwd, state) {
  try {
    ensureWorkDir(cwd);
    fs.writeFileSync(statePath(cwd), JSON.stringify(state), 'utf8');
  } catch {
    // best-effort; must never cause hook failures
  }
}

/**
 * One session's entry, defaulted when absent.
 * @param {Record<string, *>} state
 * @param {string} sessionId
 * @returns {{ lastFailedWatermark: number|null, consecutiveFailures: number, definitionsSignature: string|null }}
 */
function getEntry(state, sessionId) {
  const entry = state[sessionId];
  if (entry && typeof entry === 'object') {
    return {
      lastFailedWatermark:
        typeof entry.lastFailedWatermark === 'number' ? entry.lastFailedWatermark : null,
      consecutiveFailures:
        typeof entry.consecutiveFailures === 'number' ? entry.consecutiveFailures : 0,
      definitionsSignature:
        typeof entry.definitionsSignature === 'string' ? entry.definitionsSignature : null,
    };
  }
  return { lastFailedWatermark: null, consecutiveFailures: 0, definitionsSignature: null };
}

/**
 * Whether the attribution branch should skip evaluating this session altogether this turn,
 * because it has hit {@link MAX_CONSECUTIVE_FAILURES} consecutive failures against the CURRENT
 * `definitionsSignature`. A definitions change (different signature than what's recorded) always
 * answers `false` — the streak effectively resets the next time `recordFailure`/`recordSuccess`
 * is called with the new signature.
 * @param {string|null} cwd
 * @param {string} sessionId
 * @param {string} definitionsSignature
 * @returns {boolean}
 */
function isBlockedByFailureCap(cwd, sessionId, definitionsSignature) {
  const entry = getEntry(loadState(cwd), sessionId);
  if (entry.definitionsSignature !== definitionsSignature) return false;
  return entry.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
}

/**
 * Record a `failed` evaluation outcome. Increments the streak only when `watermark` differs from
 * the last-recorded failure's watermark (so repeated failures reported at the same watermark
 * — e.g. a retry — count once), and resets the streak first if `definitionsSignature` has
 * changed since the last recorded attempt.
 * @param {string|null} cwd
 * @param {string} sessionId
 * @param {number} watermark
 * @param {string} definitionsSignature
 */
function recordFailure(cwd, sessionId, watermark, definitionsSignature) {
  const state = loadState(cwd);
  const entry = getEntry(state, sessionId);

  const definitionsChanged = entry.definitionsSignature !== definitionsSignature;
  const consecutiveFailures = definitionsChanged
    ? 1
    : entry.lastFailedWatermark === watermark
      ? entry.consecutiveFailures
      : entry.consecutiveFailures + 1;

  state[sessionId] = {
    lastFailedWatermark: watermark,
    consecutiveFailures,
    definitionsSignature,
  };
  writeState(cwd, state);
}

/**
 * Record an `applied` (successful) evaluation outcome — resets the streak entirely.
 * @param {string|null} cwd
 * @param {string} sessionId
 */
function recordSuccess(cwd, sessionId) {
  const state = loadState(cwd);
  delete state[sessionId];
  writeState(cwd, state);
}

module.exports = {
  MAX_CONSECUTIVE_FAILURES,
  statePath,
  loadState,
  getEntry,
  isBlockedByFailureCap,
  recordFailure,
  recordSuccess,
};
