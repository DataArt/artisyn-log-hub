// Shared helpers for the morning-check collectors: gh api calls, local state under tmp/morning-check/.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'DataArt/artisyn-log-hub';
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const STATE_DIR = path.join(ROOT, 'tmp', 'morning-check');

function gh(apiPath, extra) {
  const args = ['api', apiPath].concat(extra || []);
  return execFileSync('gh', args, {
    encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ghJson(apiPath, extra) {
  return JSON.parse(gh(apiPath, extra));
}

// Returns { ok: true, value } or { ok: false, error } so one 403 does not kill the whole report.
function tryGhJson(apiPath, extra) {
  try {
    return { ok: true, value: ghJson(apiPath, extra) };
  } catch (err) {
    const msg = String((err.stderr || err.message || '')).split(/\r?\n/).filter(Boolean).pop() || 'gh failed';
    return { ok: false, error: msg.slice(0, 200) };
  }
}

function readFileFromBranch(file, ref) {
  const res = ghJson(`repos/${REPO}/contents/${file}?ref=${ref}`);
  return Buffer.from(res.content, 'base64').toString('utf8');
}

function readState(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(STATE_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(name, data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

module.exports = { REPO, ROOT, STATE_DIR, gh, ghJson, tryGhJson, readFileFromBranch, readState, writeState, today, hasFlag };
