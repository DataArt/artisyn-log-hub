// PoC runner: one `claude -p` run against a scratch project whose PreToolUse(PowerShell) hook is
// hook.cjs with the chosen variant; prints the PowerShell calls, their results and the denials.
//
//   node run.mjs --ver 2.1.326 --variant static --mode default --allow "PowerShell(curl.exe:*)" --allow "PowerShell(hostname)" --name s-default
//
// The scratch project lives in POC_WORK (default <os tmp>/lh-ps-wrap-poc), never in the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = {ver: '2.1.326', variant: 'static', mode: 'default', allow: [], deny: [], name: 'run', prompt: 'prompt.txt'};
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, '');
  if (k === 'allow' || k === 'deny') opt[k].push(args[i + 1]);
  else opt[k] = args[i + 1];
}

const work = process.env.POC_WORK || path.join(os.tmpdir(), 'lh-ps-wrap-poc');
const proj = path.join(work, `proj-${opt.name}`);
const sess = path.join(work, `sess-${opt.name}`);
fs.mkdirSync(path.join(proj, '.claude'), {recursive: true});
const hooks = opt.variant === 'none' ? {} : {
  PreToolUse: [{matcher: 'PowerShell', hooks: [{type: 'command',
    command: `node "${path.join(here, 'hook.cjs').replace(/\\/g, '/')}" ${opt.variant} "${sess.replace(/\\/g, '/')}"`}]}],
};
fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({hooks}, null, 2));

let bin = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'share', 'claude', 'versions', opt.ver);
if (process.platform === 'win32' && !fs.existsSync(bin) && fs.existsSync(`${bin}.exe`)) bin = `${bin}.exe`;
const cli = ['-p', fs.readFileSync(path.join(here, opt.prompt), 'utf8'), '--output-format', 'stream-json', '--verbose',
  '--model', 'haiku', '--permission-mode', opt.mode, '--setting-sources', 'project', '--strict-mcp-config'];
if (opt.allow.length) cli.push('--allowedTools', ...opt.allow);
if (opt.deny.length) cli.push('--disallowedTools', ...opt.deny);
const r = spawnSync(bin, cli, {cwd: proj, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000});
fs.mkdirSync(path.join(work, 'runs'), {recursive: true});
fs.writeFileSync(path.join(work, 'runs', `${opt.name}.jsonl`), r.stdout || '');
if (r.error) console.log('SPAWN ERROR', r.error.message);
if (r.stderr) console.log('STDERR', r.stderr.slice(0, 500));

console.log(`== ${opt.name} ver=${opt.ver} variant=${opt.variant} mode=${opt.mode} allow=${opt.allow.join(' ')} deny=${opt.deny.join(' ')}`);
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
let recs = [];
try {
  recs = fs.readdirSync(path.join(sess, 'calls')).filter((f) => f.endsWith('.jsonl'));
} catch {
  // no records
}
console.log(`RECORDS ${recs.length}`);
for (const f of recs) {
  const types = fs.readFileSync(path.join(sess, 'calls', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l).type);
  console.log(`  ${f}: ${types.join(',')}`);
}
