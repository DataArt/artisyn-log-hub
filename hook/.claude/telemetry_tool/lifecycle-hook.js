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

const {loadConfig, resolveTelemetryDir, resolveOtelPort} = require('./env-context');
const {getGitContext} = require('./git-context');
const {writeTelemetry} = require('./write-telemetry');
const {hookLog} = require('./hook-log');
const {announceOtelSession, maybeReArmOtelSession} = require('./otel-register');
const {deriveEditResultCounts} = require('./edit-result-counts');
const {checkOtelEndpoints} = require('./otel-endpoint-check');

const HOOK_FILE = 'lifecycle-hook.js';

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

// Wrapped in an async IIFE (rather than a bare top-level body) so the SessionStart/re-arm call
// below can be `await`-ed before the trailing `process.exit(0)`, instead of racing it
// fire-and-forget. The `try/catch` below is unchanged in shape and still provides the
// non-blocking fallback exit.
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
      // The event carries the call's IDENTITY plus a small derived record — never the tool's own
      // output. There used to be a `tool_result` field here, built from `input.tool_result`; that
      // key has never existed on a Claude Code payload (the real one is `tool_response`), so the
      // field shipped as `""` on every event this hook has ever written. It is retired rather than
      // fixed to the real key: the payload holds file contents, patch text and command output, and
      // the change-surface metrics need four derived numbers, not the bytes.
      case 'PostToolUse':
        event.tool_name = input.tool_name || null;
        event.tool_input = input.tool_input || null;
        // Call identity. `tool_use_id` is what lets the server join this record to the transcript's
        // own record of the same call, so a call can never be credited twice from two sources.
        // `agent_id`/`agent_type` exist only on sub-agent calls — their absence on a root call is
        // normal attribution data ("this is the root session"), not a missing field.
        event.tool_use_id = input.tool_use_id || null;
        event.agent_id = input.agent_id || null;
        event.agent_type = input.agent_type || null;
        {
          // `null` for every non-edit tool and for an edit whose payload carries no countable diff;
          // the field is then simply absent and the call stays *uncovered* server-side rather than
          // being recorded as a zero-line change.
          const editResult = deriveEditResultCounts(input.tool_name, input.tool_response);
          if (editResult) event.edit_result = editResult;
        }
        break;

      case 'PostToolUseFailure':
        event.tool_name = input.tool_name || null;
        event.tool_input = input.tool_input || null;
        event.error = input.error || input.tool_result || '';
        // Call identity (hook 2.24.0+): lets the viewer join the failure to its exact tool call
        // instead of matching by name + input. `null` on Claude Code versions that do not send it.
        event.tool_use_id = input.tool_use_id || null;
        break;

      case 'PermissionRequest':
        // Claude Code sends no tool_use_id here, so the viewer joins requests by name + input.
        event.tool_name = input.tool_name || null;
        event.tool_input = input.tool_input || null;
        break;

      case 'PermissionDenied':
        // Fires only for auto-mode classifier denials. Hook 2.24.0+ also records the call
        // identity and the classifier's reason; both are `null` when Claude Code omits them.
        event.tool_name = input.tool_name || null;
        event.tool_input = input.tool_input || null;
        event.tool_use_id = input.tool_use_id || null;
        event.reason = input.reason || null;
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
      //
      // `root`/`worktreeRoot` are additive: `repo` collapses to `git.root` only when the
      // repo has no remote, so until now the absolute repo root was invisible to the server for
      // every repo that has one. Change surface needs it to turn a transcript's absolute
      // `file_path` into a repo-relative one; `worktreeRoot` differs only inside a linked worktree,
      // and is the root the session's own paths are actually written under.
      case 'SessionStart':
        event.git = git ? {
          repo: git.remote || git.root,
          root: git.root,
          worktreeRoot: git.worktreeRoot,
          branch: git.branch,
          user: git.user,
        } : null;
        // Not a git checkout: send the working folder instead, so the server can still group the
        // session under a per-user local repository (D4.7). Only when `git` is null — a git repo is
        // identified by `git.repo` alone. Additive; older servers ignore the field.
        if (!git && cwd) event.cwd = cwd;
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
    //
    // Awaited (not fire-and-forget) so a stale-version restart (otel-register.js) has a chance to
    // run to completion before this process exits — bounded ~2s on the fast path, several seconds
    // longer only when a restart actually fires. Still wrapped by the same try/catch as before
    // (announceOtelSession/maybeReArmOtelSession never throw themselves, but the await keeps this
    // hook's own failure handling identical either way).
    if (eventName === 'SessionStart' && config.otelEnabled) {
      await announceOtelSession(config, sessionId, cwd, git, HOOK_FILE, 'announced');

      // Once per session: warn when Claude Code's exporter does not point at the port the receiver
      // just got armed on — otherwise every OTEL record of the session is dropped silently. Shown to
      // the user via SessionStart's `systemMessage`; see otel-endpoint-check.js.
      const warning = checkOtelEndpoints(resolveOtelPort(config, process.env, cwd), cwd, sessionId);
      if (warning) fs.writeSync(1, JSON.stringify({systemMessage: warning}));
    } else if (eventName !== 'SessionStart') {
      await maybeReArmOtelSession(config, sessionId, cwd, git, HOOK_FILE);
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
})();
