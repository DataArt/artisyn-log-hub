'use strict';

/**
 * Upload skip rule and the v2 upload manifest (DD-26 of the `2026-11-23-session-logs-streaming`
 * plan; algorithm doc `docs/knowledgebase/algorithms/hook-upload-skip.md`).
 *
 * Two manifests live side by side in the telemetry dir, both written in the same flush under the
 * project's `.upload.lock`:
 *
 * - `.claude-logs.sent` — the old one, unchanged: one `<manifestKey> <size>` line per file. Older
 *   hooks read and write only this file, so it keeps its format and keeps being written.
 * - `.claude-logs.sent.v2` — JSON `{"version":2,"entries":{"<manifestKey>":{"size":n,"mtimeMs":n,
 *   "paramsSha256":"hex","fp":"hex"?}}}`. It adds what a size alone cannot see: a same-length
 *   rewrite (mtime), a change of the upload's query params (a late `.meta.json`), and for
 *   `tool-calls` a sha256 fingerprint of its source files.
 *
 * The decision functions are pure; only the read/write helpers touch the disk.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_V1_NAME = '.claude-logs.sent';
const MANIFEST_V2_NAME = '.claude-logs.sent.v2';
const MANIFEST_V2_VERSION = 2;

/**
 * `appendBytes` / `appendLines` / `appendSha256` (2026-11-24-traffic-optimization, append uploads
 * of `claude` / `claude-subagent` logs): how much of the file the server already holds — the byte
 * length of the sent prefix (ends after a `\n`), the record count it contributed and the sha256 of
 * the raw file bytes `[0, appendBytes)`. Present all three or none.
 * @typedef {{ size: number, mtimeMs: number, paramsSha256: string, fp?: string,
 *   appendBytes?: number, appendLines?: number, appendSha256?: string }} ManifestV2Entry
 */

/**
 * @typedef {{ bytes: number, lines: number, sha256: string }} AppendState
 */

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** @param {unknown} n @returns {boolean} */
function isNonNegativeInteger(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/**
 * Whether the three append fields are all present and valid: two non-negative integers and a
 * 64-char lowercase sha256 hex.
 * @param {unknown} bytes @param {unknown} lines @param {unknown} sha256
 * @returns {boolean}
 */
function isValidAppendFields(bytes, lines, sha256) {
  return isNonNegativeInteger(bytes) && isNonNegativeInteger(lines)
    && typeof sha256 === 'string' && SHA256_HEX_RE.test(sha256);
}

/**
 * The append state of a v2 entry, or null when it has none (or an invalid one).
 * @param {ManifestV2Entry|undefined|null} entry
 * @returns {AppendState|null}
 */
function appendStateOf(entry) {
  if (!entry || !isValidAppendFields(entry.appendBytes, entry.appendLines, entry.appendSha256)) return null;
  return { bytes: entry.appendBytes, lines: entry.appendLines, sha256: entry.appendSha256 };
}

/**
 * sha256 hex of the upload's identifying params, in a fixed order with absent values as `''`.
 * @param {{ type: string, sessionId: string, parentSessionId?: string|null, workflowRunId?: string|null,
 *   agentDescription?: string|null, workflowPhase?: string|null }} params
 * @returns {string}
 */
function paramsSha256(params) {
  const p = params || {};
  const list = [
    p.type || '',
    p.sessionId || '',
    p.parentSessionId || '',
    p.workflowRunId || '',
    p.agentDescription || '',
    p.workflowPhase || '',
  ];
  return crypto.createHash('sha256').update(JSON.stringify(list), 'utf8').digest('hex');
}

/**
 * Whether a collected file can be skipped, and whether its v2 entry should be adopted (recorded
 * from the current stat because only the old manifest knew it).
 *
 * - the current session's own `artisyn` file → send (its body carries per-run prepends);
 * - no v2 entry and `oldSize === statSize` → skip and adopt;
 * - a v2 entry → skip only when `oldSize === v2.size === statSize`, the mtime, the params hash and
 *   (when given) `fp` are all equal;
 * - anything else → send.
 *
 * @param {{ isCurrentArtisyn: boolean, oldSize: number|undefined, v2: ManifestV2Entry|undefined,
 *   statSize: number, statMtimeMs: number, paramsSha256: string, fp?: string }} input
 * @returns {{ skip: boolean, adopt: boolean }}
 */
function decideUploadSkip(input) {
  const send = { skip: false, adopt: false };
  if (!input || input.isCurrentArtisyn) return send;
  const { oldSize, v2, statSize, statMtimeMs } = input;
  if (typeof oldSize !== 'number' || oldSize !== statSize) return send;
  if (!v2) return { skip: true, adopt: true };
  if (v2.size !== statSize) return send;
  if (v2.mtimeMs !== statMtimeMs) return send;
  if (v2.paramsSha256 !== input.paramsSha256) return send;
  if (input.fp !== undefined && v2.fp !== input.fp) return send;
  return { skip: true, adopt: false };
}

/**
 * Whether a `.claude-logs.pending` entry may be resumed: only when it records the same body sha256
 * and total size and still has chunks left. A legacy entry without `sha256` is never resumed.
 * @param {{ sha256?: string, totalSize?: number, nextChunkIndex?: number, totalChunks?: number }|null|undefined} entry
 * @param {number} totalSize
 * @param {string} sha256
 * @returns {boolean}
 */
function canResumePending(entry, totalSize, sha256) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.sha256 !== 'string' || entry.sha256 === '' || entry.sha256 !== sha256) return false;
  if (entry.totalSize !== totalSize) return false;
  if (typeof entry.nextChunkIndex !== 'number' || typeof entry.totalChunks !== 'number') return false;
  return entry.nextChunkIndex < entry.totalChunks;
}

