'use strict';
/**
 * Claude Code Hook helper — the per-OS-user upload job queue `~/.artisyn/upload/` (not a hook entry
 * point itself).
 *
 * Hook 3.0.0+ hands the `Stop` / `SessionEnd` log upload off to the shared OTEL receiver, which runs
 * it as the single uploader (`send-logs-hook.js --run-job <jobPath>`). Everything the hooks and that
 * uploader share lives in one directory:
 *
 *   queue/<name>.json        hook (create), uploader (rewrite under claim)   job, schema 1
 *   queue/.<name>.json.tmp   any writer   temp file of an atomic write; ignored by readers
 *   queue/<name>.json.claim  uploader / takeover hook (`'wx'`)   {pid, startedAt}
 *   failed/<name>.json       uploader or receiver   the job plus failedAt, failedReason
 *   heartbeat.json           uploader-role receiver   {schema, pid, version, capabilities,
 *                                                     uploadContract, listening, startedAt, ts}
 *   uploader.lock            receiver (`'wx'`)   {pid, startedAt, version}
 *   spawn.mark               hook   epoch ms of the last hand-off-path receiver spawn
 *
 * The dir is resolved per call from `os.homedir()` — never cached — so a fake HOME/USERPROFILE (the
 * scenario suite) isolates it. Dirs are 0o700, files 0o600, every write is tmp + rename.
 *
 * Twins (DD-18): `otel-receiver.js` keeps standalone copies of `parseJobName`, `JOB_EXIT`,
 * `isHeartbeatFresh`, `backoffMs`, `isClaimStale` and the shared constants (it must not `require`
 * any hook module). Keep all copies identical; `__tests__/upload-job-queue.algo.test.js` runs the
 * same rows on both. KB: `docs/knowledgebase/upload-job-queue.md`.
 *
 * Node built-ins only. Every reader fails soft (returns `null` / an empty shape), never throws.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Constants (DD-19) ────────────────────────────────────────────────────────

const UPLOAD_DIR = 'upload';
const QUEUE_DIR = 'queue';
const FAILED_DIR = 'failed';
const HEARTBEAT_FILE = 'heartbeat.json';
const UPLOADER_LOCK_FILE = 'uploader.lock';
const SPAWN_MARK_FILE = 'spawn.mark';
const UPLOAD_QUEUE_CAPABILITY = 'upload-queue-v1';
const UPLOAD_CONTRACT = 1;
const JOB_SCHEMA = 1;
const HEARTBEAT_STALE_MS = 15000;
const JOB_RUN_TIMEOUT_MS = 900000;
const JOB_STUCK_MS = 300000;
const JOB_MAX_AGE_MS = 86400000;
const JOB_MAX_ATTEMPTS = 10;
const RECEIVER_SPAWN_THROTTLE_MS = 60000;
const BACKOFF_BASE_MS = 30000;
const BACKOFF_MAX_MS = 900000;

const JOB_TRIGGERS = Object.freeze(['stop', 'session-end']);

/** `--run-job` exit codes (DD-5). Twin: `otel-receiver.js`. */
const JOB_EXIT = Object.freeze({
  done: 0,
  retryable: 10,
  permanent: 11,
  busy: 12,
  dropped: 13,
});

const JOB_NAME_RE = /^([A-Za-z0-9-]{1,64})_(\d{8}T\d{9}Z)_(stop|session-end)_(\d+)-([0-9a-f]{4})\.json$/;
const CLAIM_SUFFIX = '.claim';

// The env keys a job carries over to its run (DD-4), besides every `OTEL_*` key without `HEADERS`.
const JOB_ENV_KEYS = Object.freeze([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'ARTISYN_PROJECT_ROOT',
  'ARTISYN_MANAGED_SETTINGS_DIR',
]);

// ── Paths (DD-2) ─────────────────────────────────────────────────────────────

/**
 * `<home>/.artisyn/upload`. `homeDir` defaults to `os.homedir()`, read per call.
 * @param {string} [homeDir]
 * @returns {string}
 */
