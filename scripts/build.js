#!/usr/bin/env node
// Build orchestrator. Replaces the flat 11-step `&&` chain in package.json's `build` script.
//
// Measured breakdown of the old serial chain (30.4s total):
//   build:client 14.5s | build:server 8.2s | hooks-installer 3.5s | the other 8 steps 4.2s
// build:client (vite → client/dist), build:server (ncc → dist) and the hooks-installer branch
// (→ server/src/public/static) write to three disjoint trees, so they are run concurrently here.
// Everything that consumes their output runs afterwards, in one process (scripts/build-assets.js).
// Before the parallel block, build:help generates client/public/help/*.md from user-docs/.
//
// NOTE ON CONVENTIONS: .claude/skills/nodejs-script mandates synchronous child processes
// (execFileSync/spawnSync). That rule is incompatible with the entire point of this script —
// spawnSync cannot run two builds at once — so this file deliberately uses async `spawn` plus
// Promises. Every other convention from that skill is followed (CommonJS, no external deps, no
// shell strings, path.join, stderr diagnostics, explicit exit codes). It is the only script in
// the repo that needs this exemption.
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Each branch runs the EXISTING npm scripts rather than inlining their commands, so package.json
// stays the single source of truth for what each step actually does. The ~600ms npm startup is
// paid once per branch concurrently instead of once per step serially.
function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(NPM, ['run', script], {
      cwd: ROOT,
      stdio: 'inherit',
      // Windows needs a shell to launch the npm.cmd shim at all: since Node 18.20/20.12,
      // spawning a .cmd without one fails outright with EINVAL. There is no injection surface
      // here — every argument is a hardcoded literal from the call sites below, never user input.
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`\`npm run ${script}\` exited with code ${code}`));
    });
  });
}

function runSeq(scripts) {
  return scripts.reduce((p, s) => p.then(() => run(s)), Promise.resolve());
}

async function main() {
  // dist/ must be gone before ncc writes into it.
  await run('build:clean');

  // client/public/help/*.md is generated from user-docs/ and must exist before vite copies
  // client/public; the client's own prebuild re-runs it harmlessly.
  await run('build:help');

  await Promise.all([
    runSeq(['install:hooks-installer', 'build:hooks-installer']),
    run('build:client'),
    run('build:server'),
  ]);

  // Consumes client/dist, server/src/public and dist/ — must follow all three branches.
  await run('build:assets');
}

main().then(
  () => process.exit(0),
  err => {
    process.stderr.write(`build failed: ${err.message}\n`);
    process.exit(1);
  },
);
