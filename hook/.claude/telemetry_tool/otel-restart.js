'use strict';
/**
 * Claude Code Hook helper — the client-side counterpart of the OTEL receiver's
 * `POST /artisyn/shutdown` route (not a hook entry point itself).
 *
 * `otel-receiver.js` never relaunches itself: a stale (older-version) receiver only ever exits when
 * something else asks it to. This module is that "something else" — it is required by
 * `otel-register.js`'s restart trigger (a `200` register response reporting an older
 * `receiverVersion` than this hook's own) and, via its TypeScript mirror
 * `artisyn-hooks-installer/src/otel-restart.ts`, by the installer's stop-before-install step. Both
 * callers need the exact same sequence, so it is written once here and ported once there — the two
 * codebases cannot `require`/`import` each other.
 *
 * The sequence (`stopReceiverAndWait`), matching the receiver's own contract exactly:
 *
 *   1. `POST /artisyn/shutdown {gitRoot, sessionId}` at `port`. Anything other than a `200` — no
 *      response at all (nothing listening, or an old pre-2.3.0 receiver 404ing the unknown path),
 *      a `409` (the port belongs to a different project's receiver), or any other status — is
 *      treated as "nothing to wait for" and returns immediately. This is the fail-open convention
 *      used throughout this hook: a lookup or transport failure never blocks the caller.
 *   2. On `200`, poll the port with a bare TCP connect for up to `SHUTDOWN_GRACE_MS`, giving the
 *      receiver time to flush its response and exit on its own.
 *   3. If still occupied once the grace period elapses, resolve the OS PID bound to the port
 *      (`findPidOnPort`) and force-kill it — the receiver ignored the request, or a non-receiver
 *      process is squatting the port.
 *   4. Poll once more, `PORT_FREE_RETRIES` times at `PORT_FREE_RETRY_INTERVAL_MS` apart, to confirm
 *      the port is actually free before reporting success.
 *
 * `stopReceiverAndWait` never throws and always resolves `{stopped: boolean, reason?: string}` — a
 * caller always proceeds to whatever it was going to do next (spawn a replacement receiver, extract
 * an update) regardless of the outcome. An occupied port simply makes a freshly spawned receiver
 * exit 0 on `EADDRINUSE`, same as it always has.
 *
 * Deliberate constraint, same reason as `otel-receiver.js`: **Node built-ins only** (`http`, `net`,
 * `child_process`) — no `require` of any other hook module, and no logging of its own. Callers log
 * the outcome using their own conventions (`hookLog` on the hook side, `console.*` on the installer
 * side).
 */

const http = require('http');
const net = require('net');
const { spawnSync } = require('child_process');

// Mirrors `SHUTDOWN_PATH` in otel-receiver.js — the two files cannot require each other.
const SHUTDOWN_PATH = '/artisyn/shutdown';

// The receiver is a loopback process on the same machine, same reasoning as
// `REGISTER_TIMEOUT_MS` in otel-register.js: anything slower than this is a hung socket, not a
// slow answer.
const SHUTDOWN_TIMEOUT_MS = 2000;

// How long to give the receiver to exit on its own after a `200` shutdown response before this
// module resorts to a force-kill.
const SHUTDOWN_GRACE_MS = 3000;

// How often the grace period polls the port with a bare TCP connect.
const GRACE_POLL_INTERVAL_MS = 300;

// How long a bare TCP connect probe waits before treating the port as unreachable.
const PORT_PROBE_TIMEOUT_MS = 1000;

// The final confirmation poll, after a possible force-kill: how many attempts, how far apart.
const PORT_FREE_RETRIES = 3;
const PORT_FREE_RETRY_INTERVAL_MS = 3000;

// `netstat`/`lsof`/`taskkill` are OS commands, not this project's code — a hung or missing one
// must not be able to stall the caller past a few seconds.
const FIND_PID_TIMEOUT_MS = 3000;
const KILL_TIMEOUT_MS = 3000;

