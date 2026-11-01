'use strict';
/**
 * Claude Code Hook helper — "has this OKF snapshot id already been fully uploaded?" (not a hook
 * entry point itself). Plan `2026-10-27-okf-usage-tab`, DD-19; a clone of `harness-state.js`
 * without its per-session map, because OKF lines ride only on the root session's `artisyn` upload
 * from `send-logs-hook.js`, never on `prompt-upload-hook.js`.
 *
 *   - `knownSnapshotIds` — OKF snapshot ids this workspace has successfully uploaded the FULL body
 *     for, most-recent-first, capped at `OKF_KNOWN_SNAPSHOTS_MAX`. An upload whose id is in this
 *     list sends only the `okf-snapshot-ref` line; otherwise it sends the full `okf-snapshot` line
 *     too and remembers the id on success. A response echoing `unknownOkfSnapshotId` forgets it.
 *   - `hashCache` — `okf-snapshot.js`'s content-hash cache (see {@link readOkfHashCache}); losing
 *     it only costs one re-hash of the KB files.
 *
 * Fail-open throughout: a missing, unreadable, malformed or wrong-version file reads as empty
 * state — which costs one redundant full-snapshot resend, never a lost upload — and a write never
 * throws (temp-file + rename, like the hook's other state files).
 */
const fs = require('fs');
const path = require('path');

/** Single JSON file, alongside the hook's other state, inside the gitignored work dir. */
const OKF_STATE_FILE = 'okf-state.json';

/** DD-18: bumped only if the on-disk shape changes incompatibly. */
const OKF_STATE_VERSION = 1;

/** DD-18: cap on `knownSnapshotIds`, most-recent kept. */
const OKF_KNOWN_SNAPSHOTS_MAX = 20;

/** @param {string} workDir @returns {string} */
function okfStatePath(workDir) {
  return path.join(workDir, OKF_STATE_FILE);
}

/** @returns {{ knownSnapshotIds: string[] }} neutral "nothing known yet" state. */
function emptyState() {
  return { knownSnapshotIds: [] };
}

/**
 * Read the state, or {@link emptyState} on any problem (including a wrong `version`).
 * Keys other than `knownSnapshotIds` (e.g. a detection cache added later) are kept as they are,
 * so writing the known list never drops them.
 *
 * @param {string} workDir
 * @returns {{ knownSnapshotIds: string[] } & Record<string, *>}
 */
function readState(workDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(okfStatePath(workDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    if (parsed.version !== OKF_STATE_VERSION) return emptyState();
    const knownSnapshotIds = Array.isArray(parsed.knownSnapshotIds)
      ? parsed.knownSnapshotIds.filter((id) => typeof id === 'string' && id)
      : [];
    return { ...parsed, knownSnapshotIds };
  } catch {
    return emptyState();
  }
}

/**
 * Persist the state with a temp-file + rename. Never throws.
 *
 * @param {string} workDir
 * @param {{ knownSnapshotIds: string[] } & Record<string, *>} state
 * @returns {boolean} true when the state reached disk
 */
function writeState(workDir, state) {
  const target = okfStatePath(workDir);
  const tmp = `${target}.tmp`;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const doc = {
      ...state,
      version: OKF_STATE_VERSION,
      knownSnapshotIds: state.knownSnapshotIds,
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
 * The OKF snapshot ids this workspace has already uploaded the full body for, most-recent-first.
 * @param {string} workDir
 * @returns {string[]}
 */
function readKnownOkfSnapshots(workDir) {
  return readState(workDir).knownSnapshotIds;
}

/**
 * Record that `okfSnapshotId`'s full body was just uploaded successfully: move it to the front,
 * then cap the list at {@link OKF_KNOWN_SNAPSHOTS_MAX}, dropping the oldest.
 * @param {string} workDir
 * @param {string} okfSnapshotId
 * @returns {boolean} true when the state reached disk
 */
function rememberOkfSnapshot(workDir, okfSnapshotId) {
  const state = readState(workDir);
  const withoutId = state.knownSnapshotIds.filter((id) => id !== okfSnapshotId);
  withoutId.unshift(okfSnapshotId);
  state.knownSnapshotIds = withoutId.slice(0, OKF_KNOWN_SNAPSHOTS_MAX);
  return writeState(workDir, state);
}

/**
 * Remove `okfSnapshotId` from the known list — the server answered `unknownOkfSnapshotId` with
 * it (its stored row is gone), so the next upload must resend the full body.
 * @param {string} workDir
 * @param {string} okfSnapshotId
 * @returns {boolean} true when the state reached disk
 */
function forgetOkfSnapshot(workDir, okfSnapshotId) {
  const state = readState(workDir);
  state.knownSnapshotIds = state.knownSnapshotIds.filter((id) => id !== okfSnapshotId);
  return writeState(workDir, state);
}

/**
 * @typedef {Object} OkfHashCache
 * @property {string} treeKey - sha256 of the sorted `(path, mtimeMs, size)` list it was built from
 * @property {Record<string, [number, number, string]>} files - path → `[mtimeMs, size, sha256]`
 */

/**
 * The content-hash cache `okf-snapshot.js` keeps so an unchanged KB is not re-read and re-hashed
 * on every upload (Chunk 7 measurement: hashing 5 000 files took ~1.3 s on Windows). `null` when
 * absent or malformed.
 * @param {string} workDir
 * @returns {OkfHashCache|null}
 */
function readOkfHashCache(workDir) {
  const cache = readState(workDir).hashCache;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return null;
  if (typeof cache.treeKey !== 'string' || !cache.files || typeof cache.files !== 'object') return null;
  return cache;
}

/**
 * Replace the content-hash cache, keeping `knownSnapshotIds`. Never throws.
 * @param {string} workDir
 * @param {OkfHashCache} cache
 * @returns {boolean} true when the state reached disk
 */
function writeOkfHashCache(workDir, cache) {
  const state = readState(workDir);
  state.hashCache = cache;
  return writeState(workDir, state);
}

module.exports = {
  OKF_STATE_FILE,
  OKF_STATE_VERSION,
  OKF_KNOWN_SNAPSHOTS_MAX,
  okfStatePath,
  readState,
  writeState,
  readKnownOkfSnapshots,
  rememberOkfSnapshot,
  forgetOkfSnapshot,
  readOkfHashCache,
  writeOkfHashCache,
};
