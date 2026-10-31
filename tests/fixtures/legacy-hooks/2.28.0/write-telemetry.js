'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Re-entrancy marker set by `claude-invoke-async.js` on every `claude -p`
 * child it spawns. Claude Code runs a session's hooks as child processes of the CLI, so the whole
 * environment propagates: inside one of those evaluation sessions, THIS variable is set.
 *
 * Keep the name in sync with `claude-invoke-async.js`, `post-turn-analysis-hook.js` and `post-turn-analysis-worker.js`, which all read or set it.
 */
const HOOK_SERVICE_ENV_VAR = 'ARTISYN_HOOK_SERVICE';

/** Lock sidecar suffix. Not `.jsonl`, so the uploaders' `*.jsonl` scans never pick it up. */
const LOCK_SUFFIX = '.lock';
/** Total time to wait for the lock before appending unlocked. */
const LOCK_WAIT_MS = 3000;
/** Age after which a lock is treated as abandoned by a killed hook and removed. */
const LOCK_STALE_MS = 2000;
const LOCK_RETRY_MS = 5;

/**
 * Append one JSON event line to `<telemetryDir>/<session_id>.jsonl`.
 *
 * **Suppressed inside a hook-service session.** The hook's own `claude -p` evaluation
 * sessions (attribution, advisor) run their own full hook set, so each one used to write
 * its own `SessionStart` / `prompt_start` / `SessionEnd` / tool events into the telemetry dir — a
 * complete 1,811-byte session log describing the hook classifying a session, which then became
 * another session to upload and classify. On this machine that was 1,385 of 2,399 artisyn files
 * (57.7%), 2.4 MB of content that shipped as ~785 MB once per-file context prepends were applied.
 *
 * The deliberate one-line `hook_service` marker is NOT written from inside those sessions — it is
 * written by the spawning parent (`post-turn-analysis-worker.js`), which does
 * not carry the variable — so it still lands and the server's
 * `logs.body @> '[{"event":"hook_service"}]'` check keeps identifying these sessions. What is gone
 * is only the evaluation session's own transcript of itself.
 *
 * Fail-open by omission: an older hook that never set the variable simply writes as before.
 *
 * **Appends are serialized with a `<file>.lock` sidecar.** Claude Code fires several hooks at
 * once (PostToolUse → PostToolBatch, parallel SubagentStart/Stop), each its own process appending
 * to the same session file. On a filesystem without atomic cross-process `O_APPEND` — WSL's
 * `/mnt/<drive>` (DrvFs over 9p), network shares — two in-flight appends both land at the same
 * EOF offset and the shorter record overwrites the head of the longer one, leaving its tail as a
 * permanently broken line (typically a short PostToolBatch written over the head of a
 * PostToolUse). Exclusive create (`'wx'`) is decided by the host filesystem even over 9p, so it serializes the
 * writers where the append offset does not.
 *
 * The lock never blocks telemetry: if it cannot be taken within `lockWaitMs` the line is appended
 * unlocked, exactly as before this fix. A lock left behind by a killed hook is broken once it is
 * older than `lockStaleMs` (the lock is held for one small write, so a live holder is never that
 * slow).
 *
 * `opts.compact` carries the `jsonCompact` config key. `false` writes the record with a space after
 * every `:`/`,` (still one line — the file stays NDJSON, which the upload sanitizer and the server
 * parse line by line); `true` or omitted writes plain `JSON.stringify` output.
 *
 * @param {object} event
 * @param {string} telemetryDir
 * @param {{ compact?: boolean, lockWaitMs?: number, lockStaleMs?: number }} [opts] `compact` from
 *   config; the lock values are test overrides
 * @returns {boolean} true when the line was written, false when suppressed
 */
function writeTelemetry(event, telemetryDir, opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {};
  if ((process.env[HOOK_SERVICE_ENV_VAR] || '').trim() !== '') return false;
  fs.mkdirSync(telemetryDir, {recursive: true});
  const sessionId = event.session_id || 'unknown-session';
  const filepath = path.join(telemetryDir, `${sessionId}.jsonl`);
  const lockPath = `${filepath}${LOCK_SUFFIX}`;
  const locked = acquireLock(
    lockPath,
    opts.lockWaitMs ?? LOCK_WAIT_MS,
    opts.lockStaleMs ?? LOCK_STALE_MS,
  );
  try {
    fs.appendFileSync(filepath, serializeEvent(event, opts.compact !== false) + '\n', 'utf8');
  } finally {
    if (locked) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already broken as stale by another writer — nothing left to release.
      }
    }
  }
  return true;
}

/**
 * One NDJSON line for `event`. The spaced form indents with one space and folds every line break
 * back into a single space; JSON never carries a raw newline inside a string value (it is escaped
 * as `\n`), so the only line breaks folded are the ones the indentation added.
 * @param {object} event
 * @param {boolean} compact
 * @returns {string}
 */
function serializeEvent(event, compact) {
  if (compact) return JSON.stringify(event);
  return JSON.stringify(event, null, 1).replace(/\n */g, ' ');
}

/**
 * @returns {boolean} true when this process now holds `lockPath`, false when it gave up (budget
 *   spent, or the directory does not support the lock at all) and the caller should write unlocked
 */
function acquireLock(lockPath, waitMs, staleMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      return true;
    } catch (err) {
      // EEXIST: held by another writer. EPERM/EBUSY: Windows reports these while the previous
      // holder's unlink is still pending. Anything else means locking cannot work here.
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(err && err.code)) return false;
    }
    breakStaleLock(lockPath, staleMs);
    if (Date.now() >= deadline) return false;
    sleepSync(LOCK_RETRY_MS);
  }
}

function breakStaleLock(lockPath, staleMs) {
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath);
  } catch {
    // Released (or broken) by someone else in the meantime — just retry the create.
  }
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

module.exports = {writeTelemetry, serializeEvent, HOOK_SERVICE_ENV_VAR, LOCK_SUFFIX};
