#!/usr/bin/env node
/**
 * Claude Code Hook helper — prompt-triggered background upload (not a hook entry point itself).
 *
 * Spawned detached by `telemetry-hook.js` on `UserPromptSubmit` (when `sendLogsOnPromptEnabled`
 * is true and the throttle allows it). Since it is spawned with `stdio: 'ignore'`, it has no
 * stdin pipe and instead reads its input from `process.argv`:
 *
 *   node prompt-upload-hook.js --cwd <cwd> --sessionId <sessionId>
 *
 * The same values also arrive as `ARTISYN_PROMPT_UPLOAD_CWD`/`ARTISYN_PROMPT_UPLOAD_SESSION_ID`
 * env vars, and both sources are read here (argv first, env fallback). That redundancy is kept for
 * cross-version compatibility: a hook <= 2.5.1 launches this script on Windows through a VBScript
 * command line that carries env only (see spawn-hidden.js).
 *
 * Scope is deliberately narrow — only the current session's own files:
 *   artisyn — <telemetryDir>/<sessionId>.jsonl
 *   claude  — ~/.claude/projects/<slug>/<sessionId>.jsonl
 * (No subagent/workflow scan, no manifest read/write — that full-scan behavior stays in
 * send-logs-hook.js, triggered on Stop.)
 *
 * Safety mechanisms:
 *   - Watchdog: force-exits (code 1) after `sendLogsOnPromptTimeoutMs` so a hung/slow upload
 *     never leaves an orphaned detached process running indefinitely.
 *   - Shared upload lock (`<telemetryDir>/.upload.lock`, from `upload-logs.js`): mutually
 *     excludes this script from running concurrently with a Stop-triggered
 *     `send-logs-hook.js` run (or another prompt-triggered run) for the same project.
 *
 * Configure in .artisyn/config/log-hub.json / log-hub.local.json:
 *   serverUrl: "https://..."
 *   apiKey: "..."
 *   sendLogsTimeoutMs: 10000            (optional, default 10000 — per-request HTTP timeout)
 *   sendLogsOnPromptTimeoutMs: 60000    (optional, default 60000 — watchdog + lock staleness window)
 */

'use strict';
const fs = require('fs');
const path = require('path');

const { loadConfig, resolveTelemetryDir } = require('./env-context');
const { collectScopedFiles } = require('./session-files');
const { hookLog } = require('./hook-log');
const { uploadFileMaybeCompressed, uploadFileChunked, CHUNK_SIZE_BYTES, acquireUploadLock, releaseUploadLock, formatServerOrigin } = require('./upload-logs');
const { sanitizeNdjson, formatDroppedLines } = require('./ndjson-sanitize');

const HOOK_FILE = 'prompt-upload-hook.js';

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

/**
 * Parse `--cwd <value>` / `--sessionId <value>` from argv (no stdin read),
 * falling back to `ARTISYN_PROMPT_UPLOAD_CWD`/`ARTISYN_PROMPT_UPLOAD_SESSION_ID` env vars for
 * whichever isn't present in argv — a hook <= 2.5.1 launches this script through a Windows
 * VBScript command line that can only pass values that way (see spawn-hidden.js).
 * @param {string[]} argv - typically `process.argv.slice(2)`
 * @param {NodeJS.ProcessEnv} env - typically `process.env`
 * @returns {{ cwd: string|null, sessionId: string|null }}
 */
