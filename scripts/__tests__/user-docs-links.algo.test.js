'use strict';

// Table test for docs/knowledgebase/algorithms/user-docs-links.md: every row of the doc's
// examples block calls one exported function of scripts/user-docs/links.js
// (`input.fn` with the argument list `input.args`) and compares the return value with
// `expected.result`. The test holds no cases of its own.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadExamples } = require('../algo-docs/load-examples.cjs');
const mod = require('../user-docs/links.js');

for (const row of loadExamples('user-docs-links')) {
  test(row.id, () => {
    const fn = mod[row.input.fn];
    assert.equal(typeof fn, 'function', `${row.input.fn} is not exported`);
    const result = fn(...row.input.args);
    assert.deepEqual(result, row.expected.result, row.note);
  });
}
