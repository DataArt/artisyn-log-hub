'use strict';
/**
 * Shared upload primitives used by both the Stop-triggered
 * `send-logs-hook.js` and the prompt-triggered `prompt-upload-hook.js`.
 *
 * Exports:
 *   CHUNK_SIZE_BYTES     — 900KB chunk-splitting threshold, and the on-the-wire budget per request.
 *   formatServerOrigin() — `serverUrl` reduced to its origin, for logging the upload destination.
 *   isLoopbackServerUrl() — true when `serverUrl` addresses this machine, so compressing would only
 *                          burn CPU for no transfer win.
 *   alignSliceBoundary() — newline-/UTF-8-safe end offset for a slice of an NDJSON body.
 *   readGzipRatio() / writeGzipRatio() — remembered compression ratio (`<telemetryDir>/gzip-stat.json`)
 *                          used to predict slice sizes on the next run.
 *   isEncodingRejection() / resetGzipSupport() — classifier and reset for the process-level
 *                          "this server does not accept gzip" flag.
 *   planCompressedSlices() — adaptive slice plan for a chunked upload: predicts an uncompressed
 *                          slice length from a ratio, compresses, shrinks on overshoot.
 *   planIdentitySlices() — fixed-size newline-aligned plan used by the uncompressed fallback.
 *   uploadFile()         — single-request upload (chunk-aware via an optional chunkMeta param,
 *                          encoding-aware via an optional bodyEncoding param). Never compresses.
 *   uploadFileMaybeCompressed() — single-request upload that decides the encoding itself and
 *                          retries plain once if the server rejects the gzipped body.
 *   uploadFileChunked()  — splits a body >CHUNK_SIZE_BYTES into sequential chunk uploads sized so
 *                          each *request* stays under CHUNK_SIZE_BYTES on the wire, with
 *                          resumability across process restarts via a `.claude-logs.pending` file.
 *   readPendingUploads() / writePendingUploads() — helpers for that pending-upload record file,
 *                          which is a whole-file JSON document (`{version: 2, entries: {…}}`)
 *                          carrying each in-progress upload's slice plan.
 *   acquireUploadLock() / releaseUploadLock()    — mutual-exclusion lock shared by both callers
 *                          so the Stop-triggered and prompt-triggered upload paths never run at
 *                          the same time for the same project.
 *
 * All functions take `telemetryDir`/`manifestKey` as explicit params — no module-level state —
 * so both callers can use this module concurrently for different projects/sessions.
 *
 * The one deliberate exception is the module-level `gzipUnsupported` flag: it records a *transport
 * capability of the process's peer* ("this server rejected a gzipped body"), not per-project or
 * per-session state, so sharing it across every project handled by one process is exactly right —
 * it stops the hook from re-paying a rejected round-trip for each subsequent file. It is set only
 * by `isEncodingRejection()` and cleared only by `resetGzipSupport()` (used by tests).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const { hookLog } = require('./hook-log');

const HOOK_FILE = 'upload-logs.js';

// 900KB, not 10MB: many deployments sit behind a reverse proxy (e.g. nginx) whose
// client_max_body_size defaults to 1MB and 413s any larger request before it ever reaches the
// app — a limit this hook cannot detect or negotiate. 900KB leaves ~124KB of headroom under that
// 1,048,576-byte default. See docs/knowledgebase/hook-api-versioning.md for the full writeup.
const CHUNK_SIZE_BYTES = 900 * 1024;

// --- gzip transport tuning -------------------------------------------------
// A compressed request carries far more than 900KB of NDJSON, but how much more is only knowable
// after compressing. The planner therefore *predicts* an uncompressed slice length from a ratio,
// compresses, and shrinks on overshoot; these constants pin that loop's behaviour so it is not
// re-tuned per call site.

/** Ratio assumed when no usable ratio has been remembered yet. */
const GZIP_DEFAULT_RATIO = 8.0;
/** Multiplier applied to the predicted slice length, so a mispredicted ratio still fits. */
const GZIP_SAFETY_MARGIN = 0.8;
/** Factor the predicted slice length is multiplied by after each overshoot. */
const GZIP_SHRINK_FACTOR = 0.5;
/** Max shrink retries for one slice before falling back to an uncompressed slice. */
const GZIP_MAX_RECOMPRESS = 4;
/** Hard cap on a single uncompressed slice (16MB), bounding peak memory per compression. */
const GZIP_MAX_SLICE_BYTES = 16 * 1024 * 1024;
/** A compressed slice below this fraction of the budget means the ratio was under-predicted. */
const GZIP_REGROW_FRACTION = 0.5;
/** Validity clamp for a remembered/observed ratio. */
const GZIP_RATIO_MIN = 1.0;
const GZIP_RATIO_MAX = 100;
/** Ratio-memory filename, always resolved under the caller-supplied `telemetryDir`. */
const GZIP_STAT_FILE = 'gzip-stat.json';
/** Floor for the 413-driven halving of the on-the-wire budget. */
const GZIP_MIN_WIRE_BUDGET = 128 * 1024;
/** Max 413-driven re-plans per `uploadFileChunked()` call. */
const GZIP_MAX_BUDGET_RETRIES = 2;

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
// gzip transport helpers
// ---------------------------------------------------------------------------

