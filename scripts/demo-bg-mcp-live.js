#!/usr/bin/env node
// Demo: one REAL Claude Code session with MCP calls moved to the background, recorded by the real
// Log Hub hook — nothing is synthesized, nothing is killed.
//
// It runs `claude -p` in this repository's root, so this repo's own hook plugin (enabled in
// .claude/settings.json, configured by .artisyn/config/log-hub*.json) records and uploads the
// session to whatever Log Hub that config points at, under this repository. The MCP server is the
// PoC mock (docs/pocs/2026-11-09-1318-mcp-mock-old-new-cc/mock-mcp.cjs): fast_echo, fast_fail at
// once, slow_echo and slow_fail after --slow-ms. Claude Code moves the slow calls to the
// background after 2 s; the session stays open until their notifications have arrived and the
// model has answered them, then stdin is closed and Claude Code exits on its own.
//
//   node scripts/demo-bg-mcp-live.js [--slow-ms 20000] [--model haiku]
//
// Needs `claude` >= 2.1.212 on PATH and a login. Costs a few cents (haiku), plus whatever the
// hook's post-turn evaluator spends. Stream output goes to tmp/demo-bg-mcp-live/<time>.stdout.jsonl.
// Unlike the other scripts here it is async: stdin must stay open while the background tasks run.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const pocDir = path.join(repoRoot, 'docs', 'pocs', '2026-11-09-1318-mcp-mock-old-new-cc');
const workDir = path.join(repoRoot, 'tmp', 'demo-bg-mcp-live');

function parseArgs(argv) {
  const out = { slowMs: 20000, model: 'haiku' };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
      return argv[++i];
    };
    if (argv[i] === '--slow-ms') out.slowMs = Number(next());
    else if (argv[i] === '--model') out.model = next();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!Number.isFinite(out.slowMs) || out.slowMs < 3000) throw new Error('--slow-ms must be >= 3000');
  return out;
}

const PROMPT = '[demo] background MCP calls, live session. '
  + 'Call these MCP tools one after another, each exactly once, in this order: '
  + 'mcp__mock__fast_echo with text "a", mcp__mock__fast_fail with text "b", '
  + 'mcp__mock__slow_echo with text "c", mcp__mock__slow_fail with text "d". '
  + 'Do not retry a failed call and do not use any other tool. If a call is moved to the '
  + "background, go on with the next one. When all four are issued, if any is still in the "
  + "background say 'waiting' and end your turn; when a completion notification arrives, reply "
  + 'with one short line quoting its result.';

function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(workDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(workDir, `${stamp}.stdout.jsonl`);
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', opts.model,
    '--settings', path.join(pocDir, 'claude-config', 'settings.json'),
    '--mcp-config', path.join(pocDir, 'mcp.json'),
    '--strict-mcp-config',
    '--max-budget-usd', '1',
  ];
  const env = {
    ...process.env,
    POC_DIR: pocDir.split(path.sep).join('/'),
    CLAUDE_AUTO_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '2000',
    MOCK_SLOW_MS: String(opts.slowMs),
  };
  // A session started from inside Claude Code must not look nested.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const started = Date.now();
  // On Windows `claude` is a .cmd shim, which needs a shell; pass one quoted command line so
  // Node does not concatenate unescaped args (DEP0190). No argument holds a double quote.
  const child = process.platform === 'win32'
    ? spawn(['claude', ...args].map((a) => `"${a}"`).join(' '), { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'inherit'], shell: true })
    : spawn('claude', args, { cwd: repoRoot, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const out = fs.openSync(outFile, 'w');
  let buf = '';
  let results = 0;
  let sessionId = null;
  let closed = false;
  const closeStdin = (why) => {
    if (closed) return;
    closed = true;
    process.stderr.write(`closing stdin (${why}) after ${Math.round((Date.now() - started) / 1000)} s\n`);
    child.stdin.end();
  };
  // One result for the first turn, then one per notification turn (two slow calls). Notifications
  // that land together make one turn, so a quiet period after the slow calls also ends the session.
  let quiet = null;
  child.stdout.on('data', (d) => {
    fs.writeSync(out, d);
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'system' && ev.subtype === 'init' && !sessionId) {
        sessionId = ev.session_id;
        process.stderr.write(`session ${sessionId} (claude ${ev.claude_code_version || '?'})\n`);
      }
      if (ev.type === 'result') {
        results++;
        process.stderr.write(`turn ${results} done: ${String(ev.result || '').slice(0, 160)}\n`);
        if (results >= 3) closeStdin('both notifications answered');
        clearTimeout(quiet);
        if (Date.now() - started > opts.slowMs) quiet = setTimeout(() => closeStdin('no more turns'), 15000);
      }
    }
  });
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n`);
  const cap = setTimeout(() => closeStdin('time cap'), opts.slowMs + 120000);
  child.on('close', (code) => {
    clearTimeout(cap);
    clearTimeout(quiet);
    fs.closeSync(out);
    process.stderr.write(`claude exited ${code} after ${Math.round((Date.now() - started) / 1000)} s; stream: ${path.relative(repoRoot, outFile)}\n`);
    process.stdout.write(`${sessionId || ''}\n`);
    process.exit(code === 0 ? 0 : 1);
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`demo-bg-mcp-live: ${err.message}\n`);
  process.exit(1);
}
