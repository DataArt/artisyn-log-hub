#!/usr/bin/env node
// Morning check — local dependency audit: npm audit (root, server, hook) and bun audit (client),
// plus the installed runtime versions and the declared versions of the key runtime libraries,
// so the security agent knows what to search advisories for.
// Usage: node local-audit.js
// Output: JSON on stdout. Read-only: never runs `audit fix`.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./lib');

const NPM_DIRS = ['.', 'server', 'hook'];
const KEY_DEPS = [
  '@nestjs/core', 'express', 'drizzle-orm', 'pg', 'react', 'react-dom', 'vite', '@tanstack/react-query',
  'typescript', 'jsonwebtoken', 'passport', 'helmet', 'zod', 'axios', 'nodemailer', '@opentelemetry/api',
];

function run(cmd, args, cwd) {
  // npm is npm.cmd on Windows, which needs a shell; args are fixed literals, never user input.
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function version(cmd, args) {
  const r = run(cmd, args, ROOT);
  return r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop() : null;
}

function npmAudit(dir) {
  const r = run('npm', ['audit', '--json'], path.join(ROOT, dir));
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return { dir, error: (r.stderr || r.stdout).slice(0, 300) };
  }
  const advisories = [];
  for (const [name, v] of Object.entries(j.vulnerabilities || {})) {
    for (const via of v.via) {
      if (typeof via !== 'object') continue;
      advisories.push({
        package: name, severity: via.severity, title: via.title, url: via.url, range: via.range,
        direct: v.isDirect, fixAvailable: Boolean(v.fixAvailable),
      });
    }
  }
  return { dir, counts: j.metadata && j.metadata.vulnerabilities, advisories };
}

function bunAudit(dir) {
  const r = run('bun', ['audit', '--json'], path.join(ROOT, dir));
  const start = r.stdout.indexOf('{');
  if (start === -1) return { dir, counts: { total: 0 }, advisories: [], raw: r.stdout.slice(0, 200) };
  let j;
  try {
    j = JSON.parse(r.stdout.slice(start));
  } catch {
    return { dir, error: r.stdout.slice(0, 300) };
  }
  const advisories = [];
  const counts = { low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, list] of Object.entries(j)) {
    for (const a of list) {
      advisories.push({ package: name, severity: a.severity, title: a.title, url: a.url, range: a.vulnerable_versions });
      counts[a.severity] = (counts[a.severity] || 0) + 1;
      counts.total += 1;
    }
  }
  return { dir, counts, advisories };
}

function declaredDeps() {
  const out = {};
  for (const dir of ['.', 'server', 'client', 'hook', 'artisyn-hooks-installer']) {
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const all = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    for (const name of KEY_DEPS) if (all[name]) out[`${dir}:${name}`] = all[name];
    if (pkg.engines) out[`${dir}:engines`] = pkg.engines;
  }
  return out;
}

function dockerfileNode() {
  try {
    const m = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').match(/FROM\s+(\S*node\S*)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

try {
  const out = {
    runtimes: {
      node: process.version,
      npm: version('npm', ['--version']),
      bun: version('bun', ['--version']),
      dockerfileNodeImage: dockerfileNode(),
    },
    keyDependencies: declaredDeps(),
    audits: NPM_DIRS.map(npmAudit).concat([bunAudit('client')]),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`local-audit error: ${err.message}\n`);
  process.exit(1);
}