function uploadStateDir(homeDir) {
  return path.join(homeDir || os.homedir(), '.artisyn', UPLOAD_DIR);
}

/** @param {string} [homeDir] @returns {string} */
function queueDir(homeDir) {
  return path.join(uploadStateDir(homeDir), QUEUE_DIR);
}

/** @param {string} [homeDir] @returns {string} */
function failedDir(homeDir) {
  return path.join(uploadStateDir(homeDir), FAILED_DIR);
}

/**
 * Create `dir` (and its parents) with mode 0o700. Returns `false` on failure.
 * @param {string} dir
 * @returns {boolean}
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a JSON object file; `null` when missing, unreadable, not JSON or not a plain object.
 * @param {string} file
 * @returns {Record<string, *>|null}
 */
function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write `text` to `file` atomically through `tmp` (mode 0o600), creating the parent dir (0o700).
 * Returns `false` (and removes the tmp file) on any failure.
 * @param {string} file
 * @param {string} tmp
 * @param {string} text
 * @returns {boolean}
 */
function atomicWrite(file, tmp, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    return false;
  }
}

// ── Job names (DD-3) ─────────────────────────────────────────────────────────

/**
 * UTC `YYYYMMDDTHHmmssSSSZ` of an epoch-ms instant.
 * @param {number} ms
 * @returns {string}
 */
function formatJobTs(ms) {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

/**
 * Epoch ms of a `YYYYMMDDTHHmmssSSSZ` string; `NaN` when it is not a real instant.
 * @param {string} ts
 * @returns {number}
 */
function parseJobTs(ts) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(String(ts));
  if (!m) return NaN;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const ms = Date.parse(iso);
  // Reject rollovers such as month 13 or Feb 30 — the round trip must reproduce the input.
  if (!Number.isFinite(ms) || formatJobTs(ms) !== ts) return NaN;
  return ms;
}

/**
 * The session-id part of a job name: chars outside `[A-Za-z0-9-]` removed, cut to 64, or
 * `nosession` when empty.
 * @param {*} sessionId
 * @returns {string}
 */
function sanitizeSessionId(sessionId) {
  const cleaned = String(sessionId == null ? '' : sessionId).replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
  return cleaned || 'nosession';
}

/**
 * `<sid>_<ts>_<trigger>_<pid>-<rand>.json`.
 * @param {{ sessionId?: string, trigger: string, now?: number, pid?: number, rand?: string }} input
 * @returns {string}
 */
function buildJobName({ sessionId, trigger, now, pid, rand }) {
  if (!JOB_TRIGGERS.includes(trigger)) throw new TypeError(`unknown job trigger: ${trigger}`);
  const ms = Number.isFinite(now) ? now : Date.now();
  const p = Number.isInteger(pid) && pid >= 0 ? pid : process.pid;
  const r = typeof rand === 'string' && /^[0-9a-f]{4}$/.test(rand)
    ? rand
    : crypto.randomBytes(2).toString('hex');
  return `${sanitizeSessionId(sessionId)}_${formatJobTs(ms)}_${trigger}_${p}-${r}.json`;
}

/**
 * Parse a job file name; `null` when it is not a job (wrong grammar or an impossible timestamp).
 * @param {string} name
 * @returns {{ name: string, sid: string, ts: string, tsMs: number, trigger: string, pid: number,
 *   rand: string }|null}
 */
function parseJobName(name) {
  const m = JOB_NAME_RE.exec(String(name));
  if (!m) return null;
  const tsMs = parseJobTs(m[2]);
  if (!Number.isFinite(tsMs)) return null;
  return { name: m[0], sid: m[1], ts: m[2], tsMs, trigger: m[3], pid: Number(m[4]), rand: m[5] };
}

/**
 * Order two parsed job names: by `ts`, then by the full name.
 * @param {{ ts: string, name: string }} a
 * @param {{ ts: string, name: string }} b
 * @returns {number}
 */
