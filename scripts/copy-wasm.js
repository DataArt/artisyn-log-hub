#!/usr/bin/env node
// Copies the two tree-sitter WASM files the server's Bash analysis loads (OKF access extraction,
// server/src/logs/okf/server-bash-parser.ts) to <target>/wasm (default dist/wasm), next to the ncc
// bundle. The target is a parameter so the isolated scenario stand
// (scripts/scenarios/build-stand.mjs) can place them next to its own bundle; the Dockerfile's
// server-build stage does the same copy with `cp`.
const fs = require('fs');
const path = require('path');

const NODE_MODULES = path.join(__dirname, '../server/node_modules');
const DEFAULT_TARGET = path.join(__dirname, '../dist');

/** Source files, relative to server/node_modules. The basename is the name under <target>/wasm. */
const WASM_FILES = [
  'web-tree-sitter/web-tree-sitter.wasm',
  'tree-sitter-bash/tree-sitter-bash.wasm',
];

/** Copies both `.wasm` files into `<targetDir>/wasm`, skipping a file locked by a running server. */
function copyWasm(targetDir = DEFAULT_TARGET) {
  const outDir = path.join(path.resolve(targetDir), 'wasm');
  fs.mkdirSync(outDir, { recursive: true });
  for (const rel of WASM_FILES) {
    const src = path.join(NODE_MODULES, rel);
    const dest = path.join(outDir, path.basename(rel));
    try {
      fs.copyFileSync(src, dest);
    } catch (e) {
      // File in use by a running process (Windows EBUSY) — already deployed by a prior build.
      if (e.code !== 'EBUSY') throw e;
    }
  }
}

// Runs the copy when invoked directly (`node scripts/copy-wasm.js [targetDir]`); when required by
// scripts/build-assets.js it only exports, so the whole asset phase stays in one process.
if (require.main === module) {
  copyWasm(process.argv[2] || DEFAULT_TARGET);
}

module.exports = { copyWasm };
