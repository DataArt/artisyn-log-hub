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
 * nothing, and it cost a lot: dropping a self-deleting `.vbs` into `%LOCALAPPDATA%\Temp` and
 * launching it via `wscript.exe` matches commodity-loader behavior on four independent indicators
 * and is flagged as malware by corporate EDR. See T-92.
 */
const { spawn } = require('child_process');

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
 *   onError?: (err: Error, info: {stage: 'direct'}) => void,
 *   onSpawned?: (info: {launcher: 'direct', pid: number|undefined}) => void,
 * }} [opts] - `onError` fires when the launch itself fails to start (not when the launched script
 *   later exits/crashes — this is a detached, unref()'d process, so nothing here ever observes
 *   that). `onSpawned` fires once the launch has been dispatched. The single-valued `stage`/
 *   `launcher` fields are what remains of a two-path launcher; they are kept so existing hook.log
 *   lines and their tests stay unchanged.
 */
function spawnDetachedHidden(scriptPath, argv, opts = {}) {
  const child = spawn(process.execPath, [scriptPath, ...argv], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // Callers pass `Object.assign({}, process.env, {…})`, a superset of what would be inherited;
    // defaulting to `process.env` keeps today's behaviour for callers that pass no env at all.
    env: opts.env || process.env,
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
