#!/usr/bin/env node
/**
 * Claude Code Telemetry Hook — UserPromptSubmit
 * Appends a JSON line to <telemetryDir>/<session_id>.jsonl on every prompt.
 *
 * Context logged per event: git branch, git username, context vars from
 * .artisyn/config/log-hub.json / log-hub.local.json.
 *
 * Telemetry directory resolution (first match wins):
 *   1. telemetryDir in .artisyn/config/log-hub.json / log-hub.local.json (relative to cwd or absolute)
 *   2. Default: <cwd>/.artisyn/ai_work_dir/telemetry
 *
 * Context key-value pairs (config "context" array):
 *   { "key": "<key>", "value": "<value>" } -> included as "context": { "<key>": "<value>" } in every event
 *   Example: { "key": "project", "value": "prj1" } -> "context": { "project": "prj1" }
 *
 * Configure in .claude/settings.json:
 *   UserPromptSubmit  ->  new prompt
 */

'use strict';
const fs = require('fs');
const path = require('path');

const {loadConfig, resolveTelemetryDir, getEnvContext, isCompactJson} = require('./env-context');
const {getGitContext} = require('./git-context');
const {writeTelemetry} = require('./write-telemetry');
const {hookLog} = require('./hook-log');
const {spawnDetachedHidden} = require('./spawn-hidden');
const {maybeReArmOtelSession} = require('./otel-register');
const {claimThrottleSlot} = require('./throttle-state');

const HOOK_FILE = 'telemetry-hook.js';

// Independent of the shared upload lock (Decision 19) — this throttles how often a prompt is
// even allowed to *attempt* spawning a prompt-triggered upload at all (Decision 20). The OTEL
// re-arm has its own window and state file, both owned by throttle-state.js and shared with the
// other two re-arm call sites, so it neither competes with nor is masked by this one.
const PROMPT_UPLOAD_THROTTLE_MS = 60000;
const THROTTLE_STATE_FILE = 'prompt-upload-throttle.json';

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

  const config = loadConfig(cwd);
  const telemetryDir = resolveTelemetryDir(cwd, config);
  const context = getEnvContext(config);
  const compact = isCompactJson(config);

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

  // Prompt-triggered background upload (Part B / Decision 17, 20). Fire-and-forget — this must
  // not block or be awaited, and the spawn below is the last thing this hook does before exit.
  if (config.sendLogsOnPromptEnabled) {
    // claimThrottleSlot records the attempt before returning true, so a burst of
    // near-simultaneous prompts can't all pass the check before any of them updates the file.
    if (!claimThrottleSlot(cwd, THROTTLE_STATE_FILE, PROMPT_UPLOAD_THROTTLE_MS)) {
      hookLog(HOOK_FILE, sessionId, 'result', 'skipped: prompt-upload throttled', cwd);
    } else {
      try {
        // cwd/sessionId are passed twice — as argv and as env vars — and prompt-upload-hook.js
        // reads argv first with an env fallback. The redundancy is kept for cross-version
        // compatibility: hooks <= 2.5.1 launched this script through a VBScript command line that
        // could carry env only (see spawn-hidden.js).
        spawnDetachedHidden(
          path.join(__dirname, 'prompt-upload-hook.js'),
          ['--cwd', cwd, '--sessionId', sessionId],
          {
            env: Object.assign({}, process.env, {
              ARTISYN_PROMPT_UPLOAD_CWD: cwd || '',
              ARTISYN_PROMPT_UPLOAD_SESSION_ID: sessionId || '',
            }),
            onError: (err) => hookLog(HOOK_FILE, sessionId, 'error',
              `launch of prompt-upload-hook.js failed (${err.message}) — this session's ` +
              'prompt-triggered upload did not run', cwd),
          },
        );
      } catch (err) {
        hookLog(HOOK_FILE, sessionId, 'error', `failed to spawn prompt-upload-hook.js: ${err.message}`, cwd);
      }
    }
  }

  // One of three re-arm call sites (the primary announce is lifecycle-hook.js's SessionStart).
  // This one covers the start of a new turn; lifecycle-hook.js covers the twelve events *during*
  // a turn and send-logs-hook.js covers its end. All three share one throttle window.
  maybeReArmOtelSession(config, sessionId, cwd, git, HOOK_FILE);

  // Deferred one tick so a spawn failure — surfaced asynchronously via the child's 'error' event —
  // still reaches the onError handlers above and lands in hook.log, instead of being lost to an
  // exit in the same tick. Negligible delay, not a violation of the "no added latency" requirement
  // (that's about avoiding seconds of network wait, not a sub-ms tick).
  setImmediate(() => process.exit(0));
} catch (err) {
  // best-effort: input may not be parsed yet, so cwd/sessionId may be unavailable
  hookLog(HOOK_FILE, null, 'error', err.message, null);
  process.stderr.write(`telemetry-hook error: ${err.message}\n`);
  process.exit(0); // non-blocking: never fail Claude Code
}