/**
 * Parse `netstat -ano -p tcp` output for the PID of the process `LISTENING` on `port`. Each
 * matching line looks like (columns are whitespace-separated, count and order vary slightly across
 * Windows versions):
 *
 *   TCP    0.0.0.0:25317          0.0.0.0:0              LISTENING       12345
 *
 * so the check is deliberately loose: the second column ends `:<port>` and the second-to-last
 * column is `LISTENING`, then the *last* column is taken as the PID — never a fixed column index.
 * @param {string} output
 * @param {number} port
 * @returns {number|null}
 */
function parseNetstatPid(output, port) {
  if (typeof output !== 'string' || !output) return null;
  const suffix = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/^TCP/i.test(line)) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const localAddr = cols[1];
    const state = cols[cols.length - 2];
    if (!localAddr || !localAddr.endsWith(suffix)) continue;
    if (state !== 'LISTENING') continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/**
 * Parse `lsof -i tcp:<port> -sTCP:LISTEN -t` output — one PID per line, first line wins.
 * @param {string} output
 * @returns {number|null}
 */
function parseLsofPid(output) {
  if (typeof output !== 'string' || !output) return null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const pid = Number(line);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  return null;
}

/**
 * Resolve the OS PID of whatever process is `LISTENING` on `port`, on the current platform.
 * Windows runs `netstat -ano -p tcp`; POSIX runs `lsof -i tcp:<port> -sTCP:LISTEN -t`. Both are
 * synchronous (`spawnSync`, `windowsHide: true`, a short timeout) and return `null` on *any*
 * spawn or parse failure — a missing `netstat`/`lsof`, a timeout, unexpected output — never throw.
 * A `null` here falls through to "nothing to kill, proceed anyway", per the fail-open convention.
 * @param {number} port
 * @returns {number|null}
 */
function findPidOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
        windowsHide: true,
        timeout: FIND_PID_TIMEOUT_MS,
        encoding: 'utf8',
      });
      if (!result || result.error || typeof result.stdout !== 'string') return null;
      return parseNetstatPid(result.stdout, port);
    }

    const result = spawnSync('lsof', ['-i', `tcp:${port}`, '-sTCP:LISTEN', '-t'], {
      windowsHide: true,
      timeout: FIND_PID_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (!result || result.error || typeof result.stdout !== 'string') return null;
    return parseLsofPid(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Force-kill a resolved PID, best-effort and never throwing. Not routed through
 * `process-marker.js`'s `killProcessTree`, since that helper requires a `ChildProcess` handle this
 * caller does not have — this is an unrelated OS process discovered by port, not a child of this
 * process. POSIX sends `SIGKILL` directly; Windows shells out to `taskkill /PID <pid> /F`.
 * @param {number} pid
 */
function killPid(pid) {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/F'], {
        windowsHide: true,
        timeout: KILL_TIMEOUT_MS,
      });
    } catch {
      // taskkill unavailable or refused — the final confirm poll below is what actually decides
      // the outcome, not this call.
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already exited
  }
}

/**
 * `POST /artisyn/shutdown {gitRoot, sessionId}` at `port`. Never throws and never rejects: any
 * transport failure (connection refused, timeout, a malformed response) resolves `null`, which the
 * caller treats identically to a `404`/`409` — "nothing to wait for".
 * @param {number} port
 * @param {string} gitRoot
 * @param {string|null} [sessionId]
 * @param {number} [timeoutMs]
 * @returns {Promise<{status: number, ok: boolean}|null>}
 */
function postShutdown(port, gitRoot, sessionId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let body;
    let req;
    try {
      body = Buffer.from(JSON.stringify({ gitRoot, sessionId: sessionId || null }), 'utf8');
      req = http.request({
        host: '127.0.0.1',
        port,
        path: SHUTDOWN_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      }, (res) => {
        // The body carries nothing this caller needs (unlike `/artisyn/register`'s
        // `receiverVersion`) — only the status matters, but the response still has to be drained
        // so the socket can be reused/closed cleanly.
        res.on('data', () => {});
        res.on('error', () => finish(null));
        res.on('end', () => {
          finish({ status: res.statusCode, ok: res.statusCode === 200 });
        });
      });
    } catch {
      finish(null);
      return;
    }

    req.on('error', () => finish(null));

    req.setTimeout(timeoutMs || SHUTDOWN_TIMEOUT_MS, () => {
      try {
        req.destroy();
      } catch {
        // already destroyed
      }
      finish(null);
    });

    req.end(body);
  });
}