/** @param {unknown} e @returns {e is ManifestV2Entry} */
function isValidEntry(e) {
  if (!e || typeof e !== 'object') return false;
  const o = /** @type {Record<string, unknown>} */ (e);
  return typeof o.size === 'number' && Number.isFinite(o.size)
    && typeof o.mtimeMs === 'number' && Number.isFinite(o.mtimeMs)
    && typeof o.paramsSha256 === 'string'
    && (o.fp === undefined || typeof o.fp === 'string');
}

/**
 * Read `.claude-logs.sent.v2`. A missing, unreadable or malformed file, or another `version`, is
 * an empty map (every file then falls back to the old manifest and is adopted); a malformed entry
 * is dropped on its own.
 * @param {string} manifestPath
 * @returns {Map<string, ManifestV2Entry>}
 */
function readManifestV2(manifestPath) {
  const map = new Map();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return map;
  }
  if (!parsed || parsed.version !== MANIFEST_V2_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
    return map;
  }
  for (const [key, entry] of Object.entries(parsed.entries)) {
    if (!key || !isValidEntry(entry)) continue;
    const clean = { size: entry.size, mtimeMs: entry.mtimeMs, paramsSha256: entry.paramsSha256 };
    if (typeof entry.fp === 'string') clean.fp = entry.fp;
    // Append state is kept only when all three fields are valid; otherwise all three are dropped
    // (the entry itself stays — it still drives the skip rule).
    if (isValidAppendFields(entry.appendBytes, entry.appendLines, entry.appendSha256)) {
      clean.appendBytes = entry.appendBytes;
      clean.appendLines = entry.appendLines;
      clean.appendSha256 = entry.appendSha256;
    }
    map.set(key, clean);
  }
  return map;
}

/**
 * Write `.claude-logs.sent.v2` from the map with temp file + rename, so a reader never sees a
 * partial file. Throws on failure (the temp file is removed first); callers log it.
 * @param {string} manifestPath
 * @param {Map<string, ManifestV2Entry>} map
 */
