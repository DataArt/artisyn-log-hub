'use strict';

/**
 * Append uploads of `claude` / `claude-subagent` logs (plan `2026-11-24-traffic-optimization`,
 * Design Decisions 14–18; algorithm doc `docs/knowledgebase/algorithms/hook-upload-skip.md`).
 *
 * A session transcript only ever grows, yet every Stop used to re-send the whole file. The hook now
 * remembers, per manifest-v2 entry, how much of the file the server already holds
 * (`appendBytes` / `appendLines` / `appendSha256`, see `upload-skip.js`) and sends only the new
 * complete lines to `POST /api/v2/logs/append?startLine=<n>`. Any doubt — no state, a rewritten
 * prefix, a pending chunked upload, an old server without the route, a failed request — falls back
 * to the existing full upload, which stays the source of truth.
 *
 * - `planAppend`, `stateAfterFull`, `chooseAppendEncoding` are pure (algorithm-test rows).
 * - `isAppendOff` / `markAppendOff` keep a per-server 1 h cooldown in
 *   `<telemetryDir>/append-off.json` after the append route answered 404/413 (a pre-append server).
 * - `uploadWithAppend(ctx)` is the orchestrator the three call sites use (Stop scan, prompt upload,
 *   `SessionEnd` flush). It never runs the full upload itself: on `full-needed` the caller does.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { hookLog } = require('./hook-log');
const { sanitizeNdjson } = require('./ndjson-sanitize');
const {
  MANIFEST_V2_NAME, appendStateOf, failedUploadManifestKeys, paramsSha256, readManifestV2,
} = require('./upload-skip');
const {
  CHUNK_SIZE_BYTES,
  bodyContentSha256,
  formatServerOrigin,
  isLoopbackServerUrl,
  isEncodingRejection,
  isGzipUnsupported,
  readPendingUploads,
  uploadFile,
} = require('./upload-logs');

const HOOK_FILE = 'append-upload.js';

/** A delta smaller than this is sent uncompressed: gzip would save too little to be worth it. */
const APPEND_GZIP_MIN_BYTES = 16384;

/**
 * The largest uncompressed delta sent to the append route. A pre-append server parses an unknown
 * route with its 512,000-byte global text parser, so a bigger body would get a 413 there instead
 * of the 404 that tells the hook the route is missing. Larger deltas go through the full upload.
 */
const APPEND_MAX_PLAIN_BYTES = 512000;

/** How long the append route stays off for a server after it answered 404/413. */
const APPEND_OFF_MS = 3_600_000;

const APPEND_OFF_FILE = 'append-off.json';
const PENDING_FILE = '.claude-logs.pending';
const NEWLINE = 0x0a;

/**
 * @typedef {{ bytes: number, lines: number, sha256: string }} AppendState
 */

/** @param {Buffer} buf @returns {string} sha256 hex of the bytes */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Decide what to send for a file with append state (Design Decision 14). Pure.
 *
 * @param {{ buf: Buffer, state: AppendState|null|undefined, appendOff?: boolean,
 *   pendingChunked?: boolean }} input
 * @returns {{ kind: 'full', reason: 'no-state'|'append-off'|'pending-chunked'|'shorter'|'hash-changed' }
 *   | { kind: 'none', newState: AppendState }
 *   | { kind: 'append', startLine: number, delta: Buffer, records: number, newState: AppendState }}
 */
function planAppend(input) {
  const { buf, state, appendOff, pendingChunked } = input;
  if (!state) return { kind: 'full', reason: 'no-state' };
  if (appendOff) return { kind: 'full', reason: 'append-off' };
  if (pendingChunked) return { kind: 'full', reason: 'pending-chunked' };
  if (buf.length < state.bytes) return { kind: 'full', reason: 'shorter' };
  if (sha256Hex(buf.subarray(0, state.bytes)) !== state.sha256) return { kind: 'full', reason: 'hash-changed' };

  const end = buf.lastIndexOf(NEWLINE) + 1;
  if (end <= state.bytes) return { kind: 'none', newState: state };

  const s = sanitizeNdjson(buf.subarray(state.bytes, end));
  const newState = { bytes: end, lines: state.lines + s.records, sha256: sha256Hex(buf.subarray(0, end)) };
  if (s.records === 0) return { kind: 'none', newState };
  return { kind: 'append', startLine: state.lines, delta: s.body, records: s.records, newState };
}