function parseArgs(argv, env) {
  const result = { cwd: null, sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && i + 1 < argv.length) {
      result.cwd = argv[i + 1];
      i++;
    } else if (argv[i] === '--sessionId' && i + 1 < argv.length) {
      result.sessionId = argv[i + 1];
      i++;
    }
  }
  if (!result.cwd && env && env.ARTISYN_PROMPT_UPLOAD_CWD) {
    result.cwd = env.ARTISYN_PROMPT_UPLOAD_CWD;
  }
  if (!result.sessionId && env && env.ARTISYN_PROMPT_UPLOAD_SESSION_ID) {
    result.sessionId = env.ARTISYN_PROMPT_UPLOAD_SESSION_ID;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Upload work
// ---------------------------------------------------------------------------

/**
 * Format the `hook.log` `result` message for a successful upload — same two-count form as
 * `send-logs-hook.js`, so both upload paths read identically in a single `hook.log`.
 * @param {string} manifestKey
 * @param {{ wireBytes: number, plainBytes: number, requests: number, fallback: boolean }} result
 *   the reporting fields returned by `uploadFileMaybeCompressed()` / `uploadFileChunked()`
 * @returns {string}
 */
function formatUploadResultLine(manifestKey, result) {
  const { wireBytes, plainBytes, requests, fallback } = result;
  const kb = (bytes) => (bytes / 1024).toFixed(0);
  const reqs = `${requests} request${requests === 1 ? '' : 's'}`;
  const suffix = fallback ? ' [gzip fallback]' : '';
  const compressed = wireBytes > 0 && wireBytes < plainBytes;
  return compressed
    ? `${manifestKey}: uploaded ${kb(plainBytes)} KB → ${kb(wireBytes)} KB gz`
      + ` (${(plainBytes / wireBytes).toFixed(1)}x) in ${reqs}${suffix}`
    : `${manifestKey}: uploaded ${kb(plainBytes)} KB uncompressed in ${reqs}${suffix}`;
}

/**
 * Upload the scoped current-session files. No manifest read/write — every
 * invocation re-uploads whatever is currently on disk; the server's idempotent upsert absorbs
 * the resulting repeat uploads.
 * @param {string|null} cwd
 * @param {string} sessionId
 * @param {string} serverUrl
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @param {string} telemetryDir
 */
async function runUploads(cwd, sessionId, serverUrl, apiKey, timeoutMs, telemetryDir) {
  const files = collectScopedFiles(cwd, sessionId, telemetryDir);

  let uploadedCount = 0;
  let failedCount = 0;

  for (const { namespace, filePath } of files) {
    const manifestKey = `${namespace}/${path.basename(filePath)}`;

    let body;
    try {
      body = fs.readFileSync(filePath);
    } catch (err) {
      hookLog(HOOK_FILE, sessionId, 'fail', `${manifestKey}: cannot read file: ${err.message}`, cwd);
      failedCount++;
      continue;
    }

    // Drop torn/interleaved records so one broken line cannot make this session permanently
    // un-ingestable — the server rejects the whole body on the first malformed line, and this
    // hook re-uploads the same file on every prompt.
    const sanitized = sanitizeNdjson(body);
    for (const msg of formatDroppedLines(manifestKey, sanitized)) {
      hookLog(HOOK_FILE, sessionId, 'warn', msg, cwd);
    }
    body = sanitized.body;
    if (sanitized.dropped.length > 0 && body.length === 0) {
      // Nothing survived: the server rejects an empty body with a 400, so skip the request
      // entirely rather than burning a round trip and logging a misleading upload failure.
      hookLog(HOOK_FILE, sessionId, 'fail', `${manifestKey}: no valid JSON lines left after sanitizing — nothing uploaded`, cwd);
      failedCount++;
      continue;
    }

    const bodyBytes = Buffer.byteLength(body);

    // The routing test stays the *uncompressed* size: `uploadFileMaybeCompressed()` decides for
    // itself whether the single request it sends is gzipped.
    const result = bodyBytes > CHUNK_SIZE_BYTES
      ? await uploadFileChunked(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, sessionId, cwd, null, null, telemetryDir, manifestKey)
      : await uploadFileMaybeCompressed(serverUrl, apiKey, namespace, sessionId, body, timeoutMs, sessionId, cwd, null, null);
    const { success, reason } = result;

    if (success) {
      uploadedCount++;
      hookLog(HOOK_FILE, sessionId, 'result', formatUploadResultLine(manifestKey, result), cwd);
    } else {
      failedCount++;
      hookLog(HOOK_FILE, sessionId, 'fail', `${manifestKey}: ${reason}`, cwd);
    }
  }

  // See send-logs-hook.js's matching `target=` note: names the config-driven destination on every
  // run so a stale/mistyped `serverUrl` is visible without waiting for an upload to fail.
  hookLog(HOOK_FILE, sessionId, 'result',
    `done: uploaded=${uploadedCount} failed=${failedCount} total=${files.length}`
    + ` target=${formatServerOrigin(serverUrl)}`, cwd);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { cwd, sessionId } = parseArgs(process.argv.slice(2), process.env);

  const config = loadConfig(cwd);

  // Watchdog: the first action after config load. Deliberately not
  // `.unref()`'d — it must keep this detached process alive long enough to force-exit it if
  // the upload work below hangs.
  setTimeout(() => {
    process.exit(1);
  }, config.sendLogsOnPromptTimeoutMs);

  const serverUrl = (config.serverUrl || '').trim().replace(/\/$/, '');
  const apiKey = (config.apiKey || '').trim();
  const timeoutMs = config.sendLogsTimeoutMs;

  if (!serverUrl || !apiKey || !sessionId) {
    process.exit(0);
  }

  const telemetryDir = resolveTelemetryDir(cwd, config);

  const lockResult = acquireUploadLock(telemetryDir, 2 * config.sendLogsOnPromptTimeoutMs);
  if (!lockResult.acquired) {
    hookLog(HOOK_FILE, sessionId, 'result', 'skipped: upload lock held', cwd);
    process.exit(0);
  }

  try {
    await runUploads(cwd, sessionId, serverUrl, apiKey, timeoutMs, telemetryDir);
  } finally {
    releaseUploadLock(telemetryDir);
  }
  process.exit(0);
}

main().catch((err) => {
  hookLog(HOOK_FILE, null, 'error', err.message, null);
  process.exit(0);
});