function writeManifestV2(manifestPath, map) {
  const entries = {};
  for (const [key, entry] of map) {
    const out = { size: entry.size, mtimeMs: entry.mtimeMs, paramsSha256: entry.paramsSha256 };
    if (typeof entry.fp === 'string') out.fp = entry.fp;
    if (isValidAppendFields(entry.appendBytes, entry.appendLines, entry.appendSha256)) {
      out.appendBytes = entry.appendBytes;
      out.appendLines = entry.appendLines;
      out.appendSha256 = entry.appendSha256;
    }
    entries[key] = out;
  }
  const content = JSON.stringify({ version: MANIFEST_V2_VERSION, entries });
  const tmpPath = `${manifestPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, manifestPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // never existed, or already gone
    }
    throw err;
  }
}

/**
 * Read the old `.claude-logs.sent` (`<key> <size>` per line). Missing or unreadable → empty map.
 * @param {string} manifestPath
 * @returns {Map<string, number>}
 */
function readManifestV1(manifestPath) {
  const map = new Map();
  try {
    const lines = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.lastIndexOf(' ');
      if (spaceIdx === -1) continue;
      const key = trimmed.slice(0, spaceIdx);
      const size = parseInt(trimmed.slice(spaceIdx + 1), 10);
      if (!key || isNaN(size)) continue;
      map.set(key, size);
    }
  } catch {
    // file missing or unreadable — start fresh
  }
  return map;
}

/**
 * Write the old `.claude-logs.sent` from the map with temp file + rename (a crash mid-write must
 * never leave a truncated manifest, which `readManifestV1` could not tell from a shorter one).
 * Throws on failure (the temp file is removed first); callers log it.
 * @param {string} manifestPath
 * @param {Map<string, number>} map
 */
function writeManifestV1(manifestPath, map) {
  const tmpPath = `${manifestPath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    let content = '';
    for (const [key, size] of map) content += `${key} ${size}\n`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, manifestPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // never existed, or already gone
    }
    throw err;
  }
}

/**
 * Scoped-path recording (DD-26): after a 201 for the current session's own `claude` transcript,
 * the prompt-triggered upload and the `SessionEnd` flush record its entry in BOTH manifests, so the
 * next `Stop` does not re-send an unchanged transcript. The caller holds `.upload.lock`, uploaded
 * the file's exact bytes (`sanitizeNdjson` dropped nothing), and never calls this for `artisyn`.
 * @param {string} telemetryDir
 * @param {string} sessionId
 * @param {number} readSize - the byte length read
 * @param {number} preReadMtimeMs - the file's mtime from a stat taken before the read
 * @param {AppendState|null} [appendState] - the append state to store with the entry
 *   (`appendBytes` / `appendLines` / `appendSha256`); null or omitted stores none
 */
function recordScopedClaudeUpload(telemetryDir, sessionId, readSize, preReadMtimeMs, appendState) {
  const key = `claude/${sessionId}.jsonl`;
  const v1Path = path.join(telemetryDir, MANIFEST_V1_NAME);
  const v2Path = path.join(telemetryDir, MANIFEST_V2_NAME);
  const v1 = readManifestV1(v1Path);
  const v2 = readManifestV2(v2Path);
  v1.set(key, readSize);
  /** @type {ManifestV2Entry} */
  const entry = {
    size: readSize,
    mtimeMs: preReadMtimeMs,
    paramsSha256: paramsSha256({ type: 'claude', sessionId }),
  };
  if (appendState && isValidAppendFields(appendState.bytes, appendState.lines, appendState.sha256)) {
    entry.appendBytes = appendState.bytes;
    entry.appendLines = appendState.lines;
    entry.appendSha256 = appendState.sha256;
  }
  v2.set(key, entry);
  writeManifestV1(v1Path, v1);
  writeManifestV2(v2Path, v2);
}

