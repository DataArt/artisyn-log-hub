'use strict';
/**
 * Claude Code Hook helper — assembles the `tool-calls` upload of one session from the CLI tool
 * wrapper's per-call files (not a hook entry point; used by send-logs-hook.js and session-files.js).
 *
 * Every wrapped call writes its own files under `<workDir>/tool-wrap/<sessionId>/calls/` (DD-5), so
 * no file is ever appended by two processes:
 *   <callId>.jsonl      — `start` → `stream_end` → `exit` records (Bash shim + tool-wrap-tee.js, or
 *                         the PowerShell `__lhWrap` prefix of tool-wrap-powershell.js);
 *   <callId>.out/.err/.in — the captured stdout / stderr / stdin (capture `full` only).
 *
 * `assembleToolCallsUpload(workDir, sessionId)` merges them into one NDJSON file,
 * `<workDir>/tool-wrap/upload/<sessionId>.jsonl`, uploaded as log kind `tool-calls` (DD-6):
 *   - one `tool_call` line per call, in start order. Text is sent as UTF-8 when every captured
 *     stream of the call is valid UTF-8, else all of them as base64 (`encoding`). stdout / stderr
 *     are cut to CAPTURE_LIMIT_BYTES, stdin to STDIN_CAPTURE_LIMIT_BYTES, never inside a UTF-8
 *     character; `truncated` is set when anything was cut;
 *   - a call without an `exit` record has `endedAt` / `exitCode` / `durationMs` null (`killed`);
 *   - past UPLOAD_CAP_BYTES the text of the oldest calls is dropped (`textDropped: true`), their
 *     meta is kept;
 *   - one `tool_wrap_status` line (hook version, OS, the session's pre-flight result, breaker).
 * The server keeps one `tool-calls` log per session, so every upload re-sends the whole set.
 *
 * Nothing here throws: a broken call file is skipped, any other failure returns null.
 */

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const {
  CAPTURE_LIMIT_BYTES,
  STDIN_CAPTURE_LIMIT_BYTES,
  UPLOAD_CAP_BYTES,
  validateToolName,
} = require('./tool-wrap-names');
const { TOOL_WRAP_DIR, SESSION_ID_PATTERN } = require('./tool-wrap-config');
const { getHookVersion } = require('./hook-log');

const CALLS_DIR = 'calls';
const BREAKER_DIR = 'breaker';
const BREAKER_FAULTS_FILE = 'faults';
const BREAKER_GLOBAL_MARKER = '__global';
const PREFLIGHT_FILE = 'preflight.json';
/** Folder under `<workDir>/tool-wrap/` holding the assembled upload files (never a session id). */
const UPLOAD_DIR = 'upload';
/** A call id as the wrappers write it: `<epochMs>-<pid>-<random4>`. */
const CALL_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const LINE_SCHEMA = 1;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Whether `bytes` are valid UTF-8.
 * @param {Buffer} bytes
 * @returns {boolean}
 */
