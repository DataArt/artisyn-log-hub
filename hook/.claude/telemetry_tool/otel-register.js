'use strict';
/**
 * Claude Code Hook helper — the OTEL receiver announce client (not a hook entry point itself).
 *
 * Shared by both spawn call sites (`lifecycle-hook.js` on `SessionStart` and `telemetry-hook.js`'s
 * throttled re-arm on `UserPromptSubmit`). Each of them awaits the same two-step announce, in this
 * order:
 *
 *   1. `fireRegister()` — an awaited `POST /artisyn/register` at the resolved loopback port,
 *      bounded by `REGISTER_TIMEOUT_MS` on the fast path. This covers the "a receiver is already
 *      running" case, and is the only place a port collision between two projects becomes visible
 *      (the receiver answers `409 owner-mismatch`). When the receiver reports a `receiverVersion`
 *      older than this hook's own, the response handler (`handleRegisterResponse`) also drives a
 *      restart: `stopReceiverAndWait()` (from `./otel-restart`) shuts the stale receiver down, then
 *      a replacement is spawned in its place — this can add several extra seconds on that path.
 *   2. `spawnDetachedHidden(otel-receiver.js, …)` with the parameters from `buildReceiverLaunch()`
 *      — this covers the "no receiver was running" case. A receiver that is already listening
 *      makes the spawned one exit 0 on `EADDRINUSE`, so firing both unconditionally is correct.
 *      When step 1 already spawned a replacement as part of a restart, this step is skipped so the
 *      caller never ends up racing two receivers for the same port.
 *
 * Every outcome of the register call is non-fatal and never retried, per the hook's cross-version
 * compatibility rule: a connection refusal (no receiver yet) and a `404` (a pre-2.3.0 receiver
 * with no such endpoint) are both silent. A `409` (a receiver owned by a different project holds
 * the port) always produces one `warn` line. A `200` reporting an older `receiverVersion` produces
 * one `warn` line and triggers the restart above — throttled per project (`OTEL_RESTART_STATE_FILE`)
 * so two near-simultaneous `SessionStart`s don't both race a shutdown/spawn cycle.
 *
 * Everything above is the **legacy** (per-project receiver) path. Hook 2.30.0+ uses it only when
 * `~/.artisyn/otel/port.json` is missing (`resolveOtelPort` → `mode: 'legacy'`, DD-6). With the file
 * present the **shared** (per-OS-user receiver) path runs instead:
 *
 *   1. `sharedHandshake(port)` — `POST /artisyn/hello` with a client nonce and the owner hash; the
 *      answer's HMAC `proof` is verified against `~/.artisyn/otel/token` before anything secret is
 *      sent (DD-9). A `409`, a non-200, a non-JSON answer or a bad proof is a `port-conflict`
 *      (DD-17); no answer at all means no receiver is running.
 *   2. Only on "no answer": spawn this plugin's own `otel-receiver.js` with the DD-7 shared argv
 *      ("first spawner wins"), then retry hello for `SPAWN_HELLO_RETRY_MS`; still nothing (the
 *      spawned copy hit `EADDRINUSE` against something that is not a receiver) → `port-conflict`.
 *   3. An authenticated `POST /artisyn/register` with the DD-10 request (`x-artisyn-auth`).
 *
 * The shared path never stops or restarts a receiver: an older receiver that lacks a capability
 * this session needs gets one `warn` per session (FR-A10) and is replaced only after its idle-exit.
 */

const crypto = require('crypto');
const http = require('http');
const os = require('os');
const path = require('path');

const { resolveOtelDir, resolveOtelPort, resolveOtelNumber } = require('./env-context');
const { getGitRoot } = require('./git-context');
const { hookLog, getHookVersion } = require('./hook-log');
const { spawnDetachedHidden } = require('./spawn-hidden');
const { stopReceiverAndWait } = require('./otel-restart');
const {
  claimThrottleSlot,
  claimSessionWarning,
  OTEL_RESPAWN_THROTTLE_MS,
  OTEL_SPAWN_STATE_FILE,
} = require('./throttle-state');
const { otelStateDir, readOrCreateToken, repoKey, ownerHash } = require('./user-state');

const HOOK_FILE = 'otel-register.js';

// The receiver's announce endpoint (mirrors `REGISTER_PATH` in otel-receiver.js).
const REGISTER_PATH = '/artisyn/register';

// The receiver script both spawn call sites launch, as a sibling of their own `__dirname` — the
// same directory in the dev tree and in the installed plugin's scripts directory.
const RECEIVER_SCRIPT = 'otel-receiver.js';

// The receiver is a loopback process on the same machine; anything slower than this is a hung
// socket, not a slow answer. `fireRegister`'s caller now awaits the request, so this is what
// bounds the fast (no-restart) path to ~2s — the restart path can run well past it, see
// `handleRegisterResponse`.
const REGISTER_TIMEOUT_MS = 2000;

// KiB → bytes for `otelReceiverMaxBodyKb`; the receiver's `--maxBodyBytes` is always in bytes.
const BYTES_PER_KB = 1024;

// Gate on the *restart* branch of `handleRegisterResponse` specifically — a second concurrent
// `SessionStart` that also observes the same stale receiver within the same window must not also
// race a shutdown/spawn cycle. The plain register+spawn-if-absent behavior stays unthrottled, since
// it is idempotent by construction (an already-bound port makes the spawn exit on `EADDRINUSE`).
// Reuses `OTEL_RESPAWN_THROTTLE_MS`'s 60s window, on its own dedicated state file so the two
// throttles never share a slot.
const OTEL_RESTART_STATE_FILE = 'otel-receiver-restart.json';
const OTEL_RESTART_THROTTLE_MS = OTEL_RESPAWN_THROTTLE_MS;

// ---- shared receiver (hook 2.30.0+) ----------------------------------------------------------

// The shared receiver's routes (twins of the same constants in otel-receiver.js).
const HELLO_PATH = '/artisyn/hello';
const SESSION_STATUS_PATH = '/artisyn/session-status';
const SHUTDOWN_PATH = '/artisyn/shutdown';
const AUTH_HEADER = 'x-artisyn-auth';
const AUTH_SCHEME = 'v1';

