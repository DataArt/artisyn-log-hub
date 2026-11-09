#!/usr/bin/env node
// Finds the first Claude Code release whose binary contains the background-MCP hand-off text
// ("moved to the background as task"), by binary search over the published
// @anthropic-ai/claude-code-win32-x64 versions. Each probed tarball is downloaded with `npm pack`
// into raw/bisect/ (ignored), scanned and deleted.
// Usage: node bisect.cjs [from-version]   (default: the first 2.1.x release)
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const PKG = '@anthropic-ai/claude-code-win32-x64';
const NEEDLE = Buffer.from('moved to the background as task');
const dir = path.join(__dirname, 'raw', 'bisect');
fs.mkdirSync(dir, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args) => execFileSync(npm, args, { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 });

const all = JSON.parse(run(['view', PKG, 'versions', '--json']))
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v !== '0.0.0');
const from = process.argv[2];
const versions = from ? all.slice(Math.max(0, all.indexOf(from))) : all;

const cache = new Map();
function has(v) {
  if (cache.has(v)) return cache.get(v);
  const file = run(['pack', `${PKG}@${v}`, '--silent']).trim().split('\n').pop();
  const full = path.join(dir, file);
  const found = zlib.gunzipSync(fs.readFileSync(full)).includes(NEEDLE);
  fs.rmSync(full);
  process.stdout.write(`${v}: ${found ? 'has' : 'no'} hand-off text\n`);
  cache.set(v, found);
  return found;
}

let lo = 0;
let hi = versions.length - 1;
if (!has(versions[hi])) { process.stdout.write('newest version has no hand-off text\n'); process.exit(0); }
if (has(versions[lo])) { process.stdout.write(`already in ${versions[lo]}\n`); process.exit(0); }
while (hi - lo > 1) {
  const mid = (lo + hi) >> 1;
  if (has(versions[mid])) hi = mid; else lo = mid;
}
process.stdout.write(`first with hand-off text: ${versions[hi]} (last without: ${versions[lo]})\n`);