function compareJobs(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * The jobs in `dir`, parsed and ordered (DD-3). Temp files, claims and any non-matching name are
 * skipped; a missing dir reads as no jobs.
 * @param {string} dir
 * @returns {Array<ReturnType<typeof parseJobName> & { path: string }>}
 */
function listJobs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const jobs = [];
  for (const name of names) {
    if (name.endsWith('.tmp') || name.endsWith(CLAIM_SUFFIX)) continue;
    const parsed = parseJobName(name);
    if (parsed) jobs.push({ ...parsed, path: path.join(dir, name) });
  }
  return jobs.sort(compareJobs);
}

// ── Job content (DD-4) ───────────────────────────────────────────────────────

/**
 * `true` when `key` is one a job carries: a `JOB_ENV_KEYS` entry, or `OTEL_*` without `HEADERS`.
 * @param {string} key
 * @returns {boolean}
 */
function isJobEnvKey(key) {
  if (JOB_ENV_KEYS.includes(key)) return true;
  return key.startsWith('OTEL_') && !key.includes('HEADERS');
}

/**
 * The subset of `env` a job carries (only keys that are set).
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string>}
 */
function pickJobEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (typeof value === 'string' && isJobEnvKey(key)) out[key] = value;
  }
  return out;
}

/**
 * Replace the job-carried keys of `target` (default `process.env`) with `jobEnv`: first delete every
 * key `pickJobEnv` would select, then copy `jobEnv` in — so the receiver's own env never leaks into
 * another repo's run.
 * @param {Record<string, string>} jobEnv
 * @param {Record<string, string|undefined>} [target]
 */
function applyJobEnv(jobEnv, target = process.env) {
  for (const key of Object.keys(target)) {
    if (isJobEnvKey(key)) delete target[key];
  }
  if (!jobEnv || typeof jobEnv !== 'object') return;
  for (const [key, value] of Object.entries(jobEnv)) {
    if (typeof value === 'string' && isJobEnvKey(key)) target[key] = value;
  }
}

/**
 * Build a fresh job (`schema: 1`). It never carries the API key — the run reads it from the repo
 * config.
 * @param {{ sessionId?: string, trigger: string, now?: number, hookVersion?: string, uploader: string,
 *   cwd: string, gitRoot?: string|null, telemetryDir: string, transcriptPath?: string|null,
 *   hookEvent?: string, serverUrl?: string|null, env?: Record<string, string|undefined> }} input
 * @returns {Record<string, *>}
 */
function buildJob(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  return {
    schema: JOB_SCHEMA,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
    trigger: input.trigger,
    createdAt: new Date(now).toISOString(),
    hookVersion: typeof input.hookVersion === 'string' ? input.hookVersion : null,
    uploader: input.uploader,
    uploaderContract: UPLOAD_CONTRACT,
    cwd: input.cwd,
    gitRoot: typeof input.gitRoot === 'string' ? input.gitRoot : null,
    telemetryDir: input.telemetryDir,
    transcriptPath: typeof input.transcriptPath === 'string' ? input.transcriptPath : null,
    hookEvent: typeof input.hookEvent === 'string' ? input.hookEvent : null,
    serverUrl: typeof input.serverUrl === 'string' ? input.serverUrl : null,
    env: pickJobEnv(input.env || process.env),
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
  };
}

const isNonEmptyString = (v) => typeof v === 'string' && v !== '';
const isStringOrNull = (v) => v === null || typeof v === 'string';

/**
 * Validate a parsed job. `reason` names the first failed check.
 * @param {*} obj
 * @returns {{ ok: true, reason: null } | { ok: false, reason: string }}
 */