// Fixed idle timeout of the shared launch (DD-8): no single repo owns the receiver, so the repo key
// `otelReceiverIdleTimeoutMs` is ignored there. Twins: otel-receiver.js, otel-ensure-receiver.js.
const SHARED_IDLE_TIMEOUT_MS = 600000;
// The register contract version (DD-10). Twin: `REGISTER_CONTRACT` in otel-receiver.js.
const REGISTER_CONTRACT = 1;
// A live loopback receiver answers hello in milliseconds (DD-32). Twin (shorter on purpose):
// `ENSURE_HELLO_TIMEOUT_MS` in otel-ensure-receiver.js.
const HELLO_TIMEOUT_MS = 2000;
// Twin: `SESSION_STATUS_TIMEOUT_MS` in artisyn-hooks-installer/src/otel-handshake.ts.
const SESSION_STATUS_TIMEOUT_MS = 2000;
// How long hello is retried after spawning a receiver before it counts as a port conflict (DD-17).
const SPAWN_HELLO_RETRY_MS = 2000;
// Pause between those retries.
const SPAWN_HELLO_POLL_MS = 150;

// The sweep entry point a shared registration names as its `uploader` (DD-10).
const UPLOADER_SCRIPT = 'send-logs-hook.js';

const HEX_RE = /^[0-9a-f]+$/;

/**
 * The receiver's owner identity: `{gitRoot, repo}`.
 *
 * `gitRoot` is *the* project identity throughout the hook (the same anchor `loadConfig` and
 * `resolveTelemetryDir` use), and it is what the receiver compares a registration against. `repo`
 * is carried only so the mismatch warning is readable by a human.
 *
 * `gitContext` is the already-computed `getGitContext(cwd)` result, passed in rather than
 * recomputed so the announce does not re-run four `git` subprocesses. It may be `null` (outside a
 * repo), in which case `getGitRoot` supplies its own cwd fallback.
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @returns {{ gitRoot: string, repo: string }}
 */
function buildOwnerPayload(cwd, gitContext) {
  const contextRoot = gitContext && typeof gitContext.root === 'string' ? gitContext.root.trim() : '';
  const gitRoot = contextRoot || getGitRoot(cwd || process.cwd());
  const remote = gitContext && typeof gitContext.remote === 'string' ? gitContext.remote.trim() : '';
  return { gitRoot, repo: remote || gitRoot };
}

/**
 * The realtime target a shared registration carries (DD-19): the project's own server, API key and
 * `otelRealtime*` settings, so the shared receiver never reads a repo's config files. `null` when no
 * server is configured.
 * @param {Record<string, *>|null} config
 * @returns {{ enabled: boolean, serverUrl: string, apiKey: string, intervalMs: number }|null}
 */
function buildRealtimeTarget(config) {
  const c = config || {};
  const serverUrl = typeof c.serverUrl === 'string' ? c.serverUrl.trim().replace(/\/+$/, '') : '';
  if (!serverUrl) return null;
  return {
    enabled: c.otelRealtime !== false,
    serverUrl,
    apiKey: typeof c.apiKey === 'string' ? c.apiKey.trim() : '',
    intervalMs: typeof c.otelRealtimeIntervalMs === 'number' && Number.isFinite(c.otelRealtimeIntervalMs)
      ? c.otelRealtimeIntervalMs : 0,
  };
}

/**
 * The `POST /artisyn/register` body.
 *
 * Legacy fields (every receiver): the owner identity (`gitRoot`, `repo`), the announcing session and
 * the hook version. A legacy receiver uses `sessionId` only to validate its shape; `null` is
 * tolerated there.
 *
 * Shared-receiver fields (DD-10, hook 2.30.0+; unknown to a legacy receiver, which ignores them —
 * but see `legacyRegistrationPayload`, the legacy path never sends them): `otelDir`, `contract`,
 * `repoKey`, `signals` (logs + metrics when `otelEnabled`, spans only when `otelTraces === true`),
 * `uploader` (this plugin's own `send-logs-hook.js`, absolute) and the `realtime` target.
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @param {Record<string, *>|null} [config]
 * @returns {{ sessionId: string|null, gitRoot: string, repo: string, hookVersion: string|null,
 *   otelDir: string, contract: number, repoKey: string,
 *   signals: { logs: boolean, metrics: boolean, spans: boolean }, uploader: string,
 *   realtime: { enabled: boolean, serverUrl: string, apiKey: string, intervalMs: number }|null }}
 */
function buildRegistrationPayload(sessionId, cwd, gitContext, config) {
  const owner = buildOwnerPayload(cwd, gitContext);
  const enabled = !config || config.otelEnabled !== false;
  return {
    sessionId: sessionId || null,
    gitRoot: owner.gitRoot,
    repo: owner.repo,
    hookVersion: getHookVersion(),
    otelDir: path.resolve(resolveOtelDir(cwd, config || null)),
    contract: REGISTER_CONTRACT,
    repoKey: repoKey(owner.gitRoot),
    signals: {
      logs: enabled,
      metrics: enabled,
      spans: enabled && !!config && config.otelTraces === true,
    },
    uploader: path.join(__dirname, UPLOADER_SCRIPT),
    realtime: buildRealtimeTarget(config),
  };
}

/**
 * The pre-2.30.0 register body, for the legacy (unauthenticated) path: never the realtime API key
 * or anything else a foreign listener on the port should not see.
 * @param {ReturnType<typeof buildRegistrationPayload>} payload
 * @returns {{ sessionId: string|null, gitRoot: string, repo: string, hookVersion: string|null }}
 */
function legacyRegistrationPayload(payload) {
  return {
    sessionId: payload.sessionId,
    gitRoot: payload.gitRoot,
    repo: payload.repo,
    hookVersion: payload.hookVersion,
  };
}

/**
 * Split a version into its numeric parts, ignoring any pre-release/build suffix. Anything that is
 * not a dotted numeric version yields `null`, which callers treat as "not comparable".
 * @param {*} value
 * @returns {number[]|null}
 */
