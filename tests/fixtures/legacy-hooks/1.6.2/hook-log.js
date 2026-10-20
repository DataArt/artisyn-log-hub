'use strict';
const fs = require('fs');
const path = require('path');
const { getGitRoot } = require('./git-context');

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
 * Append a structured log entry to <project-root>/.ai_work_dir/hook.log
 *
 * @param {string}      hookFile  - calling script filename (e.g. 'telemetry-hook.js')
 * @param {string|null} sessionId - Claude Code session_id (or null)
 * @param {'activate'|'result'|'error'} event - log event type
 * @param {string}      message   - human-readable message
 * @param {string|null} cwd       - project working directory (falls back to process.cwd())
 */
function hookLog(hookFile, sessionId, event, message, cwd) {
  try {
    const base = cwd || process.cwd();
    const dir = path.join(getGitRoot(base), '.ai_work_dir');
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, 'hook.log');
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
 * Read the last `n` non-empty lines of <gitRoot>/.ai_work_dir/hook.log.
 * @param {string|null} cwd - project working directory (falls back to process.cwd())
 * @param {number} n - max number of lines to return
 * @returns {string[]}
 */
function readLogTail(cwd, n) {
  try {
    const base = cwd || process.cwd();
    const logPath = path.join(getGitRoot(base), '.ai_work_dir', 'hook.log');
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

module.exports = { hookLog, getHookVersion, readLogTail };
