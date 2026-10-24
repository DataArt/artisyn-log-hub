// Legacy hook (FR-13): build the previous-release installer from git (PREV_RELEASE_REF) under the
// run-dir — never inside the git root — and install it into the legacy repo.
// Every thrown error starts with `infra: <step>:` (steps: archive, npm ci, build, version, install).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PREV_HOOK_VERSION,
  PREV_INSTALLER_VERSION,
  PREV_RELEASE_REF,
  STAND_URL,
  TIMEOUTS,
} from './config.mjs';
import { run, runAsync } from './proc.mjs';
import { HOOKS_INSTALLED_MARKER, readServerUrl } from './hooks.mjs';
import { redactOneLiner } from './browser.mjs';

export const PREV_INSTALLER_TGZ = 'artisyn-hooks-installer.tgz';
export const PREV_INSTALLER_VERSION_FILE = 'installer-version.json';
const PREV_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const ARCHIVE_NAME = '_prev-src.tar';

/** The old installer tarball produced by buildPrevInstaller. */
export function prevInstallerTgz(runPaths) {
  return path.join(runPaths.prevHookDir, PREV_INSTALLER_TGZ);
}

/** The step log of buildPrevInstaller. */
export function prevHookBuildLog(runPaths) {
  return path.join(runPaths.stateDir, 'prev-hook-build.log');
}

function infraError(step, err) {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`infra: ${step}: ${msg}`);
}

function tail(text, n = 20) {
  return String(text || '').trim().split(/\r?\n/).slice(-n).join('\n');
}

function makeLogger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `prev-hook build: ref ${PREV_RELEASE_REF}, started ${new Date().toISOString()}\n`);
  return (step, lines) => {
    fs.appendFileSync(file, [`===== ${step} =====`, ...lines, ''].join('\n'));
  };
}

/** Runs one sync step, logging command, duration and output; throws `infra: <step>: …`. */
function syncStep(log, step, cmd, args, opts) {
  const started = Date.now();
  const header = [`command: ${[cmd, ...args].join(' ')}`, `cwd: ${opts.cwd}`];
  try {
    const res = run(cmd, args, opts);
    log(step, [...header, `exit: 0`, `duration: ${Date.now() - started}ms`, tail(res.stdout), tail(res.stderr)]);
    return res;
  } catch (err) {
    log(step, [...header, `FAILED after ${Date.now() - started}ms`, err.message, tail(err.stdout), tail(err.stderr)]);
    throw infraError(step, err);
  }
}

/** Runs one async step (shell command string), logging it; throws `infra: <step>: …` unless exit 0. */
async function asyncStep(log, step, command, opts) {
  const started = Date.now();
  const header = [`command: ${command}`, `cwd: ${opts.cwd}`];
  let res;
  try {
    res = await runAsync(command, [], { ...opts, shell: true });
  } catch (err) {
    log(step, [...header, `FAILED to spawn: ${err.message}`]);
    throw infraError(step, err);
  }
  const status = res.timedOut ? `timed out after ${Math.round(opts.timeoutMs / 1000)}s` : `exit: ${res.exitCode}`;
  log(step, [...header, status, `duration: ${Date.now() - started}ms`, '--- stdout ---', tail(res.stdout, 40), '--- stderr ---', tail(res.stderr, 40)]);
  if (res.timedOut || res.exitCode !== 0) {
    throw infraError(step, `${command} ${status}${res.stderr ? `:\n${tail(res.stderr)}` : ''}`);
  }
  return res;
}

/**
 * Builds the previous-release installer (Design Decision 16):
 *   1. archive  — `git -C <gitRoot> archive --format=tar <ref>` into a tar file, extracted under
 *                 `_prev-src` (tar runs with cwd there and a relative archive path, so no drive
 *                 letter ever reaches tar);
 *   2. npm ci   — `npm ci --ignore-scripts --no-audit --no-fund` in `_prev-src`;
 *   3. build    — `node scripts/build-hooks-installer.js --static-dir <_prev-hook>`;
 *   4. version  — `_prev-hook/installer-version.json` version === PREV_HOOK_VERSION and
 *                 `git show <ref>:artisyn-hooks-installer/package.json` version === PREV_INSTALLER_VERSION.
 * Every command runs with a cwd under the run-dir. Steps are logged to `_state/prev-hook-build.log`.
 * Returns { tgz, hookVersion, installerVersion, logFile }.
 */