/**
 * The append state to store after a successful full upload of `buf` (Design Decision 15). Pure.
 * Null when the bytes after the last newline hold a parseable record — the server then has a
 * record the hook's line counter cannot place, so the next upload must be a full one again.
 *
 * @param {Buffer} buf the raw file bytes the full upload was made from
 * @returns {AppendState|null}
 */
function stateAfterFull(buf) {
  const end = buf.lastIndexOf(NEWLINE) + 1;
  const tail = buf.toString('utf8', end).trim();
  if (tail.length > 0) {
    let parsed = false;
    try {
      JSON.parse(tail);
      parsed = true;
    } catch {
      // a torn last line: the server dropped it with the rest of the malformed lines
    }
    if (parsed) return null;
  }
  const prefix = buf.subarray(0, end);
  return { bytes: end, lines: sanitizeNdjson(prefix).records, sha256: sha256Hex(prefix) };
}

/**
 * The encoding of a delta (Design Decision 16). Pure. Gzip only when the delta is at least
 * `APPEND_GZIP_MIN_BYTES`, the server has not rejected gzip in this process, the server is not
 * loopback and the gzipped body is actually smaller.
 *
 * @param {{ plainBytes: number, gzipBytes?: number|null, gzipUnsupported: boolean, loopback: boolean }} input
 * @returns {'gzip'|'identity'}
 */
function chooseAppendEncoding(input) {
  const { plainBytes, gzipBytes, gzipUnsupported, loopback } = input;
  if (!(plainBytes >= APPEND_GZIP_MIN_BYTES)) return 'identity';
  if (gzipUnsupported) return 'identity';
  if (loopback) return 'identity';
  if (typeof gzipBytes !== 'number' || !(gzipBytes < plainBytes)) return 'identity';
  return 'gzip';
}

/** @param {string} serverUrl @returns {string} the cooldown file's key for this server */
function appendOffKey(serverUrl) {
  return String(serverUrl || '').trim().replace(/\/+$/, '');
}

/**
 * @param {string} telemetryDir
 * @returns {Record<string, number>} the cooldown map; empty when missing or malformed
 */
function readAppendOff(telemetryDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(telemetryDir, APPEND_OFF_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // missing or malformed — counts as "not off"
  }
  return {};
}

/**
 * Whether the append route is in its 404 cooldown for `serverUrl` (Design Decision 17).
 * A missing or malformed file counts as not off.
 * @param {string} telemetryDir
 * @param {string} serverUrl
 * @param {number} now epoch ms
 * @returns {boolean}
 */
function isAppendOff(telemetryDir, serverUrl, now) {
  const until = readAppendOff(telemetryDir)[appendOffKey(serverUrl)];
  return typeof until === 'number' && Number.isFinite(until) && until > now;
}

/**
 * Turn the append route off for `serverUrl` until `now + APPEND_OFF_MS`, with temp file + rename.
 * Never throws: a failed write only means the next run probes the route again.
 * @param {string} telemetryDir
 * @param {string} serverUrl
 * @param {number} now epoch ms
 * @returns {boolean} true when the file was written
 */
function markAppendOff(telemetryDir, serverUrl, now) {
  const map = readAppendOff(telemetryDir);
  const clean = {};
  for (const [key, until] of Object.entries(map)) {
    // Expired or malformed entries are dropped, so the file never grows without bound.
    if (typeof until === 'number' && Number.isFinite(until) && until > now) clean[key] = until;
  }
  clean[appendOffKey(serverUrl)] = now + APPEND_OFF_MS;
  const filePath = path.join(telemetryDir, APPEND_OFF_FILE);
  const tmpPath = `${filePath}.tmp`;
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(clean), 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // never existed, or already gone
    }
    return false;
  }
}

/**
 * Whether a chunked upload of this file is still pending (`.claude-logs.pending`): the append
 * path must not run next to it.
 * @param {string} telemetryDir
 * @param {string} manifestKey
 * @returns {boolean}
 */
function hasPendingChunked(telemetryDir, manifestKey) {
  try {
    return readPendingUploads(path.join(telemetryDir, PENDING_FILE)).has(manifestKey);
  } catch {
    return false;
  }
}

