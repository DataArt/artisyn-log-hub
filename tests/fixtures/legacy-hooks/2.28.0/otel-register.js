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
 */

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
 * @param {Record<string, *>} [config] - required only on the restart branch, to rebuild the launch
 * @param {{ remote: string|null, root: string, branch: string|null, user: string|null }|null} [gitContext]
 * @returns {Promise<{restarted: boolean}>}
 */
async function handleRegisterResponse(status, raw, port, sessionId, cwd, config, gitContext) {
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

  const launch = buildReceiverLaunch(config, cwd, gitContext);
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
 * @returns {Promise<void>}
 */
async function announceOtelSession(config, sessionId, cwd, gitContext, hookFile, verb) {
  try {
    const launch = buildReceiverLaunch(config, cwd, gitContext);
    const result = await fireRegister(
      launch.port, buildRegistrationPayload(sessionId, cwd, gitContext), sessionId, cwd, config, gitContext,
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
  buildOwnerPayload,
  buildRegistrationPayload,
  buildReceiverLaunch,
  fireRegister,
  isOlderVersion,
  maybeReArmOtelSession,
  OTEL_RESTART_STATE_FILE,
  OTEL_RESTART_THROTTLE_MS,
  RECEIVER_SCRIPT,
  REGISTER_PATH,
  REGISTER_TIMEOUT_MS,
};
