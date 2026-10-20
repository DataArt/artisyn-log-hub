#!/usr/bin/env node
/**
 * Claude Code Hook — `Stop` trigger for the combined Turn-End Cost Advisor / AI Session
 * Attribution worker.
 *
 * This script does no network I/O itself — it only resolves context from the `Stop` payload and
 * the local git repo, then spawns `post-turn-analysis-worker.js` as a fully detached background
 * process (`spawn-hidden.js`'s existing `spawnDetachedHidden()`, the same pattern
 * `telemetry-hook.js` uses to launch `prompt-upload-hook.js`) and exits immediately — the
 * interactive turn is never blocked waiting on the worker's `claude -p` calls or its HTTP
 * round-trips.
 *
 * Reads its input from stdin, same convention as every other hook entry point in this codebase
 * (`send-logs-hook.js`, `lifecycle-hook.js`, …) — NOT from argv, which is reserved for the
 * detached worker this script spawns.
 *
 * Configure in .artisyn/config/log-hub.json / log-hub.local.json:
 *   serverUrl / apiKey  — read by the spawned worker, not by this trigger script itself.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const { getGitContext } = require('./git-context');
const { hookLog } = require('./hook-log');
const { spawnDetachedHidden } = require('./spawn-hidden');

const HOOK_FILE = 'post-turn-analysis-hook.js';

/**
 * Set by every `claude -p` this hook family spawns — `claude-invoke-async.js`'s `callLlmAsync()`
 * (advisor + attribution) — and inherited from there by that
 * child session's own hooks, since Claude Code runs hooks as child processes of the CLI.
 *
 * Its presence means this `Stop` ends a hook-service LLM call rather than a real user turn.
 * Evaluating those is not just wasteful, it is self-feeding: each evaluation spawns two `claude -p`
 * sessions, whose own `Stop` would spawn two more, and the server discards their submissions
 * anyway as not-yet-ingested.
 */
const HOOK_SERVICE_ENV_VAR = 'ARTISYN_HOOK_SERVICE';

function main() {
  let input = {};
  if (!process.stdin.isTTY) {
    try {
      const raw = fs.readFileSync(process.stdin.fd, 'utf8');
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      hookLog(HOOK_FILE, null, 'warn', `exit: stdin unreadable or not JSON: ${err.message}`, null);
      process.exit(0);
    }
  }

  const hookEvent = input.hook_event_name;
  if (hookEvent !== 'Stop') {
    hookLog(HOOK_FILE, input.session_id || null, 'result',
      `exit: hook_event_name=${hookEvent || '<none>'} is not Stop`, input.cwd || null);
    process.exit(0);
  }

  const cwd = input.cwd || null;
  const sessionId = input.session_id || null;
  const transcriptPath = input.transcript_path || null;

  const hookService = (process.env[HOOK_SERVICE_ENV_VAR] || '').trim();
  if (hookService) {
    hookLog(HOOK_FILE, sessionId, 'result',
      `exit: this session is a '${hookService}' hook-service LLM call, not a user turn`, cwd);
    process.exit(0);
  }

  if (!sessionId || !transcriptPath) {
    hookLog(HOOK_FILE, sessionId, 'result',
      'exit: missing session_id or transcript_path in Stop payload', cwd);
    process.exit(0);
  }

  const repoUrl = (getGitContext(cwd) || {}).remote;
  if (!repoUrl) {
    hookLog(HOOK_FILE, sessionId, 'result', 'exit: no git remote resolvable for this cwd', cwd);
    process.exit(0);
  }

  hookLog(HOOK_FILE, sessionId, 'activate', 'Stop event received — spawning post-turn-analysis-worker.js', cwd);

  try {
    spawnDetachedHidden(
      path.join(__dirname, 'post-turn-analysis-worker.js'),
      ['--cwd', cwd || '', '--sessionId', sessionId, '--transcriptPath', transcriptPath, '--repoUrl', repoUrl],
      {
        env: Object.assign({}, process.env, {
          ARTISYN_POST_TURN_ANALYSIS_CWD: cwd || '',
          ARTISYN_POST_TURN_ANALYSIS_SESSION_ID: sessionId || '',
          ARTISYN_POST_TURN_ANALYSIS_TRANSCRIPT_PATH: transcriptPath || '',
          ARTISYN_POST_TURN_ANALYSIS_REPO_URL: repoUrl || '',
        }),
        onError: (err) => hookLog(HOOK_FILE, sessionId, 'error',
          `launch of post-turn-analysis-worker.js failed (${err.message}) — this turn's ` +
          'advisor/attribution evaluation did not run', cwd),
      },
    );
  } catch (err) {
    hookLog(HOOK_FILE, sessionId, 'error', `failed to spawn post-turn-analysis-worker.js: ${err.message}`, cwd);
  }

  // Deferred one tick so a spawn failure — surfaced asynchronously via the child's 'error' event —
  // still reaches the onError handler above and lands in hook.log, instead of being lost to an
  // exit in the same tick (same reasoning as telemetry-hook.js's matching deferred exit).
  setImmediate(() => process.exit(0));
}

main();
