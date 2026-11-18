// Runner for the REAL hook (not the stand-in hook.cjs): one `claude -p` run in a fresh scratch
// project whose SessionStart is `lifecycle-hook.js` and PreToolUse(PowerShell) is
// `tool-wrap-powershell.js` from this repo's hook/, with a pre-seeded tool-wrap config cache
// (curl, hostname), `otelEnabled: false` and no server URL / API key — nothing is uploaded.
//
//   node real-hook-run.mjs --ver 2.1.326 --mode default --allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)" --name r-default
//
// The scratch project lives in POC_WORK (default <os tmp>/lh-ps-wrap-poc), never in the repo; a
// project name that already exists is refused (nothing is ever deleted).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(here, '../../../hook/.claude/telemetry_tool').replace(/\\/g, '/');
const args = process.argv.slice(2);
const opt = {ver: '2.1.326', mode: 'default', allow: [], deny: [], name: 'real'};
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, '');
  if (k === 'allow' || k === 'deny') opt[k].push(args[i + 1]);
  else opt[k] = args[i + 1];
}

const work = process.env.POC_WORK || path.join(os.tmpdir(), 'lh-ps-wrap-poc');
const proj = path.join(work, `real-${opt.name}`);
if (fs.existsSync(proj)) throw new Error(`project exists already: ${proj}`);
fs.mkdirSync(path.join(proj, '.claude'), {recursive: true});
fs.mkdirSync(path.join(proj, '.artisyn', 'config'), {recursive: true});
fs.mkdirSync(path.join(proj, '.artisyn', 'ai_work_dir', 'tool-wrap'), {recursive: true});
fs.writeFileSync(path.join(proj, '.artisyn', 'config', 'log-hub.json'), JSON.stringify({otelEnabled: false}, null, 2));
fs.writeFileSync(path.join(proj, '.artisyn', 'ai_work_dir', 'tool-wrap', 'config-cache.json'), JSON.stringify({
  schemaVersion: 1, paused: false,
  tools: [{name: 'curl', capture: 'full'}, {name: 'hostname', capture: 'full'}],
}));
fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({
  hooks: {
    SessionStart: [{hooks: [{type: 'command', command: `node "${HOOK}/lifecycle-hook.js"`}]}],
    PreToolUse: [{matcher: 'PowerShell', hooks: [{type: 'command', command: `node "${HOOK}/tool-wrap-powershell.js"`}]}],
  },
}, null, 2));

let bin = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'share', 'claude', 'versions', opt.ver);
if (!fs.existsSync(bin) && fs.existsSync(`${bin}.exe`)) bin = `${bin}.exe`;
// Drop the parent Claude Code session's variables so the child is a session of its own.
const env = {...process.env};
for (const k of Object.keys(env)) {
  if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT|CLAUDE_CODE_(SESSION_ID|CHILD_SESSION|MESSAGING_.*|ENTRYPOINT|EXECPATH|SESSION_ATTENDED|ENABLE_TELEMETRY|ENHANCED_TELEMETRY_BETA))$/.test(k)) delete env[k];
}
env.CLAUDE_CODE_USE_POWERSHELL_TOOL = '1';
const cli = ['-p', fs.readFileSync(path.join(here, 'prompt.txt'), 'utf8'), '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku', '--permission-mode', opt.mode, '--setting-sources', 'project', '--strict-mcp-config'];
if (opt.allow.length) cli.push('--allowedTools', ...opt.allow);
if (opt.deny.length) cli.push('--disallowedTools', ...opt.deny);
const r = spawnSync(bin, cli, {cwd: proj, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000});
fs.mkdirSync(path.join(work, 'runs'), {recursive: true});
fs.writeFileSync(path.join(work, 'runs', `real-${opt.name}.jsonl`), r.stdout || '');

console.log(`== real-${opt.name} ver=${opt.ver} mode=${opt.mode} allow=${opt.allow.join(' ')} deny=${opt.deny.join(' ')}`);
if (r.error) console.log('SPAWN ERROR', r.error.message);
const uses = new Map();
for (const line of (r.stdout || '').split(/\r?\n/)) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  if (ev.type === 'system' && ev.subtype === 'init') console.log('INIT', ev.claude_code_version, ev.permissionMode);
  const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
  for (const c of content) {
    if (c.type === 'tool_use') uses.set(c.id, c.input && c.input.command);
    if (c.type === 'tool_result') {
      const text = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
      console.log(`CALL ${JSON.stringify(uses.get(c.tool_use_id))} error=${Boolean(c.is_error)} :: ${text.replace(/\s+/g, ' ').slice(0, 260)}`);
    }
  }
  if (ev.type === 'result') console.log(`DENIALS ${(ev.permission_denials || []).length} cost=${ev.total_cost_usd}`);
}
const twDir = path.join(proj, '.artisyn', 'ai_work_dir', 'tool-wrap');
for (const sid of fs.readdirSync(twDir).filter((n) => !n.endsWith('.json'))) {
  let calls = [];
  try {
    calls = fs.readdirSync(path.join(twDir, sid, 'calls')).filter((f) => f.endsWith('.jsonl'));
  } catch {
    // no calls dir
  }
  console.log(`SESSION ${sid}: ${calls.length} call record file(s)`);
  for (const f of calls) {
    const types = fs.readFileSync(path.join(twDir, sid, 'calls', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
    console.log(`  ${f}: ${types.join(',')}`);
  }
}
try {
  console.log('HOOK.LOG\n' + fs.readFileSync(path.join(proj, '.artisyn', 'ai_work_dir', 'hook.log'), 'utf8'));
} catch {
  console.log('no hook.log');
}
