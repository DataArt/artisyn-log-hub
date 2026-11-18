#!/usr/bin/env node
// SessionEnd probe hook: logs a tick every 100 ms to <logFile> until <sleepMs> passes,
// then logs "done". Where the ticks stop is how long Claude Code let the hook live.
// Usage (from a hook command): node probe-hook.cjs <logFile> <sleepMs>
'use strict';

const fs = require('fs');

const logFile = process.argv[2];
const sleepMs = Number(process.argv[3]) || 10000;
const t0 = Date.now();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function log(entry) {
  fs.appendFileSync(logFile, JSON.stringify({ t: Date.now() - t0, ...entry }) + '\n');
}

try {
  let payload = {};
  try {
    payload = JSON.parse(fs.readFileSync(process.stdin.fd, 'utf8'));
  } catch {
    // keep empty: stdin may be missing or malformed
  }
  log({
    ev: 'start',
    startedAt: new Date(t0).toISOString(),
    hookEvent: payload.hook_event_name,
    reason: payload.reason,
    envTimeout: process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS || null,
  });
  while (Date.now() - t0 < sleepMs) {
    Atomics.wait(sleeper, 0, 0, 100);
    log({ ev: 'tick' });
  }
  log({ ev: 'done' });
  process.exit(0);
} catch (err) {
  process.stderr.write(`probe-hook error: ${err.message}\n`);
  process.exit(0);
}
