#!/usr/bin/env node
// Builds a local session corpus from scratch, `npm run corpus:bootstrap` (tests/corpus/README.md).
// tests/corpus/sets/ is gitignored: a fresh clone has no set and S-CORPUS-01…05 skip until one exists.
//
//   1. `npm run corpus:generate` — records the sessions with `claude -p` (needs Claude Code installed
//      and logged in; spends real tokens). Skipped when a set already exists, unless --force-generate.
//   2. `node scripts/corpus/diff-format.mjs <set> --approve` — merges the set's format into
//      tests/corpus/known-format.json.
//   3. `CORPUS_APPROVE=1 npm run test:scenarios -- --mode a --only corpus` — writes expected.json of
//      every session from the mode-A stand (needs Postgres: tests/scenarios/docker-compose.yml).
//
// Usage: npm run corpus:bootstrap [-- --force-generate]
// Exit codes: 0 done, otherwise the exit code of the step that failed.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SETS_DIR = path.join(ROOT, 'tests', 'corpus', 'sets');

function listSets() {
  if (!fs.existsSync(SETS_DIR)) return [];
  return fs
    .readdirSync(SETS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(SETS_DIR, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort();
}

function step(title, command, args, env) {
  process.stderr.write(`\ncorpus:bootstrap: ${title}\n`);
  // npm is a .cmd shim on Windows and needs the shell there; every argument here is a fixed literal.
  const res = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: Object.assign({}, process.env, env),
    shell: command === 'npm' && process.platform === 'win32',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    process.stderr.write(`corpus:bootstrap: "${title}" failed with exit code ${res.status}\n`);
    process.exit(res.status || 1);
  }
}

try {
  const forceGenerate = process.argv.slice(2).includes('--force-generate');
  if (listSets().length === 0 || forceGenerate) {
    step('record sessions with claude -p', 'npm', ['run', 'corpus:generate']);
  } else {
    process.stderr.write(`corpus:bootstrap: using the existing set(s): ${listSets().join(', ')}\n`);
  }
  const sets = listSets();
  if (sets.length === 0) throw new Error('no set under tests/corpus/sets/ after generation');
  for (const set of sets) {
    step(`approve the format of ${set}`, process.execPath, [path.join('scripts', 'corpus', 'diff-format.mjs'), set, '--approve']);
  }
  step('approve expected.json on the mode-A stand', 'npm', ['run', 'test:scenarios', '--', '--mode', 'a', '--only', 'corpus'], {
    CORPUS_APPROVE: '1',
  });
  process.stderr.write('\ncorpus:bootstrap: done. Check with `npm run test:scenarios -- --mode a --only corpus`.\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`corpus:bootstrap error: ${err.message}\n`);
  process.exit(1);
}
