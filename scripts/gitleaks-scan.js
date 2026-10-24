#!/usr/bin/env node
'use strict';

// Secret scan for the versioned git hooks (.githooks/), with gitleaks and the
// repo's .gitleaks.toml (default rules + reviewed false positives).
//
// Modes:
//   node scripts/gitleaks-scan.js --pre-commit          (.githooks/pre-commit)
//     Scans the staged changes, so a secret never lands in a commit.
//   node scripts/gitleaks-scan.js --pre-push <remote>   (.githooks/pre-push)
//     Scans every commit about to be pushed (the ref lines git writes to the
//     hook's stdin) — the backstop for commits made with --no-verify or before
//     the hooks were installed.
//
// Strict: a found secret and a missing gitleaks binary both block (exit 1).
// The bypass for a reviewed false positive is an allowlist entry in
// .gitleaks.toml; `--no-verify` skips the hook as a last resort.
// See docs/knowledgebase/git-hooks.md.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, '.gitleaks.toml');
const ZERO_SHA = /^0+$/;
/** gitleaks exit code on found leaks, distinct from its own error exit (1). */
const LEAKS_EXIT = 42;

const INSTALL_HINT = [
  'gitleaks is required by the git hooks (secret scan) but was not found on PATH.',
  'Install it:',
  '  Windows: scoop install gitleaks   (or: winget install gitleaks)',
  '  macOS:   brew install gitleaks',
  '  Linux:   https://github.com/gitleaks/gitleaks/releases',
  'Last resort, skips every check of this hook: git commit/push --no-verify',
].join('\n');

function hasGitleaks() {
  const res = spawnSync('gitleaks', ['version'], { stdio: 'ignore', timeout: 10000 });
  return !res.error && res.status === 0;
}

function commitExists(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * git log revision args for one pre-push ref line, or null for a branch
 * deletion. A new remote branch, or a remote tip this clone does not have
 * (force push over someone else's commits), scans what no remote-tracking
 * branch of `remote` already contains.
 */
function pushRange(line, remote) {
  const [, localSha, , remoteSha] = line.trim().split(/\s+/);
  if (!localSha || ZERO_SHA.test(localSha)) return null;
  if (remoteSha && !ZERO_SHA.test(remoteSha) && commitExists(remoteSha)) {
    return `${remoteSha}..${localSha}`;
  }
  return `${localSha} --not --remotes=${remote}`;
}

function runGitleaks(args) {
  const res = spawnSync('gitleaks', [
    'git', ...args,
    '--config', CONFIG,
    '--redact', '--verbose', '--no-banner', '--log-level', 'warn',
    '--exit-code', String(LEAKS_EXIT),
    ROOT,
  ], { cwd: ROOT, stdio: 'inherit' });
  if (res.error) throw res.error;
  return res.status;
}

function report(hook, status) {
  if (status === 0) return 0;
  if (status === LEAKS_EXIT) {
    process.stderr.write(
      `\n${hook}: gitleaks found possible secrets (above) — ${hook === 'pre-commit' ? 'commit' : 'push'} blocked.\n` +
      'Remove the secret (and rotate it if it is real). If it is a verified false positive, add a\n' +
      'narrow allowlist entry to .gitleaks.toml (see docs/knowledgebase/git-hooks.md).\n',
    );
  } else {
    process.stderr.write(`${hook}: gitleaks failed (exit ${status}).\n`);
  }
  return 1;
}

try {
  const preCommit = process.argv.includes('--pre-commit');
  const preIdx = process.argv.indexOf('--pre-push');
  if (!preCommit && preIdx === -1) {
    process.stderr.write('usage: gitleaks-scan.js --pre-commit | --pre-push <remote>\n');
    process.exit(1);
  }
  const hook = preCommit ? 'pre-commit' : 'pre-push';
  if (!hasGitleaks()) {
    process.stderr.write(`${hook}: ${INSTALL_HINT}\n`);
    process.exit(1);
  }

  if (preCommit) {
    process.exit(report(hook, runGitleaks(['--pre-commit', '--staged'])));
  }

  const remote = process.argv[preIdx + 1] || 'origin';
  const stdin = fs.readFileSync(0, 'utf8');
  for (const line of stdin.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const range = pushRange(line, remote);
    if (!range) continue;
    const code = report(hook, runGitleaks([`--log-opts=${range}`]));
    if (code !== 0) process.exit(code);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`gitleaks-scan: ${err.message}\n`);
  process.exit(1);
}