function parseVersionParts(value) {
  if (typeof value !== 'string') return null;
  const core = value.trim().split(/[-+]/)[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split('.').map(Number);
}

/**
 * Whether `candidate` is strictly older than `reference`. Missing trailing parts count as `0`, so
 * `2.3` is not older than `2.3.0`. Returns `false` when either side is uncomparable — an
 * unrecognisable version must not produce a spurious warning.
 * @param {*} candidate
 * @param {*} reference
 * @returns {boolean}
 */
function isOlderVersion(candidate, reference) {
  const left = parseVersionParts(candidate);
  const right = parseVersionParts(reference);
  if (!left || !right) return false;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const a = left[i] === undefined ? 0 : left[i];
    const b = right[i] === undefined ? 0 : right[i];
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}

/**
 * Parse a register response body, tolerating anything unparseable (an older or foreign listener on
 * the port may answer with anything at all).
 * @param {string} raw
 * @returns {Record<string, *>}
 */
function parseResponseBody(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Handle one register response. A `409` and a `200`-current-version each produce at most one
 * `warn` line; a `404` from a pre-2.3.0 receiver that has no such endpoint is deliberately silent.
 * A `200`-stale-version additionally drives a restart: `stopReceiverAndWait()` (from
 * `./otel-restart`) against the reporting receiver, then a replacement spawned via
 * `buildReceiverLaunch`/`spawnDetachedHidden` — mirroring `announceOtelSession`'s own spawn step, so
 * that caller knows (via the returned `{restarted: true}`) to skip its unconditional one.
 *
 * A `409` is detection and logging only: the hook cannot fix a port collision at runtime, since
 * Claude Code's exporter is already pointed at that port by `.claude/settings.json`, so only an
 * install-time change moves it.
 *
 * The restart branch is throttled per project (`OTEL_RESTART_STATE_FILE`,
 * `OTEL_RESTART_THROTTLE_MS`) so two near-simultaneous `SessionStart`s that both observe the same
 * stale receiver don't both race a shutdown/spawn cycle — a throttled call logs and falls through
 * to `{restarted: false}`, leaving the caller's own idempotent spawn-if-absent step (safe, since an
 * already-bound port just makes that spawn exit on `EADDRINUSE`) to run as it always has.
 * @param {number} status
 * @param {string} raw
 * @param {number} port
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * In shared mode (`opts.mode === 'shared'`) none of that applies: see `handleSharedRegisterResponse`
 * — it never stops or restarts a receiver.
 * @param {Record<string, *>} [config] - required only on the restart branch, to rebuild the launch
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} [gitContext]
 * @param {{ mode?: 'shared'|'legacy', payload?: Record<string, *>, helloCapabilities?: string[] }} [opts]
 * @returns {Promise<{restarted: boolean}>}
 */
async function handleRegisterResponse(status, raw, port, sessionId, cwd, config, gitContext, opts = {}) {
  if (opts.mode === 'shared') {
    handleSharedRegisterResponse(status, raw, port, sessionId, cwd, opts.payload || null, opts.helloCapabilities || null);
    return { restarted: false };
  }

  if (status === 409) {
    const ownerRepo = parseResponseBody(raw).ownerRepo;
    const owner = typeof ownerRepo === 'string' && ownerRepo.trim() ? ownerRepo.trim() : 'an unknown repository';
    hookLog(HOOK_FILE, sessionId, 'warn',
      `the OTEL receiver on port ${port} belongs to another project (${owner}) — this project's OTEL ` +
      'telemetry is being filed under that project. Re-run the installer with --otel-port <n> to give ' +
      'this project a distinct port', cwd);
    return { restarted: false };
  }

  if (status !== 200) return { restarted: false };

  const receiverVersion = parseResponseBody(raw).receiverVersion;
  const hookVersion = getHookVersion();
  if (!isOlderVersion(receiverVersion, hookVersion)) return { restarted: false };

  if (!claimThrottleSlot(cwd, OTEL_RESTART_STATE_FILE, OTEL_RESTART_THROTTLE_MS)) {
    hookLog(HOOK_FILE, sessionId, 'result', 'skipped: otel receiver restart throttled', cwd);
    return { restarted: false };
  }

  hookLog(HOOK_FILE, sessionId, 'warn',
    `the OTEL receiver on port ${port} is running version ${receiverVersion}, older than this hook's ` +
    `${hookVersion} — restarting it`, cwd);

  const owner = buildOwnerPayload(cwd, gitContext);
  await stopReceiverAndWait(port, owner.gitRoot, sessionId);

  const launch = buildReceiverLaunch(config, cwd, gitContext, { sessionId, warn: false });
  spawnDetachedHidden(
    path.join(__dirname, RECEIVER_SCRIPT),
    launch.argv,
    {
      env: launch.env,
      // Neutral cwd — see announceOtelSession.
      cwd: os.tmpdir(),
      onSpawned: ({ launcher, pid }) => hookLog(HOOK_FILE, sessionId, 'result',
        `otel receiver restart spawn dispatched via ${launcher}${pid ? ` pid=${pid}` : ''} on 127.0.0.1:${launch.port}`,
        cwd),
      onError: (err) => hookLog(HOOK_FILE, sessionId, 'error',
        `spawn of ${RECEIVER_SCRIPT} failed (${err.message}) — the receiver was not launched`,
        cwd),
    },
  );

  return { restarted: true };
}

/**
 * The receiver capabilities this session needs (FR-A10): `session-status` always (the per-session
 * OTEL status), `spans` when the registration asks for traces, `realtime` when it carries an
 * enabled realtime target.
 * @param {Record<string, *>|null} payload - from `buildRegistrationPayload`
 * @returns {string[]}
 */
function neededCapabilities(payload) {
  const needed = ['session-status'];
  if (payload && payload.signals && payload.signals.spans === true) needed.push('spans');
  if (payload && payload.realtime && payload.realtime.enabled !== false) needed.push('realtime');
  return needed;
}

