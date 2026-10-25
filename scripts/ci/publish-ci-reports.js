#!/usr/bin/env node
'use strict';

// Publishes the nightly security-scan results to the orphan `ci-reports`
// branch (FR-24). Design Decision 17 of
// docs/tasks/todo/2026-10-23-ci-cd-scans/impl-plan.md.
//
// Uses the Git Data API through `gh api` (GH_TOKEN = the workflow's
// GITHUB_TOKEN, never a PAT); no git checkout and no persisted credentials:
//   1. one blob per file under --dir (security-scan-results.json, badges/*);
//   2. a tree built from those blobs only (no base_tree, so the branch always
//      holds exactly the latest results);
//   3. a commit `ci: security scan results <sha7> [skip ci]` whose parent is
//      the current ci-reports head, or no parent when the ref does not exist
//      yet (orphan bootstrap);
//   4. PATCH refs/heads/ci-reports with force: false, or create the ref.
// On HTTP 422 (not a fast-forward / ref already exists) it re-reads the ref
// and retries steps 3-4, at most 3 attempts in total.
//
// Modes:
//   GH_TOKEN=... REPO=owner/name node scripts/ci/publish-ci-reports.js --dir <dir> --sha <sha>
//
// Exit codes: 0 when published and on a publish failure (report-only; the
// failure is printed as a ::warning:: annotation), 1 only on a usage error.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BRANCH = 'ci-reports';
const MAX_ATTEMPTS = 3;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;

class GhError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** `gh api <endpoint>`; body (if any) goes to stdin as JSON. Returns parsed JSON. */
function ghApi(method, endpoint, body) {
  const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', endpoint];
  if (body !== undefined) args.push('--input', '-');
  const res = spawnSync('gh', args, {
    input: body !== undefined ? JSON.stringify(body) : undefined,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new GhError(`gh ${method} ${endpoint}: ${res.error.message}`, 0);
  if (res.status !== 0) {
    const stderr = String(res.stderr).trim();
    const m = /HTTP (\d{3})/.exec(stderr);
    throw new GhError(`gh ${method} ${endpoint}: ${stderr}`, m ? Number(m[1]) : 0);
  }
  const out = String(res.stdout).trim();
  return out ? JSON.parse(out) : null;
}

/** Repo-relative POSIX paths of every file under dir. */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Current head SHA of ci-reports, or null when the ref does not exist. */
function readHead(repo) {
  try {
    const ref = ghApi('GET', `repos/${repo}/git/ref/heads/${BRANCH}`);
    return ref && ref.object ? ref.object.sha : null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

function publish(repo, dir, sha) {
  const files = listFiles(dir);
  if (!files.includes('security-scan-results.json')) {
    throw new Error(`${path.join(dir, 'security-scan-results.json')} not found`);
  }
  const tree = files.map((rel) => {
    const content = fs.readFileSync(path.join(dir, ...rel.split('/'))).toString('base64');
    const blob = ghApi('POST', `repos/${repo}/git/blobs`, { content, encoding: 'base64' });
    return { path: rel, mode: '100644', type: 'blob', sha: blob.sha };
  });
  const treeSha = ghApi('POST', `repos/${repo}/git/trees`, { tree }).sha;
  const message = `ci: security scan results ${sha.slice(0, 7)} [skip ci]`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const head = readHead(repo);
    const commit = ghApi('POST', `repos/${repo}/git/commits`, {
      message,
      tree: treeSha,
      parents: head ? [head] : [],
    });
    try {
      if (head) {
        ghApi('PATCH', `repos/${repo}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
      } else {
        ghApi('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
      }
      return { commit: commit.sha, files, attempt };
    } catch (err) {
      if (err.status !== 422 || attempt === MAX_ATTEMPTS) throw err;
      process.stdout.write(`publish-ci-reports: ref moved (HTTP 422), retry ${attempt + 1}/${MAX_ATTEMPTS}\n`);
    }
  }
  throw new Error('unreachable');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--dir' || a === '--sha') && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${a}`);
    }
  }
  if (!args.dir) throw new Error('--dir <dir> is required');
  if (!args.sha || !SHA_RE.test(args.sha)) throw new Error('--sha <commit sha> is required');
  const repo = String(process.env.REPO || '');
  if (!REPO_RE.test(repo)) throw new Error('env REPO must be owner/name');
  if (!process.env.GH_TOKEN) throw new Error('env GH_TOKEN is required');
  args.repo = repo;
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`publish-ci-reports: ${err.message}\n`
      + 'Usage: GH_TOKEN=... REPO=owner/name node scripts/ci/publish-ci-reports.js --dir <dir> --sha <sha>\n');
    process.exit(1);
  }
  try {
    const result = publish(args.repo, path.resolve(args.dir), args.sha);
    process.stdout.write(`publish-ci-reports: ${BRANCH} -> ${result.commit} `
      + `(${result.files.join(', ')}; attempt ${result.attempt})\n`);
  } catch (err) {
    process.stdout.write(`::warning::publish-ci-reports failed: ${err.message.replace(/\r?\n/g, ' ')}\n`);
  }
  process.exit(0);
}

module.exports = { listFiles };

if (require.main === module) main();
