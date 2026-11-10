#!/usr/bin/env node
'use strict';
// PoC statusline command: reads the JSON Claude Code passes on stdin, appends a
// snapshot of rate_limits (5-hour / 7-day quota) to out/quota.jsonl next to this
// script, and prints a one-line status. Never fails: a status line must not break.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'out');

function fmtWindow(w) {
  if (!w || typeof w.used_percentage !== 'number') return 'n/a';
  const resets = typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : '?';
  return `${w.used_percentage}% (resets ${resets})`;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { /* keep empty */ }
  const rl = input.rate_limits || null;
  const snap = {
    capturedAt: new Date().toISOString(),
    sessionId: input.session_id || null,
    version: input.version || null,
    model: input.model && input.model.id,
    hasRateLimits: !!rl,
    rateLimits: rl,
    topLevelKeys: Object.keys(input),
  };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(path.join(OUT_DIR, 'quota.jsonl'), JSON.stringify(snap) + '\n');
  } catch { /* ignore */ }
  process.stdout.write(rl
    ? `5h ${fmtWindow(rl.five_hour)} | 7d ${fmtWindow(rl.seven_day)}`
    : 'quota: no rate_limits yet');
});
