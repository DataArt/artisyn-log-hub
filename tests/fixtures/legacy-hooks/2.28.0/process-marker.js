'use strict';
/**
 * Claude Code Hook helper — provenance markers for, and reliable reaping of, every child process
 * this hook spawns (not a hook entry point itself).
 *
 * Two related jobs, both about children we launch:
 *
 * 1. `buildProcessMarkerEnv()` stamps a child's environment with what it is, who launched it and
 *    when. This exists because hook-spawned children DO leak: an audit of this machine found six
 *    orphaned `cmd.exe /c mcp-server-postgres` wrappers up to five days old, with no way to tell
 *    which hook run, session or role each belonged to — the command line alone says
 *    "some MCP server", not "the upload run's per-file probe from session X at 14:38".
 *    Anything spawned here now carries that answer with it.
 *
 * 2. `killProcessTree()` is why there were six of them. On Windows, a child started with the
 *    `shell: true` option is a `cmd.exe` wrapper and the real program is its GRANDchild, so
 *    `child.kill()` reaps the wrapper and orphans the server, which then survives until reboot.
 *    Every place this hook kills a `shell: true` child must go through here instead.
 *
 * Note on reading the markers back: env vars are the right carrier (they are inherited by the whole
 * subtree, cost nothing, and never change a command line), but Windows does NOT expose another
 * process's environment through `Win32_Process` — only through the PEB. So on Windows these are
 * readable from inside the child (and by anything the child reports to, e.g. hook.log), and from
 * outside only with a PEB reader such as Sysinternals Process Explorer. On Linux/macOS
 * `/proc/<pid>/environ` and `ps eww` show them directly. The markers are therefore for attribution
 * and post-mortem, not a substitute for `killProcessTree()` actually working.
 */
const { spawnSync } = require('child_process');

/**
 * Shared prefix for every marker variable. Deliberately distinct from `ARTISYN_HOOK_SERVICE`
 * (`claude-invoke-async.js`), which is a re-entrancy GUARD whose value
 * changes behaviour — these are inert metadata and must never be branched on.
 */
const MARKER_PREFIX = 'ARTISYN_PROC_';

/**
 * Build the marker environment for a child process about to be spawned.
 *
 * Additive only: callers merge the result over `process.env`, so an older installed hook that
 * never sets these is indistinguishable from one where they are simply absent. Nothing in this
 * codebase reads them to make a decision (see MARKER_PREFIX), which is what keeps that true.
 *
 * @param {string} role - what the process IS, in `<kind>` or `<kind>:<detail>` form, e.g.
 *   `'mcp-probe:playwright'`, `'claude-invoke:haiku'`, `'otel-receiver'`. Free-form but keep it
 *   stable and greppable — this is the field a human scans first.
 * @param {{ sessionId?: string|null, hookFile?: string|null, hookVersion?: string|null }} [meta]
 * @returns {Record<string, string>} plain object, safe to `Object.assign` over `process.env`
 */
function buildProcessMarkerEnv(role, meta = {}) {
  const now = new Date();
  const env = {
    [`${MARKER_PREFIX}ROLE`]: String(role || 'unknown'),
    // Both forms on purpose: the ISO string is what a human reads out of a process listing, the
    // epoch is what a cleanup script does age arithmetic on without parsing dates.
    [`${MARKER_PREFIX}STARTED_AT`]: now.toISOString(),
    [`${MARKER_PREFIX}STARTED_EPOCH_MS`]: String(now.getTime()),
    // The spawning process, not the child: a leaked child's own PID is already visible in any
    // process listing, whereas the launcher it outlived is exactly what you cannot recover later.
    [`${MARKER_PREFIX}PARENT_PID`]: String(process.pid),
  };
  if (meta.hookFile) env[`${MARKER_PREFIX}PARENT_SCRIPT`] = String(meta.hookFile);
  if (meta.sessionId) env[`${MARKER_PREFIX}SESSION_ID`] = String(meta.sessionId);
  if (meta.hookVersion) env[`${MARKER_PREFIX}HOOK_VERSION`] = String(meta.hookVersion);
  return env;
}

/**
 * Kill a spawned child and everything below it, best-effort and never throwing.
 *
 * On Windows, `taskkill /T` walks the tree so a `shell: true` wrapper cannot orphan the program it
 * launched. It runs via `spawnSync` — synchronous on purpose, so the tree is provably gone before
 * the caller continues rather than racing a detached killer we would then have to trust — with
 * `windowsHide` for the same reason every other subprocess in this hook passes it (see
 * `spawn-hidden.js` and the `__tests__/no-visible-window.test.js` regression pin). The added
 * latency is one `taskkill` per probed server per RUN, not per uploaded file.
 *
 * Elsewhere `child.kill()` already reaches the real program, because there is no wrapper process
 * in between.
 *
 * @param {import('child_process').ChildProcess|null|undefined} child
 * @returns {void}
 */
function killProcessTree(child) {
  if (!child) return;
  const pid = child.pid;
  // `child.kill()` first in every case: on POSIX it is the whole fix, and on Windows it still
  // reaps the wrapper immediately even if the `taskkill` below cannot run for any reason.
  try {
    child.kill();
  } catch {
    // already exited
  }
  if (process.platform !== 'win32' || !pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5000,
    });
  } catch {
    // taskkill unavailable or refused — the tree may survive, but this is a cleanup path where
    // throwing would be strictly worse and the caller has already been settled.
  }
}

module.exports = { buildProcessMarkerEnv, killProcessTree, MARKER_PREFIX };