/**
 * The fallback reason for a failed append request (Design Decision 18).
 * @param {{ statusCode?: number|null, reason?: string|null }} result
 * @returns {string}
 */
function failureReason(result) {
  const status = result && result.statusCode;
  if (typeof status === 'number') {
    if (status === 404 || status === 413) return 'route-missing';
    return `http-${status}`;
  }
  const reason = result && typeof result.reason === 'string' ? result.reason : '';
  if (reason.startsWith('timeout')) return 'timeout';
  return 'network';
}

/**
 * Try the append path for one `claude` / `claude-subagent` file (Design Decisions 16–18).
 *
 * @param {{ buf: Buffer, state: AppendState|null, manifestKey: string, serverUrl: string,
 *   apiKey: string, namespace: string, sessionId: string, parentSessionId?: string|null,
 *   workflowRunId?: string|null, agentMeta?: {agentDescription?: string|null, workflowPhase?: string|null}|null,
 *   timeoutMs: number, hookSessionId: string|null, cwd: string|null, telemetryDir: string }} ctx
 * @returns {Promise<{ kind: 'none', newState: AppendState }
 *   | { kind: 'appended', result: object, newState: AppendState, records: number, startLine: number,
 *       plainBytes: number, wireBytes: number, encoding: 'gzip'|'identity' }
 *   | { kind: 'full-needed', reason: string }>}
 *   `full-needed`: the caller runs its existing full upload and stores `stateAfterFull(buf)`.
 */
async function uploadWithAppend(ctx) {
  try {
    const plan = planAppend({
      buf: ctx.buf,
      state: ctx.state,
      appendOff: ctx.state ? isAppendOff(ctx.telemetryDir, ctx.serverUrl, Date.now()) : false,
      pendingChunked: ctx.state ? hasPendingChunked(ctx.telemetryDir, ctx.manifestKey) : false,
    });
    if (plan.kind === 'full') return { kind: 'full-needed', reason: plan.reason };
    if (plan.kind === 'none') return { kind: 'none', newState: plan.newState };

    const delta = plan.delta;
    const plainBytes = delta.length;
    if (plainBytes > APPEND_MAX_PLAIN_BYTES) return { kind: 'full-needed', reason: 'over-budget' };

    const gzipUnsupported = isGzipUnsupported();
    const loopback = isLoopbackServerUrl(ctx.serverUrl);
    let gzipped = null;
    if (plainBytes >= APPEND_GZIP_MIN_BYTES && !gzipUnsupported && !loopback) {
      gzipped = zlib.gzipSync(delta);
    }
    let encoding = chooseAppendEncoding({
      plainBytes,
      gzipBytes: gzipped ? gzipped.length : null,
      gzipUnsupported,
      loopback,
    });
    let wireBody = encoding === 'gzip' && gzipped ? gzipped : delta;
    if (wireBody.length > CHUNK_SIZE_BYTES) return { kind: 'full-needed', reason: 'over-budget' };

    // DD-24: the hash of the uncompressed delta, the same on a gzipped attempt and a plain retry.
    const contentSha256 = bodyContentSha256(delta);
    const send = (body, enc) => uploadFile(
      ctx.serverUrl, ctx.apiKey, ctx.namespace, ctx.sessionId, body, ctx.timeoutMs,
      ctx.hookSessionId, ctx.cwd, ctx.parentSessionId || null, ctx.workflowRunId || null, null,
      enc === 'gzip' ? 'gzip' : null, null, ctx.agentMeta || null, contentSha256, plan.startLine,
    );

    let result = await send(wireBody, encoding);
    if (!result.success && encoding === 'gzip' && isEncodingRejection(result)) {
      // Same delta, same URL — only the encoding changes (as `uploadFileMaybeCompressed` does).
      encoding = 'identity';
      wireBody = delta;
      result = await send(wireBody, encoding);
    }

    if (!result.success) {
      const reason = failureReason(result);
      if (reason === 'route-missing') {
        markAppendOff(ctx.telemetryDir, ctx.serverUrl, Date.now());
        hookLog(
          HOOK_FILE, ctx.hookSessionId, 'warn',
          `append route not available on ${formatServerOrigin(ctx.serverUrl)} (HTTP ${result.statusCode})`
          + ' — append uploads off for 1 h',
          ctx.cwd,
        );
      }
      return { kind: 'full-needed', reason };
    }

    return {
      kind: 'appended',
      result,
      newState: plan.newState,
      records: plan.records,
      startLine: plan.startLine,
      plainBytes,
      wireBytes: wireBody.length,
      encoding,
    };
  } catch (err) {
    hookLog(
      HOOK_FILE, ctx && ctx.hookSessionId, 'error',
      `${ctx && ctx.manifestKey}: append upload threw: ${err && err.message}`,
      ctx && ctx.cwd,
    );
    return { kind: 'full-needed', reason: 'error' };
  }
}

