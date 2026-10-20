'use strict';
/**
 * Claude Code Hook helper — the OTEL receiver announce client (not a hook entry point itself).
 *
 * Shared by both spawn call sites (`lifecycle-hook.js` on `SessionStart` and `telemetry-hook.js`'s
 * throttled re-arm on `UserPromptSubmit`). Each of them performs the same two-step announce, in
 * this order and neither awaited:
 *
 *   1. `fireRegister()` — a non-blocking `POST /artisyn/register` at the resolved loopback port.
 *      This covers the "a receiver is already running" case, and is the only place a port
 *      collision between two projects becomes visible (the receiver answers `409 owner-mismatch`).
 *   2. `spawnDetachedHidden(otel-receiver.js, …)` with the parameters from `buildReceiverLaunch()`
 *      — this covers the "no receiver was running" case. A receiver that is already listening
 *      makes the spawned one exit 0 on `EADDRINUSE`, so firing both unconditionally is correct.
 *
 * Every outcome of the register call is non-fatal and never retried, per the hook's cross-version
 * compatibility rule: a connection refusal (no receiver yet) and a `404` (a pre-2.3.0 receiver
 * with no such endpoint) are both silent. Only two outcomes produce output, one `warn` line each:
 * a `409` (a receiver owned by a different project holds the port) and a `200` reporting a
 * `receiverVersion` older than this hook's own.
 */

const http = require('http');
const path = require('path');

const { resolveOtelDir, resolveOtelPort, resolveOtelNumber } = require('./env-context');
const { getGitRoot } = require('./git-context');
const { hookLog, getHookVersion } = require('./hook-log');
const { spawnDetachedHidden } = require('./spawn-hidden');
const {
  claimThrottleSlot,
  OTEL_RESPAWN_THROTTLE_MS,
  OTEL_SPAWN_STATE_FILE,
} = require('./throttle-state');

const HOOK_FILE = 'otel-register.js';

// The receiver's announce endpoint (mirrors `REGISTER_PATH` in otel-receiver.js).
const REGISTER_PATH = '/artisyn/register';

// The receiver script both spawn call sites launch, as a sibling of their own `__dirname` — the
// same directory in the dev tree and in the installed plugin's scripts directory.
const RECEIVER_SCRIPT = 'otel-receiver.js';

// The receiver is a loopback process on the same machine; anything slower than this is a hung
// socket, not a slow answer. The request is unref()'d anyway, so this only bounds the case where
// the caller happens to outlive it.
const REGISTER_TIMEOUT_MS = 2000;

// KiB → bytes for `otelReceiverMaxBodyKb`; the receiver's `--maxBodyBytes` is always in bytes.
const BYTES_PER_KB = 1024;

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
 * The `POST /artisyn/register` body: the owner identity plus the announcing session and hook
 * version. `sessionId` is used by the receiver only to validate its shape (it keeps no session
 * registry); `null` is tolerated.
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @returns {{ sessionId: string|null, gitRoot: string, repo: string, hookVersion: string|null }}
 */
function buildRegistrationPayload(sessionId, cwd, gitContext) {
  const owner = buildOwnerPayload(cwd, gitContext);
  return {
    sessionId: sessionId || null,
    gitRoot: owner.gitRoot,
    repo: owner.repo,
    hookVersion: getHookVersion(),
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
 * Turn one register response into at most one `warn` line. Every other outcome — including a `404`
 * from a pre-2.3.0 receiver that has no such endpoint — is deliberately silent.
 *
 * A `409` is detection and logging only: the hook cannot fix a port collision at runtime, since
 * Claude Code's exporter is already pointed at that port by `.claude/settings.json`, so only an
 * install-time change moves it.
 * @param {number} status
 * @param {string} raw
 * @param {number} port
 * @param {string|null} sessionId
 * @param {string|null} cwd
 */
function handleRegisterResponse(status, raw, port, sessionId, cwd) {
  if (status === 409) {
    const ownerRepo = parseResponseBody(raw).ownerRepo;
    const owner = typeof ownerRepo === 'string' && ownerRepo.trim() ? ownerRepo.trim() : 'an unknown repository';
    hookLog(HOOK_FILE, sessionId, 'warn',
      `the OTEL receiver on port ${port} belongs to another project (${owner}) — this project's OTEL ` +
      'telemetry is being filed under that project. Re-run the installer with --otel-port <n> to give ' +
      'this project a distinct port', cwd);
    return;
  }

  if (status !== 200) return;

  const receiverVersion = parseResponseBody(raw).receiverVersion;
  const hookVersion = getHookVersion();
  if (isOlderVersion(receiverVersion, hookVersion)) {
    hookLog(HOOK_FILE, sessionId, 'warn',
      `the OTEL receiver on port ${port} is running version ${receiverVersion}, older than this hook's ` +
      `${hookVersion} — it will be replaced once the running receiver reaches its idle timeout`, cwd);
  }
}

/**
 * Announce this session to a receiver that may or may not be listening: a single non-blocking
 * `POST /artisyn/register` on loopback. Never throws, never retries, never blocks the caller — the
 * socket is `unref()`'d, so this cannot hold the hook process open, and a caller that exits first
 * simply never sees the response.
 * @param {number} port
 * @param {Record<string, *>} payload - from `buildRegistrationPayload`
 * @param {string|null} sessionId - for the log lines only
 * @param {string|null} cwd
 */
function fireRegister(port, payload, sessionId, cwd) {
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
      });
      res.on('end', () => {
        try {
          handleRegisterResponse(res.statusCode, raw, port, sessionId, cwd);
        } catch {
          // the announce is best-effort; a logging failure must never surface
        }
      });
    });

    // ECONNREFUSED is the *expected* outcome when no receiver is running yet — the spawn that
    // follows this call is what covers it. Every other transport error is equally non-fatal.
    req.on('error', () => {});

    // Detached from the event loop: the announce must not extend the hook's lifetime by a single
    // tick, so whichever of the two finishes first is fine.
    req.on('socket', (socket) => {
      try {
        socket.unref();
      } catch {
        // socket already gone
      }
    });

    req.setTimeout(REGISTER_TIMEOUT_MS, () => {
      try {
        req.destroy();
      } catch {
        // already destroyed
      }
    });

    req.end(body);
  } catch (err) {
    hookLog(HOOK_FILE, sessionId, 'error', `otel register on port ${port} could not be sent: ${err.message}`, cwd);
  }
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
 * @param {Record<string, *>} config
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @returns {{ port: number, otelDir: string, argv: string[], env: Record<string, string> }}
 */
