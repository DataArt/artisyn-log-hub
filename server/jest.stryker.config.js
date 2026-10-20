// Jest config for Stryker mutation runs: the main `jest` block of package.json
// without globalSetup/globalTeardown and limited to the src/**/*.spec.ts unit specs, so no run
// needs the database and Stryker can work in parallel sandboxes.
//
// JEST_NO_DB=1 tells specs that mix pure cases with a "(real DB)" block to skip that block
// (cost.sql.spec.ts). Specs that need the DB throughout are ignored outright below.
process.env.JEST_NO_DB = '1';

const fs = require('fs');
const path = require('path');

/**
 * The repo root above this file: the first ancestor holding `.git`. Stryker copies only
 * `server/` into a sandbox under `tmp/stryker/sandbox/`, which is still inside the repo, so the
 * walk finds the real root from there too.
 */
function repoRoot() {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`jest.stryker.config.js: no .git above ${__dirname}`);
    dir = parent;
  }
}

const config = {
  ...require('./package.json').jest,
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  // The `*.algo.spec.ts` table tests import scripts/algo-docs/load-examples.cjs by a relative
  // path that leaves `server/`, which does not exist inside the sandbox; map it to the repo's
  // copy (it then reads the docs from the repo as well).
  moduleNameMapper: {
    '^(?:\\.\\./)+scripts/algo-docs/load-examples\\.cjs$': path.join(
      repoRoot(),
      'scripts',
      'algo-docs',
      'load-examples.cjs',
    ),
  },
};
delete config.testRegex;
delete config.globalSetup;
delete config.globalTeardown;
config.testPathIgnorePatterns = [
  ...config.testPathIgnorePatterns,
  'server-secrets[.]spec[.]ts$',
  'turn-end-advisor-orphan-cleanup[.]scheduler[.]spec[.]ts$',
];

module.exports = config;
