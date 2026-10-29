'use strict';

// Table test for docs/knowledgebase/algorithms/site-example-dataset.md: every row of the doc's
// examples block calls one exported function of scripts/site/dataset.mjs (`input.fn` with the
// argument list `input.args`) and compares the return value with `expected.result`, or the
// thrown error with `expected.error` (compared as `{ error: <message> }`). The test holds no
// cases of its own. dataset.mjs is ESM, so it is loaded with a dynamic import.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const { loadExamples } = require('../algo-docs/load-examples.cjs');

const DATASET_MODULE = pathToFileURL(path.join(__dirname, '..', 'site', 'dataset.mjs')).href;

for (const row of loadExamples('site-example-dataset')) {
  test(row.id, async () => {
    const mod = await import(DATASET_MODULE);
    const fn = mod[row.input.fn];
    assert.equal(typeof fn, 'function', `${row.input.fn} is not exported`);
    let actual;
    try {
      actual = { result: fn(...row.input.args) };
    } catch (err) {
      actual = { error: err instanceof Error ? err.message : String(err) };
    }
    assert.deepEqual(actual, row.expected, row.note);
  });
}