/**
 * True when `serverUrl` addresses this same machine.
 *
 * Compressing for a loopback destination is pure loss: there is no network to save, so the gzip CPU
 * cost is spent for nothing (and a local dev server is exactly where the hook runs most often).
 * Decided from the URL alone — no probing, no config flag — using the same `new URL()` parse as
 * `formatServerOrigin()`.
 *
 * @param {string} serverUrl
 * @returns {boolean} false for anything unparsable — such an upload fails on its own merits.
 */
function isLoopbackServerUrl(serverUrl) {
  const raw = typeof serverUrl === 'string' ? serverUrl.trim() : '';
  if (!raw) return false;
  let hostname;
  try {
    hostname = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  // `URL.hostname` keeps the brackets around an IPv6 literal (`http://[::1]/` → `[::1]`).
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Pick a safe end offset for the slice `[start, targetEnd)` of an NDJSON body.
 *
 * Two problems it solves at once: a slice that ends mid-line is fine for the server (it concatenates
 * chunks before parsing) but makes every slice individually un-decodable, and — the latent bug in
 * the previous fixed-offset slicing — a slice that ends mid-UTF-8-character produces mojibake the
 * moment anything decodes a chunk on its own. So: prefer to cut just after a newline; failing that,
 * back off to a UTF-8 character boundary.
 *
 * @param {Buffer} body
 * @param {number} start inclusive start offset of the slice
 * @param {number} targetEnd desired exclusive end offset
 * @returns {number} an end offset strictly greater than `start`, so a planner looping on this can
 *   never stall.
 */
function alignSliceBoundary(body, start, targetEnd) {
  if (targetEnd >= body.length) return body.length;
  for (let i = targetEnd - 1; i >= start; i--) {
    if (body[i] === 0x0A) return i + 1;
  }
  // No newline in range (one giant line): walk back off any UTF-8 continuation byte (10xxxxxx),
  // floored at start + 1 so the slice is never empty.
  let end = targetEnd;
  while (end > start + 1 && (body[end] & 0xC0) === 0x80) end--;
  return end;
}

/**
 * Read the remembered compression ratio from `<telemetryDir>/gzip-stat.json`.
 *
 * Degrades silently in the same way as `acquireUploadLock()`'s lock read: a missing, unreadable,
 * malformed or out-of-clamp value is simply "no memory yet", never an upload failure.
 *
 * @param {string} telemetryDir caller-supplied — never a hardcoded path.
 * @returns {number} the remembered ratio, or `GZIP_DEFAULT_RATIO`.
 */
function readGzipRatio(telemetryDir) {
  try {
    const raw = fs.readFileSync(path.join(telemetryDir, GZIP_STAT_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    const ratio = parsed && typeof parsed.ratio === 'number' ? parsed.ratio : NaN;
    if (Number.isFinite(ratio) && ratio >= GZIP_RATIO_MIN && ratio <= GZIP_RATIO_MAX) {
      return ratio;
    }
  } catch {
    // missing, unreadable or corrupt stat file — fall back to the default prediction
  }
  return GZIP_DEFAULT_RATIO;
}

/**
 * Best-effort write of the observed compression ratio to `<telemetryDir>/gzip-stat.json`.
 *
 * Purely an optimisation for the *next* run's first slice prediction, so a failure to persist it is
 * logged and shrugged off — never propagated to the upload.
 *
 * @param {string} telemetryDir caller-supplied — never a hardcoded path.
 * @param {number} ratio ignored unless finite and within [GZIP_RATIO_MIN, GZIP_RATIO_MAX].
 * @param {string|null} [sessionId]
 * @param {string|null} [cwd]
 */
function writeGzipRatio(telemetryDir, ratio, sessionId, cwd) {
  if (!Number.isFinite(ratio) || ratio < GZIP_RATIO_MIN || ratio > GZIP_RATIO_MAX) return;
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(
      path.join(telemetryDir, GZIP_STAT_FILE),
      JSON.stringify({ ratio, updatedAt: new Date().toISOString() }),
      'utf8',
    );
  } catch (err) {
    hookLog(HOOK_FILE, sessionId || null, 'warn', `failed to write ${GZIP_STAT_FILE}: ${err.message}`, cwd || null);
  }
}

// Process-level "the peer rejected a gzipped body" flag. See the module header for why this one
// piece of module-level state is intentional.
let gzipUnsupported = false;

// The v2 log-ingest controller's own validation messages (server/src/logs/logs-v2.controller.ts).
// A 400 carrying any of these is a complaint about the *request parameters*, not about the body
// encoding — treating it as an encoding rejection would disable compression for the whole process
// over an unrelated bug.
const V2_VALIDATION_MESSAGES = [
  'Missing sessionId query parameter',
  'Missing type query parameter',
  'Request body must not be empty',
  'Incomplete chunked-upload parameters',
  'chunkIndex and totalChunks must be non-negative integers',
  'chunkIndex/totalChunks out of range',
  'Missing totalSize on first chunk',
  'Unknown uploadId',
  'totalChunks mismatch for uploadId',
];

/**
 * Decide whether a failed `uploadFile()` result means "this server cannot accept a gzipped body",
 * and latch the process-level flag when it does.
 *
 * Deliberately narrow: only a request we actually sent compressed can be an encoding rejection, and
 * only `415` (the unambiguous answer) or a `400` that is *not* one of the controller's own
 * parameter-validation complaints. `413` is excluded on purpose — that means the body was too big,
 * which compression helps with rather than causes; `401`/`403`/`404`/`429` never match either.
 *
 * @param {{success?: boolean, statusCode?: number|null, snippet?: string, sentEncoding?: string|null}} result
 * @returns {boolean}
 */
function isEncodingRejection(result) {
  if (!result || result.sentEncoding !== 'gzip') return false;
  const statusCode = result.statusCode;
  let rejected = false;
  if (statusCode === 415) {
    rejected = true;
  } else if (statusCode === 400) {
    const snippet = typeof result.snippet === 'string' ? result.snippet : '';
    rejected = !V2_VALIDATION_MESSAGES.some((m) => snippet.includes(m));
  }
  if (rejected) gzipUnsupported = true;
  return rejected;
}

/**
 * Clear the process-level gzip-unsupported flag. Exists for tests, which share one process across
 * cases and would otherwise leak a latched rejection from one case into the next.
 */
function resetGzipSupport() {
  gzipUnsupported = false;
}

// ---------------------------------------------------------------------------
// Slice planning
// ---------------------------------------------------------------------------

/**
 * Keep a compression ratio inside the range the planner is willing to believe.
 * @param {number} ratio
 * @returns {number}
 */
function clampGzipRatio(ratio) {
  if (!Number.isFinite(ratio)) return GZIP_DEFAULT_RATIO;
  return Math.min(GZIP_RATIO_MAX, Math.max(GZIP_RATIO_MIN, ratio));
}

/**
 * Plan how `body` is cut into chunks for a chunked upload, deciding each slice's on-the-wire
 * encoding as it goes.
 *
 * The whole plan is computed *before* chunk 0 is sent because the server pins `totalChunks` at
 * chunk 0 — a plan discovered incrementally could not name a stable chunk count. Since the
 * compressed size of a slice is only knowable by compressing it, each slice is *predicted* from a
 * ratio (remembered from a previous run, or `GZIP_DEFAULT_RATIO`), compressed, and shrunk by
 * `GZIP_SHRINK_FACTOR` on overshoot; after `GZIP_MAX_RECOMPRESS` shrinks that one slice falls back
 * to an uncompressed slice rather than spending unbounded CPU on an incompressible run of bytes.
 *
 * Only offsets and per-slice encodings are kept — each slice is re-gzipped at send time — so peak
 * memory is one compressed slice, never the whole compressed body.
 *
 * @param {Buffer} body the full uncompressed body.
 * @param {number} startRatio ratio to predict the first slice with; out-of-clamp/non-finite values
 *   fall back to `GZIP_DEFAULT_RATIO`.
 * @param {number} wireBudget max bytes any single request may put on the wire (normally
 *   `CHUNK_SIZE_BYTES`; lowered by the caller after a 413).
 * @returns {{slices: Array<{s: number, e: number, enc: 'gzip'|'identity'}>, ratio: number}} the
 *   plan, plus the last accepted gzip slice's *observed* ratio (clamped) for the caller to
 *   remember. Slices tile `body` exactly: `slices[0].s === 0`, `slices[i].e === slices[i+1].s`,
 *   and the last `e === body.length`.
 */
function planCompressedSlices(body, startRatio, wireBudget) {
  const budget = Number.isFinite(wireBudget) && wireBudget >= 1
    ? Math.floor(wireBudget)
    : CHUNK_SIZE_BYTES;
  // The prediction ratio, revised downstream only when a slice comes back far under budget.
  let ratio = Number.isFinite(startRatio) && startRatio >= GZIP_RATIO_MIN && startRatio <= GZIP_RATIO_MAX
    ? startRatio
    : GZIP_DEFAULT_RATIO;
  // The ratio actually observed on the last accepted gzip slice — what gets remembered.
  let observedRatio = null;

  const slices = [];
  const total = body.length;
  let s = 0;

  while (s < total) {
    const remaining = total - s;
    let target = Math.min(
      Math.round(budget * ratio * GZIP_SAFETY_MARGIN),
      GZIP_MAX_SLICE_BYTES,
      remaining,
    );
    if (target < 1) target = 1;

    let placed = false;
    // One initial attempt plus at most GZIP_MAX_RECOMPRESS shrink retries.
    for (let attempt = 0; attempt <= GZIP_MAX_RECOMPRESS; attempt++) {
      const e = alignSliceBoundary(body, s, s + target);
      const compressedLength = zlib.gzipSync(body.subarray(s, e)).length;
      if (compressedLength <= budget) {
        slices.push({ s, e, enc: 'gzip' });
        observedRatio = (e - s) / compressedLength;
        // Far under budget means the ratio was under-predicted: grow the next prediction.
        if (compressedLength < budget * GZIP_REGROW_FRACTION) {
          ratio = clampGzipRatio(observedRatio);
        }
        s = e;
        placed = true;
        break;
      }
      target = Math.max(1, Math.floor(target * GZIP_SHRINK_FACTOR));
    }

    if (!placed) {
      // Terminal fallback for this slice only — the rest of the body keeps trying gzip. Sized
      // against `budget` rather than CHUNK_SIZE_BYTES so a budget lowered after a 413 cannot be
      // breached by the very fallback meant to stay under it.
      const e = alignSliceBoundary(body, s, s + Math.min(CHUNK_SIZE_BYTES, budget));
      slices.push({ s, e, enc: 'identity' });
      s = e;
    }
  }

  return { slices, ratio: clampGzipRatio(observedRatio === null ? ratio : observedRatio) };
}

/**
 * Plan `body` as fixed-size, newline-aligned uncompressed slices.
 *
 * Used when compression is off the table — a loopback destination, or a server that has already
 * rejected a gzipped body — so no prediction or re-compression loop is involved. Alignment still
 * matters: it keeps every chunk independently decodable and never splits a UTF-8 character.
 *
 * @param {Buffer} body
 * @param {number} sliceSize max bytes per slice; non-finite/non-positive values fall back to
 *   `CHUNK_SIZE_BYTES`.
 * @returns {Array<{s: number, e: number, enc: 'identity'}>} slices tiling `body` exactly.
 */
function planIdentitySlices(body, sliceSize) {
  const size = Number.isFinite(sliceSize) && sliceSize >= 1 ? Math.floor(sliceSize) : CHUNK_SIZE_BYTES;
  const slices = [];
  const total = body.length;
  let s = 0;
  while (s < total) {
    const e = alignSliceBoundary(body, s, s + size);
    slices.push({ s, e, enc: 'identity' });
    s = e;
  }
  return slices;
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
 *   query params (and `totalSize` when present on the meta object — only chunk 0 sets it).
 * @param {'gzip'|null} [bodyEncoding] - when `'gzip'`, `body` is *already* a gzipped buffer and the
 *   request declares `Content-Encoding: gzip`. This function never compresses anything itself;
 *   `Content-Length` is always `Buffer.byteLength(body)` of the buffer it was handed, so an
 *   already-compressed body is described correctly with no other change.
 * @param {{snapshotId: string, snapshotFull: boolean}|null} [snapshotQuery] - DD-7/DD-8 of the
 *   `2026-10-16-sysctx-skill-source` plan: appends `&snapshotId=…`, and `&snapshotFull=1` when
 *   `snapshotFull` is true. Omitted (or `snapshotId` falsy) sends neither param, exactly like an
 *   old hook.
 * @returns {Promise<{ success: boolean, reason: string|null, warnings?: string[], complete?: boolean,
 *   unknownSnapshotId?: string, statusCode?: number|null, snippet?: string, sentEncoding?: 'gzip'|null }>}
 *   on failure, `statusCode` / `snippet` / `sentEncoding` describe the rejection precisely enough
 *   for `isEncodingRejection()` to classify it; `reason` keeps its historical text verbatim.
 *   `unknownSnapshotId`, when the server's 201 JSON carries one, is DD-8's answer to the
 *   `snapshotQuery` this request sent.
 */
function uploadFile(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId, workflowRunId, chunkMeta, bodyEncoding, snapshotQuery) {
  const sentEncoding = bodyEncoding === 'gzip' ? 'gzip' : null;
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
    if (snapshotQuery && snapshotQuery.snapshotId) {
      urlStr += `&snapshotId=${encodeURIComponent(snapshotQuery.snapshotId)}`;
      if (snapshotQuery.snapshotFull) {
        urlStr += '&snapshotFull=1';
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
    if (sentEncoding === 'gzip') {
      options.headers['Content-Encoding'] = 'gzip';
    }

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
          let unknownSnapshotId;
          try {
            const parsed = JSON.parse(Buffer.concat(okChunks).toString('utf8'));
            warnings = parsed && Array.isArray(parsed.warnings) ? parsed.warnings : [];
            if (parsed && typeof parsed.complete === 'boolean') {
              complete = parsed.complete;
            }
            if (parsed && typeof parsed.unknownSnapshotId === 'string') {
              unknownSnapshotId = parsed.unknownSnapshotId;
            }
          } catch {
            // fail-open: no/invalid JSON body — treat as no warnings
            warnings = [];
          }
          const result = { success: true, reason: null, warnings };
          if (complete !== undefined) result.complete = complete;
          if (unknownSnapshotId !== undefined) result.unknownSnapshotId = unknownSnapshotId;
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
        resolve({
          success: false,
          reason: `HTTP ${res.statusCode}${hint}`,
          statusCode: res.statusCode,
          snippet,
          sentEncoding,
        });
      });
    });

    req.setTimeout(timeoutMs, () => {
      const msg = `upload timeout for ${namespace}/${sessionId} (${reqCtx})`
        + ' — the file did not finish uploading before sendLogsTimeoutMs elapsed;'
        + ' for large sessions raise sendLogsTimeoutMs in .artisyn/config/log-hub.local.json';
      process.stderr.write(`upload-logs: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      req.destroy();
      resolve({
        success: false,
        reason: `timeout after ${timeoutMs}ms (size=${bodyMb}MB)`,
        statusCode: null,
        snippet: '',
        sentEncoding,
      });
    });

    req.on('error', (err) => {
      const largePayloadHint = bodyBytes > CHUNK_SIZE_BYTES / 2
        ? ' — connection was interrupted mid-upload of a large payload; may indicate a server/proxy body-size or timeout limit'
        : '';
      const msg = `network error for ${namespace}/${sessionId}: ${err.message} (code=${err.code || 'unknown'}, ${reqCtx})${largePayloadHint}`;
      process.stderr.write(`upload-logs: ${msg}\n`);
      hookLog(HOOK_FILE, hookSessionId, 'error', msg, cwd);
      resolve({
        success: false,
        reason: `network error: ${err.message}${largePayloadHint}`,
        statusCode: null,
        snippet: '',
        sentEncoding,
      });
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Pending-upload record file (.claude-logs.pending) — chunked-upload resumability
// ---------------------------------------------------------------------------

/** @returns {boolean} true for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @returns {boolean} true for a number that is a non-negative integer. */
function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Read `.claude-logs.pending` — a whole-file JSON document, format v2:
 *
 * ```json
 * { "version": 2,
 *   "entries": {
 *     "<manifestKey>": { "uploadId": "…", "totalSize": 6291456, "totalChunks": 7,
 *                        "nextChunkIndex": 3,
 *                        "slices": [{ "s": 0, "e": 912345, "enc": "gzip" }] } } }
 * ```
 *
 * The record now carries the whole slice plan, because slice lengths are no longer derivable from
 * an index (they depend on where the newlines fell and on how well each slice compressed), and
 * `nextChunkIndex` is the next chunk **to send** — the pre-v2 positional format stored the last
 * *acked* index instead, so the meaning of the stored number deliberately changed with the format.
 *
 * A pre-v2 positional file fails `JSON.parse` and is ignored outright rather than mis-read: the
 * cost is one restarted upload, against a wrong-offset upload that would corrupt a session's logs.
 * Every entry is validated the same way and dropped individually — a plan whose slices do not tile
 * `[0, totalSize)` exactly cannot be resumed safely.
 *
 * @param {string} pendingPath
 * @returns {Map<string, {uploadId: string, totalSize: number, totalChunks: number,
 *   nextChunkIndex: number, slices: Array<{s: number, e: number, enc: 'gzip'|'identity'}>}>}
 *   empty when the file is missing, unreadable, not JSON, not v2, or has no valid entry.
 */
function readPendingUploads(pendingPath) {
  const map = new Map();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch {
    // file missing, unreadable, or not JSON (e.g. a pre-v2 positional file) — start fresh
    return map;
  }
  if (!isPlainObject(parsed) || parsed.version !== 2 || !isPlainObject(parsed.entries)) return map;

  for (const [key, entry] of Object.entries(parsed.entries)) {
    if (!key || !isPlainObject(entry)) continue;
    const { uploadId, totalSize, totalChunks, nextChunkIndex, slices } = entry;
    if (typeof uploadId !== 'string' || !uploadId) continue;
    if (!isNonNegativeInt(totalSize) || !isNonNegativeInt(totalChunks) || !isNonNegativeInt(nextChunkIndex)) continue;
    if (!Array.isArray(slices) || slices.length === 0 || slices.length !== totalChunks) continue;
    if (!slices.every((sl) => isPlainObject(sl) && isNonNegativeInt(sl.s) && isNonNegativeInt(sl.e))) continue;
    if (slices[0].s !== 0 || slices[slices.length - 1].e !== totalSize) continue;
    let contiguous = true;
    for (let i = 0; i < slices.length - 1; i++) {
      if (slices[i].e !== slices[i + 1].s) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;

    map.set(key, {
      uploadId,
      totalSize,
      totalChunks,
      nextChunkIndex,
      slices: slices.map((sl) => ({ s: sl.s, e: sl.e, enc: sl.enc === 'gzip' ? 'gzip' : 'identity' })),
    });
  }
  return map;
}

/**
 * Rewrite `.claude-logs.pending` from the current map, in the v2 JSON shape documented on
 * `readPendingUploads()`.
 * @param {string} telemetryDir
 * @param {string} pendingPath
 * @param {Map<string, {uploadId: string, totalSize: number, totalChunks: number,
 *   nextChunkIndex: number, slices: Array<{s: number, e: number, enc: 'gzip'|'identity'}>}>} map
 * @param {string|null} [sessionId]
 * @param {string|null} [cwd]
 */
function writePendingUploads(telemetryDir, pendingPath, map, sessionId, cwd) {
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
    const entries = {};
    for (const [key, rec] of map) {
      entries[key] = {
        uploadId: rec.uploadId,
        totalSize: rec.totalSize,
        totalChunks: rec.totalChunks,
        nextChunkIndex: rec.nextChunkIndex,
        slices: (Array.isArray(rec.slices) ? rec.slices : []).map((sl) => ({
          s: sl.s,
          e: sl.e,
          enc: sl.enc === 'gzip' ? 'gzip' : 'identity',
        })),
      };
    }
    fs.writeFileSync(pendingPath, `${JSON.stringify({ version: 2, entries }, null, 2)}\n`, 'utf8');
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
 * The body is no longer cut at fixed `CHUNK_SIZE_BYTES` offsets. `CHUNK_SIZE_BYTES` is now the
 * *on-the-wire* budget per request, and the cut points come from a slice plan computed before
 * chunk 0 is sent (`planCompressedSlices()`, or `planIdentitySlices()` when compression is off the
 * table): a compressible slice can therefore carry many times the budget in NDJSON. The plan is
 * fixed up front because the server pins `totalChunks` at chunk 0.
 *
 * `chunkMeta.totalSize` on chunk 0 stays the **uncompressed** total, so the server's reassembly
 * size check and `upload_queue.size_bytes` keep meaning what they always did.
 *
 * Return shape matches the non-chunked `uploadFile()` caller contract: only the final
 * chunk's `warnings` are surfaced, and any chunk failure (other than the three in-call restarts
 * below) marks the whole upload failed. On a failed chunk the branches are tried in this order:
 * (1) the legacy stale-`uploadId` restart, (2) a `413` budget re-plan (halve the wire budget and
 * restart, up to `GZIP_MAX_BUDGET_RETRIES` times), (3) an encoding rejection (re-plan uncompressed
 * and restart, once).
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
 * @param {{snapshotId: string, snapshotFull: boolean}|null} [snapshotQuery] - DD-7: every chunk of
 *   this upload carries the same query params, forwarded to each `uploadFile()` call below.
 * @returns {Promise<{ success: boolean, reason: string|null, warnings?: string[], wireBytes: number,
 *   plainBytes: number, requests: number, fallback: boolean, unknownSnapshotId?: string }>}
 *   `wireBytes` sums every request body actually put on the wire (so a restart's re-sent chunks
 *   are counted, which is the honest transfer cost); `plainBytes` is the file's uncompressed size;
 *   `requests` counts the requests this call made; `fallback` is true when the peer rejected a
 *   gzipped body and the run had to fall back to sending it uncompressed. `unknownSnapshotId`
 *   (DD-8) is set only on a completing result, taken from the final chunk's response.
 */
async function uploadFileChunked(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId, workflowRunId, telemetryDir, manifestKey, snapshotQuery) {
  const totalSize = Buffer.byteLength(body);
  const pendingPath = path.join(telemetryDir, '.claude-logs.pending');
  const pending = readPendingUploads(pendingPath);
  const loopback = isLoopbackServerUrl(serverUrl);

  // The per-request on-the-wire budget for this call. Only ever lowered, by a 413.
  let wireBudget = CHUNK_SIZE_BYTES;
  let budgetRetries = 0;
  let encodingRestarts = 0;

  let wireBytes = 0;
  let requests = 0;
  // True only when a gzipped body was rejected (now, or earlier in this process): sending plain to
  // a loopback URL, or an `identity` slice inside an otherwise compressed plan, is a planned
  // outcome rather than a fallback.
  let fallback = gzipUnsupported && !loopback;

  /** @returns {Array<{s: number, e: number, enc: 'gzip'|'identity'}>} a fresh plan at the current budget. */
  const makePlan = () => {
    if (gzipUnsupported || loopback) return planIdentitySlices(body, wireBudget);
    const { slices: planned, ratio } = planCompressedSlices(body, readGzipRatio(telemetryDir), wireBudget);
    // Only a plan that actually compressed something has an observed ratio worth remembering.
    if (planned.some((sl) => sl.enc === 'gzip')) {
      writeGzipRatio(telemetryDir, ratio, hookSessionId, cwd);
    }
    return planned;
  };

  // A pending record only applies to the same file and only if it still has a chunk
  // left to send; a resumed run replays its stored plan verbatim, so it can never announce a
  // different `totalChunks` for an uploadId the server already knows.
  const existing = pending.get(manifestKey);
  const resumed = !!(existing && existing.totalSize === totalSize && existing.nextChunkIndex < existing.totalChunks);

  let slices = resumed ? existing.slices : makePlan();
  let totalChunks = resumed ? existing.totalChunks : slices.length;
  let uploadId = resumed ? existing.uploadId : crypto.randomUUID();
  let chunkIndex = resumed ? existing.nextChunkIndex : 0;
  const startChunkIndex = chunkIndex;
  let allowRestart = resumed;

  /** Drop the pending record and start a fresh upload of the same body from chunk 0. */
  const restartFresh = () => {
    pending.delete(manifestKey);
    writePendingUploads(telemetryDir, pendingPath, pending, hookSessionId, cwd);
    uploadId = crypto.randomUUID();
    chunkIndex = 0;
    allowRestart = false;
  };

  while (chunkIndex < totalChunks) {
    const slice = slices[chunkIndex];
    const plainSlice = body.subarray(slice.s, slice.e);
    const useGzip = slice.enc === 'gzip';
    const chunkBody = useGzip ? zlib.gzipSync(plainSlice) : plainSlice;
    const chunkMeta = { uploadId, chunkIndex, totalChunks };
    if (chunkIndex === 0) chunkMeta.totalSize = totalSize;

    const result = await uploadFile(
      serverUrl, apiKey, namespace, sessionId, chunkBody, timeoutMs, hookSessionId, cwd,
      parentSessionId, workflowRunId, chunkMeta, useGzip ? 'gzip' : null, snapshotQuery,
    );
    requests++;
    wireBytes += chunkBody.length;

    if (!result.success) {
      // (1) A resumed chunk request (reusing a stored uploadId) that comes back 400 — e.g. the
      // server-side row was cleaned up — is treated like a fresh upload attempt: discard the
      // record, mint a new uploadId, restart from chunk 0, once, within this same call. Keeps
      // precedence over the encoding branch, and the stored plan stays valid.
      if (allowRestart && chunkIndex === startChunkIndex && result.statusCode === 400) {
        restartFresh();
        continue;
      }

      // (2) A 413 says the *budget* is too high, not that gzip is unsupported — compression is
      // what makes a big body fit in the first place. Halve the budget, re-plan the whole file and
      // restart, at most GZIP_MAX_BUDGET_RETRIES times. Never re-sends a larger body than before.
      if (result.statusCode === 413 && budgetRetries < GZIP_MAX_BUDGET_RETRIES && wireBudget > GZIP_MIN_WIRE_BUDGET) {
        budgetRetries++;
        wireBudget = Math.max(GZIP_MIN_WIRE_BUDGET, Math.floor(wireBudget / 2));
        restartFresh();
        slices = makePlan();
        totalChunks = slices.length;
        continue;
      }

      // (3) The peer cannot take a gzipped body: latch the process-level flag (done inside the
      // classifier) and restart the whole file as plain slices, once per call.
      if (isEncodingRejection(result)) {
        if (encodingRestarts < 1) {
          encodingRestarts++;
          fallback = true;
          restartFresh();
          slices = planIdentitySlices(body, wireBudget);
          totalChunks = slices.length;
          continue;
        }
      }

      return { success: false, reason: result.reason, wireBytes, plainBytes: totalSize, requests, fallback };
    }

    if (result.complete) {
      pending.delete(manifestKey);
      writePendingUploads(telemetryDir, pendingPath, pending, hookSessionId, cwd);
      const final = {
        success: true,
        reason: null,
        warnings: result.warnings || [],
        wireBytes,
        plainBytes: totalSize,
        requests,
        fallback,
      };
      if (result.unknownSnapshotId !== undefined) final.unknownSnapshotId = result.unknownSnapshotId;
      return final;
    }

    // Record the plan and the next chunk to send, so a later run can resume from here.
    pending.set(manifestKey, { uploadId, totalSize, totalChunks, nextChunkIndex: chunkIndex + 1, slices });
    writePendingUploads(telemetryDir, pendingPath, pending, hookSessionId, cwd);

    chunkIndex++;
  }

  // Defensive fallback: the loop only exits normally via the `complete: true` branch
  // above. Reaching here means the server never reported completion on the final
  // chunk — treat it as a failure rather than silently reporting success.
  return {
    success: false,
    reason: 'chunked upload did not receive a final completion response',
    wireBytes,
    plainBytes: totalSize,
    requests,
    fallback,
  };
}

/**
 * Single-request upload that compresses the body when that is likely to pay off, and transparently
 * retries plain if the server turns out not to accept a gzipped body.
 *
 * Takes exactly the ten arguments the non-chunked call sites already pass — it decides the encoding
 * itself, so callers never mention gzip. The chunked/non-chunked routing decision upstream stays
 * the *uncompressed* `bodyBytes > CHUNK_SIZE_BYTES` test, so this function's body is always small
 * enough to send in one request either way.
 *
 * It sends plain when the flag is latched or the destination is loopback (no network to save), and
 * also when compressing did not actually help: gzip adds ~18 bytes of framing, so a near
 * incompressible body can come out *larger*.
 *
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {string} namespace
 * @param {string} sessionId
 * @param {Buffer|string} body
 * @param {number} timeoutMs
 * @param {string|null} hookSessionId
 * @param {string|null} cwd
 * @param {string|null} [parentSessionId]
 * @param {string|null} [workflowRunId]
 * @param {{snapshotId: string, snapshotFull: boolean}|null} [snapshotQuery] - DD-7: forwarded to
 *   every `uploadFile()` call this function makes — the one attempt, or the plain retry.
 * @returns {Promise<{ success: boolean, reason: string|null, warnings?: string[], wireBytes: number,
 *   plainBytes: number, requests: number, fallback: boolean, unknownSnapshotId?: string }>} the
 *   underlying `uploadFile()` result plus the same reporting fields as `uploadFileChunked()`;
 *   `requests` is 2 when the compressed attempt was rejected and the plain retry was made.
 */
async function uploadFileMaybeCompressed(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd, parentSessionId, workflowRunId, snapshotQuery) {
  const plainBytes = Buffer.byteLength(body);
  const loopback = isLoopbackServerUrl(serverUrl);
  let fallback = gzipUnsupported && !loopback;

  let wireBody = body;
  let encoding = null;
  if (!gzipUnsupported && !loopback) {
    const compressed = zlib.gzipSync(body);
    if (compressed.length < plainBytes && compressed.length <= CHUNK_SIZE_BYTES) {
      wireBody = compressed;
      encoding = 'gzip';
    }
  }

  const result = await uploadFile(
    serverUrl, apiKey, namespace, sessionId, wireBody, timeoutMs, hookSessionId, cwd,
    parentSessionId, workflowRunId, null, encoding, snapshotQuery,
  );
  let requests = 1;
  let wireBytes = Buffer.byteLength(wireBody);

  if (!result.success && encoding === 'gzip' && isEncodingRejection(result)) {
    // Same body, same URL, same query params — only the encoding changes.
    const retry = await uploadFile(
      serverUrl, apiKey, namespace, sessionId, body, timeoutMs, hookSessionId, cwd,
      parentSessionId, workflowRunId, null, null, snapshotQuery,
    );
    requests++;
    wireBytes += plainBytes;
    fallback = true;
    return { ...retry, wireBytes, plainBytes, requests, fallback };
  }

  return { ...result, wireBytes, plainBytes, requests, fallback };
}

// ---------------------------------------------------------------------------
// Upload lock (mutual exclusion between Stop-triggered and prompt-triggered uploads)
// ---------------------------------------------------------------------------

const LOCK_FILE_NAME = '.upload.lock';

// A lock file whose `{startedAt}` record cannot be read is normally a leftover (treated as stale),
// but it is also what a racing acquirer sees in the instant between the holder's exclusive create
// and its write of the record. Within this grace, measured from the file's mtime, it counts as held.
const UPLOAD_LOCK_UNREADABLE_GRACE_MS = 2000;

/**
 * Exclusive-create the lock file and write a fresh `{startedAt}` record into it.
 * @param {string} lockPath
 * @returns {'acquired'|'exists'|'error'} `exists` when another process holds the file (EEXIST,
 *   or EPERM/EBUSY, which Windows reports while a previous holder's unlink is still pending)
 */
function tryCreateUploadLock(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    const code = err && err.code;
    return code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY' ? 'exists' : 'error';
  }
  try {
    fs.writeSync(fd, JSON.stringify({ startedAt: new Date().toISOString() }));
  } catch {
    // the file itself is the lock; an unwritten record only makes it look unreadable for a moment
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return 'acquired';
}

/**
 * Whether an existing lock file is abandoned: its `startedAt` is at least `staleWindowMs` old, or
 * the record is unreadable and the file is older than `UPLOAD_LOCK_UNREADABLE_GRACE_MS`.
 * @param {string} lockPath
 * @param {number} staleWindowMs
 * @returns {boolean}
 */
function isUploadLockStale(lockPath, staleWindowMs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const startedAt = parsed && typeof parsed.startedAt === 'string' ? parsed.startedAt : null;
    const age = startedAt ? Date.now() - Date.parse(startedAt) : NaN;
    if (!isNaN(age)) return age >= staleWindowMs;
  } catch {
    // unreadable or corrupt record — fall through to the mtime check
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs >= UPLOAD_LOCK_UNREADABLE_GRACE_MS;
  } catch {
    return true; // gone in the meantime — free
  }
}

/**
 * Acquire `<telemetryDir>/.upload.lock` with an exclusive create (`'wx'`), so two processes can
 * never both see the lock as free and both take it. Fails (returns `{acquired: false}`) only when
 * a non-stale lock already exists; a stale or corrupt lock is removed and the create retried once.
 * When the lock cannot be created at all (e.g. an unwritable directory) it fails open and proceeds.
 * @param {string} telemetryDir
 * @param {number} staleWindowMs
 * @returns {{acquired: boolean}}
 */
function acquireUploadLock(telemetryDir, staleWindowMs) {
  const lockPath = path.join(telemetryDir, LOCK_FILE_NAME);
  try {
    fs.mkdirSync(telemetryDir, { recursive: true });
  } catch {
    // reported by the create below
  }

  let outcome = tryCreateUploadLock(lockPath);
  if (outcome === 'exists' && isUploadLockStale(lockPath, staleWindowMs)) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already removed by another process breaking the same stale lock
    }
    outcome = tryCreateUploadLock(lockPath);
  }

  if (outcome === 'exists') return { acquired: false };
  // 'error': best-effort, as before — if the lock cannot be persisted, fail open and proceed.
  return { acquired: true };
}

/**
 * `acquireUploadLock` with a bounded wait: retry every `pollIntervalMs` until the lock is free
 * or `maxWaitMs` has elapsed. Always attempts at least once, so `maxWaitMs <= 0` behaves exactly
 * like the plain `acquireUploadLock`.
 *
 * Why this exists: the lock is held for the whole of a `Stop` run, which on a catch-up run can be
 * tens of seconds. With a plain try-once acquire, a *second* session whose own upload lands in
 * that window silently gave up (`process.exit(0)`) and — because `Stop` is the only trigger that
 * ships a session's own artisyn/claude files — its final delta was stranded on disk until some
 * unrelated session happened to run a full scan later. A session whose artisyn log never gains a
 * `prompt_start` event has a NULL `first_prompt` server-side and is filtered out of the repository
 * session list entirely, so the session simply does not appear in the UI.
 *
 * Callers choose the budget by how much a wait costs them: a `Stop` run blocks the interactive
 * turn and so waits briefly, while the `SessionEnd` flush blocks nothing and waits long enough to
 * outlast a typical contending run.
 *
 * @param {string} telemetryDir
 * @param {number} staleWindowMs
 * @param {number} maxWaitMs
 * @param {number} pollIntervalMs
 * @returns {Promise<{acquired: boolean, waitedMs: number}>}
 */
async function acquireUploadLockWithWait(telemetryDir, staleWindowMs, maxWaitMs, pollIntervalMs) {
  const startedAt = Date.now();
  const poll = pollIntervalMs > 0 ? pollIntervalMs : 250;

  for (;;) {
    if (acquireUploadLock(telemetryDir, staleWindowMs).acquired) {
      return { acquired: true, waitedMs: Date.now() - startedAt };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed + poll > maxWaitMs) {
      return { acquired: false, waitedMs: elapsed };
    }
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
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
  GZIP_DEFAULT_RATIO,
  GZIP_SAFETY_MARGIN,
  GZIP_SHRINK_FACTOR,
  GZIP_MAX_RECOMPRESS,
  GZIP_MAX_SLICE_BYTES,
  GZIP_REGROW_FRACTION,
  GZIP_RATIO_MIN,
  GZIP_RATIO_MAX,
  GZIP_STAT_FILE,
  GZIP_MIN_WIRE_BUDGET,
  GZIP_MAX_BUDGET_RETRIES,
  formatServerOrigin,
  isLoopbackServerUrl,
  alignSliceBoundary,
  readGzipRatio,
  writeGzipRatio,
  isEncodingRejection,
  resetGzipSupport,
  planCompressedSlices,
  planIdentitySlices,
  uploadFile,
  uploadFileMaybeCompressed,
  uploadFileChunked,
  readPendingUploads,
  writePendingUploads,
  acquireUploadLock,
  acquireUploadLockWithWait,
  releaseUploadLock,
};