/**
 * Handle one shared-mode register response. Never stops, restarts or spawns anything (DD-7): a
 * receiver older than this hook keeps running until its idle-exit.
 *  - `200`: compare the receiver's `capabilities` (falling back to the hello's) with what this
 *    session needs; anything missing → one `warn` per session (FR-A10).
 *  - anything else (`400` with a `reason`, `401` after a nonce race) → one `warn` line.
 * @param {number} status
 * @param {string} raw
 * @param {number} port
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {Record<string, *>|null} payload
 * @param {string[]|null} helloCapabilities
 */
function handleSharedRegisterResponse(status, raw, port, sessionId, cwd, payload, helloCapabilities) {
  const body = parseResponseBody(raw);
  if (status !== 200) {
    const reason = typeof body.reason === 'string' ? ` reason=${body.reason}`
      : (typeof body.error === 'string' ? ` error=${body.error}` : '');
    hookLog(HOOK_FILE, sessionId, 'warn',
      `otel shared register on 127.0.0.1:${port} answered ${status}${reason} — this session is not registered`, cwd);
    return;
  }
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities
    : (Array.isArray(helloCapabilities) ? helloCapabilities : []);
  const missing = neededCapabilities(payload).filter((cap) => !capabilities.includes(cap));
  if (missing.length > 0 && claimSessionWarning(sessionId, 'otel-capabilities', cwd)) {
    const receiverVersion = typeof body.receiverVersion === 'string' ? body.receiverVersion : 'unknown';
    hookLog(HOOK_FILE, sessionId, 'warn',
      `otel receiver ${receiverVersion} on 127.0.0.1:${port} lacks capabilities ${missing.join(', ')} needed by ` +
      `hook ${getHookVersion()} — it keeps running; the newer receiver takes over after its idle-exit`, cwd);
  }
}

/**
 * `HMAC(token, "srv\n"+clientNonce+"\n"+serverNonce)` hex — the hello proof (DD-9). Twins:
 * otel-receiver.js, otel-ensure-receiver.js; keep identical.
 * @param {string} token
 * @param {string} clientNonce
 * @param {string} serverNonce
 * @returns {string}
 */
function computeHelloProof(token, clientNonce, serverNonce) {
  return crypto.createHmac('sha256', token).update(`srv\n${clientNonce}\n${serverNonce}`).digest('hex');
}

/**
 * Constant-time check of a hello answer's proof.
 * @param {string} token
 * @param {string} clientNonce
 * @param {*} answer - the parsed hello body
 * @returns {boolean}
 */
function helloProofValid(token, clientNonce, answer) {
  if (!answer || typeof answer !== 'object') return false;
  const { serverNonce, proof } = answer;
  if (typeof serverNonce !== 'string' || !serverNonce || typeof proof !== 'string' || !HEX_RE.test(proof)) return false;
  const expected = Buffer.from(computeHelloProof(token, clientNonce, serverNonce), 'hex');
  const actual = Buffer.from(proof, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * The `x-artisyn-auth` header value of one authenticated request (DD-9):
 * `v1 <serverNonce> <HMAC(token, "cli\n"+serverNonce+"\n"+urlPath+"\n"+sha256hex(rawBody))>`.
 * `rawBody` must be the exact wire bytes. Twin of `computeAuthMac` in otel-receiver.js.
 * @param {string} token
 * @param {string} serverNonce - single-use, from a verified hello
 * @param {string} urlPath
 * @param {Buffer|string} rawBody
 * @returns {string}
 */
function buildAuthHeader(token, serverNonce, urlPath, rawBody) {
  const bodyHash = crypto.createHash('sha256').update(rawBody === undefined || rawBody === null ? '' : rawBody).digest('hex');
  const mac = crypto.createHmac('sha256', token).update(`cli\n${serverNonce}\n${urlPath}\n${bodyHash}`).digest('hex');
  return `${AUTH_SCHEME} ${serverNonce} ${mac}`;
}

/**
 * One loopback JSON POST. Resolves `{kind: 'answer', status, raw}` or `{kind: 'none'}` (refused,
 * reset or timed out). Never rejects.
 * @param {number} port
 * @param {string} urlPath
 * @param {Buffer} body
 * @param {Record<string, string>} extraHeaders
 * @param {number} timeoutMs
 * @returns {Promise<{ kind: 'answer', status: number, raw: string }|{ kind: 'none' }>}
 */
function postJson(port, urlPath, body, extraHeaders, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': body.length }, extraHeaders),
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('error', () => finish({ kind: 'answer', status: res.statusCode || 0, raw: '' }));
        res.on('end', () => finish({ kind: 'answer', status: res.statusCode || 0, raw }));
      });
      req.on('error', () => finish({ kind: 'none' }));
      req.setTimeout(timeoutMs, () => {
        try {
          req.destroy();
        } catch {
          // already destroyed
        }
        finish({ kind: 'none' });
      });
      req.end(body);
    } catch {
      finish({ kind: 'none' });
    }
  });
}

/**
 * @typedef {object} SharedHandshake
 * @property {'ok'} status
 * @property {string} token
 * @property {string} serverNonce   single-use — one authenticated request per handshake
 * @property {string|null} receiverVersion
 * @property {number|null} contract
 * @property {string[]} capabilities
 * @property {(urlPath: string, rawBody: Buffer|string) => string} authHeader
 */

/**
 * The shared-receiver hello (DD-9, DD-17). Resolves:
 *  - `{status: 'ok', …}` — a receiver of this OS user answered with a valid proof; `authHeader`
 *    builds the `x-artisyn-auth` value of exactly one request with the issued nonce;
 *  - `{status: 'none'}` — nothing answered (refused or timed out): no receiver is running;
 *  - `{status: 'port-conflict', detail}` — something answered but is not our receiver: a `409`
 *    (another OS user's), any other status, a non-JSON body or a bad proof;
 *  - `{status: 'no-token'}` — `~/.artisyn/otel/token` is unusable and could not be created.
 * Never rejects.
 * @param {number} port
 * @param {{ timeoutMs?: number, homeDir?: string }} [opts]
 * @returns {Promise<SharedHandshake|{ status: 'none' }|{ status: 'no-token' }|{ status: 'port-conflict', detail: string }>}
 */
