#!/usr/bin/env node
// Claude Code command hook used for every hook event: appends the stdin JSON payload, with a
// receive timestamp, as one line to raw/hooks.jsonl. Prints nothing, exits 0, so it never
// changes a decision.
'use strict';

const fs = require('fs');
const path = require('path');

let raw = '';
try {
  raw = fs.readFileSync(process.stdin.fd, 'utf8');
} catch (e) {
  raw = '';
}
let payload;
try {
  payload = JSON.parse(raw);
} catch (e) {
  payload = { unparsed: raw };
}
const dir = path.join(__dirname, 'raw');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'hooks.jsonl'), `${JSON.stringify({ receivedAt: new Date().toISOString(), payload })}\n`);
process.exit(0);