/**
 * The append state a call site may use for a v2 entry: its append fields, but only when the entry
 * was recorded with the same upload params — a changed `parentSessionId` / `workflowRunId` / agent
 * meta means the next upload must be a full one (the server stores the log under those params).
 * @param {{ paramsSha256?: string }|undefined|null} entry the `.claude-logs.sent.v2` entry
 * @param {string} currentParamsSha256 `paramsSha256()` of this upload's params
 * @returns {AppendState|null}
 */
function appendStateForEntry(entry, currentParamsSha256) {
  if (!entry || entry.paramsSha256 !== currentParamsSha256) return null;
  return appendStateOf(entry);
}

/**
 * The append state of the session's own `claude` transcript for the scoped paths (prompt upload,
 * `SessionEnd` flush), which keep no manifest in memory. The caller holds `.upload.lock`.
 * @param {string} telemetryDir
 * @param {string} sessionId
 * @returns {AppendState|null}
 */
function readScopedAppendState(telemetryDir, sessionId) {
  try {
    const entry = readManifestV2(path.join(telemetryDir, MANIFEST_V2_NAME)).get(`claude/${sessionId}.jsonl`);
    return appendStateForEntry(entry, paramsSha256({ type: 'claude', sessionId }));
  } catch {
    return null;
  }
}

/**
 * Whether a `failedUploads` list (DD-25) names this upload's own manifest key (Design Decision 19).
 * @param {Array<{sessionId: string, type: string}>|undefined} failedUploads
 * @param {string} manifestKey
 * @returns {boolean}
 */
function failedUploadsIncludeKey(failedUploads, manifestKey) {
  if (!Array.isArray(failedUploads)) return false;
  return failedUploads.some((f) => failedUploadManifestKeys([manifestKey], f).length > 0);
}

/**
 * The `hook.log` `result` line for a successful append (Design Decision 21). Exact byte counts,
 * so a scenario can compare them with the delta size.
 * @param {string} manifestKey
 * @param {{ records: number, startLine: number, plainBytes: number, wireBytes: number,
 *   encoding: 'gzip'|'identity' }} appended
 * @returns {string}
 */
function formatAppendResultLine(manifestKey, appended) {
  const { records, startLine, plainBytes, wireBytes, encoding } = appended;
  const wire = encoding === 'gzip' ? `${plainBytes} B → ${wireBytes} B gz` : `${plainBytes} B uncompressed`;
  return `${manifestKey}: appended ${records} lines from line ${startLine}: ${wire}`;
}

/**
 * The `hook.log` line for a file that had to take the full upload instead of the append path
 * (Design Decision 21). Null for `no-state` — a first upload is not a fallback worth a line.
 * @param {string} manifestKey
 * @param {string} reason a Design Decision 18 reason, or `failed-feedback`
 * @returns {string|null}
 */
function formatAppendFallbackLine(manifestKey, reason) {
  if (!reason || reason === 'no-state') return null;
  return `${manifestKey}: append not used (${reason}) — full upload`;
}

module.exports = {
  APPEND_GZIP_MIN_BYTES,
  APPEND_MAX_PLAIN_BYTES,
  APPEND_OFF_MS,
  APPEND_OFF_FILE,
  planAppend,
  stateAfterFull,
  chooseAppendEncoding,
  isAppendOff,
  markAppendOff,
  uploadWithAppend,
  appendStateForEntry,
  readScopedAppendState,
  failedUploadsIncludeKey,
  formatAppendResultLine,
  formatAppendFallbackLine,
};