async function sharedHandshake(port, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const token = readOrCreateToken({ homeDir });
  if (!token) return { status: 'no-token' };
  const clientNonce = crypto.randomBytes(16).toString('hex');
  const body = Buffer.from(JSON.stringify({ clientNonce, ownerHash: ownerHash(homeDir) }), 'utf8');
  const answer = await postJson(port, HELLO_PATH, body, {}, opts.timeoutMs || HELLO_TIMEOUT_MS);
  if (answer.kind === 'none') return { status: 'none' };
  if (answer.status === 409) return { status: 'port-conflict', detail: 'owner-mismatch' };
  if (answer.status !== 200) return { status: 'port-conflict', detail: `hello-status-${answer.status}` };
  let parsed;
  try {
    parsed = JSON.parse(answer.raw);
  } catch {
    return { status: 'port-conflict', detail: 'hello-not-json' };
  }
  if (!helloProofValid(token, clientNonce, parsed)) return { status: 'port-conflict', detail: 'bad-proof' };
  const serverNonce = parsed.serverNonce;
  return {
    status: 'ok',
    token,
    serverNonce,
    receiverVersion: typeof parsed.receiverVersion === 'string' ? parsed.receiverVersion : null,
    contract: Number.isInteger(parsed.contract) ? parsed.contract : null,
    capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities.filter((c) => typeof c === 'string') : [],
    authHeader: (urlPath, rawBody) => buildAuthHeader(token, serverNonce, urlPath, rawBody),
  };
}

/**
 * One authenticated shared-receiver request with an already verified handshake (its nonce is spent
 * by this call). Resolves `{kind: 'answer', status, raw}` or `{kind: 'none'}`; never rejects.
 * @param {number} port
 * @param {SharedHandshake} handshake
 * @param {string} urlPath - `REGISTER_PATH`, `SESSION_STATUS_PATH` or `SHUTDOWN_PATH`
 * @param {*} payload - JSON-serialised as the body
 * @param {number} [timeoutMs]
 * @returns {Promise<{ kind: 'answer', status: number, raw: string }|{ kind: 'none' }>}
 */
function sharedAuthedPost(port, handshake, urlPath, payload, timeoutMs = REGISTER_TIMEOUT_MS) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(payload === undefined ? {} : payload), 'utf8');
  } catch {
    return Promise.resolve({ kind: 'none' });
  }
  return postJson(port, urlPath, body, { [AUTH_HEADER]: handshake.authHeader(urlPath, body) }, timeoutMs);
}

/**
 * Hello + one authenticated request in one go — for a caller that has no handshake yet (the
 * session-status reader). Resolves the handshake outcome when it is not `ok`.
 * @param {number} port
 * @param {string} urlPath
 * @param {*} payload
 * @param {{ timeoutMs?: number, homeDir?: string }} [opts]
 * @returns {Promise<{ kind: 'answer', status: number, raw: string, handshake: SharedHandshake }
 *   |{ kind: 'none' }|{ kind: 'handshake', handshake: { status: string, detail?: string } }>}
 */
async function sharedRequest(port, urlPath, payload, opts = {}) {
  const handshake = await sharedHandshake(port, opts);
  if (handshake.status !== 'ok') return { kind: 'handshake', handshake };
  const result = await sharedAuthedPost(port, handshake, urlPath, payload, opts.timeoutMs || SESSION_STATUS_TIMEOUT_MS);
  return result.kind === 'answer' ? { ...result, handshake } : result;
}

/**
 * Normalise a `{logs, metrics, spans}` counter map to non-negative integers.
 * @param {*} value
 * @returns {{ logs: number, metrics: number, spans: number }}
 */
function normalizeReceived(value) {
  const v = value && typeof value === 'object' ? value : {};
  const count = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0);
  return { logs: count(v.logs), metrics: count(v.metrics), spans: count(v.spans) };
}

/**
 * Ask the shared receiver what it has received for one session (DD-11): an authenticated
 * `POST /artisyn/session-status {sessionId}` bounded by `SESSION_STATUS_TIMEOUT_MS`. Resolves
 *  - the DD-11 body `{receiverVersion, registered, received:{logs,metrics,spans}, firstRecordAt,
 *    pending, forward}` (normalised);
 *  - `{unreachable: true, detail}` — nothing answered (`detail: null`), or something that is not
 *    this user's receiver holds the port (`detail: 'port-conflict'`), or the token is unusable
 *    (`detail: 'no-token'`);
 *  - `{unsupported: true, detail}` — an older receiver without the `session-status` capability or
 *    route (`detail: 'no-session-status'`), or any other non-200 answer.
 * Never rejects, never spawns anything.
 * @param {number} port
 * @param {string} sessionId
 * @param {{ timeoutMs?: number, homeDir?: string }} [opts]
 * @returns {Promise<{ receiverVersion: string|null, registered: boolean,
 *   received: { logs: number, metrics: number, spans: number }, firstRecordAt: string|null,
 *   pending: number, forward: 'ok'|'degraded'|'off' }
 *   |{ unreachable: true, detail: string|null }|{ unsupported: true, detail: string, receiverVersion: string|null }>}
 */
async function queryOtelSessionStatus(port, sessionId, opts = {}) {
  try {
    const timeoutMs = opts.timeoutMs || SESSION_STATUS_TIMEOUT_MS;
    const handshake = await sharedHandshake(port, { timeoutMs, homeDir: opts.homeDir });
    if (handshake.status === 'none') return { unreachable: true, detail: null };
    if (handshake.status === 'no-token') return { unreachable: true, detail: 'no-token' };
    if (handshake.status !== 'ok') return { unreachable: true, detail: 'port-conflict' };
    if (!handshake.capabilities.includes('session-status')) {
      return { unsupported: true, detail: 'no-session-status', receiverVersion: handshake.receiverVersion };
    }
    const answer = await sharedAuthedPost(port, handshake, SESSION_STATUS_PATH, { sessionId }, timeoutMs);
    if (answer.kind === 'none') return { unreachable: true, detail: null };
    if (answer.status === 404) {
      return { unsupported: true, detail: 'no-session-status', receiverVersion: handshake.receiverVersion };
    }
    if (answer.status !== 200) {
      return { unsupported: true, detail: `session-status-${answer.status}`, receiverVersion: handshake.receiverVersion };
    }
    const body = parseResponseBody(answer.raw);
    return {
      receiverVersion: typeof body.receiverVersion === 'string' ? body.receiverVersion : handshake.receiverVersion,
      registered: body.registered === true,
      received: normalizeReceived(body.received),
      firstRecordAt: typeof body.firstRecordAt === 'string' ? body.firstRecordAt : null,
      pending: Number.isFinite(Number(body.pending)) && Number(body.pending) > 0 ? Math.floor(Number(body.pending)) : 0,
      forward: body.forward === 'ok' || body.forward === 'degraded' ? body.forward : 'off',
    };
  } catch {
    return { unreachable: true, detail: null };
  }
}

