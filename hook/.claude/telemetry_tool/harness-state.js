'use strict';
/**
 * Claude Code Hook helper — "has this harness snapshot id already been fully uploaded, and what
 * id did this session last upload?" (not a hook entry point itself).
 *
 * v2 (DD-6 of the `2026-10-16-sysctx-skill-source` plan), replacing the v1 once-per-session
 * fingerprint/mtime scheme (`computeHarnessFingerprint`, removed here): DD-2 gives every harness
 * snapshot a content-derived, stable id, so "have we sent the full body for this id before" is now
 * a simple membership check against a remembered list of ids, instead of a once-per-session
 * mtime-based guess.
 *
 * Two independent pieces of state live in the same file:
 *   - `knownSnapshotIds` — ids this workspace has successfully uploaded the FULL body for. A
 *     `send-logs-hook.js` run that computes an id already in this list sends only the cheap
 *     `harness-snapshot-ref` line (DD-7); one that doesn't, sends the full snapshot (after the MCP
 *     probe) and remembers the id on success.
 *   - `sessionSnapshots` — per-session `{ sessionId: snapshotId }`, so `prompt-upload-hook.js`
 *     (DD-19) can prepend a ref to every UserPromptSubmit re-upload of the CURRENT session without
 *     recomputing the catalog or re-probing MCP servers on that fast path.
 *
 * Both are capped at `HARNESS_KNOWN_SNAPSHOTS_MAX`, most-recently-used kept.
 *
 * Fail-open throughout, same as v1 and the other hook state files (`code-inventory-state.json`,
 * the upload manifest): a missing, unreadable, malformed, or wrong-version file reads as empty
 * state — which costs one redundant full-snapshot resend, never a lost upload — and a write never
 * throws, using the same temp-file + rename pattern as the rest of this hook's state files.
 */
const fs = require('fs');
const path = require('path');

/** Single JSON file, alongside the hook's other state, inside the gitignored work dir. */
const HARNESS_STATE_FILE = 'harness-state.json';

/** DD-16: bumped only if the on-disk shape changes incompatibly. */
const HARNESS_STATE_VERSION = 2;

/** DD-16: cap on both `knownSnapshotIds` and `sessionSnapshots`, most-recent-kept. */
const HARNESS_KNOWN_SNAPSHOTS_MAX = 20;

/** @param {string} workDir @returns {string} */
function harnessStatePath(workDir) {
  return path.join(workDir, HARNESS_STATE_FILE);
}

/** @returns {{ knownSnapshotIds: string[], sessionSnapshots: Record<string, string> }} neutral "nothing known yet" state. */
function emptyState() {
  return { knownSnapshotIds: [], sessionSnapshots: {} };
}

/**
 * Read the full v2 state, or {@link emptyState} on any problem — including a v1 file (wrong
 * `version`), which is deliberately NOT migrated: the old fingerprint has no mapping to a DD-2 id,
 * so there is nothing valid to carry forward, and re-sending the full snapshot once is harmless.
 *
 * @param {string} workDir
 * @returns {{ knownSnapshotIds: string[], sessionSnapshots: Record<string, string> }}
 */
function readState(workDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(harnessStatePath(workDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    if (parsed.version !== HARNESS_STATE_VERSION) return emptyState();

    const knownSnapshotIds = Array.isArray(parsed.knownSnapshotIds)
      ? parsed.knownSnapshotIds.filter((id) => typeof id === 'string' && id)
      : [];
    const sessionSnapshots =
      parsed.sessionSnapshots && typeof parsed.sessionSnapshots === 'object' && !Array.isArray(parsed.sessionSnapshots)
        ? Object.fromEntries(
            Object.entries(parsed.sessionSnapshots).filter(
              ([sessionId, id]) => typeof sessionId === 'string' && typeof id === 'string' && id,
            ),
          )
        : {};

    return { knownSnapshotIds, sessionSnapshots };
  } catch {
    return emptyState();
  }
}

/**
 * Persist the state with a temp-file + rename, so a crash mid-write can never leave a truncated
 * JSON that the next run would have to treat as "no state".
 *
 * Never throws: failing to record the report costs a redundant resend or a missed fast-path ref
 * next run, which must not be allowed to fail an upload that already succeeded.
 *
 * @param {string} workDir
 * @param {{ knownSnapshotIds: string[], sessionSnapshots: Record<string, string> }} state
 * @returns {boolean} true when the state reached disk
 */
function writeState(workDir, state) {
  const target = harnessStatePath(workDir);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const doc = {
      version: HARNESS_STATE_VERSION,
      knownSnapshotIds: state.knownSnapshotIds,
      sessionSnapshots: state.sessionSnapshots,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing left to clean up
    }
    return false;
  }
}

