'use strict';

// Table test for docs/knowledgebase/algorithms/release-assets.md: every row of the doc's
// examples block calls one exported function (`input.fn` with the argument list `input.args`)
// of the script named by `input.module` and checks the result against `expected`:
//   {result}             exact deep equality with the return value;
//   {includes, excludes} every `includes` string occurs in the returned text, no `excludes` one does;
//   {error}              the call throws and the message contains the text.
// The test holds no cases of its own.
//
// A JSON object of the exact shape {"$commits": <n>} anywhere in `input.args` stands for n
// commits [{sha: "c<i>", subject: "s<i>"}] for i = 1..n (the doc's Examples section describes it).

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadExamples } = require('../algo-docs/load-examples.cjs');

const MODULES = {
  'release-kit': require('../release-kit.js'),
  'release-notes': require('../ci/release-notes.js'),
  'virustotal-scan': require('../ci/virustotal-scan.js'),
};

function expand(value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$commits') {
    return Array.from({ length: value.$commits }, (_, i) => ({ sha: `c${i + 1}`, subject: `s${i + 1}` }));
  }
  const out = {};
  for (const key of keys) out[key] = expand(value[key]);
  return out;
}

for (const row of loadExamples('release-assets')) {
  test(row.id, () => {
    const mod = MODULES[row.input.module];
    assert.ok(mod, `unknown module ${row.input.module}`);
    const fn = mod[row.input.fn];
    assert.equal(typeof fn, 'function', `${row.input.fn} is not exported by ${row.input.module}`);
    const args = expand(row.input.args);
    const expected = row.expected;

    if (Object.prototype.hasOwnProperty.call(expected, 'error')) {
      assert.throws(() => fn(...args), (err) => String(err.message).includes(expected.error), row.note);
      return;
    }
    const result = fn(...args);
    if (Object.prototype.hasOwnProperty.call(expected, 'result')) {
      assert.deepEqual(result, expected.result, row.note);
      return;
    }
    assert.equal(typeof result, 'string', `${row.input.fn} did not return text`);
    for (const text of expected.includes || []) {
      assert.ok(result.includes(text), `missing ${JSON.stringify(text)} — ${row.note}`);
    }
    for (const text of expected.excludes || []) {
      assert.ok(!result.includes(text), `unexpected ${JSON.stringify(text)} — ${row.note}`);
    }
  });
}
