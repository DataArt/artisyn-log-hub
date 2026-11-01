'use strict';
const fs = require('fs');
const path = require('path');
const { getWorkDirPath, ensureWorkDir } = require('./git-context');

let _hookVersionCache;

/**
 * Read the installed hook version from version.json (cached after first read).
 * @returns {string|null}
 */
function getHookVersion() {
  if (_hookVersionCache !== undefined) return _hookVersionCache;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8');
    _hookVersionCache = JSON.parse(raw).version || null;
  } catch {
    _hookVersionCache = null;
  }
  return _hookVersionCache;
}

const MAX_LOG_SIZE = 100 * 1024; // 100 KB
const MAX_LOG_FILES = 3;         // hook.log + hook.log.1 + hook.log.2

function rotateLog(logPath) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_LOG_SIZE) return;
  } catch {
    return; // file doesn't exist yet, nothing to rotate
  }

  // Delete the oldest file if it would exceed the limit
  const oldest = `${logPath}.${MAX_LOG_FILES - 1}`;
  try { fs.unlinkSync(oldest); } catch { /* doesn't exist */ }

  // Shift: hook.log.1 → hook.log.2, hook.log → hook.log.1
  for (let i = MAX_LOG_FILES - 2; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    try { fs.renameSync(src, dst); } catch { /* doesn't exist */ }
  }

  try { fs.renameSync(logPath, `${logPath}.1`); } catch { /* ignore */ }
}

/**
 * Append a structured log entry to <project-root>/.artisyn/ai_work_dir/<logFileName> — the
 * generalized entry point both `hookLog()` (fixed at `'hook.log'`, kept for every pre-existing
 * caller's backward compatibility) and callers that want their own dedicated, independently
 * rotated log file (e.g. the post-turn-analysis worker's advisor/attribution branches) go
 * through. `rotateLog()` above is already keyed off whatever `logPath` it's given, so no rotation
 * logic changes — every named log file gets its own independent `<name>`/`<name>.1`/`<name>.2`
 * rotation.
 *
 * @param {string}      logFileName - file name under `.artisyn/ai_work_dir/`, e.g. `'hook.log'`
 * @param {string}      hookFile  - calling script filename (e.g. 'telemetry-hook.js')
 * @param {string|null} sessionId - Claude Code session_id (or null)
 * @param {'activate'|'result'|'error'|'fail'|'warn'} event - log event type ('warn' is used for
 *   recoverable config/data problems — e.g. an invalid config value falling back to its default —
 *   that should surface to the user without being treated as a hook failure)
 * @param {string}      message   - human-readable message
 * @param {string|null} cwd       - project working directory (falls back to process.cwd())
 */
function hookLogTo(logFileName, hookFile, sessionId, event, message, cwd) {
  try {
    const dir = ensureWorkDir(cwd);
    const logPath = path.join(dir, logFileName);
    rotateLog(logPath);
    const timestamp = new Date().toISOString();
    const sid = sessionId || '-';
    const hookVersion = getHookVersion();
    const versionTag = (event === 'activate' && hookVersion) ? ` [hook v${hookVersion}]` : '';
    const line = `${timestamp} [${hookFile}] [${sid}] [${event}] ${message}${versionTag}\n`;
    fs.appendFileSync(logPath, line);
  } catch {
    // logging must never cause hook failures
  }
}

/**
 * Append a structured log entry to <project-root>/.artisyn/ai_work_dir/hook.log — the original,
 * still-default entry point. Unchanged signature/behavior for every existing caller; equivalent
 * to `hookLogTo('hook.log', ...)`.
 *
 * @param {string}      hookFile  - calling script filename (e.g. 'telemetry-hook.js')
 * @param {string|null} sessionId - Claude Code session_id (or null)
 * @param {'activate'|'result'|'error'|'fail'|'warn'} event - log event type ('warn' is used for
 *   recoverable config/data problems — e.g. an invalid config value falling back to its default —
 *   that should surface to the user without being treated as a hook failure)
 * @param {string}      message   - human-readable message
 * @param {string|null} cwd       - project working directory (falls back to process.cwd())
 */
function hookLog(hookFile, sessionId, event, message, cwd) {
  hookLogTo('hook.log', hookFile, sessionId, event, message, cwd);
}

/**
 * Read the last `n` non-empty lines of <gitRoot>/.artisyn/ai_work_dir/<logFileName>.
 * @param {string|null} cwd - project working directory (falls back to process.cwd())
 * @param {number} n - max number of lines to return
 * @param {string} [logFileName] - defaults to `'hook.log'` for backward compatibility
 * @returns {string[]}
 */
function readLogTail(cwd, n, logFileName) {
  try {
    const logPath = path.join(getWorkDirPath(cwd), logFileName || 'hook.log');
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * `node <hook script> --self-check` — the installer's post-install load check. Called by each hook
 * entry script right after its top-level requires, so reaching it proves the script and its whole
 * module graph load with this `node` in this repo (e.g. not broken by the repo's package.json
 * `"type": "module"`). Prints one JSON line and exits 0 without reading stdin or touching a file.
 * A no-op without the flag.
 * @param {string} hookFile - the entry script's file name
 */
function exitIfSelfCheck(hookFile) {
  if (!process.argv.includes('--self-check')) return;
  process.stdout.write(
    JSON.stringify({ selfCheck: 'ok', script: hookFile, hookVersion: getHookVersion(), node: process.version }) + '\n',
  );
  process.exit(0);
}

module.exports = { hookLog, hookLogTo, getHookVersion, readLogTail, exitIfSelfCheck };
