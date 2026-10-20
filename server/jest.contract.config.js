// Jest config of the API <-> DB contract suite, `npm run test:contract`.
//
// Same transform/module settings as the main `jest` block of package.json, but:
//   - only test/contract/**/*.contract-spec.ts (the main config's testRegex never matches them);
//   - its own globalSetup/globalTeardown: a fresh `contract_<uuid>` schema, the deterministic
//     world-v1 fixture and one shared app listening on a free port.
// The main config stays untouched, so `npm run test` never picks the contract suite up.
// Always run in band (the script passes --runInBand): every spec reads and writes the one schema.
const base = require('./package.json').jest;

const config = {
  ...base,
  testRegex: 'test/contract/.*\\.contract-spec\\.ts$',
  globalSetup: '<rootDir>/test/contract/setup/global-setup.ts',
  globalTeardown: '<rootDir>/test/contract/setup/global-teardown.ts',
  // A write row reloads the world and snapshots its tables twice; argon2 and SMTP attempts
  // (no sink running) add seconds. Generous, so a slow machine fails on a diff, not a timer.
  testTimeout: 60000,
};
delete config.collectCoverageFrom;
delete config.coverageDirectory;

module.exports = config;
