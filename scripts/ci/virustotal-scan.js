#!/usr/bin/env node
'use strict';

// VirusTotal scan of the installer tarballs (FR-29 - FR-31) for the
// virustotal CI workflow. Design Decision 21 of
// docs/tasks/todo/2026-10-23-ci-cd-scans/impl-plan.md.
//
// For each tarball:
//   1. GET /files/<sha256>; upload (POST /files) only when VirusTotal answers 404.
//   2. After an upload, poll /analyses/<id> every 16 s (at most 40 times) until
//      data.attributes.status === 'completed', then re-read GET /files/<sha256>.
//   3. Verdict from data.attributes.last_analysis_stats (malicious, suspicious);
//      engine names are the keys of last_analysis_results whose category is
//      malicious or suspicious.
// Requests are spaced 16 s apart to stay under the public-API limit of 4/min.
// All HTTP goes through curl; the API key is sent as `--header @-` on stdin,
// so it never appears in the process arguments or the logs.
//
// Row per tarball (tool `virustotal`), scope chosen by file name:
//   artisyn-hooks-installer.tgz -> installer-tgz -> <out>/row-virustotal-installer-tgz.json
//   hooks.tar.gz                -> hooks-tgz     -> <out>/row-virustotal-hooks-tgz.json
//   malicious + suspicious > 0  -> neutral (high = malicious, medium = suspicious, engines in note)
//   API error, timeout, no key  -> neutral (reason in note)
//   zero detections             -> pass
//   link: https://www.virustotal.com/gui/file/<sha256>
//
// Modes:
//   VIRUS_TOTAL_KEY=... node scripts/ci/virustotal-scan.js --out <dir> [--raw <dir>] <tarball>...
//     --raw <dir> also saves every VirusTotal JSON response there (raw-<job> artifact).
//
// Exit codes: 0 after writing the rows (report-only), 1 only on a usage error.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { makeRow, writeRow } = require('./scan-rows');

const API = 'https://www.virustotal.com/api/v3';
const PERMALINK = 'https://www.virustotal.com/gui/file/';
const REQUEST_GAP_MS = 16000;
const MAX_POLLS = 40;
const SCOPES = {
  'artisyn-hooks-installer.tgz': 'installer-tgz',
  'hooks.tar.gz': 'hooks-tgz',
};

let lastRequestAt = 0;

