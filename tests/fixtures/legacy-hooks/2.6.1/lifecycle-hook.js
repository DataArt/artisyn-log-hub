#!/usr/bin/env node
/**
 * Claude Code Lifecycle Hook — records artisyn telemetry events for:
 * PostToolUse, PostToolUseFailure, SessionStart, SessionEnd,
 * PermissionRequest, PermissionDenied, SubagentStart, SubagentStop,
 * PreCompact, PostCompact, PostToolBatch, StopFailure
 *
 * Writes one JSON line per event to <TELEMETRY_DIR>/<session_id>.jsonl
 * in the same file as the session's main telemetry (from telemetry-hook.js).
 */

'use strict';
const fs = require('fs');

const {loadConfig, resolveTelemetryDir} = require('./env-context');
const {getGitContext} = require('./git-context');
const {writeTelemetry} = require('./write-telemetry');
const {hookLog} = require('./hook-log');
const {announceOtelSession, maybeReArmOtelSession} = require('./otel-register');

const HOOK_FILE = 'lifecycle-hook.js';
const RESULT_TRUNCATE = 4000;

const HANDLED_EVENTS = new Set([
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'PermissionRequest',
  'PermissionDenied',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PostToolBatch',
  'StopFailure',
]);

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

  const eventName = input.hook_event_name;
  if (!HANDLED_EVENTS.has(eventName)) process.exit(0);

  const cwd = input.cwd || null;
  const sessionId = input.session_id || null;

  hookLog(HOOK_FILE, sessionId, 'activate', `${eventName} received`, cwd);

  const config = loadConfig(cwd);
  const telemetryDir = resolveTelemetryDir(cwd, config);

  // Hoisted out of the SessionStart case below so the otel announce can reuse it rather than
  // re-running four `git` subprocesses. Still only computed for SessionStart — no other event
  // needs it, and every other event must stay as cheap as it is today.
  const git = eventName === 'SessionStart' ? getGitContext(cwd) : null;

  const event = {
    type: 'artisyn',
    hook_event_name: eventName,
    timestamp: new Date().toISOString(),
    session_id: sessionId,
  };

  switch (eventName) {
    case 'PostToolUse':
      event.tool_name = input.tool_name || null;
      event.tool_input = input.tool_input || null;
      event.tool_result = String(input.tool_result ?? '').slice(0, RESULT_TRUNCATE);
      break;

    case 'PostToolUseFailure':
      event.tool_name = input.tool_name || null;
      event.tool_input = input.tool_input || null;
      event.error = input.error || input.tool_result || '';
      break;

    case 'PermissionRequest':
    case 'PermissionDenied':
      event.tool_name = input.tool_name || null;
      event.tool_input = input.tool_input || null;
      break;

    case 'SubagentStart':
      event.agent_id = input.agent_id || null;
      event.agent_type = input.agent_type || null;
      break;

    case 'SubagentStop':
      event.agent_id = input.agent_id || null;
      break;

    case 'PreCompact':
    case 'PostCompact':
      event.transcript_path = input.transcript_path || null;
      break;

    // Carry the git context on SessionStart so the server can link the session to its
    // repository from the very first uploaded chunk. Otherwise `git.repo` first appears on
    // `prompt_start` (telemetry-hook.js), and a session uploaded before its first prompt has
    // nothing to link against. Same shape as the prompt_start field; purely additive, so
    // servers that do not read it are unaffected.
    case 'SessionStart':
      event.git = git ? {repo: git.remote || git.root, branch: git.branch, user: git.user} : null;
      break;

    // SessionEnd, PostToolBatch, StopFailure: base event only
    default:
      break;
  }

  writeTelemetry(event, telemetryDir);

  hookLog(HOOK_FILE, sessionId, 'result', `${eventName} recorded to ${telemetryDir}`, cwd);

  // SessionStart is the primary spawn call site: `session.count`, `mcp_server_connection` and
  // `plugin_loaded` all fire before the first prompt, so a receiver armed only on the first
  // UserPromptSubmit would miss them. Unconditional per session (the receiver itself deduplicates
  // via EADDRINUSE) and gated only on the runtime switch.
  //
  // EVERY OTHER event this hook receives re-arms through the shared throttle. This hook is wired to
  // twelve events — PostToolUse, PostToolUseFailure, SessionEnd, PermissionRequest,
  // PermissionDenied, SubagentStart, SubagentStop, PreCompact, PostCompact, PostToolBatch,
  // StopFailure — and a working turn emits PostToolUse/PostToolBatch continuously. That matters
  // because the receiver's idle timeout used to be able to kill it mid-turn with nothing to revive
  // it: the only other re-arm is on UserPromptSubmit, and a long autonomous turn has no prompts (a
  // measured one ran 7 h 36 m on two), so its telemetry was lost for hours. Pinging at least once
  // per throttle window also keeps the receiver's idle timer from ever expiring mid-session, so
  // this prevents the death rather than only recovering from it. See maybeReArmOtelSession.
  if (eventName === 'SessionStart' && config.otelEnabled) {
    announceOtelSession(config, sessionId, cwd, git, HOOK_FILE, 'announced');
  } else if (eventName !== 'SessionStart') {
    maybeReArmOtelSession(config, sessionId, cwd, git, HOOK_FILE);
  }

  // Deferred one tick so a spawn failure — surfaced asynchronously via the child's 'error' event —
  // still reaches announceOtelSession's onError handler and lands in hook.log, instead of being
  // lost to an exit in the same tick. Matches telemetry-hook.js.
  setImmediate(() => process.exit(0));
} catch (err) {
  hookLog(HOOK_FILE, null, 'error', err.message, null);
  process.stderr.write(`lifecycle-hook error: ${err.message}\n`);
  process.exit(0); // non-blocking: never fail Claude Code
}
