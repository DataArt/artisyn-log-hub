'use strict';

// Table test for docs/knowledgebase/algorithms/security-scan-summary.md: every row of the doc's
// examples block calls one exported function of scripts/ci/security-summary.js
// (`input.fn` with the argument list `input.args`) and compares the return value with
// `expected.result`. The test holds no cases of its own.
//
// A JSON object of the exact shape {"$repeat": ["<text>", <n>]} anywhere in `input.args` or
// `expected.result` stands for "<text>".repeat(n), so rows near the 65,536-character body limit
// stay readable (the doc's Examples section describes it).

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadExamples } = require('../algo-docs/load-examples.cjs');
const mod = require('../ci/security-summary.js');

function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$repeat') {
    const [text, n] = value.$repeat;
    return String(text).repeat(n);
  }
  const out = {};
  for (const key of keys) out[key] = expand(value[key]);
  return out;
}

for (const row of loadExamples('security-scan-summary')) {
  test(row.id, () => {
    const fn = mod[row.input.fn];
    assert.equal(typeof fn, 'function', `${row.input.fn} is not exported`);
    const result = fn(...expand(row.input.args));
    assert.deepEqual(result, expand(row.expected.result), row.note);
  });
}