function buildReceiverLaunch(config, cwd, gitContext) {
  const port = resolveOtelPort(config, process.env, cwd);
  const otelDir = resolveOtelDir(cwd, config);
  const idleTimeoutMs = resolveOtelNumber(config, 'otelReceiverIdleTimeoutMs');
  const maxBodyBytes = resolveOtelNumber(config, 'otelReceiverMaxBodyKb') * BYTES_PER_KB;
  const ownerJson = JSON.stringify(buildOwnerPayload(cwd, gitContext));

  return {
    port,
    otelDir,
    argv: [
      '--port', String(port),
      '--dir', otelDir,
      '--owner', ownerJson,
      '--idleTimeoutMs', String(idleTimeoutMs),
      '--maxBodyBytes', String(maxBodyBytes),
    ],
    env: Object.assign({}, process.env, {
      ARTISYN_OTEL_PORT: String(port),
      ARTISYN_OTEL_DIR: otelDir,
      ARTISYN_OTEL_OWNER_JSON: ownerJson,
      ARTISYN_OTEL_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
      ARTISYN_OTEL_MAX_BODY_BYTES: String(maxBodyBytes),
    }),
  };
}

/**
 * Announce this session's OTEL receiver, in the two fire-and-forget steps of Design Decision 6: a
 * non-blocking register POST (which covers "a receiver is already running" and is what surfaces a
 * port collision), then a detached spawn of `otel-receiver.js` (which covers "no receiver was
 * running" — an already-bound port makes the new process exit 0 on `EADDRINUSE`).
 *
 * Shared by both call sites — `lifecycle-hook.js` on `SessionStart` (`verb: 'announced'`) and
 * `telemetry-hook.js`'s throttled re-arm on `UserPromptSubmit` (`verb: 're-armed'`) — so the
 * spawn-outcome logging below can't drift between the two copies.
 *
 * Neither step is awaited and nothing here can fail the caller: every parameter is passed as both
 * argv and env, for the cross-version reason documented on `buildReceiverLaunch()`.
 * @param {Record<string, *>} config
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @param {string} hookFile - calling script filename, for hook.log attribution
 * @param {string} verb - 'announced' or 're-armed', for the summary log line's wording
 */
function announceOtelSession(config, sessionId, cwd, gitContext, hookFile, verb) {
  try {
    const launch = buildReceiverLaunch(config, cwd, gitContext);
    fireRegister(launch.port, buildRegistrationPayload(sessionId, cwd, gitContext), sessionId, cwd);
    spawnDetachedHidden(
      path.join(__dirname, RECEIVER_SCRIPT),
      launch.argv,
      {
        env: launch.env,
        onSpawned: ({ launcher, pid }) => hookLog(hookFile, sessionId, 'result',
          `otel receiver spawn dispatched via ${launcher}${pid ? ` pid=${pid}` : ''} on 127.0.0.1:${launch.port}`,
          cwd),
        onError: (err) => hookLog(hookFile, sessionId, 'error',
          `spawn of ${RECEIVER_SCRIPT} failed (${err.message}) — the receiver was not launched`,
          cwd),
      },
    );
    hookLog(hookFile, sessionId, 'result',
      `otel receiver ${verb} on 127.0.0.1:${launch.port} (dir ${launch.otelDir})`, cwd);
  } catch (err) {
    hookLog(hookFile, sessionId, 'error', `otel receiver announce failed: ${err.message}`, cwd);
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
 * shared state file, never awaited, and cannot fail the caller.
 * @param {Record<string, *>} config
 * @param {string|null} sessionId
 * @param {string|null} cwd
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} gitContext
 * @param {string} hookFile - calling script filename, for hook.log attribution
 * @returns {boolean} whether an announce was dispatched (false = disabled or throttled)
 */
function maybeReArmOtelSession(config, sessionId, cwd, gitContext, hookFile) {
  if (!config.otelEnabled) return false;
  if (!claimThrottleSlot(cwd, OTEL_SPAWN_STATE_FILE, OTEL_RESPAWN_THROTTLE_MS)) {
    hookLog(hookFile, sessionId, 'result', 'skipped: otel receiver re-arm throttled', cwd);
    return false;
  }
  announceOtelSession(config, sessionId, cwd, gitContext, hookFile, 're-armed');
  return true;
}

module.exports = {
  announceOtelSession,
  buildOwnerPayload,
  buildRegistrationPayload,
  buildReceiverLaunch,
  fireRegister,
  isOlderVersion,
  maybeReArmOtelSession,
  RECEIVER_SCRIPT,
  REGISTER_PATH,
  REGISTER_TIMEOUT_MS,
};
