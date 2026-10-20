'use strict';
/**
 * Shared upload primitives used by both the Stop/Interrupt-triggered
 * `send-logs-hook.js` and the prompt-triggered `prompt-upload-hook.js`.
 *
 * Exports:
 *   CHUNK_SIZE_BYTES     — 900KB chunk-splitting threshold/size.
 *   formatServerOrigin() — `serverUrl` reduced to its origin, for logging the upload destination.
 *   uploadFile()         — single-request upload (chunk-aware via an optional chunkMeta param).
 *   uploadFileChunked()  — splits a body >CHUNK_SIZE_BYTES into sequential chunk uploads, with
 *                          resumability across process restarts via a `.claude-logs.pending` file.
 *   readPendingUploads() / writePendingUploads() — helpers for that pending-upload record file.
 *   acquireUploadLock() / releaseUploadLock()    — mutual-exclusion lock shared by both callers
 *                          so the Stop-triggered and prompt-triggered upload paths never run at
 *                          the same time for the same project.
 *
 * All functions take `telemetryDir`/`manifestKey` as explicit params — no module-level state —
 * so both callers can use this module concurrently for different projects/sessions.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const { hookLog } = require('./hook-log');

const HOOK_FILE = 'upload-logs.js';

// 900KB, not 10MB: many deployments sit behind a reverse proxy (e.g. nginx) whose
// client_max_body_size defaults to 1MB and 413s any larger request before it ever reaches the
// app — a limit this hook cannot detect or negotiate. 900KB leaves ~124KB of headroom under that
// 1,048,576-byte default. See doc/knowledgebase/hook-api-versioning.md for the full writeup.
const CHUNK_SIZE_BYTES = 900 * 1024;

/**
 * Reduce a configured `serverUrl` to its origin (`protocol//host:port`) for logging.
 *
 * Every upload destination is config-driven (`.artisyn/config/log-hub.json` → `serverUrl`); nothing
 * in the hook hardcodes a host. A stale or mistyped value is therefore invisible until someone
 * notices sessions landing in the wrong instance, so every per-run log line names the origin it
 * used. Only the origin: never the path, the query string (which carries sessionId) or the API key.
 *
 * @param {string} serverUrl
 * @returns {string} the origin, or the raw value (truncated) when it cannot be parsed — an
 *   unparsable `serverUrl` is exactly the case worth showing verbatim.
 */
function formatServerOrigin(serverUrl) {
  const raw = typeof serverUrl === 'string' ? serverUrl.trim() : '';
  if (!raw) return '(unset)';
  try {
    return new URL(raw).origin;
  } catch {
    return raw.slice(0, 100);
  }
}

// ---------------------------------------------------------------------------
// HTTP upload
// ---------------------------------------------------------------------------

/**
 * Upload a JSONL file (or one chunk of one) to the server.
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} namespace
 * @param {string} sessionId
 * @param {Buffer} body
 * @param {number} timeoutMs
 * @param {string|null} hookSessionId
 * @param {string|null} cwd
 * @param {string|null} [parentSessionId]
 * @param {string|null} [workflowRunId]
 * @param {{uploadId: string, chunkIndex: number, totalChunks: number, totalSize?: number}|null} [chunkMeta] -
 *   when present, the request is a chunked-upload chunk: appends `uploadId`/`chunkIndex`/`totalChunks`
 *   query params (and `totalSize` when present on the meta object, per Decision 3 — only chunk 0 sets it).
 * @returns {Promise<{ success: boolean, reason: string|null, warnings?: string[], complete?: boolean }>}
 */
