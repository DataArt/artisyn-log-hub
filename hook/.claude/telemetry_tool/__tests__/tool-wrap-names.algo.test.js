'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/tool-monitor-name-validation.md against the hook's
 * plain-JS twin `tool-wrap-names.js` (`validateToolName`, `denylistRole`). The server runs the
 * same rows against the shared `@loghub/tool-monitor` package
 * (`server/src/logs/tool-monitoring/tool-monitor-name-validation.algo.spec.ts`), so the two
 * copies cannot drift apart without one of the runners failing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { validateToolName, denylistRole } = require('../tool-wrap-names');

/**
 * The typed name of a row, as described in the doc's Examples preamble.
 * @param {{ name?: string, repeat?: string, times?: number }} input
 * @returns {string}
 */
function nameOf(input) {
  if (input.repeat !== undefined) return input.repeat.repeat(input.times || 0);
  return input.name === undefined ? '' : input.name;
}

for (const row of loadExamples('tool-monitor-name-validation')) {
  test(`${row.id}: ${row.note}`, () => {
    const name = nameOf(row.input);
    const actual = { ...validateToolName(name), role: denylistRole(name) };
    const subset = {};
    for (const key of Object.keys(row.expected)) subset[key] = actual[key];
    assert.deepEqual(subset, row.expected);
  });
}
