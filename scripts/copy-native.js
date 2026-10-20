#!/usr/bin/env node
// Copies argon2 prebuilds to <target>/prebuilds (default dist/prebuilds), skipping locked files
// (Windows EBUSY). The target is a parameter so the isolated scenario stand
// (scripts/scenarios/build-stand.mjs) can place them next to its own ncc bundle.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '../server/node_modules/argon2/prebuilds');
const DEFAULT_TARGET = path.join(__dirname, '../dist');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      try {
        fs.copyFileSync(s, d);
      } catch (e) {
        if (e.code === 'EBUSY') {
          // File in use by running process — already deployed from prior build, skip
        } else {
          throw e;
        }
      }
    }
  }
}

/** Copies the prebuilds into `<targetDir>/prebuilds`, next to an ncc bundle in `targetDir`. */
function copyNative(targetDir = DEFAULT_TARGET) {
  copyDir(src, path.join(path.resolve(targetDir), 'prebuilds'));
}

// Runs the copy when invoked directly (`npm run build:copy:native [targetDir]`); when required by
// scripts/build-assets.js it only exports, so the whole asset phase stays in one process.
if (require.main === module) {
  copyNative(process.argv[2] || DEFAULT_TARGET);
}

module.exports = { copyNative };