function isValidUtf8(bytes) {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * `buf` without a UTF-8 sequence left incomplete at its end (what a cut at a byte limit leaves).
 * Only the last character is looked at; anything else invalid stays and makes the call base64.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function trimIncompleteUtf8Tail(buf) {
  let i = buf.length - 1;
  let continuation = 0;
  while (i >= 0 && continuation < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    continuation++;
  }
  if (i < 0) return buf;
  const lead = buf[i];
  const need = lead >= 0xf0 && lead <= 0xf7 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
  if (lead < 0xc0 || continuation >= need) return buf;
  return buf.subarray(0, i);
}

/**
 * Read at most `limit` bytes of a file. `size` is the whole file size; null when it does not exist.
 * @param {string} file
 * @param {number} limit
 * @returns {{ bytes: Buffer, size: number }|null}
 */
function readHead(file, limit) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const want = Math.min(st.size, limit);
    const bytes = Buffer.alloc(want);
    fd = fs.openSync(file, 'r');
    let read = 0;
    while (read < want) {
      const n = fs.readSync(fd, bytes, read, want - read, read);
      if (n <= 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read), size: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * The records of one `<callId>.jsonl`, merged by type (the last record of a type wins).
 * Malformed lines are skipped.
 * @param {string} file
 * @returns {{ start: object|null, streamEnd: object|null, exit: object|null }}
 */
function readCallRecords(file) {
  const out = { start: null, streamEnd: null, exit: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'start') out.start = rec;
    else if (rec.type === 'stream_end') out.streamEnd = rec;
    else if (rec.type === 'exit') out.exit = rec;
  }
  return out;
}

/**
 * A finite number, or null.
 * @param {*} v
 * @returns {number|null}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * ISO timestamp of an epoch-ms value, or null.
 * @param {number|null} ms
 * @returns {string|null}
 */
function isoOf(ms) {
  if (ms === null) return null;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Build the `tool_call` line of one call (DD-6), or null when it has no usable `start` record.
 * @param {string} callsDir
 * @param {string} callId
 * @param {string} sessionId
 * @returns {{ line: object, startedAtMs: number }|null}
 */
function buildCallLine(callsDir, callId, sessionId) {
  const { start, streamEnd, exit } = readCallRecords(path.join(callsDir, `${callId}.jsonl`));
  if (!start) return null;
  const startedAtMs = num(start.startedAtMs);
  const startedAt = isoOf(startedAtMs);
  if (startedAtMs === null || startedAt === null) return null;
  if (typeof start.tool !== 'string' || !validateToolName(start.tool).ok) return null;

  const capture = start.capture === 'meta' ? 'meta' : 'full';
  const endedAtMs = exit ? num(exit.endedAtMs) : null;
  const exitCode = exit ? num(exit.exitCode) : null;

  const outFile = readHead(path.join(callsDir, `${callId}.out`), CAPTURE_LIMIT_BYTES);
  const errFile = readHead(path.join(callsDir, `${callId}.err`), CAPTURE_LIMIT_BYTES);
  const inFile = readHead(path.join(callsDir, `${callId}.in`), STDIN_CAPTURE_LIMIT_BYTES);

  const stdoutBytes = streamEnd && num(streamEnd.stdoutBytes) !== null
    ? num(streamEnd.stdoutBytes)
    : (outFile ? outFile.size : 0);
  const stderrBytes = errFile ? errFile.size : (streamEnd && num(streamEnd.stderrBytes)) || 0;
  const stdinBytes = inFile ? inFile.size : 0;

  let truncated = !!(streamEnd && streamEnd.truncated === true);
  if (errFile && errFile.size > CAPTURE_LIMIT_BYTES) truncated = true;
  if (inFile && inFile.size > STDIN_CAPTURE_LIMIT_BYTES) truncated = true;
  if (outFile && outFile.size > CAPTURE_LIMIT_BYTES) truncated = true;

  const line = {
    type: 'tool_call',
    schema: LINE_SCHEMA,
    callId,
    sessionId: typeof start.sessionId === 'string' && start.sessionId ? start.sessionId : sessionId,
    tool: start.tool,
    args: Array.isArray(start.args) ? start.args.filter((a) => typeof a === 'string') : [],
    real: typeof start.real === 'string' ? start.real : null,
    cwd: typeof start.cwd === 'string' ? start.cwd : null,
    shell: start.shell === 'powershell' ? 'powershell' : 'bash',
    startedAt,
    endedAt: isoOf(endedAtMs),
    exitCode: exitCode === null ? null : Math.trunc(exitCode),
    durationMs: endedAtMs !== null && endedAtMs >= startedAtMs ? endedAtMs - startedAtMs : null,
    bytes: { stdin: stdinBytes, stdout: stdoutBytes, stderr: stderrBytes },
    consumerClosed: !!(streamEnd && streamEnd.consumerClosed === true),
    truncated,
    capture,
    encoding: 'utf8',
  };

  if (capture === 'full') {
    // "cut": the bytes reach the limit — cut here, or already by the wrapper's own capture limit.
    /** @type {[string, Buffer, boolean][]} field, captured bytes, whether they may end mid-character */
    const texts = [];
    if (inFile) texts.push(['stdin', inFile.bytes, inFile.bytes.length >= STDIN_CAPTURE_LIMIT_BYTES]);
    if (outFile) texts.push(['stdout', outFile.bytes, outFile.bytes.length >= CAPTURE_LIMIT_BYTES]);
    if (errFile) texts.push(['stderr', errFile.bytes, errFile.bytes.length >= CAPTURE_LIMIT_BYTES]);
    // A cut at the limit may split a character: drop that partial character, so a long UTF-8
    // output still travels as text.
    const trimmed = texts.map(([field, bytes, cut]) => [field, cut ? trimIncompleteUtf8Tail(bytes) : bytes]);
    const asUtf8 = trimmed.every(([, bytes]) => isValidUtf8(bytes));
    if (asUtf8) {
      for (const [field, bytes] of trimmed) line[field] = bytes.toString('utf8');
    } else {
      line.encoding = 'base64';
      for (const [field, bytes] of texts) line[field] = bytes.toString('base64');
    }
  }
  return { line, startedAtMs };
}

/**
 * Drop the text of the oldest calls until the serialized lines fit in `capBytes` (DD-5).
 * Mutates the lines; returns their serialized form.
 * @param {object[]} lines - `tool_call` lines in start order
 * @param {number} reserveBytes - bytes already taken by other lines (the status line)
 * @param {number} capBytes
 * @returns {string[]}
 */
function applyUploadCap(lines, reserveBytes, capBytes) {
  const serialized = lines.map((l) => JSON.stringify(l));
  let total = reserveBytes + serialized.reduce((s, t) => s + Buffer.byteLength(t) + 1, 0);
  for (let i = 0; i < lines.length && total > capBytes; i++) {
    const l = lines[i];
    if (l.stdin === undefined && l.stdout === undefined && l.stderr === undefined) continue;
    const before = Buffer.byteLength(serialized[i]) + 1;
    delete l.stdin;
    delete l.stdout;
    delete l.stderr;
    l.encoding = 'utf8';
    l.textDropped = true;
    serialized[i] = JSON.stringify(l);
    total -= before - (Buffer.byteLength(serialized[i]) + 1);
  }
  return serialized;
}

/**
 * The session's `preflight.json`, or null.
 * @param {string} sessionDir
 * @returns {object|null}
 */
function readPreflight(sessionDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(sessionDir, PREFLIGHT_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The session's breaker state.
 * @param {string} sessionDir
 * @returns {{ global: boolean, tools: string[] }}
 */
function readBreaker(sessionDir) {
  try {
    const names = fs.readdirSync(path.join(sessionDir, BREAKER_DIR), { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
    return {
      global: names.includes(BREAKER_GLOBAL_MARKER),
      tools: names.filter((n) => n !== BREAKER_GLOBAL_MARKER && n !== BREAKER_FAULTS_FILE && validateToolName(n).ok),
    };
  } catch {
    return { global: false, tools: [] };
  }
}

/**
 * The `tool_wrap_status` line of a session (DD-6).
 * @param {string} sessionDir
 * @param {object|null} preflight
 * @returns {object}
 */
function buildStatusLine(sessionDir, preflight) {
  const shells = preflight && preflight.shells && typeof preflight.shells === 'object' ? preflight.shells : {};
  return {
    type: 'tool_wrap_status',
    schema: LINE_SCHEMA,
    hookVersion: getHookVersion(),
    os: process.platform,
    preflight: {
      ok: !!(preflight && preflight.ok === true),
      reason: preflight && typeof preflight.reason === 'string' ? preflight.reason : null,
      shells: { bash: shells.bash === true, powershell: shells.powershell === true },
    },
    breaker: readBreaker(sessionDir),
    at: new Date().toISOString(),
  };
}

/**
 * `<workDir>/tool-wrap/<sessionId>`, or null for an unsafe session id.
 * @param {string} workDir
 * @param {string} sessionId
 * @returns {string|null}
 */
function sessionDirOf(workDir, sessionId) {
  if (!workDir || typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return null;
  return path.join(workDir, TOOL_WRAP_DIR, sessionId);
}

/**
 * `<workDir>/tool-wrap/upload/<sessionId>.jsonl` — where the assembled upload of a session goes.
 * @param {string} workDir
 * @param {string} sessionId
 * @returns {string}
 */
function uploadFilePath(workDir, sessionId) {
  return path.join(workDir, TOOL_WRAP_DIR, UPLOAD_DIR, `${sessionId}.jsonl`);
}

/**
 * Call ids that have a record file in `callsDir`.
 * @param {string} callsDir
 * @returns {string[]}
 */
function listCallIds(callsDir) {
  try {
    return fs.readdirSync(callsDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
      .map((d) => d.name.slice(0, -'.jsonl'.length))
      .filter((id) => CALL_ID_PATTERN.test(id));
  } catch {
    return [];
  }
}

/**
 * Session ids that have a wrapper session dir under `<workDir>/tool-wrap/` (symlinks skipped), or
 * null when that folder does not exist or cannot be read — so a caller can tell "no sessions" from
 * "could not look" (the manifest prune must only run on the former).
 * @param {string} workDir
 * @returns {string[]|null}
 */
function listToolWrapSessionsChecked(workDir) {
  try {
    return fs.readdirSync(path.join(workDir, TOOL_WRAP_DIR), { withFileTypes: true })
      .filter((d) => d.isDirectory() && SESSION_ID_PATTERN.test(d.name))
      .map((d) => d.name);
  } catch {
    return null;
  }
}

/**
 * Remove assembled upload files whose session dir is gone (pruned at SessionStart after 7 days).
 * Touches only regular files directly in `<workDir>/tool-wrap/upload/` named `<sessionId>.jsonl`;
 * leftover temp files of a crashed assembly (`*.tmp`) older than a day go too. Never throws.
 * @param {string} workDir
 * @param {{ now?: number }} [opts]
 * @returns {number} files removed
 */
function pruneUploadFiles(workDir, opts) {
  let removed = 0;
  try {
    const dir = path.join(workDir, TOOL_WRAP_DIR, UPLOAD_DIR);
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return 0;
    const now = opts && typeof opts.now === 'number' ? opts.now : Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile()) continue;
        const session = /^(.+)\.jsonl$/.exec(name);
        const staleTmp = /\.tmp$/.test(name) && now - st.mtimeMs > 24 * 60 * 60 * 1000;
        const orphan = session && SESSION_ID_PATTERN.test(session[1])
          && !fs.existsSync(path.join(workDir, TOOL_WRAP_DIR, session[1]));
        if (!staleTmp && !orphan) continue;
        fs.unlinkSync(file);
        removed++;
      } catch {
        // one file that cannot be removed never stops the others
      }
    }
  } catch {
    // no upload dir yet
  }
  return removed;
}

/**
 * A cheap fingerprint of everything the upload of a session is built from: the summed sizes of
 * the files in `calls/`, `breaker/` and `preflight.json`, plus their count. Used as the manifest
 * "size" of the `tool-calls/<sessionId>` entry, so an unchanged session is skipped without being
 * assembled. 0 when the session has nothing.
 * @param {string} workDir
 * @param {string} sessionId
 * @returns {number}
 */
function toolCallsSourceSize(workDir, sessionId) {
  const sessionDir = sessionDirOf(workDir, sessionId);
  if (!sessionDir) return 0;
  let total = 0;
  const add = (file) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile()) total += st.size + 1;
    } catch {
      // absent
    }
  };
  for (const sub of [CALLS_DIR, BREAKER_DIR]) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(sessionDir, sub));
    } catch {
      names = [];
    }
    for (const name of names) add(path.join(sessionDir, sub, name));
  }
  add(path.join(sessionDir, PREFLIGHT_FILE));
  return total;
}

