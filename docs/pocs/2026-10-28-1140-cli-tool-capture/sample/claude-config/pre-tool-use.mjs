// POC: wrap monitored CLI tools inside the PowerShell tool, which does not read CLAUDE_ENV_FILE.
// Prepends `function <tool> { node <shim> <tool> @args }` so the call goes through the shim.
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const TOOLS = ['ce'];
const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const cmd = input.tool_input?.command;
const dbg = path.resolve(process.cwd(), '..', 'out', 'envtest-hook.log');
if (input.tool_name !== 'PowerShell' || typeof cmd !== 'string') process.exit(0);
const used = TOOLS.filter((t) => new RegExp(`(^|[\\s;|&(])${t}(\\.exe)?(\\s|$)`).test(cmd));
if (!used.length) process.exit(0);

const shim = path.resolve(process.cwd(), '..', 'shim', 'tool-shim.mjs').replace(/'/g, "''");
const prefix = used.map((t) => `function ${t} { node '${shim}' ${t} @args }`).join('; ') + '; ';
appendFileSync(dbg, JSON.stringify({ pre: true, used, cmd }) + '\n');
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: prefix + cmd } },
}));