function validateJob(obj) {
  const fail = (reason) => ({ ok: false, reason });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('not-an-object');
  if (obj.schema !== JOB_SCHEMA) return fail('unknown-schema');
  if (typeof obj.sessionId !== 'string') return fail('invalid-sessionId');
  if (!JOB_TRIGGERS.includes(obj.trigger)) return fail('invalid-trigger');
  if (!isNonEmptyString(obj.createdAt) || !Number.isFinite(Date.parse(obj.createdAt))) {
    return fail('invalid-createdAt');
  }
  if (!isNonEmptyString(obj.uploader) || !path.isAbsolute(obj.uploader)) return fail('invalid-uploader');
  if (!Number.isInteger(obj.uploaderContract) || obj.uploaderContract < 1) {
    return fail('invalid-uploaderContract');
  }
  if (!isNonEmptyString(obj.cwd)) return fail('invalid-cwd');
  if (!isStringOrNull(obj.gitRoot)) return fail('invalid-gitRoot');
  if (!isNonEmptyString(obj.telemetryDir)) return fail('invalid-telemetryDir');
  if (!isStringOrNull(obj.transcriptPath)) return fail('invalid-transcriptPath');
  if (!obj.env || typeof obj.env !== 'object' || Array.isArray(obj.env)
    || Object.values(obj.env).some((v) => typeof v !== 'string')) {
    return fail('invalid-env');
  }
  if (!Number.isInteger(obj.attempts) || obj.attempts < 0) return fail('invalid-attempts');
  if (obj.nextAttemptAt !== null && obj.nextAttemptAt !== undefined && !Number.isFinite(obj.nextAttemptAt)) {
    return fail('invalid-nextAttemptAt');
  }
  if (obj.lastError !== null && obj.lastError !== undefined && typeof obj.lastError !== 'string') {
    return fail('invalid-lastError');
  }
  return { ok: true, reason: null };
}

/**
 * Write a job to `<dir>/<name>` atomically (`.<name>.tmp` + rename, mode 0o600; dir 0o700).
 * @param {string} dir
 * @param {string} name
 * @param {Record<string, *>} job
 * @returns {boolean}
 */
