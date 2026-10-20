#!/usr/bin/env node
/**
 * Claude Code Telemetry Hook — UserPromptSubmit
 * Appends a JSON line to <TELEMETRY_DIR>/<session_id>.jsonl on every prompt.
 *
 * Context logged per event: git branch, git username, CTX_ vars from .env
 *
 * Telemetry directory resolution (first match wins):
 *   1. TELEMETRY_DIR in .claude/telemetry_tool/.env (relative to cwd or absolute)
 *   2. Default: <cwd>/.ai_work_dir/telemetry
 *
 * Context key-value pairs (.env):
 *   CTX_<KEY>=<VALUE>  ->  included as "context": { "<key>": "<value>" } in every event
 *   Example: CTX_PROJECT=prj1  ->  "context": { "project": "prj1" }
 *
 * Configure in .claude/settings.json:
 *   UserPromptSubmit  ->  new prompt
 */

'use strict';
const fs = require('fs');
const path = require('path');

const {loadEnvWithLocal, resolveTelemetryDir, getEnvContext, isCompactJson} = require('./env-context');
const {getGitContext} = require('./git-context');
const {writeTelemetry} = require('./write-telemetry');
const {hookLog} = require('./hook-log');

const HOOK_FILE = 'telemetry-hook.js';

try {
  let input = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(process.stdin.fd, 'utf8');
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      // malformed or empty stdin
    }
  }

  if (input.hook_event_name !== 'UserPromptSubmit') process.exit(0);

  const cwd = input.cwd || null;
  const sessionId = input.session_id || null;

  hookLog(HOOK_FILE, sessionId, 'activate', 'UserPromptSubmit received', cwd);

  const envVars = loadEnvWithLocal(path.join(__dirname, '.env'));
  const telemetryDir = resolveTelemetryDir(cwd, envVars);
  const context = getEnvContext(envVars);
  const compact = isCompactJson(envVars);

  const git = getGitContext(cwd);
  writeTelemetry({
    event: 'prompt_start',
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    prompt: input.prompt || null,
    ...(context ? {context} : {}),
    git: git ? {repo: git.remote || git.root, branch: git.branch, user: git.user} : null,
  }, telemetryDir, compact);

  hookLog(HOOK_FILE, sessionId, 'result', `telemetry written to ${telemetryDir}`, cwd);
  process.exit(0);
} catch (err) {
  // best-effort: input may not be parsed yet, so cwd/sessionId may be unavailable
  hookLog(HOOK_FILE, null, 'error', err.message, null);
  process.stderr.write(`telemetry-hook error: ${err.message}\n`);
  process.exit(0); // non-blocking: never fail Claude Code
}
