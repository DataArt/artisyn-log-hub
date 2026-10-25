'use strict';

// Table test for docs/knowledgebase/algorithms/executable-config-guard.md: every row of the doc's
// examples block runs against the real checkConfigGuard() in scripts/ci/config-guard.js. The test
// holds no cases of its own.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadExamples } = require('../algo-docs/load-examples.cjs');
const { checkConfigGuard } = require('../ci/config-guard.js');

for (const row of loadExamples('executable-config-guard')) {
  test(row.id, () => {
    const { findings } = checkConfigGuard(row.input);
    assert.deepEqual(findings, row.expected.findings, row.note);
  });
}