function uploadFile(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId, workflowRunId, chunkMeta) {
  return new Promise((resolve) => {
    let urlStr = `${serverUrl}/api/v2/logs?type=${encodeURIComponent(namespace)}&sessionId=${encodeURIComponent(sessionId)}`;
    if (parentSessionId) {
      urlStr += `&parentSessionId=${encodeURIComponent(parentSessionId)}`;
    }
    if (workflowRunId) {
      urlStr += `&workflowRunId=${encodeURIComponent(workflowRunId)}`;
    }
    if (chunkMeta) {
      if (chunkMeta.uploadId !== undefined && chunkMeta.uploadId !== null) {
        urlStr += `&uploadId=${encodeURIComponent(chunkMeta.uploadId)}`;
      }
      if (chunkMeta.chunkIndex !== undefined && chunkMeta.chunkIndex !== null) {
        urlStr += `&chunkIndex=${encodeURIComponent(chunkMeta.chunkIndex)}`;
      }
      if (chunkMeta.totalChunks !== undefined && chunkMeta.totalChunks !== null) {
        urlStr += `&totalChunks=${encodeURIComponent(chunkMeta.totalChunks)}`;
      }
      if (chunkMeta.totalSize !== undefined && chunkMeta.totalSize !== null) {
        urlStr += `&totalSize=${encodeURIComponent(chunkMeta.totalSize)}`;
      }
    }
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (err) {
      const msg = `invalid SERVER_URL (target=${formatServerOrigin(serverUrl)}): ${err.message}`;
      process.stderr.write(`upload-logs: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      resolve({ success: false, reason: msg });
      return;
    }

    const bodyBytes = Buffer.byteLength(body);
    const bodyMb = (bodyBytes / 1024 / 1024).toFixed(1);
    // `target` names the destination origin on every failure path below — a wrong or stale
    // `serverUrl` otherwise shows up as a bare ENOTFOUND/HTTP status with no hint of where the
    // upload was actually addressed. Origin only: the path/query carry the sessionId, and the
    // API key travels in a header that is never logged.
    const reqCtx = `size=${bodyMb}MB timeout=${timeoutMs}ms target=${urlObj.origin}`;

    const transport = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'X-API-Key': apiKey,
        'Content-Length': bodyBytes,
      },
    };

    const req = transport.request(options, (res) => {
      if (res.statusCode === 201) {
        // Buffer the response body (same 2000-byte cap as the non-201 branch below)
        // so we can pick up any `{ warnings: string[], complete?: boolean }` the server returned.
        const okChunks = [];
        let okReceived = 0;
        res.on('data', (chunk) => {
          if (okReceived < 2000) {
            okChunks.push(chunk);
            okReceived += chunk.length;
          }
        });
        res.on('end', () => {
          let warnings = [];
          let complete;
          try {
            const parsed = JSON.parse(Buffer.concat(okChunks).toString('utf8'));
            warnings = parsed && Array.isArray(parsed.warnings) ? parsed.warnings : [];
            if (parsed && typeof parsed.complete === 'boolean') {
              complete = parsed.complete;
            }
          } catch {
            // fail-open: no/invalid JSON body — treat as no warnings
            warnings = [];
          }
          const result = { success: true, reason: null, warnings };
          if (complete !== undefined) result.complete = complete;
          resolve(result);
        });
        return;
      }

      // Capture a snippet of the response body so the actual server-side
      // rejection reason (e.g. a body-parser "entity too large" message,
      // or a validation error) shows up in the hook log instead of just a
      // bare status code.
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        if (received < 2000) {
          chunks.push(chunk);
          received += chunk.length;
        }
      });
      res.on('end', () => {
        const snippet = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500);
        let hint = '';
        if (res.statusCode === 413) {
          hint = ' — payload exceeds the server\'s request body limit; this session file is too large to upload in one request';
        } else if (res.statusCode === 400 && bodyBytes > CHUNK_SIZE_BYTES / 2) {
          // No request this module sends is ever larger than CHUNK_SIZE_BYTES (uploadFileChunked
          // slices before calling uploadFile), so a "large" rejected body here means a proxy in
          // front of the server has an even stricter cap than our own chunk size — not that this
          // one request happens to be unusually big by absolute standards.
          hint = ' — large payload rejected; check server body-size limit and reverse-proxy/client_max_body_size settings';
        }
        const msg = `upload failed for ${namespace}/${sessionId}: HTTP ${res.statusCode} (${reqCtx})${snippet ? ` response=${snippet}` : ''}${hint}`;
        process.stderr.write(`upload-logs: ${msg}\n`);
        hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
        resolve({ success: false, reason: `HTTP ${res.statusCode}${hint}` });
      });
    });

    req.setTimeout(timeoutMs, () => {
      const msg = `upload timeout for ${namespace}/${sessionId} (${reqCtx})`
        + ' — the file did not finish uploading before sendLogsTimeoutMs elapsed;'
        + ' for large sessions raise sendLogsTimeoutMs in .artisyn/config/log-hub.local.json';
      process.stderr.write(`upload-logs: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      req.destroy();
      resolve({ success: false, reason: `timeout after ${timeoutMs}ms (size=${bodyMb}MB)` });
    });

    req.on('error', (err) => {
      const largePayloadHint = bodyBytes > CHUNK_SIZE_BYTES / 2
        ? ' — connection was interrupted mid-upload of a large payload; may indicate a server/proxy body-size or timeout limit'
        : '';
      const msg = `network error for ${namespace}/${sessionId}: ${err.message} (code=${err.code || 'unknown'}, ${reqCtx})${largePayloadHint}`;
      process.stderr.write(`upload-logs: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      resolve({ success: false, reason: `network error: ${err.message}${largePayloadHint}` });
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Pending-upload record file (.claude-logs.pending) — chunked-upload resumability
// ---------------------------------------------------------------------------

/**
 * Read `.claude-logs.pending`: one line per in-progress chunked upload,
 * `<manifestKey> <uploadId> <chunkIndex> <size>`.
 * @param {string} pendingPath
 * @returns {Map<string, {uploadId: string, chunkIndex: number, size: number}>}
 */
function readPendingUploads(pendingPath) {
  const map = new Map();
  try {
    const lines = fs.readFileSync(pendingPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;
      const size = parseInt(parts[parts.length - 1], 10);
      const chunkIndex = parseInt(parts[parts.length - 2], 10);
      const uploadId = parts[parts.length - 3];
      const key = parts.slice(0, parts.length - 3).join(' ');
      if (!key || !uploadId || isNaN(chunkIndex) || isNaN(size)) continue;
      map.set(key, { uploadId, chunkIndex, size });
    }
  } catch {
    // file missing or unreadable — start fresh
  }
  return map;
}

/**
 * Rewrite `.claude-logs.pending` from the current map.
 * @param {string} telemetryDir
 * @param {string} pendingPath
 * @param {Map<string, {uploadId: string, chunkIndex: number, size: number}>} map
 * @param {string|null} [sessionId]
 * @param {string|null} [cwd]
 */
function writePendingUploads(telemetryDir, pendingPath, map, sessionId, cwd) {
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    let content = '';
    for (const [key, rec] of map) {
      content += `${key} ${rec.uploadId} ${rec.chunkIndex} ${rec.size}\n`;
    }
    fs.writeFileSync(pendingPath, content, 'utf8');
  } catch (err) {
    const msg = `failed to write pending-uploads file: ${err.message}`;
    process.stderr.write(`upload-logs: ${msg}\n`);
    hookLog(HOOK_FILE, sessionId || null, 'error', msg, cwd || null);
  }
}

// ---------------------------------------------------------------------------
// Chunked upload
// ---------------------------------------------------------------------------

/**
 * Upload a body larger than CHUNK_SIZE_BYTES as a sequence of chunk requests, resumable
 * across process restarts via `.claude-logs.pending`.
 *
 * Return shape matches the non-chunked `uploadFile()` caller contract: only the final
 * chunk's `warnings` are surfaced, and any chunk failure (other than the resume-target-gone
 * 400 fallback, Decision 12) marks the whole upload failed.
 *
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} namespace
 * @param {string} sessionId
 * @param {Buffer} body
 * @param {number} timeoutMs
 * @param {string|null} hookSessionId
 * @param {string|null} cwd
 * @param {string|null} parentSessionId
 * @param {string|null} workflowRunId
 * @param {string} telemetryDir
 * @param {string} manifestKey
 * @returns {Promise<{ success: boolean, reason: string|null, warnings?: string[] }>}
 */
async function uploadFileChunked(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId, workflowRunId, telemetryDir, manifestKey) {
  const totalSize = Buffer.byteLength(body);
  const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE_BYTES));
  const pendingPath = path.join(telemetryDir, '.claude-logs.pending');
  const pending = readPendingUploads(pendingPath);

  const existing = pending.get(manifestKey);
  const resumed = !!(existing && existing.size === totalSize);

  let uploadId = resumed ? existing.uploadId : crypto.randomUUID();
  let chunkIndex = resumed ? existing.chunkIndex : 0;
  const startChunkIndex = chunkIndex;
  let allowRestart = resumed;

  while (chunkIndex < totalChunks) {
    const start = chunkIndex * CHUNK_SIZE_BYTES;
    const end = Math.min(start + CHUNK_SIZE_BYTES, totalSize);
    const chunkBody = body.subarray(start, end);
    const chunkMeta = { uploadId, chunkIndex, totalChunks };
    if (chunkIndex === 0) chunkMeta.totalSize = totalSize;

    const result = await uploadFile(
      serverUrl, apiKey, namespace, sessionId, chunkBody, timeoutMs, hookSessionId, cwd,
      parentSessionId, workflowRunId, chunkMeta,
    );

    if (!result.success) {
      const is400 = typeof result.reason === 'string' && result.reason.startsWith('HTTP 400');
      // Decision 12: a resumed chunk request (reusing a stored uploadId) that comes back
      // 400 (e.g. the server-side row was cleaned up) is treated like a fresh upload
      // attempt — discard the pending record, generate a new uploadId, restart from
      // chunkIndex=0, once, within this same call.
      if (allowRestart && chunkIndex === startChunkIndex && is400) {
        allowRestart = false;
        pending.delete(manifestKey);
        writePendingUploads(telemetryDir, pendingPath, pending, hookSessionId, cwd);
        uploadId = crypto.randomUUID();
        chunkIndex = 0;
        continue;
      }
      return { success: false, reason: result.reason };
    }

    if (result.complete) {
      pending.delete(manifestKey);
      writePendingUploads(telemetryDir, pendingPath, pending, hookSessionId, cwd);
      return { success: true, reason: null, warnings: result.warnings || [] };
    }

    // Record the just-acked chunk so a later run can resume from here (Decision 11).
    pending.set(manifestKey, { uploadId, chunkIndex, size: totalSize });
    writePendingUploads(telemetryDir, pendingPath, pending, hookSessionId, cwd);

    chunkIndex++;
  }

  // Defensive fallback: the loop only exits normally via the `complete: true` branch
  // above. Reaching here means the server never reported completion on the final
  // chunk — treat it as a failure rather than silently reporting success.
  return { success: false, reason: 'chunked upload did not receive a final completion response' };
}

// ---------------------------------------------------------------------------
// Upload lock (mutual exclusion between Stop-triggered and prompt-triggered uploads)
// ---------------------------------------------------------------------------

const LOCK_FILE_NAME = '.upload.lock';

/**
 * Acquire `<telemetryDir>/.upload.lock`. Fails (returns `{acquired: false}`) only when a
 * non-stale lock already exists; a missing/corrupt/stale lock is treated as free and
 * (best-effort) overwritten with a fresh `{startedAt}` record.
 * @param {string} telemetryDir
 * @param {number} staleWindowMs
 * @returns {{acquired: boolean}}
 */
function acquireUploadLock(telemetryDir, staleWindowMs) {
  const lockPath = path.join(telemetryDir, LOCK_FILE_NAME);
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    const startedAt = parsed && typeof parsed.startedAt === 'string' ? parsed.startedAt : null;
    if (startedAt) {
      const age = Date.now() - Date.parse(startedAt);
      if (!isNaN(age) && age < staleWindowMs) {
        return { acquired: false };
      }
    }
  } catch {
    // missing, unreadable, or corrupt lock file — treat as free
  }

  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString() }), 'utf8');
  } catch {
    // best-effort: if we can't persist the lock, fail open and proceed anyway
  }
  return { acquired: true };
}

/**
 * Best-effort release of `<telemetryDir>/.upload.lock`.
 * @param {string} telemetryDir
 */
function releaseUploadLock(telemetryDir) {
  try {
    fs.unlinkSync(path.join(telemetryDir, LOCK_FILE_NAME));
  } catch {
    // best-effort — nothing to do if it's already gone or unremovable
  }
}

module.exports = {
  CHUNK_SIZE_BYTES,
  formatServerOrigin,
  uploadFile,
  uploadFileChunked,
  readPendingUploads,
  writePendingUploads,
  acquireUploadLock,
  releaseUploadLock,
};