/**
 * The ids this workspace has already uploaded the full snapshot body for, most-recent-first.
 * Callers check membership (`.includes(snapshotId)`), not order, but the order is kept so
 * {@link rememberSnapshot}'s cap evicts the least-recently-confirmed id first.
 *
 * @param {string} workDir
 * @returns {string[]}
 */
function readKnownSnapshots(workDir) {
  return readState(workDir).knownSnapshotIds;
}

/**
 * Record that `snapshotId`'s full body was just uploaded successfully (DD-6: "added only after a
 * successful upload that carried the full snapshot"). Moves the id to the front if it was already
 * present, then caps the list at {@link HARNESS_KNOWN_SNAPSHOTS_MAX}, dropping the oldest.
 *
 * @param {string} workDir
 * @param {string} snapshotId
 * @returns {boolean} true when the state reached disk
 */
function rememberSnapshot(workDir, snapshotId) {
  const state = readState(workDir);
  const withoutId = state.knownSnapshotIds.filter((id) => id !== snapshotId);
  withoutId.unshift(snapshotId);
  state.knownSnapshotIds = withoutId.slice(0, HARNESS_KNOWN_SNAPSHOTS_MAX);
  return writeState(workDir, state);
}

/**
 * Remove `snapshotId` from the known list (DD-6: "removed, and the file persisted, when the
 * response carries `unknownSnapshotId` equal to it") — the server told us a purge dropped the
 * stored row, so the next upload of this id must resend the full body (DD-21's self-heal).
 *
 * @param {string} workDir
 * @param {string} snapshotId
 * @returns {boolean} true when the state reached disk
 */
function forgetSnapshot(workDir, snapshotId) {
  const state = readState(workDir);
  state.knownSnapshotIds = state.knownSnapshotIds.filter((id) => id !== snapshotId);
  return writeState(workDir, state);
}

/**
 * Record which snapshot id the CURRENT session last uploaded — DD-19's fast path for
 * `prompt-upload-hook.js`, which reads this back via {@link readSessionSnapshot} to prepend a ref
 * without recomputing anything. Re-setting an existing session's id bumps it to "most recent" for
 * the cap below; once more than {@link HARNESS_KNOWN_SNAPSHOTS_MAX} sessions are tracked, the
 * least-recently-touched one is evicted (insertion order in a plain object is preserved for string
 * keys, so the first remaining key is always the oldest).
 *
 * @param {string} workDir
 * @param {string} sessionId
 * @param {string} snapshotId
 * @returns {boolean} true when the state reached disk
 */
function recordSessionSnapshot(workDir, sessionId, snapshotId) {
  const state = readState(workDir);
  delete state.sessionSnapshots[sessionId];
  state.sessionSnapshots[sessionId] = snapshotId;

  const keys = Object.keys(state.sessionSnapshots);
  if (keys.length > HARNESS_KNOWN_SNAPSHOTS_MAX) {
    for (const oldest of keys.slice(0, keys.length - HARNESS_KNOWN_SNAPSHOTS_MAX)) {
      delete state.sessionSnapshots[oldest];
    }
  }

  return writeState(workDir, state);
}

/**
 * The snapshot id the given session last recorded via {@link recordSessionSnapshot}, or `null` if
 * none is known (never uploaded yet, evicted by the cap, or a missing/corrupt state file).
 *
 * @param {string} workDir
 * @param {string} sessionId
 * @returns {string|null}
 */
function readSessionSnapshot(workDir, sessionId) {
  const id = readState(workDir).sessionSnapshots[sessionId];
  return typeof id === 'string' ? id : null;
}

module.exports = {
  HARNESS_STATE_FILE,
  HARNESS_STATE_VERSION,
  HARNESS_KNOWN_SNAPSHOTS_MAX,
  harnessStatePath,
  readKnownSnapshots,
  rememberSnapshot,
  forgetSnapshot,
  recordSessionSnapshot,
  readSessionSnapshot,
};