/**
 * The manifest keys a server-reported failed upload (`failedUploads` entry, DD-25/DD-26) maps to:
 * every key whose namespace (the part before the first `/`) equals `type` and whose last segment,
 * without `.jsonl`, equals `sessionId`. For `tool-calls` that is exactly `tool-calls/<sessionId>`.
 * A malformed entry maps to nothing.
 * @param {Iterable<string>} keys - the manifest's keys
 * @param {{ sessionId?: unknown, type?: unknown }} failed
 * @returns {string[]}
 */
function failedUploadManifestKeys(keys, failed) {
  if (!failed || typeof failed.sessionId !== 'string' || typeof failed.type !== 'string') return [];
  const { sessionId, type } = failed;
  if (!sessionId || !type) return [];
  const out = [];
  for (const key of keys) {
    const slash = key.indexOf('/');
    if (slash <= 0 || key.slice(0, slash) !== type) continue;
    const last = key.slice(key.lastIndexOf('/') + 1);
    const id = last.endsWith('.jsonl') ? last.slice(0, -'.jsonl'.length) : last;
    if (id === sessionId) out.push(key);
  }
  return out;
}

/**
 * Forget the server-reported failed uploads in BOTH in-memory manifests, so the next scan re-sends
 * those files (DD-25: the server already flagged the failures delivered, it will not repeat them).
 * `keepKey` — the key of the upload whose response carried the feedback — is left alone: that
 * upload just succeeded with the current bytes, and if its own processing fails the server reports
 * it again.
 * @param {Map<string, number>} v1
 * @param {Map<string, ManifestV2Entry>} v2
 * @param {Array<{ sessionId: string, type: string }>} failedUploads
 * @param {string|null} [keepKey]
 * @returns {string[]} the keys removed from either manifest
 */
function forgetFailedUploadsInMaps(v1, v2, failedUploads, keepKey) {
  const removed = new Set();
  if (!Array.isArray(failedUploads)) return [];
  for (const failed of failedUploads) {
    const keys = new Set([...failedUploadManifestKeys(v1.keys(), failed), ...failedUploadManifestKeys(v2.keys(), failed)]);
    for (const key of keys) {
      if (keepKey && key === keepKey) continue;
      if (v1.delete(key)) removed.add(key);
      if (v2.delete(key)) removed.add(key);
    }
  }
  return Array.from(removed);
}

/**
 * `forgetFailedUploadsInMaps` for the scoped paths (prompt upload, `SessionEnd` flush), which keep
 * no manifest in memory: reads both files, removes the keys and writes both back when anything
 * changed. The caller holds `.upload.lock`. Throws on a write failure; callers log it.
 * @param {string} telemetryDir
 * @param {Array<{ sessionId: string, type: string }>} failedUploads
 * @param {string|null} [keepKey]
 * @returns {string[]} the keys removed
 */
function forgetFailedUploads(telemetryDir, failedUploads, keepKey) {
  if (!Array.isArray(failedUploads) || failedUploads.length === 0) return [];
  const v1Path = path.join(telemetryDir, MANIFEST_V1_NAME);
  const v2Path = path.join(telemetryDir, MANIFEST_V2_NAME);
  const v1 = readManifestV1(v1Path);
  const v2 = readManifestV2(v2Path);
  const removed = forgetFailedUploadsInMaps(v1, v2, failedUploads, keepKey);
  if (removed.length > 0) {
    writeManifestV1(v1Path, v1);
    writeManifestV2(v2Path, v2);
  }
  return removed;
}

module.exports = {
  MANIFEST_V1_NAME,
  MANIFEST_V2_NAME,
  decideUploadSkip,
  canResumePending,
  paramsSha256,
  isValidAppendFields,
  appendStateOf,
  readManifestV1,
  writeManifestV1,
  readManifestV2,
  writeManifestV2,
  recordScopedClaudeUpload,
  failedUploadManifestKeys,
  forgetFailedUploadsInMaps,
  forgetFailedUploads,
};
