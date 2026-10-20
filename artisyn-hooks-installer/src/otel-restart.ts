import * as http from 'http';
import * as net from 'net';
import { spawnSync } from 'child_process';

/**
 * Installer-side counterpart of the OTEL receiver's `POST /artisyn/shutdown` route — TypeScript
 * mirror of `hook/.claude/telemetry_tool/otel-restart.js`. That file's header doc comment explains
 * the full rationale; kept in sync here rather than duplicated at length. The two codebases cannot
 * `require`/`import` each other (separate npm packages, separate build pipelines), so this module
 * is written once here, matching the hook-side sequence exactly.
 *
 * `stopReceiverAndWait` (and `stopExistingReceiverIfRunning`, which wraps it for the installer's
 * stop-before-install step) never throws and never rejects: an occupied port simply makes a freshly
 * extracted/spawned receiver exit 0 on `EADDRINUSE`, same as always — so every outcome here is fail
 * open, and the caller always proceeds to whatever it was going to do next.
 *
 * Deliberate constraint, matching the hook-side module: Node built-ins only (`http`, `net`,
 * `child_process`) — no dependency on the rest of `install.ts`, even though some of its patterns
 * (e.g. `postLoopbackJson`) are similar in shape. Kept standalone.
 */

// Mirrors `SHUTDOWN_PATH` in otel-receiver.js — the two files cannot require each other.
export const SHUTDOWN_PATH = '/artisyn/shutdown';

// The receiver is a loopback process on the same machine — anything slower than this is a hung
// socket, not a slow answer.
export const SHUTDOWN_TIMEOUT_MS = 2000;

// How long to give the receiver to exit on its own after a `200` shutdown response before this
// module resorts to a force-kill.
export const SHUTDOWN_GRACE_MS = 3000;

// How often the grace period polls the port with a bare TCP connect.
export const GRACE_POLL_INTERVAL_MS = 300;

// How long a bare TCP connect probe waits before treating the port as unreachable.
export const PORT_PROBE_TIMEOUT_MS = 1000;

// The final confirmation poll, after a possible force-kill: how many attempts, how far apart.
export const PORT_FREE_RETRIES = 3;
export const PORT_FREE_RETRY_INTERVAL_MS = 3000;

// `netstat`/`lsof`/`taskkill` are OS commands, not this project's code — a hung or missing one
// must not be able to stall the caller past a few seconds.
const FIND_PID_TIMEOUT_MS = 3000;
const KILL_TIMEOUT_MS = 3000;

export type StopReceiverResult = { stopped: boolean; reason?: string };

export type StopReceiverOpts = {
  shutdownTimeoutMs?: number;
  graceMs?: number;
  gracePollIntervalMs?: number;
  portFreeRetries?: number;
  portFreeRetryIntervalMs?: number;
};

/**
 * Parse `netstat -ano -p tcp` output for the PID of the process `LISTENING` on `port`. See
 * otel-restart.js's `parseNetstatPid` doc comment for the exact column layout being matched —
 * deliberately loose (last column as PID, never a fixed index) since column count/order varies
 * slightly across Windows versions.
 */
export function parseNetstatPid(output: string, port: number): number | null {
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
 */
export function parseLsofPid(output: string): number | null {
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
 * synchronous (`spawnSync`, `windowsHide: true`, a short timeout) and return `null` on *any* spawn
 * or parse failure — a missing `netstat`/`lsof`, a timeout, unexpected output — never throw. A
 * `null` here falls through to "nothing to kill, proceed anyway", per the fail-open convention.
 */
export function findPidOnPort(port: number): number | null {
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
 * Force-kill a resolved PID, best-effort and never throwing. This is an unrelated OS process
 * discovered by port, not a child of this process — POSIX sends `SIGKILL` directly; Windows shells
 * out to `taskkill /PID <pid> /F`.
 */
function killPid(pid: number): void {
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
 */
export function postShutdown(
  port: number,
  gitRoot: string,
  sessionId?: string | null,
  timeoutMs?: number,
): Promise<{ status: number; ok: boolean } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { status: number; ok: boolean } | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let body: Buffer;
    let req: http.ClientRequest;
    try {
      body = Buffer.from(JSON.stringify({ gitRoot, sessionId: sessionId || null }), 'utf8');
      req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: SHUTDOWN_PATH,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length,
          },
        },
        (res) => {
          // The body carries nothing this caller needs — only the status matters, but the
          // response still has to be drained so the socket can be reused/closed cleanly.
          res.on('data', () => {});
          res.on('error', () => finish(null));
          res.on('end', () => {
            finish({ status: res.statusCode ?? 0, ok: res.statusCode === 200 });
          });
        },
      );
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
 */
export function isPortOccupied(port: number, timeoutMs?: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let socket: net.Socket;
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

/** `await`-able sleep, used only by the polling loops below. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The full shutdown-call → grace-period poll → force-kill → confirm-poll sequence shared by the
 * hook's restart trigger (via its own JS copy) and the installer's stop-before-install step.
 *
 * `opts` overrides the timing constants — the module-level defaults exported above — purely so
 * tests can shrink a sequence that otherwise takes up to ~12s in its worst case (grace period plus
 * 3 confirm retries) down to milliseconds.
 *
 * Never throws. Always resolves `{stopped: boolean, reason?: string}` — `stopped: true` only when
 * the final confirmation poll observes the port free; every other outcome, including the shutdown
 * call itself failing or being refused, resolves `stopped: false` with a `reason` describing why,
 * and the caller is expected to proceed regardless.
 */
export async function stopReceiverAndWait(
  port: number,
  gitRoot: string,
  sessionId?: string | null,
  opts?: StopReceiverOpts,
): Promise<StopReceiverResult> {
  const o = {
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    graceMs: SHUTDOWN_GRACE_MS,
    gracePollIntervalMs: GRACE_POLL_INTERVAL_MS,
    portFreeRetries: PORT_FREE_RETRIES,
    portFreeRetryIntervalMs: PORT_FREE_RETRY_INTERVAL_MS,
    ...(opts || {}),
  };

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

/**
 * Installer's stop-before-install step. Calls `stopReceiverAndWait` against
 * `127.0.0.1:<port>` with `{gitRoot: cwd}` — the installer has no `sessionId` to send, matching
 * `stopReceiverAndWait(port, cwd, undefined)`.
 *
 * Never blocks/fails the install on any outcome, mirroring `verifyInstalledReceiver`'s
 * required-but-non-fatal contract: `console.log` on a confirmed stop, silent on "no receiver was
 * running" (a transport error on the shutdown POST — the common case, since most installs/upgrades
 * run against a project with no receiver currently listening), and `console.warn` (never
 * `process.exit`) if the sequence completes without confirming the port free.
 */
export async function stopExistingReceiverIfRunning(port: number, cwd: string): Promise<void> {
  const result = await stopReceiverAndWait(port, cwd, undefined);
  if (result.stopped) {
    console.log(`Stopped existing OTEL receiver on port ${port}.`);
    return;
  }
  if (result.reason === 'transport-error') {
    // No receiver was running — silent, this is the common case.
    return;
  }
  console.warn(
    `Warning: could not confirm the existing OTEL receiver on port ${port} stopped ` +
    `(${result.reason ?? 'unknown reason'}) — proceeding with installation regardless.`,
  );
}
