#!/usr/bin/env node
// Runs one headless Claude Code 2.1.319 session from the PoC-local install.
// Usage: node run-session.cjs <name> <cwd-outside-repo> "<prompt>" [extra claude args...]
// - cwd must be a scratch folder outside the repo, so no project hooks/settings apply;
// - only --settings claude-config/settings.json is loaded (--setting-sources project, and the
//   scratch folder has no project settings), so user-level hooks/plugins/OTEL env do not apply;
// - OTEL console exporter is enabled; stdout -> raw/<name>.stdout.jsonl, stderr -> raw/<name>.stderr.log.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [name, cwd, prompt, ...extra] = process.argv.slice(2);
if (!name || !cwd || !prompt) {
  process.stderr.write('usage: node run-session.cjs <name> <cwd> "<prompt>" [args...]\n');
  process.exit(1);
}
const pocDir = __dirname;
const repoRoot = path.resolve(pocDir, '..', '..', '..');
const absCwd = path.resolve(cwd);
if (absCwd === repoRoot || absCwd.startsWith(repoRoot + path.sep)) {
  process.stderr.write('cwd must be outside the repo\n');
  process.exit(1);
}
fs.mkdirSync(absCwd, { recursive: true });
const rawDir = path.join(pocDir, 'raw');
fs.mkdirSync(rawDir, { recursive: true });

const exe = path.join(pocDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin',
  process.platform === 'win32' ? 'claude.exe' : 'claude');
const args = [
  '-p', prompt,
  '--model', 'haiku',
  '--setting-sources', 'project',
  '--settings', path.join(pocDir, 'claude-config', 'settings.json'),
  '--mcp-config', path.join(pocDir, 'mcp.json'),
  '--strict-mcp-config',
  '--output-format', 'stream-json',
  '--verbose',
  '--max-budget-usd', '0.5',
  ...extra,
];
const env = {
  ...process.env,
  POC_DIR: pocDir.split(path.sep).join('/'),
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  // `console` is silently dropped by CC under --output-format stream-json, so logs go over
  // OTLP http/json to otlp-receiver.cjs (start it first: node otlp-receiver.cjs 4399).
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.POC_OTLP_ENDPOINT || 'http://127.0.0.1:4399',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_TRACES_EXPORTER: 'none',
  OTEL_LOG_TOOL_DETAILS: '1',
  OTEL_LOGS_EXPORT_INTERVAL: '1000',
};
for (const k of ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL']) delete env[k];
const started = new Date().toISOString();
// POC_STDIN_HOLD_MS=<ms>: send the prompt as a stream-json user message and keep stdin open that
// long, so a backgrounded task can finish and its notification can start a new turn before exit.
const holdMs = Number(process.env.POC_STDIN_HOLD_MS || 0);
let r;
if (holdMs > 0) {
  args.splice(0, 2, '-p', '--input-format', 'stream-json');
  const userMsg = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });
  // a tiny Node child writes the message and keeps the pipe open for holdMs; shell-free piping
  const feeder = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('child_process');
    const c = spawn(${JSON.stringify(exe)}, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(absCwd)}, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.stdin.write(${JSON.stringify(userMsg + '\n')});
    setTimeout(() => c.stdin.end(), ${holdMs});
    c.on('close', (code) => { process.stdout.write(JSON.stringify({ code, out, err })); });
  `], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
  let parsed = { code: null, out: '', err: feeder.stderr || '' };
  try { parsed = JSON.parse(feeder.stdout); } catch (e) { parsed.err += String(feeder.stdout); }
  r = { status: parsed.code, stdout: parsed.out, stderr: parsed.err, error: feeder.error };
} else {
  r = spawnSync(exe, args, { cwd: absCwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 });
}
fs.writeFileSync(path.join(rawDir, `${name}.stdout.jsonl`), r.stdout || '');
fs.writeFileSync(path.join(rawDir, `${name}.stderr.log`), r.stderr || '');
fs.appendFileSync(path.join(rawDir, 'runs.log'), `${started} ${name} exit=${r.status} err=${r.error ? r.error.message : ''}\n`);
process.stdout.write(`exit=${r.status} stdout=${(r.stdout || '').length}B stderr=${(r.stderr || '').length}B\n`);
process.exit(0);
