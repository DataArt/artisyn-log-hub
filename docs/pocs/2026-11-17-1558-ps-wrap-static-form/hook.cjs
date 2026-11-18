'use strict';
// PoC stand-in for hook/.claude/telemetry_tool/tool-wrap-powershell.js: emits a wrapped
// updatedInput without the config / preflight gating. argv[2] = variant (old | static),
// argv[3] = session dir for the call records.
const fs = require('fs');
const path = require('path');

const REPO_HOOK = path.resolve(__dirname, '../../../hook/.claude/telemetry_tool');
const {buildPowerShellPrefix} = require(path.join(REPO_HOOK, 'tool-wrap-powershell.js'));
const {toolMentionRegex} = require(path.join(REPO_HOOK, 'tool-wrap-names.js'));
const {buildStaticPrefix} = require('./static-prefix.cjs');

const TOOLS = ['curl', 'hostname', 'node'];
const variant = process.argv[2] || 'static';
const sessionDir = process.argv[3] || path.join(__dirname, 'sess');

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  // empty stdin
}
const command = input && input.tool_input && input.tool_input.command;
if (input.tool_name === 'PowerShell' && typeof command === 'string') {
  const mentioned = TOOLS.filter((t) => toolMentionRegex(t).test(command)).map((name) => ({name, capture: 'full'}));
  const opts = {sessionDir, sessionId: input.session_id || 'test', stderrRedirected: /(^|[^\w$])(2|\*)>/.test(command)};
  // `raw-<name>`: a hand-written probe prefix from probes/<name>.ps1 (one line), for any command.
  const prefix = variant.startsWith('raw-')
    ? fs.readFileSync(path.join(__dirname, 'probes', `${variant.slice(4)}.ps1`), 'utf8').trim() + ' '
    : mentioned.length === 0 ? ''
      : variant === 'old' ? buildPowerShellPrefix(mentioned, opts) : buildStaticPrefix(mentioned, opts);
  fs.mkdirSync(sessionDir, {recursive: true});
  fs.appendFileSync(path.join(sessionDir, 'hook-fired.log'),
    `${new Date().toISOString()} variant=${variant} permission_mode=${JSON.stringify(input.permission_mode)} keys=${Object.keys(input).join(',')} wraps=[${mentioned.map((t) => t.name).join(',')}] cmd=${command}\n`);
  if (prefix) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {hookEventName: 'PreToolUse', updatedInput: {...input.tool_input, command: prefix + command}},
    }));
  }
}