/**
 * The one-per-session port-conflict warning (DD-17). The hook never allocates a port.
 * @param {number} port
 * @param {string} detail
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {string} hookFile
 */
function warnPortConflict(port, detail, sessionId, cwd, hookFile) {
  if (!claimSessionWarning(sessionId, 'port-conflict', cwd)) return;
  hookLog(hookFile, sessionId, 'warn',
    `otel port-conflict port=${port} detail=${detail} — the shared OTEL receiver port is held by something that ` +
    'is not this user\'s receiver; re-run the log-hub installer with --otel-port <n>', cwd);
}

/**
 * Wait `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After a spawn: retry hello until it answers or `SPAWN_HELLO_RETRY_MS` has passed.
 * @param {number} port
 * @returns {Promise<SharedHandshake|{ status: string, detail?: string }>}
 */
async function helloAfterSpawn(port) {
  const deadline = Date.now() + SPAWN_HELLO_RETRY_MS;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: 'port-conflict', detail: 'no-answer-after-spawn' };
    const hs = await sharedHandshake(port, { timeoutMs: Math.max(100, Math.min(HELLO_TIMEOUT_MS, remaining)) });
    if (hs.status !== 'none') return hs;
    await delay(Math.min(SPAWN_HELLO_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * The shared-mode announce (DD-7, DD-9, DD-10, DD-17): hello; spawn this plugin's receiver copy only
 * when nothing answers (then retry hello for `SPAWN_HELLO_RETRY_MS`); then an authenticated
 * register. Never stops or restarts a receiver. Never throws.
 * @param {ReturnType<typeof buildReceiverLaunch>} launch
 * @param {Record<string, *>} config
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @param {string} hookFile
 * @returns {Promise<{ status: string, detail?: string }>}
 */
async function announceShared(launch, config, sessionId, cwd, gitContext, hookFile) {
  let hs = await sharedHandshake(launch.port);
  if (hs.status === 'none') {
    spawnDetachedHidden(
      path.join(__dirname, RECEIVER_SCRIPT),
      launch.argv,
      {
        env: launch.env,
        // Neutral cwd — see announceOtelSession.
        cwd: os.tmpdir(),
        onSpawned: ({ launcher, pid }) => hookLog(hookFile, sessionId, 'result',
          `otel shared receiver spawn dispatched via ${launcher}${pid ? ` pid=${pid}` : ''} on 127.0.0.1:${launch.port}`,
          cwd),
        onError: (err) => hookLog(hookFile, sessionId, 'error',
          `spawn of ${RECEIVER_SCRIPT} failed (${err.message}) — the receiver was not launched`,
          cwd),
      },
    );
    hs = await helloAfterSpawn(launch.port);
  }

  if (hs.status === 'no-token') {
    hookLog(hookFile, sessionId, 'error',
      'otel: ~/.artisyn/otel/token is unusable and could not be created — the shared receiver cannot be reached', cwd);
    return { status: 'no-token' };
  }
  if (hs.status !== 'ok') {
    const detail = hs.detail || 'unknown';
    warnPortConflict(launch.port, detail, sessionId, cwd, hookFile);
    return { status: 'port-conflict', detail };
  }

  if (!sessionId) return { status: 'ok' };
  const payload = buildRegistrationPayload(sessionId, cwd, gitContext, config);
  const answer = await sharedAuthedPost(launch.port, hs, REGISTER_PATH, payload);
  if (answer.kind === 'none') {
    hookLog(hookFile, sessionId, 'warn', `otel shared register on 127.0.0.1:${launch.port} got no answer`, cwd);
    return { status: 'register-failed' };
  }
  await handleRegisterResponse(answer.status, answer.raw, launch.port, sessionId, cwd, config, gitContext,
    { mode: 'shared', payload, helloCapabilities: hs.capabilities });
  return { status: answer.status === 200 ? 'ok' : 'register-failed' };
}

/**
 * Announce this session to a receiver that may or may not be listening: a single `POST
 * /artisyn/register` on loopback. Never throws and never retries; the returned promise always
 * resolves — never rejects — whether the request succeeds, is refused, errors, or times out.
 * `REGISTER_TIMEOUT_MS` bounds the fast (no-restart) path, so an `await` here cannot hang the
 * caller past ~2s except when the response drives a restart (see `handleRegisterResponse`, which
 * itself never throws and always resolves the `{restarted}` outcome this promise carries back).
 * @param {number} port
 * @param {Record<string, *>} payload - from `buildRegistrationPayload`
 * @param {string|null} sessionId - for the log lines only
 * @param {string|null} cwd
 * @param {Record<string, *>} [config] - threaded through to `handleRegisterResponse`'s restart branch
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} [gitContext]
 * @returns {Promise<{restarted: boolean}>}
 */
function fireRegister(port, payload, sessionId, cwd, config, gitContext) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result || { restarted: false });
    };

    let body;
    let req;
    try {
      body = Buffer.from(JSON.stringify(payload), 'utf8');
      req = http.request({
        host: '127.0.0.1',
        port,
        path: REGISTER_PATH,
        method: 'POST',
        headers: {
          // Required by the receiver's browser-origin defence, and the reason a web page cannot
          // reach it: `application/json` is not a CORS simple request, so a browser must preflight,
          // and the receiver sends no CORS headers.
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('error', () => {
          // a truncated response is as non-fatal as no response at all
          finish({ restarted: false });
        });
        res.on('end', async () => {
          try {
            finish(await handleRegisterResponse(res.statusCode, raw, port, sessionId, cwd, config, gitContext));
          } catch {
            // the announce is best-effort; a logging/restart failure must never surface
            finish({ restarted: false });
          }
        });
      });

      // ECONNREFUSED is the *expected* outcome when no receiver is running yet — the spawn that
      // follows this call is what covers it. Every other transport error is equally non-fatal.
      req.on('error', () => finish({ restarted: false }));

      req.setTimeout(REGISTER_TIMEOUT_MS, () => {
        try {
          req.destroy();
        } catch {
          // already destroyed
        }
        finish({ restarted: false });
      });

      req.end(body);
    } catch (err) {
      hookLog(HOOK_FILE, sessionId, 'error', `otel register on port ${port} could not be sent: ${err.message}`, cwd);
      finish({ restarted: false });
    }
  });
}

