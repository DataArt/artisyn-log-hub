// Runs INSIDE a node:<ver> container. /repo is the repo mounted read-only.
// Installs the packed installer into a temp git project, then feeds sample
// payloads to every hook command from the installed hooks.json. No Log Hub
// server is reachable (server-url points at a closed port).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); };

const work = fs.mkdtempSync('/tmp/poc-');
const proj = path.join(work, 'proj');
fs.mkdirSync(proj);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });

console.log(`node ${process.version}`);

// 1. install the packed installer globally
fs.copyFileSync('/repo/server/src/public/static/artisyn-hooks-installer.tgz', path.join(work, 'i.tgz'));
let r = sh('npm', ['install', '-g', '--no-audit', '--no-fund', path.join(work, 'i.tgz')]);
record('npm install -g installer tgz', r.status === 0, (r.stderr || '').trim().split('\n').filter(l => /EBADENGINE|ERR/.test(l)).join(' | '));

// 2. run installer non-interactively in a temp git repo
execFileSync('git', ['init', '-q', proj]);
r = sh('artisyn-hooks', ['install', '--server-url', 'http://127.0.0.1:9', '--api-key', 'poc-key', '--otel-traces=no', '--otel-existing=keep'],
  { cwd: proj, input: 'y\n', env: { ...process.env, CI: '1' } });
const out = (r.stdout + r.stderr).trim();
record('artisyn-hooks install', r.status === 0, `exit=${r.status} ${/Error|TypeError|SyntaxError/.test(out) ? out.split('\n').filter(l => /Error/.test(l)).slice(0, 3).join(' | ') : ''}`);

// 3. syntax-check every installed script
const pluginRoot = path.join(proj, '.artisyn/marketplace/plugins/log-hub-hooks');
const scripts = fs.existsSync(path.join(pluginRoot, 'scripts')) ? fs.readdirSync(path.join(pluginRoot, 'scripts')).filter(f => f.endsWith('.js')) : [];
const bad = scripts.filter(f => sh(process.execPath, ['--check', path.join(pluginRoot, 'scripts', f)]).status !== 0);
record(`node --check ${scripts.length} installed scripts`, scripts.length > 0 && bad.length === 0, bad.join(','));

// 4. run every hook command with a sample payload
const hooks = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks/hooks.json'), 'utf8')).hooks;
const base = { session_id: 'poc-session-0001', transcript_path: path.join(work, 't.jsonl'), cwd: proj };
fs.writeFileSync(base.transcript_path, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: base.session_id }) + '\n');
const payloads = {
  SessionStart: { source: 'startup' },
  UserPromptSubmit: { prompt: 'hello' },
  PreToolUse: { tool_name: 'PowerShell', tool_input: { command: 'Get-Date' }, tool_use_id: 'tu1' },
  PostToolUse: { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a', stderr: '' }, tool_use_id: 'tu2' },
  PostToolUseFailure: { tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1', tool_use_id: 'tu3' },
  Stop: { stop_hook_active: false },
  SubagentStop: { stop_hook_active: false },
  SessionEnd: { reason: 'other' },
};
for (const [event, groups] of Object.entries(hooks)) {
  for (const g of groups) for (const h of g.hooks) {
    const args = (h.args || []).map(a => a.replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
    const input = JSON.stringify({ ...base, hook_event_name: event, ...(payloads[event] || {}) });
    const t0 = Date.now();
    const p = sh(h.command, args, { cwd: proj, input, env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: proj }, timeout: 60000 });
    const err = (p.stderr || '').split('\n').find(l => /(TypeError|ReferenceError|SyntaxError|is not a function|is not defined|ERR_)/.test(l)) || '';
    record(`${event} -> ${path.basename(args[0] || h.command)}`, p.status === 0 && !err, `exit=${p.status} ${Date.now() - t0}ms ${err}`);
  }
}

// 5. hook log scan for thrown errors (wait for detached background workers first)
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
const logs = [];
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(log|ndjson|jsonl)$/.test(e.name)) logs.push(f); } };
for (const d of [proj, process.env.HOME]) { try { walk(d); } catch { /* absent */ } }
const hits = logs.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').filter(l => /(TypeError|ReferenceError|SyntaxError|is not a function)/.test(l)).map(l => `${path.basename(f)}: ${l.slice(0, 200)}`));
record(`hook logs free of TypeError/ReferenceError (${logs.length} files)`, hits.length === 0, hits.slice(0, 3).join(' | '));

const failed = results.filter(x => !x.ok).length;
console.log(`SUMMARY ${process.version}: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
