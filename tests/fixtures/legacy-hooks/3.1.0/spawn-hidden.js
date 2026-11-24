'use strict';
/**
 * Detached background-process launch with no visible window, cross-platform.
 *
 * One `spawn(…, { detached: true, stdio: 'ignore', windowsHide: true })` is all this needs on every
 * platform. On Windows `detached: true` makes libuv pass `DETACHED_PROCESS`, so the child is given
 * no console *at all* — there is no window that could flash, with or without `windowsHide`
 * (measured on Windows 11 / Node 24 from a console-owning parent: no `conhost` child, no window).
 *
 * This file used to route the Windows launch through `wscript.exe //B //Nologo` running a
 * self-deleting VBScript written to the temp dir, to avoid a console flash. The flash was real, but
 * it came from one level further down: a console-less detached child that shells out to a
 * console-subsystem exe makes Windows allocate a *visible* console for that grandchild. Here that
 * is `prompt-upload-hook.js` reaching `git.exe` through git-context.js on every prompt past the
 * throttle. `WScript.Shell.Run(cmd, 0, False)` only masked it, by handing the child a
 * real-but-hidden console for its grandchildren to inherit.
 *
 * The fix belongs at those call sites instead: every `spawnSync`/`execFileSync` in this hook passes
 * `windowsHide: true`, pinned by a regression test in `__tests__/no-visible-window.test.js` (a
 * comment alone let this regress once already). With that in place the script-host detour buys
 * nothing, and a temp-dir script launched through `wscript.exe` tends to trip endpoint-security
 * heuristics, so it was removed in favour of a plain detached `node` child.
 */
const { spawn } = require('child_process');
const path = require('path');
const { buildProcessMarkerEnv } = require('./process-marker');

/**
 * Spawn `scriptPath` as a fully detached background Node process with no visible window.
 *
 * @param {string} scriptPath - absolute path to the Node script to run
 * @param {string[]} argv - args for the launched script. Callers also pass the same values via
 *   `opts.env`, and the launched scripts read argv first with an env fallback: that redundancy is
 *   kept for cross-version compatibility, since an installed hook <= 2.5.1 launching a newer
 *   receiver still goes through its own VBScript command line, which carried env only.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   role?: string,
 *   sessionId?: string|null,
 *   cwd?: string,
 *   onError?: (err: Error, info: {stage: 'direct'}) => void,
 *   onSpawned?: (info: {launcher: 'direct', pid: number|undefined}) => void,
 * }} [opts] - `onError` fires when the launch itself fails to start (not when the launched script
 *   later exits/crashes — this is a detached, unref()'d process, so nothing here ever observes
 *   that). `onSpawned` fires once the launch has been dispatched. The single-valued `stage`/
 *   `launcher` fields are what remains of a two-path launcher; they are kept so existing hook.log
 *   lines and their tests stay unchanged. `role`/`sessionId` only label the child (see
 *   `process-marker.js`); `role` defaults to the launched script's basename, which is already the
 *   most useful answer for every current call site. `cwd`, when set, is the child's working
 *   directory; omitted, the child inherits this process's cwd (the old behaviour). The OTEL
 *   receiver is launched with a neutral one (`os.tmpdir()`) so the long-lived detached process
 *   never holds a handle on the project folder, which on Windows blocks deleting or renaming it.
 */
function spawnDetachedHidden(scriptPath, argv, opts = {}) {
  // Stamped here rather than at the three call sites: a detached, unref()'d background process is
  // exactly the kind that outlives its launcher and turns up later as an unexplained orphan, and
  // doing it centrally means no call site can forget. Markers are inert metadata — nothing in this
  // codebase branches on them — so merging them over the caller's env cannot change behaviour.
  const markers = buildProcessMarkerEnv(
    opts.role || path.basename(scriptPath, '.js'),
    { sessionId: opts.sessionId || null, hookFile: 'spawn-hidden.js' },
  );
  // The options stay inline: `__tests__/no-visible-window.test.js` reads them off the call text.
  const child = spawn(process.execPath, [scriptPath, ...argv], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // Callers pass `Object.assign({}, process.env, {…})`, a superset of what would be inherited;
    // defaulting to `process.env` keeps today's behaviour for callers that pass no env at all.
    env: Object.assign({}, opts.env || process.env, markers),
    // Omitted unless set, so the child inherits this process's cwd exactly as before.
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  // Without this, a spawn failure (e.g. process.execPath unresolvable) is silent: nothing else
  // observes the child.
  child.on('error', (err) => {
    if (opts.onError) opts.onError(err, { stage: 'direct' });
  });
  if (opts.onSpawned) opts.onSpawned({ launcher: 'direct', pid: child.pid });
  child.unref();
}

module.exports = { spawnDetachedHidden };