// Env twins of the other launch mode. The receiver falls back to env for every flag, so one inherited
// from the hook's own environment would turn a shared launch into the `--shared` + `--dir` conflict
// (exit 2), or a legacy launch into a shared one.
const LEGACY_ONLY_ENV = ['ARTISYN_OTEL_DIR', 'ARTISYN_OTEL_OWNER_JSON'];
const SHARED_ONLY_ENV = ['ARTISYN_OTEL_SHARED', 'ARTISYN_OTEL_OWNER_HOME', 'ARTISYN_OTEL_STATE_DIR'];

/**
 * A copy of `process.env` without `keys` — the base of a launch env (never a bare object: `opts.env`
 * becomes the child's entire environment).
 * @param {string[]} keys
 * @returns {Record<string, string|undefined>}
 */
function inheritedEnvWithout(keys) {
  const env = Object.assign({}, process.env);
  for (const key of keys) delete env[key];
  return env;
}

/**
 * Build everything `spawnDetachedHidden` needs to launch this project's receiver.
 *
 * Every parameter is supplied **twice** — as argv and as an `ARTISYN_OTEL_*` env var — and the
 * receiver reads argv first with an env fallback. The redundancy is kept for cross-version
 * compatibility: a hook <= 2.5.1 launches the receiver through a Windows VBScript command line that
 * carries env only, so a mixed-version pair still works either way.
 *
 * `env` is `Object.assign({}, process.env, {…})` and never a bare object: `opts.env` becomes the
 * child's *entire* environment, so anything less would strip it.
 * Shared mode (`resolveOtelPort` → `mode: 'shared'`, DD-7): the per-OS-user launch —
 * `--shared --owner-home <home> --state-dir <dir> --port <n> --idle-timeout-ms <ms> --max-body-bytes <n>`
 * with the env twins `ARTISYN_OTEL_SHARED=1`, `ARTISYN_OTEL_OWNER_HOME`, `ARTISYN_OTEL_STATE_DIR`,
 * `ARTISYN_OTEL_PORT`, `ARTISYN_OTEL_IDLE_TIMEOUT_MS`, `ARTISYN_OTEL_MAX_BODY_BYTES`. The idle timeout
 * is always `SHARED_IDLE_TIMEOUT_MS` (DD-8); no `--owner`/`--dir`, which the receiver rejects
 * together with `--shared`.
 * @param {Record<string, *>} config
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @param {{ sessionId?: string|null, warn?: boolean }} [opts] - passed to `resolveOtelPort`
 * @returns {{ mode: 'shared'|'legacy', port: number, otelDir: string, argv: string[], env: Record<string, string> }}
 */
function buildReceiverLaunch(config, cwd, gitContext, opts = {}) {
  const resolved = resolveOtelPort(config, process.env, cwd, opts);
  const port = resolved.port;
  const otelDir = resolveOtelDir(cwd, config);
  const maxBodyBytes = resolveOtelNumber(config, 'otelReceiverMaxBodyKb') * BYTES_PER_KB;

  if (resolved.mode === 'shared') {
    const home = os.homedir();
    const stateDir = otelStateDir(home);
    return {
      mode: 'shared',
      port,
      otelDir,
      argv: [
        '--shared',
        '--owner-home', home,
        '--state-dir', stateDir,
        '--port', String(port),
        '--idle-timeout-ms', String(SHARED_IDLE_TIMEOUT_MS),
        '--max-body-bytes', String(maxBodyBytes),
      ],
      env: Object.assign(inheritedEnvWithout(LEGACY_ONLY_ENV), {
        ARTISYN_OTEL_SHARED: '1',
        ARTISYN_OTEL_OWNER_HOME: home,
        ARTISYN_OTEL_STATE_DIR: stateDir,
        ARTISYN_OTEL_PORT: String(port),
        ARTISYN_OTEL_IDLE_TIMEOUT_MS: String(SHARED_IDLE_TIMEOUT_MS),
        ARTISYN_OTEL_MAX_BODY_BYTES: String(maxBodyBytes),
      }),
    };
  }

  const idleTimeoutMs = resolveOtelNumber(config, 'otelReceiverIdleTimeoutMs');
  const ownerJson = JSON.stringify(buildOwnerPayload(cwd, gitContext));

  return {
    mode: 'legacy',
    port,
    otelDir,
    argv: [
      '--port', String(port),
      '--dir', otelDir,
      '--owner', ownerJson,
      '--idleTimeoutMs', String(idleTimeoutMs),
      '--maxBodyBytes', String(maxBodyBytes),
    ],
    env: Object.assign(inheritedEnvWithout(SHARED_ONLY_ENV), {
      ARTISYN_OTEL_PORT: String(port),
      ARTISYN_OTEL_DIR: otelDir,
      ARTISYN_OTEL_OWNER_JSON: ownerJson,
      ARTISYN_OTEL_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
      ARTISYN_OTEL_MAX_BODY_BYTES: String(maxBodyBytes),
    }),
  };
}

