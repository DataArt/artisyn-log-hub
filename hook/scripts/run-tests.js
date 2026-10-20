#!/usr/bin/env node
'use strict';

/**
 * Runs every hook test file under .claude/telemetry_tool/__tests__/*.test.js
 * with Node's built-in test runner.
 *
 * The file list is collected here instead of being hardcoded in package.json,
 * so a new test file is picked up without editing the `test` script. A glob
 * passed straight to `node --test` needs Node >= 21, while the hook supports
 * Node >= 18.19, so the directory is read explicitly.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const hookRoot = path.resolve(__dirname, '..');
const testsDir = path.join(hookRoot, '.claude', 'telemetry_tool', '__tests__');

const files = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testsDir, name));

if (files.length === 0) {
  console.error(`No *.test.js files found in ${testsDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: hookRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
