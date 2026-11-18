#!/usr/bin/env node
// S-HOOK-10 in-container driver (tests/scenarios/helpers/docker-laptop.ts copies it to
// /laptop/run-event.cjs inside the "laptop" container). It plays Claude Code for one hook event:
// every command the installed plugin's `hooks/hooks.json` registers for the event runs in order,
// with `${CLAUDE_PLUGIN_ROOT}` resolved, the event JSON on stdin and the repo as cwd — and its wall
// time is measured here, inside the container, so `docker exec` overhead never counts.
//
// Request (stdin, JSON): { plugin, input, cut? }
//   - plugin: absolute plugin root inside the container;
//   - input:  the hook event JSON (`hook_event_name`, `session_id`, `cwd`, …);
//   - cut:    optional power cut { queueDir, file, timeoutMs }: while the hooks run (and after),
//             poll `queueDir` for a job claim (`*.claim`); on the first one write
//             { cutAt, claims, runs } to `file`, then SIGKILL every process of the container
//             (`kill(-1)`, which spares only PID 1 and this process) — the moment the power goes.
//             No claim within `timeoutMs` → `file` gets { cutAt: null } and nothing is killed.
//
// Answer (stdout, one JSON line): { runs: [{ script, code, ms, stdout, stderr }] }. After a cut the
// container stops, so the answer may never arrive; the caller reads `cut.file` after the restart.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLUGIN_ROOT_VAR = '$' + '{CLAUDE_PLUGIN_ROOT}';

function readRequest() {
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

function commandsFor(plugin, event) {
  const parsed = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8'));
  const groups = (parsed.hooks && parsed.hooks[event]) || [];
  const out = [];
  for (const group of groups) {
    for (const hook of group.hooks || []) {
      if (hook.type !== 'command') continue;
      out.push({ command: hook.command, args: (hook.args || []).map((a) => a.split(PLUGIN_ROOT_VAR).join(plugin)) });
    }
  }
  return out;
}

function runOne(command, args, input, plugin) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    const script = path.basename(args[0] || command);
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, {
        cwd: input.cwd,
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ script, code: null, ms: ms(), stdout, stderr: String(err && err.message) });
      return;
    }
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', (err) => resolve({ script, code: null, ms: ms(), stdout, stderr: String(err && err.message) }));
    child.on('close', (code) => resolve({ script, code, ms: ms(), stdout, stderr }));
    child.stdin.on('error', () => { /* the hook exited before reading stdin */ });
    child.stdin.end(JSON.stringify(input));
  });
}

function writeDurable(file, body) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function claimsIn(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.claim'));
  } catch {
    return [];
  }
}

/** Polls for a job claim and cuts the power on the first one (see the header). */
async function watchAndCut(cut, runs) {
  const deadline = Date.now() + (cut.timeoutMs || 20000);
  while (Date.now() < deadline) {
    const claims = claimsIn(cut.queueDir);
    if (claims.length > 0) {
      writeDurable(cut.file, JSON.stringify({ cutAt: new Date().toISOString(), claims, runs }) + '\n');
      process.kill(-1, 'SIGKILL');
      return true;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  writeDurable(cut.file, JSON.stringify({ cutAt: null, claims: [], runs }) + '\n');
  return false;
}

async function main() {
  const req = readRequest();
  const runs = [];
  const watcher = req.cut ? watchAndCut(req.cut, runs) : null;
  for (const { command, args } of commandsFor(req.plugin, req.input.hook_event_name)) {
    runs.push(await runOne(command, args, req.input, req.plugin));
  }
  if (watcher) await watcher;
  process.stdout.write(JSON.stringify({ runs }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`run-event failed: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
