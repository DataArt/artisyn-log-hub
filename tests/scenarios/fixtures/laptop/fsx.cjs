#!/usr/bin/env node
// S-HOOK-10 in-container file helper (copied to /laptop/fsx.cjs by helpers/docker-laptop.ts), so
// the scenario never builds shell command lines:
//
//   node fsx.cjs put <file>     stdin → <file> (parent dirs created, tmp + rename, 0o600)
//   node fsx.cjs get <file>     <file> → stdout; exit 3 when it does not exist
//   node fsx.cjs upload <home>  one JSON line: the upload state under <home>/.artisyn/upload/ —
//                               { queue: [{name, job}], claims: [{name, claim}],
//                                 failed: [{name, record}], lock, heartbeat, now }
'use strict';
const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function put(file) {
  const body = fs.readFileSync(0);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function get(file) {
  if (!fs.existsSync(file)) process.exit(3);
  process.stdout.write(fs.readFileSync(file));
}

function upload(home) {
  const root = path.join(home, '.artisyn', 'upload');
  const queueDir = path.join(root, 'queue');
  const failedDir = path.join(root, 'failed');
  const names = listDir(queueDir).filter((n) => !n.startsWith('.'));
  const out = {
    queue: names.filter((n) => n.endsWith('.json')).map((name) => ({ name, job: readJson(path.join(queueDir, name)) })),
    claims: names.filter((n) => n.endsWith('.claim')).map((name) => ({ name, claim: readJson(path.join(queueDir, name)) })),
    failed: listDir(failedDir)
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .map((name) => ({ name, record: readJson(path.join(failedDir, name)) })),
    lock: readJson(path.join(root, 'uploader.lock')),
    heartbeat: readJson(path.join(root, 'heartbeat.json')),
    now: Date.now(),
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'put' && arg) put(arg);
else if (cmd === 'get' && arg) get(arg);
else if (cmd === 'upload' && arg) upload(arg);
else {
  process.stderr.write('usage: fsx.cjs put|get <file> | upload <home>\n');
  process.exit(2);
}
