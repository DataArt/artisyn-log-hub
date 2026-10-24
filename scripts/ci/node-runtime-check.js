#!/usr/bin/env node
'use strict';

// Node runtime freshness check (FR-35) for the security-scans CI workflow.
// Design Decision 20 of docs/tasks/todo/2026-10-23-ci-cd-scans/impl-plan.md.
//
// For each pinned Node version it writes one unified scan row:
//   Dockerfile            every `FROM node:<ver>` line (all stages must agree)
//                         -> <out>/row-node-runtime-dockerfile.json
//   docker-dev/Dockerfile `ARG NODE_VERSION=<ver>`
//                         -> <out>/row-node-runtime-docker-dev.json
//
// Status per version:
//   vulnerable (is-my-node-vulnerable, platform linux, EOL counts) -> findings, high = 1
//   newer patch of the same major on nodejs.org/dist/index.json    -> warning, note `22.23.4 < 22.23.6`
//   otherwise                                                     -> pass
//   version not found, stages disagree, lookup failure            -> error
//
// is-my-node-vulnerable is not a repo dependency: the workflow installs it with
//   npm install --prefix "$RUNNER_TEMP/imnv" --ignore-scripts is-my-node-vulnerable@1.6.1
// and sets NODE_PATH="$RUNNER_TEMP/imnv/node_modules". The async API is called
// in a child `node -e` process so this script stays synchronous. The release
// index is fetched with curl.
//
// Modes:
//   node scripts/ci/node-runtime-check.js --out <dir> [--link <url>] [--imnv <node_modules dir>]
//     --imnv overrides NODE_PATH for the is-my-node-vulnerable lookup.
//
// Exit codes: 0 after writing both rows (report-only), 1 only on a usage error.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeRow, writeRow } = require('./scan-rows');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX_URL = 'https://nodejs.org/dist/index.json';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// Awaits isNodeVulnerable(version, 'linux') and prints 1 or 0.
const SNIPPET = [
  "const { isNodeVulnerable } = require('is-my-node-vulnerable');",
  "isNodeVulnerable(process.argv[1], 'linux')",
  "  .then((v) => { process.stdout.write(v ? '1' : '0'); })",
  '  .catch((e) => { process.stderr.write(String((e && e.message) || e)); process.exit(2); });',
].join('\n');

/** All `FROM node:<x.y.z>` versions of a Dockerfile, in order. */
function dockerfileVersions(text) {
  const re = /^\s*FROM\s+(?:--platform=\S+\s+)?node:(\d+\.\d+\.\d+)\b/gim;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

function dockerDevVersion(text) {
  const m = /^\s*ARG\s+NODE_VERSION=(\d+\.\d+\.\d+)\s*$/im.exec(text);
  return m ? m[1] : null;
}

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Newest version per major from the parsed index.json array. */
function latestPerMajor(index) {
  const latest = new Map();
  for (const entry of Array.isArray(index) ? index : []) {
    const v = entry && typeof entry.version === 'string' ? entry.version.replace(/^v/, '') : '';
    if (!VERSION_RE.test(v)) continue;
    const major = v.split('.')[0];
    if (!latest.has(major) || cmp(v, latest.get(major)) > 0) latest.set(major, v);
  }
  return latest;
}

function fetchIndex() {
  const res = spawnSync('curl', ['-fsSL', '--max-time', '60', INDEX_URL], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`curl failed: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`curl exit ${res.status}: ${String(res.stderr).trim()}`);
  return JSON.parse(res.stdout);
}

function isVulnerable(version, nodePath) {
  const env = { ...process.env };
  if (nodePath) env.NODE_PATH = nodePath;
  const res = spawnSync(process.execPath, ['-e', SNIPPET, version], {
    encoding: 'utf8',
    env,
    timeout: 120000,
  });
  if (res.error) throw new Error(`is-my-node-vulnerable failed: ${res.error.message}`);
  const out = String(res.stdout).trim();
  if (res.status !== 0 || (out !== '1' && out !== '0')) {
    const detail = `${String(res.stderr).trim()} ${out}`.trim();
    throw new Error(`is-my-node-vulnerable exit ${res.status}: ${detail || 'no output'}`);
  }
  return out === '1';
}

/** Pure status rule for one version (Decision 12, Node runtime). */
function runtimeStatus(version, vulnerable, latest) {
  if (vulnerable) {
    const tail = latest && cmp(latest, version) > 0 ? `; latest ${latest}` : '';
    return { status: 'findings', counts: { high: 1 }, note: `${version} is vulnerable or end-of-life${tail}` };
  }
  if (latest && cmp(latest, version) > 0) return { status: 'warning', counts: {}, note: `${version} < ${latest}` };
  return { status: 'pass', counts: {}, note: `${version} is the latest patch` };
}

function readRepoFile(rel) {
  return fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
}

/** Resolves the version of one target; returns { version } or { error }. */
function targetVersion(scope) {
  if (scope === 'dockerfile') {
    const versions = dockerfileVersions(readRepoFile('Dockerfile'));
    if (versions.length === 0) return { error: 'no FROM node:<ver> line in Dockerfile' };
    const distinct = [...new Set(versions)];
    if (distinct.length > 1) return { error: `Dockerfile stages disagree: ${distinct.join(', ')}` };
    return { version: distinct[0] };
  }
  const v = dockerDevVersion(readRepoFile('docker-dev/Dockerfile'));
  return v ? { version: v } : { error: 'no ARG NODE_VERSION=<ver> in docker-dev/Dockerfile' };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (['--out', '--link', '--imnv'].includes(a) && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${a}`);
    }
  }
  if (!args.out) throw new Error('--out <dir> is required');
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`node-runtime-check: ${err.message}\n`
      + 'Usage: node scripts/ci/node-runtime-check.js --out <dir> [--link <url>] [--imnv <node_modules dir>]\n');
    process.exit(1);
  }
  const nodePath = args.imnv ? path.resolve(args.imnv) : null;

  let latest = null;
  let indexError = null;
  try {
    latest = latestPerMajor(fetchIndex());
  } catch (err) {
    indexError = `release index: ${err.message}`;
  }

  for (const scope of ['dockerfile', 'docker-dev']) {
    const base = { tool: 'node-runtime', scope, link: args.link };
    let row;
    try {
      const target = targetVersion(scope);
      if (target.error) {
        row = makeRow({ ...base, status: 'error', note: target.error });
      } else if (indexError) {
        row = makeRow({ ...base, version: target.version, status: 'error', note: indexError });
      } else {
        const vulnerable = isVulnerable(target.version, nodePath);
        const major = target.version.split('.')[0];
        const result = runtimeStatus(target.version, vulnerable, latest.get(major) || null);
        row = makeRow({ ...base, version: target.version, ...result });
      }
    } catch (err) {
      row = makeRow({ ...base, status: 'error', note: err.message });
    }
    if (row.status !== 'pass') process.stdout.write(`::warning::node-runtime/${scope}: ${row.note}\n`);
    const file = writeRow(args.out, row);
    process.stdout.write(`node-runtime-check: ${scope} ${row.status} (${row.note}) -> ${file}\n`);
  }
  process.exit(0);
}

module.exports = { dockerfileVersions, dockerDevVersion, latestPerMajor, runtimeStatus };

if (require.main === module) main();
