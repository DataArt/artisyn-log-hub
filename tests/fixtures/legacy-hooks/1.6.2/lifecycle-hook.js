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
const path = require('path');

const {loadEnvWithLocal, resolveTelemetryDir} = require('./env-context');
const {writeTelemetry} = require('./write-telemetry');
const {hookLog} = require('./hook-log');

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

  const envVars = loadEnvWithLocal(path.join(__dirname, '.env'));
  const telemetryDir = resolveTelemetryDir(cwd, envVars);

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

    // SessionStart, SessionEnd, PostToolBatch, StopFailure: base event only
    default:
      break;
  }

  writeTelemetry(event, telemetryDir);

  hookLog(HOOK_FILE, sessionId, 'result', `${eventName} recorded to ${telemetryDir}`, cwd);
  process.exit(0);
} catch (err) {
  hookLog(HOOK_FILE, null, 'error', err.message, null);
  process.stderr.write(`lifecycle-hook error: ${err.message}\n`);
  process.exit(0); // non-blocking: never fail Claude Code
}
