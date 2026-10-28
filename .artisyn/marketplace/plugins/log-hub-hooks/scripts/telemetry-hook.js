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
const toolWrapConfig = require('./tool-wrap-config');
const {
  CONFIG_REFRESH_THROTTLE_FILE,
  CONFIG_REFRESH_THROTTLE_MS,
  CONFIG_FETCH_TIMEOUT_MS_DEFAULT,
  PROMPT_CONFIG_REFRESH_TIMEOUT_MS,
} = require('./tool-wrap-names');

const HOOK_FILE = 'telemetry-hook.js';

// `--self-check`: the installer's post-install load check — every require above has run.
require('./hook-log').exitIfSelfCheck(HOOK_FILE);

// Independent of the shared upload lock — this throttles how often a prompt is
// even allowed to *attempt* spawning a prompt-triggered upload at all. The OTEL
// re-arm has its own window and state file, both owned by throttle-state.js and shared with the
// other two re-arm call sites, so it neither competes with nor is masked by this one.
const PROMPT_UPLOAD_THROTTLE_MS = 60000;
const THROTTLE_STATE_FILE = 'prompt-upload-throttle.json';

/**
 * Throttled refresh of the CLI tool-wrap config (at most once a minute per project): fetch the
 * monitored-tools list, rewrite the local cache and this session's off/ and mode/ markers, so a
 * UI pause, a disabled tool or a capture change reaches the running session's shims without a
 * restart. A tool added mid-session has no shim and is wrapped only from the next session.
 *
 * Fail-open: skipped under the kill switches or without a server/API key, a failed fetch leaves
 * the cache and markers untouched, and nothing here can throw out of the hook.
 * @param {string|null} cwd
 * @param {string|null} sessionId
 * @param {Record<string, *>} config
 * @returns {Promise<void>}
 */
async function refreshToolWrapConfig(cwd, sessionId, config) {
  try {
    if (toolWrapConfig.isToolWrapDisabled(config)) return;
    if (!String(config.serverUrl || '').trim() || !String(config.apiKey || '').trim()) return;
    if (!claimThrottleSlot(cwd, CONFIG_REFRESH_THROTTLE_FILE, CONFIG_REFRESH_THROTTLE_MS)) return;
    // Capped below the configured timeout: the prompt hook must never hold Claude up on a slow
    // or hanging server (a miss just keeps the cache until the next refresh).
    const configured = config.toolWrapConfigTimeoutMs;
    const base = typeof configured === 'number' && configured > 0 ? configured : CONFIG_FETCH_TIMEOUT_MS_DEFAULT;
    const cfg = await toolWrapConfig.fetchToolWrapConfig(cwd, config, Math.min(base, PROMPT_CONFIG_REFRESH_TIMEOUT_MS));
    if (!cfg) {
      hookLog(HOOK_FILE, sessionId, 'result', 'tool-wrap config refresh: no config (kept cache)', cwd);
      return;
    }
    toolWrapConfig.writeCache(cwd, cfg);
    const sessionDir = toolWrapConfig.sessionDirPath(cwd, sessionId);
    const generated = sessionDir ? toolWrapConfig.listGeneratedTools(sessionDir) : [];
    if (sessionDir && generated.length > 0) {
      toolWrapConfig.writeSessionMarkers(sessionDir, cfg, generated);
    }
    hookLog(HOOK_FILE, sessionId, 'result',
      `tool-wrap config refreshed (${cfg.paused ? 'paused' : `${cfg.tools.length} tool(s)`})`, cwd);
  } catch (err) {
    hookLog(HOOK_FILE, sessionId, 'error', `tool-wrap config refresh failed: ${err && err.message}`, cwd);
  }
}

// Wrapped in an async IIFE (rather than a bare top-level body) so the re-arm call below can be
// `await`-ed before the trailing `process.exit(0)`, instead of racing it fire-and-forget. The
// `try/catch` below is unchanged in shape and still provides the non-blocking fallback exit.
(async () => {
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
      // `root`/`worktreeRoot` are additive: `repo` falls back to `git.root` only for a repo
      // with no remote, so the absolute repo root was previously invisible to the server whenever a
      // remote existed. Change surface strips it off the transcript's absolute `file_path`s to get a
      // repo-relative path; `worktreeRoot` differs from `root` only inside a linked worktree, where
      // it is the root this session's paths were actually written under.
      git: git ? {
        repo: git.remote || git.root,
        root: git.root,
        worktreeRoot: git.worktreeRoot,
        branch: git.branch,
        user: git.user,
      } : null,
      // Not a git checkout: send the working folder instead, so the server can still group the
      // session under a per-user local repository (D4.7). Only when `git` is null — a git repo is
      // identified by `git.repo` alone. Additive; older servers ignore the field.
      ...(!git && cwd ? { cwd } : {}),
    }, telemetryDir, { compact });

    hookLog(HOOK_FILE, sessionId, 'result', `telemetry written to ${telemetryDir}`, cwd);

    // Prompt-triggered background upload. Fire-and-forget — this must
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
    //
    // Awaited (not fire-and-forget) so a stale-version restart (otel-register.js) has a chance to
    // run to completion before this process exits — bounded ~2s on the fast path, several seconds
    // longer only when a restart actually fires.
    //
    // The tool-wrap config refresh runs alongside it, so its bounded fetch
    // (at most `PROMPT_CONFIG_REFRESH_TIMEOUT_MS`, once a minute) adds no latency on top.
    await Promise.all([
      maybeReArmOtelSession(config, sessionId, cwd, git, HOOK_FILE),
      refreshToolWrapConfig(cwd, sessionId, config),
    ]);

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
})();
