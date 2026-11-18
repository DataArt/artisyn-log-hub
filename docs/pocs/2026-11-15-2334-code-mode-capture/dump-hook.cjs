#!/usr/bin/env node
'use strict';

// PoC hook: appends every hook event payload to capture/hooks.jsonl, one JSON object per line:
//   { at: <ISO time>, payload: <the hook input as Claude Code sent it> }
// Fail-open: it never blocks a tool call and never writes to stdout.

const fs = require('fs');
const path = require('path');

try {
  const raw = fs.readFileSync(process.stdin.fd, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { unparsed: raw };
  }
  const dir = path.join(__dirname, 'capture');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'hooks.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), payload })}\n`, 'utf8');
  process.exit(0);
} catch (err) {
  process.stderr.write(`dump-hook error: ${err.message}\n`);
  process.exit(0);
}