/**
 * Announce this session's OTEL receiver, in two steps: an awaited
 * register POST (which covers "a receiver is already running", is what surfaces a port collision,
 * and may itself drive a restart when the receiver reports a stale version), then — only when that
 * restart did not already happen — a detached spawn of `otel-receiver.js` (which covers "no
 * receiver was running"; an already-bound port makes the new process exit 0 on `EADDRINUSE`).
 *
 * Shared by both call sites — `lifecycle-hook.js` on `SessionStart` (`verb: 'announced'`) and
 * `telemetry-hook.js`'s throttled re-arm on `UserPromptSubmit` (`verb: 're-armed'`) — so the
 * spawn-outcome logging below can't drift between the two copies.
 *
 * Nothing here can fail the caller: every parameter is passed as both argv and env, for the
 * cross-version reason documented on `buildReceiverLaunch()`.
 * @param {Record<string, *>} config
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @param {string} hookFile - calling script filename, for hook.log attribution
 * @param {string} verb - 'announced' or 're-armed', for the summary log line's wording
 * @returns {Promise<{ mode: 'shared'|'legacy', port: number, status: string, detail: string|null }|null>}
 *   the receiver mode, port and announce outcome (`null` when the announce itself failed)
 */
async function announceOtelSession(config, sessionId, cwd, gitContext, hookFile, verb) {
  try {
    const launch = buildReceiverLaunch(config, cwd, gitContext, { sessionId });

    if (launch.mode === 'shared') {
      const shared = await announceShared(launch, config, sessionId, cwd, gitContext, hookFile);
      hookLog(hookFile, sessionId, 'result',
        `otel shared receiver ${verb} on 127.0.0.1:${launch.port} (dir ${launch.otelDir}) status=${shared.status}` +
        `${shared.detail ? ` detail=${shared.detail}` : ''}`, cwd);
      return { mode: 'shared', port: launch.port, status: shared.status, detail: shared.detail || null };
    }

    const result = await fireRegister(
      launch.port, legacyRegistrationPayload(buildRegistrationPayload(sessionId, cwd, gitContext, config)),
      sessionId, cwd, config, gitContext,
    );

    if (!result || !result.restarted) {
      spawnDetachedHidden(
        path.join(__dirname, RECEIVER_SCRIPT),
        launch.argv,
        {
          env: launch.env,
          // Neutral cwd: the receiver is long-lived and detached, and must not pin the project
          // folder (Windows refuses to delete/rename a directory that is a process's cwd).
          cwd: os.tmpdir(),
          onSpawned: ({ launcher, pid }) => hookLog(hookFile, sessionId, 'result',
            `otel receiver spawn dispatched via ${launcher}${pid ? ` pid=${pid}` : ''} on 127.0.0.1:${launch.port}`,
            cwd),
          onError: (err) => hookLog(hookFile, sessionId, 'error',
            `spawn of ${RECEIVER_SCRIPT} failed (${err.message}) — the receiver was not launched`,
            cwd),
        },
      );
    }

    hookLog(hookFile, sessionId, 'result',
      `otel receiver ${verb} on 127.0.0.1:${launch.port} (dir ${launch.otelDir})`, cwd);
    return { mode: 'legacy', port: launch.port, status: 'ok', detail: null };
  } catch (err) {
    hookLog(hookFile, sessionId, 'error', `otel receiver announce failed: ${err.message}`, cwd);
    return null;
  }
}

/**
 * Throttled re-arm — the shape every call site except `SessionStart` uses.
 *
 * Why so many call sites: the receiver self-exits after its idle timeout, and until this existed
 * the ONLY thing that revived it was `UserPromptSubmit`. A long autonomous turn has no prompts (a
 * measured one ran 7 h 36 m on two), so a receiver that died early stayed dead for hours and its
 * telemetry was lost — the OTLP exporter pushes over HTTP and does not spool to disk, so anything
 * POSTed while nothing was listening is gone. Re-arming from the high-frequency lifecycle events
 * and at `Stop` bounds that hole to one throttle window.
 *
 * It doubles as a keepalive, which is the more valuable half: `announceOtelSession` starts with a
 * `POST /artisyn/register`, and the receiver re-arms its idle timer on *any* request on *any*
 * route. Pinging it at least once per throttle window therefore stops the idle timeout from ever
 * firing mid-session — it prevents the death rather than only recovering from it.
 *
 * Safe to call from anywhere and on any event: it is gated on `otelEnabled`, throttled on the
 * shared state file, and cannot fail the caller — `announceOtelSession`'s own `try/catch` absorbs
 * everything, so awaiting it here never turns an OTEL failure into a hook failure.
 * @param {Record<string, *>} config
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @param {string} hookFile - calling script filename, for hook.log attribution
 * @returns {Promise<boolean>} whether an announce was dispatched (false = disabled or throttled)
 */
async function maybeReArmOtelSession(config, sessionId, cwd, gitContext, hookFile) {
  if (!config.otelEnabled) return false;
  if (!claimThrottleSlot(cwd, OTEL_SPAWN_STATE_FILE, OTEL_RESPAWN_THROTTLE_MS)) {
    hookLog(hookFile, sessionId, 'result', 'skipped: otel receiver re-arm throttled', cwd);
    return false;
  }
  await announceOtelSession(config, sessionId, cwd, gitContext, hookFile, 're-armed');
  return true;
}

module.exports = {
  announceOtelSession,
  buildAuthHeader,
  buildOwnerPayload,
  buildRealtimeTarget,
  buildRegistrationPayload,
  buildReceiverLaunch,
  computeHelloProof,
  fireRegister,
  handleRegisterResponse,
  helloProofValid,
  isOlderVersion,
  legacyRegistrationPayload,
  maybeReArmOtelSession,
  neededCapabilities,
  queryOtelSessionStatus,
  sharedAuthedPost,
  sharedHandshake,
  sharedRequest,
  AUTH_HEADER,
  HELLO_PATH,
  HELLO_TIMEOUT_MS,
  OTEL_RESTART_STATE_FILE,
  OTEL_RESTART_THROTTLE_MS,
  RECEIVER_SCRIPT,
  REGISTER_CONTRACT,
  REGISTER_PATH,
  REGISTER_TIMEOUT_MS,
  SESSION_STATUS_PATH,
  SESSION_STATUS_TIMEOUT_MS,
  SHARED_IDLE_TIMEOUT_MS,
  SHUTDOWN_PATH,
  SPAWN_HELLO_RETRY_MS,
};
