#!/usr/bin/env node
// Runs `claude -p` once per variant with a SessionEnd probe hook and reports how long the hook
// lived. Output goes to runs/<variant>/ (gitignored). The claude working dir is a fresh empty
// folder under the OS temp dir, so no project or user settings/hooks interfere; it is left in
// place (not deleted) — remove it yourself if you want.
// Usage: node run.cjs [variant...]   (default: all variants)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const POC_DIR = __dirname;
const PROBE = path.join(POC_DIR, 'probe-hook.cjs');
const RUNS = path.join(POC_DIR, 'runs');
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// sleepMs: how long the probe wants to run. timeoutSec: the hook's own `timeout` field.
const VARIANTS = {
  'A-default': { sleepMs: 10000 },
  'B-hook-timeout-10s': { sleepMs: 5000, timeoutSec: 10 },
  'C-env-4000': { sleepMs: 10000, env: { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '4000' } },
  'D-plugin-hook-timeout-10s': { sleepMs: 5000, timeoutSec: 10, plugin: true },
};

function sleep(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

function hookEntry(logFile, v) {
  const entry = { type: 'command', command: `node "${PROBE}" "${logFile}" ${v.sleepMs}` };
  if (v.timeoutSec) entry.timeout = v.timeoutSec;
  return { SessionEnd: [{ hooks: [entry] }] };
}

function prepare(name, v) {
  const dir = path.join(RUNS, name);
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'ticks.log');
  fs.writeFileSync(logFile, '');
  const args = ['-p', 'Reply with exactly: OK', '--model', 'haiku', '--setting-sources', 'local'];
  if (v.plugin) {
    const pluginDir = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'poc-sessionend', version: '0.0.1' }, null, 2));
    fs.writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: hookEntry(logFile, v) }, null, 2));
    args.push('--plugin-dir', pluginDir);
  } else {
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: hookEntry(logFile, v) }, null, 2));
    args.push('--settings', settingsFile);
  }
  return { dir, logFile, args };
}

function summarize(logFile) {
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const start = lines.find((l) => l.ev === 'start') || null;
  const last = lines.length ? lines[lines.length - 1] : null;
  return {
    hookStarted: Boolean(start),
    reason: start ? start.reason : null,
    envSeenByHook: start ? start.envTimeout : null,
    hookLivedMs: last ? last.t : null,
    hookFinished: lines.some((l) => l.ev === 'done'),
  };
}

try {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VARIANTS);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-sessionend-'));
  const results = [];
  for (const name of names) {
    const v = VARIANTS[name];
    if (!v) throw new Error(`unknown variant ${name}`);
    const { dir, logFile, args } = prepare(name, v);
    const t0 = Date.now();
    const r = spawnSync('claude', args, {
      cwd: workDir,
      env: { ...process.env, ...(v.env || {}) },
      encoding: 'utf8',
      timeout: 180000,
    });
    const claudeMs = Date.now() - t0;
    fs.writeFileSync(path.join(dir, 'claude.out'), r.stdout || '');
    fs.writeFileSync(path.join(dir, 'claude.err'), r.stderr || '');
    // Give a hook that was not killed time to finish before reading its log.
    sleep(v.sleepMs + 2000);
    results.push({
      variant: name,
      probeWantedMs: v.sleepMs,
      claudeExit: r.status,
      claudeWallMs: claudeMs,
      claudeStderr: (r.stderr || '').trim().slice(0, 300),
      ...summarize(logFile),
    });
  }
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`run.cjs error: ${err.message}\n`);
  process.exit(1);
}
