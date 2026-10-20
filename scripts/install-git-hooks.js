#!/usr/bin/env node
'use strict';

// `prepare` target of the root package.json: points git at the repo's
// versioned hooks (.githooks/, see .githooks/pre-commit) by setting
// core.hooksPath to the relative `.githooks`. Outside a git checkout (Docker
// build, tarball, CI without .git) or without git on PATH it does nothing and
// exits 0, so `npm install` never fails because of it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

try {
  if (!fs.existsSync(path.join(ROOT, '.git'))) process.exit(0);
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 10000,
    });
  } catch {
    process.exit(0); // git is not installed
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`install-git-hooks: ${err.message}\n`);
  process.exit(0);
}