/**
 * Assemble the `tool-calls` upload file of one session (DD-5 / DD-6).
 * Returns null when the session has nothing to report — no wrapped call and no failed pre-flight —
 * or on any failure. A failed pre-flight alone is still reported, so the server can show why the
 * session has no wrapper data.
 * @param {string} workDir - `<root>/.artisyn/ai_work_dir`
 * @param {string} sessionId
 * @param {{ capBytes?: number }} [opts]
 * @returns {string|null} path of the assembled file
 */
function assembleToolCallsUpload(workDir, sessionId, opts) {
  try {
    const sessionDir = sessionDirOf(workDir, sessionId);
    if (!sessionDir) return null;
    try {
      const st = fs.lstatSync(sessionDir);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    } catch {
      return null;
    }
    const callsDir = path.join(sessionDir, CALLS_DIR);
    const built = [];
    for (const callId of listCallIds(callsDir)) {
      const b = buildCallLine(callsDir, callId, sessionId);
      if (b) built.push(b);
    }
    const preflight = readPreflight(sessionDir);
    const preflightFailed = !!(preflight && preflight.ok === false);
    if (built.length === 0 && !preflightFailed) return null;

    built.sort((a, b) => a.startedAtMs - b.startedAtMs
      || (a.line.callId < b.line.callId ? -1 : a.line.callId > b.line.callId ? 1 : 0));
    const statusText = JSON.stringify(buildStatusLine(sessionDir, preflight));
    const cap = opts && typeof opts.capBytes === 'number' ? opts.capBytes : UPLOAD_CAP_BYTES;
    const callTexts = applyUploadCap(built.map((b) => b.line), Buffer.byteLength(statusText) + 1, cap);

    const target = uploadFilePath(workDir, sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(tmp, [...callTexts, statusText].join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return target;
  } catch {
    return null;
  }
}

module.exports = {
  UPLOAD_DIR,
  assembleToolCallsUpload,
  toolCallsSourceSize,
  listToolWrapSessionsChecked,
  pruneUploadFiles,
  uploadFilePath,
  applyUploadCap,
};