function writeJobAtomic(dir, name, job) {
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(2).toString('hex')}.tmp`);
  return atomicWrite(path.join(dir, name), tmp, JSON.stringify(job, null, 2) + '\n');
}

/**
 * Move a job to `failed/` as the job plus `failedAt` (ISO) and `failedReason`, then delete the
 * queue file and its claim. When `job` is null (unparsable), the raw file is kept under `job: null`.
 * @param {string} jobPath
 * @param {Record<string, *>|null} job
 * @param {string} reason
 * @param {{ homeDir?: string, now?: number }} [opts]
 * @returns {boolean} `true` when the `failed/` record was written
 */
function moveJobToFailed(jobPath, job, reason, opts = {}) {
  const name = path.basename(jobPath);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let record;
  if (job && typeof job === 'object' && !Array.isArray(job)) {
    record = { ...job };
  } else {
    let raw = null;
    try { raw = fs.readFileSync(jobPath, 'utf8'); } catch { /* gone */ }
    record = { job: null, raw };
  }
  record.failedAt = new Date(now).toISOString();
  record.failedReason = String(reason);
  const dir = failedDir(opts.homeDir);
  const ok = writeJobAtomic(dir, name, record);
  if (ok) {
    try { fs.unlinkSync(jobPath); } catch { /* already gone */ }
    releaseClaim(jobPath);
  }
  return ok;
}

// ── Heartbeat and hand-off decision (DD-6, DD-7) ─────────────────────────────

/**
 * `heartbeat.json`, or `null` when missing / malformed.
 * @param {{ homeDir?: string }} [opts]
 * @returns {Record<string, *>|null}
 */
function readHeartbeat(opts = {}) {
  return readJsonObject(path.join(uploadStateDir(opts.homeDir), HEARTBEAT_FILE));
}

/**
 * Fresh: written within `HEARTBEAT_STALE_MS`, lists `upload-queue-v1`, and speaks at least the
 * contract this hook writes. No pid probe.
 * @param {*} hb
 * @param {number} now
 * @returns {boolean}
 */
function isHeartbeatFresh(hb, now) {
  if (!hb || typeof hb !== 'object') return false;
  if (typeof hb.ts !== 'number' || !Number.isFinite(hb.ts)) return false;
  if (now - hb.ts > HEARTBEAT_STALE_MS) return false;
  if (!Array.isArray(hb.capabilities) || !hb.capabilities.includes(UPLOAD_QUEUE_CAPABILITY)) return false;
  return typeof hb.uploadContract === 'number' && hb.uploadContract >= UPLOAD_CONTRACT;
}

/**
 * Create the queue dir if needed and check it is readable and writable.
 * @param {{ homeDir?: string }} [opts]
 * @returns {boolean}
 */
function isQueueDirUsable(opts = {}) {
  const dir = queueDir(opts.homeDir);
  if (!ensureDir(dir)) return false;
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * DD-7: `queue` when the heartbeat is fresh and the queue dir is usable; else the per-event
 * fallback. `null` for an event that never uploads.
 * @param {{ event: string, heartbeat: *, queueDirUsable: boolean, now: number }} input
 * @returns {'queue'|'in-process-stop'|'session-end-fallback'|null}
 */
function decideHandOff({ event, heartbeat, queueDirUsable, now }) {
  if (event !== 'Stop' && event !== 'SessionEnd') return null;
  if (queueDirUsable === true && isHeartbeatFresh(heartbeat, now)) return 'queue';
  return event === 'Stop' ? 'in-process-stop' : 'session-end-fallback';
}

// ── Claims and stuck jobs (DD-11) ────────────────────────────────────────────

/**
 * `process.kill(pid, 0)` probe: `false` only on `ESRCH` (or a non-positive pid).
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err && err.code === 'ESRCH');
  }
}

/** @param {string} jobPath @returns {string} */
function claimPath(jobPath) {
  return jobPath + CLAIM_SUFFIX;
}

/**
 * The claim of a job, or `null` when missing / malformed.
 * @param {string} jobPath
 * @returns {{ pid: number, startedAt: string }|null}
 */
function readClaim(jobPath) {
  const parsed = readJsonObject(claimPath(jobPath));
  if (!parsed || !Number.isInteger(parsed.pid) || typeof parsed.startedAt !== 'string') return null;
  return { pid: parsed.pid, startedAt: parsed.startedAt };
}

/**
 * A claim is stale when null / unparsable, its pid is dead, or it is older than
 * `JOB_RUN_TIMEOUT_MS`.
 * @param {*} claim
 * @param {number} now
 * @param {(pid: number) => boolean} isAlive
 * @returns {boolean}
 */
function isClaimStale(claim, now, isAlive) {
  if (!claim || typeof claim !== 'object' || !Number.isInteger(claim.pid)) return true;
  const started = Date.parse(claim.startedAt);
  if (!Number.isFinite(started)) return true;
  if (!isAlive(claim.pid)) return true;
  return now - started > JOB_RUN_TIMEOUT_MS;
}

/**
 * Stuck: queued longer than `JOB_STUCK_MS` ago and without a live claim.
 * @param {{ tsMs: number }|null} parsedName
 * @param {*} claim
 * @param {number} now
 * @param {(pid: number) => boolean} isAlive
 * @returns {boolean}
 */
function isJobStuck(parsedName, claim, now, isAlive) {
  if (!parsedName || !Number.isFinite(parsedName.tsMs)) return false;
  return now - parsedName.tsMs > JOB_STUCK_MS && isClaimStale(claim, now, isAlive);
}

/**
 * Claim a job with a `'wx'` `.claim` file `{pid, startedAt}`. An existing stale claim is removed
 * and the claim retried once.
 * @param {string} jobPath
 * @param {{ now?: number, pid?: number, isPidAlive?: (pid: number) => boolean }} [opts]
 * @returns {boolean} `true` when this process now holds the claim
 */
function claimJob(jobPath, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const pid = Number.isInteger(opts.pid) ? opts.pid : process.pid;
  const alive = typeof opts.isPidAlive === 'function' ? opts.isPidAlive : isPidAlive;
  const file = claimPath(jobPath);
  const body = JSON.stringify({ pid, startedAt: new Date(now).toISOString() }) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST' || attempt > 0) return false;
      if (!isClaimStale(readClaim(jobPath), now, alive)) return false;
      try { fs.unlinkSync(file); } catch (e) { if (!e || e.code !== 'ENOENT') return false; }
    }
  }
  return false;
}

/**
 * Remove a job's claim (no-op when there is none).
 * @param {string} jobPath
 */
function releaseClaim(jobPath) {
  try { fs.unlinkSync(claimPath(jobPath)); } catch { /* already gone */ }
}

// ── Run outcome and backoff (DD-12) ──────────────────────────────────────────

/**
 * @param {{ uploaded?: number, retryableFailures?: number, permanentFailures?: number,
 *   aborted?: boolean }} result
 * @returns {'done'|'retryable'|'permanent'}
 */
function classifyRunOutcome(result) {
  const r = result || {};
  const uploaded = Number(r.uploaded) || 0;
  const retryable = Number(r.retryableFailures) || 0;
  const permanent = Number(r.permanentFailures) || 0;
  if (r.aborted === true || retryable > 0) return 'retryable';
  if (permanent > 0 && uploaded === 0) return 'permanent';
  return 'done';
}

/**
 * `min(30000 × 2^(n−1), 900000)`; `n` below 1 counts as 1.
 * @param {number} n
 * @returns {number}
 */
function backoffMs(n) {
  const k = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  if (k > 30) return BACKOFF_MAX_MS;
  return Math.min(BACKOFF_BASE_MS * 2 ** (k - 1), BACKOFF_MAX_MS);
}

/**
 * DD-9 step 3: why a valid job must not run any more, or null. `over-age` when its `createdAt` is
 * more than `JOB_MAX_AGE_MS` before `now` (checked first), `max-attempts` when `attempts >=
 * JOB_MAX_ATTEMPTS`.
 * @param {{ createdAt: string, attempts: number }} job
 * @param {number} now
 * @returns {'over-age'|'max-attempts'|null}
 */
function jobLimitReason(job, now) {
  if (now - Date.parse(job.createdAt) > JOB_MAX_AGE_MS) return 'over-age';
  if (job.attempts >= JOB_MAX_ATTEMPTS) return 'max-attempts';
  return null;
}

// ── Per-repo queries ─────────────────────────────────────────────────────────

/**
 * The comparable form of a dir path: resolved, forward slashes, lowercased on win32.
 * @param {string} p
 * @returns {string}
 */
function normalizeDir(p) {
  const resolved = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Jobs in `dir` whose JSON names `telemetryDir`, in DD-3 order, each with its parsed `job`.
 * @param {string} dir
 * @param {string} telemetryDir
 * @returns {Array<ReturnType<typeof parseJobName> & { path: string, job: Record<string, *> }>}
 */
function listJobsInDirForRepo(dir, telemetryDir) {
  if (!isNonEmptyString(telemetryDir)) return [];
  const want = normalizeDir(telemetryDir);
  const out = [];
  for (const entry of listJobs(dir)) {
    const job = readJsonObject(entry.path);
    if (job && isNonEmptyString(job.telemetryDir) && normalizeDir(job.telemetryDir) === want) {
      out.push({ ...entry, job });
    }
  }
  return out;
}

/**
 * Queue jobs of one repo (matching `telemetryDir`).
 * @param {string} telemetryDir
 * @param {{ homeDir?: string }} [opts]
 */
function listJobsForRepo(telemetryDir, opts = {}) {
  return listJobsInDirForRepo(queueDir(opts.homeDir), telemetryDir);
}

/**
 * Stuck queue jobs of one repo (DD-11).
 * @param {string} telemetryDir
 * @param {number} now
 * @param {{ homeDir?: string, isPidAlive?: (pid: number) => boolean }} [opts]
 */
function listStuckJobs(telemetryDir, now, opts = {}) {
  const alive = typeof opts.isPidAlive === 'function' ? opts.isPidAlive : isPidAlive;
  return listJobsForRepo(telemetryDir, opts)
    .filter((entry) => isJobStuck(entry, readClaim(entry.path), now, alive));
}

/**
 * `failed/` jobs of one repo (matching `telemetryDir`), in DD-3 order.
 * @param {string} telemetryDir
 * @param {{ homeDir?: string }} [opts]
 */
function listFailedJobsForRepo(telemetryDir, opts = {}) {
  return listJobsInDirForRepo(failedDir(opts.homeDir), telemetryDir);
}

/**
 * Number of `failed/` jobs of one repo.
 * @param {string} telemetryDir
 * @param {{ homeDir?: string }} [opts]
 * @returns {number}
 */
function countFailedJobs(telemetryDir, opts = {}) {
  return listFailedJobsForRepo(telemetryDir, opts).length;
}

// ── Receiver spawn throttle (DD-7) ───────────────────────────────────────────

/** @param {string} [homeDir] @returns {string} */
function spawnMarkPath(homeDir) {
  return path.join(uploadStateDir(homeDir), SPAWN_MARK_FILE);
}

/**
 * `true` when no hand-off-path receiver spawn happened within `RECEIVER_SPAWN_THROTTLE_MS`
 * (a missing / malformed / future mark counts as none).
 * @param {number} now
 * @param {{ homeDir?: string }} [opts]
 * @returns {boolean}
 */
function shouldSpawnReceiver(now, opts = {}) {
  let mark;
  try {
    mark = Number(fs.readFileSync(spawnMarkPath(opts.homeDir), 'utf8').trim());
  } catch {
    return true;
  }
  if (!Number.isFinite(mark) || mark > now) return true;
  return now - mark >= RECEIVER_SPAWN_THROTTLE_MS;
}

/**
 * Record a hand-off-path receiver spawn at `now`.
 * @param {number} now
 * @param {{ homeDir?: string }} [opts]
 * @returns {boolean}
 */
function markReceiverSpawn(now, opts = {}) {
  const file = spawnMarkPath(opts.homeDir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(2).toString('hex')}.tmp`;
  return atomicWrite(file, tmp, String(Math.floor(now)));
}