/**
 * Whether something is accepting TCP connections on `127.0.0.1:<port>` right now — a bare connect
 * probe, immediately destroyed, never a real request. Resolves `true` on a successful connect
 * (there IS a listener), `false` on `'error'` (e.g. `ECONNREFUSED` — nothing listening) or on a
 * connect timeout. Never rejects.
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function isPortOccupied(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let socket;
    try {
      socket = net.connect({ host: '127.0.0.1', port });
    } catch {
      finish(false);
      return;
    }

    socket.setTimeout(timeoutMs || PORT_PROBE_TIMEOUT_MS);

    socket.on('connect', () => {
      finish(true);
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    });

    socket.on('timeout', () => {
      finish(false);
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    });

    socket.on('error', () => {
      finish(false);
    });
  });
}

/**
 * `await`-able sleep, used only by the polling loops below.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The full shutdown-call → grace-period poll → force-kill → confirm-poll sequence shared by the
 * hook's restart trigger and the installer's stop-before-install step.
 *
 * `opts` overrides the timing constants (`shutdownTimeoutMs`, `graceMs`, `gracePollIntervalMs`,
 * `portFreeRetries`, `portFreeRetryIntervalMs`) — the module-level defaults exported below — purely
 * so tests can shrink a sequence that otherwise takes up to ~12s in its worst case (grace period
 * plus 3 confirm retries) down to milliseconds.
 *
 * Never throws. Always resolves `{stopped: boolean, reason?: string}` — `stopped: true` only when
 * the final confirmation poll observes the port free; every other outcome, including the shutdown
 * call itself failing or being refused, resolves `stopped: false` with a `reason` describing why,
 * and the caller is expected to proceed regardless (an occupied port simply makes a freshly spawned
 * receiver exit 0 on `EADDRINUSE`).
 * @param {number} port
 * @param {string} gitRoot
 * @param {string|null} [sessionId]
 * @param {{shutdownTimeoutMs?: number, graceMs?: number, gracePollIntervalMs?: number,
 *   portFreeRetries?: number, portFreeRetryIntervalMs?: number}} [opts]
 * @returns {Promise<{stopped: boolean, reason?: string}>}
 */
async function stopReceiverAndWait(port, gitRoot, sessionId, opts) {
  const o = Object.assign({
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    graceMs: SHUTDOWN_GRACE_MS,
    gracePollIntervalMs: GRACE_POLL_INTERVAL_MS,
    portFreeRetries: PORT_FREE_RETRIES,
    portFreeRetryIntervalMs: PORT_FREE_RETRY_INTERVAL_MS,
  }, opts || {});

  const response = await postShutdown(port, gitRoot, sessionId, o.shutdownTimeoutMs);
  if (!response) return { stopped: false, reason: 'transport-error' };
  if (response.status === 409) return { stopped: false, reason: 'owner-mismatch' };
  // Any non-200/409 status (404 from a pre-shutdown-route receiver, 400, 5xx, …) is treated
  // identically to a transport failure — fail open, nothing further attempted.
  if (response.status !== 200) return { stopped: false, reason: `unexpected-status-${response.status}` };

  const graceDeadline = Date.now() + o.graceMs;
  let occupied = await isPortOccupied(port);
  while (occupied && Date.now() < graceDeadline) {
    await sleep(o.gracePollIntervalMs);
    occupied = await isPortOccupied(port);
  }

  if (occupied) {
    const pid = findPidOnPort(port);
    if (pid !== null) killPid(pid);
  }

  for (let attempt = 0; attempt < o.portFreeRetries; attempt++) {
    if (!(await isPortOccupied(port))) return { stopped: true };
    if (attempt < o.portFreeRetries - 1) await sleep(o.portFreeRetryIntervalMs);
  }

  return { stopped: false, reason: 'port-still-occupied' };
}

module.exports = {
  stopReceiverAndWait,
  findPidOnPort,
  postShutdown,
  isPortOccupied,
  parseNetstatPid,
  parseLsofPid,
  SHUTDOWN_PATH,
  SHUTDOWN_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
  GRACE_POLL_INTERVAL_MS,
  PORT_FREE_RETRIES,
  PORT_FREE_RETRY_INTERVAL_MS,
};
