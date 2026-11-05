#!/usr/bin/env node
// Writes build.origin.json: where this build came from and whether it is an official release.
//
// Shape: { branch, version, builtAt, officialRelease } — builtAt is ISO 8601 UTC at write time,
// an unknown string value is 'unknown'. The server reads it next to its bundle (dist/, the stand
// dir) via readBuildOrigin(); the release-update check runs only when officialRelease is true.
//
// Writers: this helper for `npm run build` / `build:serial` (officialRelease false) and the
// scenario stand (scripts/scenarios/build-stand.mjs, officialRelease true); the Docker image
// writes its own copy with printf in the Dockerfile runtime stage.
//
// Importing this module has no side effects; only the CLI entry (`npm run build:origin`) writes.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FILE_NAME = 'build.origin.json';

function nonEmptyOrUnknown(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'unknown';
}

// Current git branch; 'unknown' when git is missing, the dir is not a repo or HEAD is detached
// in a way git cannot name.
function detectBranch() {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return nonEmptyOrUnknown(out);
  } catch (_) {
    return 'unknown';
  }
}

function readRootVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return nonEmptyOrUnknown(pkg.version);
}

/**
 * Writes `<destDir>/build.origin.json` and returns the written object.
 * @param {string} destDir
 * @param {{ branch?: string, officialRelease: boolean }} opts
 */
function writeBuildOrigin(destDir, { branch, officialRelease }) {
  const origin = {
    branch: branch === undefined ? detectBranch() : nonEmptyOrUnknown(branch),
    version: readRootVersion(),
    builtAt: new Date().toISOString(),
    officialRelease: officialRelease === true,
  };
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, FILE_NAME), JSON.stringify(origin), 'utf8');
  return origin;
}

module.exports = { writeBuildOrigin, FILE_NAME };

if (require.main === module) {
  try {
    writeBuildOrigin(path.join(ROOT, 'dist'), { officialRelease: false });
    process.exit(0);
  } catch (err) {
    process.stderr.write(`build-origin error: ${err.message}\n`);
    process.exit(1);
  }
}