module.exports = {
  // constants
  UPLOAD_DIR,
  QUEUE_DIR,
  FAILED_DIR,
  HEARTBEAT_FILE,
  UPLOADER_LOCK_FILE,
  SPAWN_MARK_FILE,
  UPLOAD_QUEUE_CAPABILITY,
  UPLOAD_CONTRACT,
  JOB_SCHEMA,
  HEARTBEAT_STALE_MS,
  JOB_RUN_TIMEOUT_MS,
  JOB_STUCK_MS,
  JOB_MAX_AGE_MS,
  JOB_MAX_ATTEMPTS,
  RECEIVER_SPAWN_THROTTLE_MS,
  JOB_TRIGGERS,
  JOB_EXIT,
  JOB_ENV_KEYS,
  JOB_NAME_RE,
  // paths
  uploadStateDir,
  queueDir,
  failedDir,
  // names
  buildJobName,
  parseJobName,
  listJobs,
  // content
  pickJobEnv,
  applyJobEnv,
  buildJob,
  validateJob,
  writeJobAtomic,
  moveJobToFailed,
  // heartbeat / decision
  readHeartbeat,
  isHeartbeatFresh,
  isQueueDirUsable,
  decideHandOff,
  // claims / stuck
  isPidAlive,
  claimPath,
  readClaim,
  claimJob,
  releaseClaim,
  isClaimStale,
  isJobStuck,
  // outcome / backoff
  classifyRunOutcome,
  backoffMs,
  jobLimitReason,
  // per repo
  listJobsForRepo,
  listStuckJobs,
  listFailedJobsForRepo,
  countFailedJobs,
  // spawn throttle
  shouldSpawnReceiver,
  markReceiverSpawn,
};