export async function buildPrevInstaller(runPaths, { ref = PREV_RELEASE_REF } = {}) {
  const logFile = prevHookBuildLog(runPaths);
  const log = makeLogger(logFile);
  const srcDir = runPaths.prevSrcDir;
  const hookDir = runPaths.prevHookDir;
  const tarFile = path.join(runPaths.runDir, ARCHIVE_NAME);

  // 1. archive
  try {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.mkdirSync(srcDir, { recursive: true });
  } catch (err) {
    throw infraError('archive', err);
  }
  syncStep(log, 'archive', 'git', ['-C', runPaths.gitRoot, 'archive', '--format=tar', '-o', tarFile, ref], {
    cwd: runPaths.runDir,
    timeoutMs: PREV_BUILD_TIMEOUT_MS,
  });
  syncStep(log, 'archive', 'tar', ['-x', '-f', `../${ARCHIVE_NAME}`], { cwd: srcDir, timeoutMs: PREV_BUILD_TIMEOUT_MS });
  fs.rmSync(tarFile, { force: true });

  // 2. npm ci
  await asyncStep(log, 'npm ci', 'npm ci --ignore-scripts --no-audit --no-fund', {
    cwd: srcDir,
    timeoutMs: PREV_BUILD_TIMEOUT_MS,
  });

  // 3. build
  await asyncStep(log, 'build', `node scripts/build-hooks-installer.js --static-dir "${hookDir}"`, {
    cwd: srcDir,
    timeoutMs: PREV_BUILD_TIMEOUT_MS,
  });
  const tgz = prevInstallerTgz(runPaths);
  if (!fs.existsSync(tgz)) {
    log('build', [`missing ${tgz}`]);
    throw infraError('build', `${tgz} was not produced`);
  }

  // 4. version
  let hookVersion;
  let installerVersion;
  try {
    hookVersion = JSON.parse(fs.readFileSync(path.join(hookDir, PREV_INSTALLER_VERSION_FILE), 'utf8')).version;
  } catch (err) {
    log('version', [`cannot read ${PREV_INSTALLER_VERSION_FILE}: ${err.message}`]);
    throw infraError('version', err);
  }
  const pkg = syncStep(log, 'version', 'git', ['-C', runPaths.gitRoot, 'show', `${ref}:artisyn-hooks-installer/package.json`], {
    cwd: runPaths.runDir,
  });
  try {
    installerVersion = JSON.parse(pkg.stdout).version;
  } catch (err) {
    throw infraError('version', `artisyn-hooks-installer/package.json at ${ref} is not JSON: ${err.message}`);
  }
  log('version', [`hook ${hookVersion}`, `installer ${installerVersion}`]);
  if (hookVersion !== PREV_HOOK_VERSION) {
    throw infraError('version', `${PREV_INSTALLER_VERSION_FILE} version is ${JSON.stringify(hookVersion)}, expected "${PREV_HOOK_VERSION}"`);
  }
  if (installerVersion !== PREV_INSTALLER_VERSION) {
    throw infraError('version', `installer package version is ${JSON.stringify(installerVersion)}, expected "${PREV_INSTALLER_VERSION}"`);
  }
  return { tgz, hookVersion, installerVersion, logFile };
}

/**
 * Installs the old tarball into `repoDir`: `npx --yes "<file: URL>" install --server-url
 * STAND_URL --api-key <key>` (`shell: true`, stdin closed). A file: URL is used because npx hangs
 * on a bare Windows path and resolves a relative one against the npm workspace root.
 * Success needs exit 0, "Hooks installed" in the output and the merged config serverUrl ===
 * STAND_URL; anything else throws `infra: install: …`.
 * opts: { logFile, timeoutMs }. Returns { exitCode, serverUrl }.
 */
export async function installPrevHook(repoDir, tgz, apiKey, env, opts = {}) {
  const { logFile = null, timeoutMs = TIMEOUTS.installerMs } = opts;
  const command = `npx --yes "${pathToFileURL(tgz).href}" install --server-url ${STAND_URL} --api-key ${apiKey}`;
  const started = Date.now();
  let res;
  try {
    res = await runAsync(command, [], { cwd: repoDir, env, shell: true, timeoutMs });
  } catch (err) {
    throw infraError('install', err);
  }
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(
      logFile,
      [
        `command: ${redactOneLiner(command)}`,
        `cwd: ${repoDir}`,
        `exit: ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}`,
        `duration: ${Math.round((Date.now() - started) / 1000)}s`,
        '===== stdout =====',
        res.stdout || '',
        '===== stderr =====',
        res.stderr || '',
      ].join('\n'),
    );
  }
  const repo = path.basename(repoDir);
  const where = logFile ? ` (see ${logFile})` : '';
  if (res.timedOut) throw infraError('install', `${repo} timed out after ${Math.round(timeoutMs / 1000)}s${where}`);
  if (res.exitCode !== 0) throw infraError('install', `${repo} exited with ${res.exitCode}${where}`);
  if (!output.includes(HOOKS_INSTALLED_MARKER)) {
    throw infraError('install', `${repo}: output has no "${HOOKS_INSTALLED_MARKER}"${where}`);
  }
  const serverUrl = readServerUrl(repoDir);
  if (serverUrl !== STAND_URL) {
    throw infraError('install', `${repo}: merged serverUrl is ${JSON.stringify(serverUrl)}, expected "${STAND_URL}"${where}`);
  }
  return { exitCode: res.exitCode, serverUrl };
}