function sleepMs(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Waits so consecutive VirusTotal requests are REQUEST_GAP_MS apart. */
function throttle() {
  if (lastRequestAt > 0) sleepMs(lastRequestAt + REQUEST_GAP_MS - Date.now());
  lastRequestAt = Date.now();
}

/**
 * One VirusTotal request through curl. Returns { status, json }; status is 0
 * when curl itself failed. `extra` holds additional curl arguments.
 */
function vtRequest(key, url, extra = []) {
  throttle();
  const res = spawnSync('curl', ['-sS', '--max-time', '120', '--header', '@-',
    '--write-out', '\n%{http_code}', ...extra, url], {
    input: `x-apikey: ${key}\naccept: application/json\n`,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) return { status: 0, json: null, error: res.error.message };
  const text = String(res.stdout);
  const nl = text.lastIndexOf('\n');
  const status = Number.parseInt(text.slice(nl + 1), 10) || 0;
  let json = null;
  try {
    json = JSON.parse(text.slice(0, nl));
  } catch {
    json = null;
  }
  return { status, json, error: res.status !== 0 ? String(res.stderr).trim() : '' };
}

function apiError(step, res) {
  const msg = res.json && res.json.error && res.json.error.code ? ` ${res.json.error.code}` : '';
  return new Error(`VirusTotal ${step} failed: HTTP ${res.status}${msg}${res.error ? ` ${res.error}` : ''}`);
}

function saveRaw(rawDir, name, json) {
  if (!rawDir || !json) return;
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, name), `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

/** Pure verdict from a GET /files/<sha> response (Decision 12, VirusTotal). */
function verdictFromReport(json) {
  const attrs = json && json.data && json.data.attributes ? json.data.attributes : null;
  const stats = attrs && attrs.last_analysis_stats;
  if (!stats) return { status: 'neutral', counts: {}, note: 'no analysis stats in report' };
  const malicious = Number.isInteger(stats.malicious) ? stats.malicious : 0;
  const suspicious = Number.isInteger(stats.suspicious) ? stats.suspicious : 0;
  const results = attrs.last_analysis_results && typeof attrs.last_analysis_results === 'object'
    ? attrs.last_analysis_results : {};
  const engines = Object.keys(results).filter((k) => results[k]
    && (results[k].category === 'malicious' || results[k].category === 'suspicious'));
  if (malicious + suspicious > 0) {
    return {
      status: 'neutral',
      counts: { high: malicious, medium: suspicious },
      note: `${malicious} malicious, ${suspicious} suspicious: ${engines.join(', ')}`,
    };
  }
  return { status: 'pass', counts: {}, note: `0/${Object.keys(results).length} engines` };
}

/** Looks up (and if unknown uploads) one file; returns the final report JSON. */
function scanFile(key, file, rawDir, label) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let res = vtRequest(key, `${API}/files/${sha}`);
  saveRaw(rawDir, `${label}-lookup.json`, res.json);
  process.stdout.write(`virustotal-scan: ${path.basename(file)} sha256=${sha} lookup HTTP ${res.status}\n`);
  if (res.status === 404) {
    const up = vtRequest(key, `${API}/files`, ['--form', `file=@${file};filename=${path.basename(file)}`]);
    saveRaw(rawDir, `${label}-upload.json`, up.json);
    const id = up.json && up.json.data && up.json.data.id;
    if (up.status !== 200 || !id) throw apiError('upload', up);
    let done = false;
    for (let i = 0; i < MAX_POLLS && !done; i += 1) {
      const a = vtRequest(key, `${API}/analyses/${encodeURIComponent(id)}`);
      const st = a.json && a.json.data && a.json.data.attributes && a.json.data.attributes.status;
      process.stdout.write(`virustotal-scan:   poll ${i + 1} HTTP ${a.status} ${st || '-'}\n`);
      if (st === 'completed') {
        saveRaw(rawDir, `${label}-analysis.json`, a.json);
        done = true;
      }
    }
    if (!done) throw new Error(`VirusTotal analysis not completed after ${MAX_POLLS} polls`);
    res = vtRequest(key, `${API}/files/${sha}`);
    saveRaw(rawDir, `${label}-report.json`, res.json);
  }
  if (res.status !== 200) throw apiError('lookup', res);
  return { sha, json: res.json };
}

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--out' || a === '--raw') && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown or incomplete argument: ${a}`);
    } else {
      if (!SCOPES[path.basename(a)]) throw new Error(`unexpected tarball name: ${path.basename(a)}`);
      args.files.push(a);
    }
  }
  if (!args.out) throw new Error('--out <dir> is required');
  if (args.files.length === 0) throw new Error('at least one tarball path is required');
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`virustotal-scan: ${err.message}\n`
      + 'Usage: VIRUS_TOTAL_KEY=... node scripts/ci/virustotal-scan.js --out <dir> [--raw <dir>] '
      + '<artisyn-hooks-installer.tgz> <hooks.tar.gz>\n');
    process.exit(1);
  }
  const key = String(process.env.VIRUS_TOTAL_KEY || '').trim();

  for (const file of args.files) {
    const scope = SCOPES[path.basename(file)];
    const base = { tool: 'virustotal', scope };
    let row;
    try {
      if (!key) {
        row = makeRow({ ...base, status: 'neutral', note: 'no VIRUS_TOTAL_KEY' });
      } else if (!fs.existsSync(file)) {
        row = makeRow({ ...base, status: 'error', note: 'no output' });
      } else {
        const { sha, json } = scanFile(key, file, args.raw, scope);
        row = makeRow({ ...base, link: `${PERMALINK}${sha}`, ...verdictFromReport(json) });
      }
    } catch (err) {
      row = makeRow({ ...base, status: 'neutral', note: err.message });
    }
    if (row.status !== 'pass') process.stdout.write(`::warning::virustotal/${scope}: ${row.note}\n`);
    const out = writeRow(args.out, row);
    process.stdout.write(`virustotal-scan: ${scope} ${row.status} (${row.note}) -> ${out}\n`);
  }
  process.exit(0);
}

module.exports = { verdictFromReport };

if (require.main === module) main();
