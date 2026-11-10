#!/usr/bin/env node
// Runs one headless Claude Code session against the mock MCP server and copies its transcript.
// Usage: node run.cjs <old|new> <full|cut> <scratch-cwd>
//   old  = cc/old (2.1.318, before background MCP), new = cc/new (2.1.319);
//   full = keep stdin open POC_HOLD_MS (default 45000) so background notifications arrive;
//   cut  = plain -p with slow tools taking 60 s. After POC_CUT_MS (default 15000), while the
//          background calls still run, the transcript is snapshotted as <ver>-live (what a
//          mid-session upload sees: no notification yet), then the process is killed and the
//          final transcript is <ver>-kill. A plain -p exit is not enough: -p waits for running
//          background tasks.
// The scratch cwd must already exist outside the repo (no project settings there). Only
// claude-config/settings.json and mcp.json are loaded; user hooks/plugins do not apply.
// Writes raw/<name>.stdout.jsonl, .stderr.log and .transcript.jsonl (raw/ is ignored), where
// <name> is <ver>-full, or <ver>-live and <ver>-kill for cut.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const [ver, mode, cwdArg] = process.argv.slice(2);
if (!['old', 'new'].includes(ver) || !['full', 'cut'].includes(mode) || !cwdArg) {
  process.stderr.write('usage: node run.cjs <old|new> <full|cut> <scratch-cwd>\n');
  process.exit(1);
}

const pocDir = __dirname;
const repoRoot = path.resolve(pocDir, '..', '..', '..');
const cwd = path.resolve(cwdArg);
const home = os.homedir();
const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
if (isInside(cwd, repoRoot) || isInside(repoRoot, cwd) || cwd === home
  || path.parse(cwd).root === cwd || !fs.existsSync(cwd)) {
  process.stderr.write('scratch cwd must be an existing folder outside the repo, not home or a drive root\n');
  process.exit(1);
}

const PROMPT = 'Call these MCP tools one after another, each exactly once, in this order: '
  + 'mcp__mock__fast_echo with text "a", mcp__mock__fast_fail with text "b", '
  + 'mcp__mock__slow_echo with text "c", mcp__mock__slow_fail with text "d". '
  + 'Do not retry a failed call and do not use any other tool. If a call is moved to the '
  + 'background, go on with the next one. When all four are issued, if any is still in the '
  + "background say 'waiting' and end your turn; when a completion notification arrives, reply "
  + 'with one short line quoting its result.';

const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
const exe = path.join(pocDir, 'cc', ver, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', binName);
// cut keeps stdin open past the kill, so the session stays alive (a plain -p ends the turn,
// closes the MCP connection and fails the tasks with "Connection closed").
const holdMs = mode === 'full' ? Number(process.env.POC_HOLD_MS || 45000) : 600000;
const args = [
  '-p',
  ...(holdMs ? ['--input-format', 'stream-json'] : [PROMPT]),
  '--model', 'haiku',
  '--setting-sources', 'project',
  '--settings', path.join(pocDir, 'claude-config', 'settings.json'),
  '--mcp-config', path.join(pocDir, 'mcp.json'),
  '--strict-mcp-config',
  '--output-format', 'stream-json',
  '--verbose',
  '--max-budget-usd', '0.5',
];
const env = {
  ...process.env,
  POC_DIR: pocDir.split(path.sep).join('/'),
  CLAUDE_AUTO_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: process.env.POC_BG_MS || '2000',
  MOCK_SLOW_MS: process.env.MOCK_SLOW_MS || (mode === 'cut' ? '60000' : '8000'),
};
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_ENTRYPOINT;

const rawDir = path.join(pocDir, 'raw');
fs.mkdirSync(rawDir, { recursive: true });
const tag = `${ver}-${mode}`;
const started = Date.now();
const child = spawn(exe, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });
if (holdMs) {
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n`);
  setTimeout(() => child.stdin.end(), holdMs);
} else {
  child.stdin.end();
}
// Copies the session's transcript (found by the stream-json init event's session_id) to
// raw/<name>.transcript.jsonl; returns the copied path or 'not found'.
function copyTranscript(name) {
  const init = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .find((e) => e && e.type === 'system' && e.subtype === 'init');
  const sessionId = init && init.session_id;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
  if (!sessionId || !fs.existsSync(projects)) return 'not found';
  for (const d of fs.readdirSync(projects)) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(rawDir, `${name}.transcript.jsonl`));
      return `raw/${name}.transcript.jsonl`;
    }
  }
  return 'not found';
}

// cut: first snapshot the live transcript (what a mid-session upload sees), then kill.
const killer = setTimeout(() => {
  if (mode === 'cut') process.stdout.write(`${ver}-live: snapshot=${copyTranscript(`${ver}-live`)}\n`);
  child.kill();
}, mode === 'cut' ? Number(process.env.POC_CUT_MS || 15000) : 300000);

child.on('close', (code) => {
  clearTimeout(killer);
  const name = mode === 'cut' ? `${ver}-kill` : tag;
  fs.writeFileSync(path.join(rawDir, `${name}.stdout.jsonl`), out);
  fs.writeFileSync(path.join(rawDir, `${name}.stderr.log`), err);
  process.stdout.write(`${name}: exit=${code} ${Math.round((Date.now() - started) / 1000)}s transcript=${copyTranscript(name)}\n`);
  process.exit(0); // the pending stdin-hold timer would keep the process alive
});
