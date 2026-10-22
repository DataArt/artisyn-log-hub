'use strict';

// Table test for docs/knowledgebase/algorithms/sandbox-prune-classification.md: every row of the
// doc's examples block runs against the real classifyPruneCandidate() in
// scripts/claude-docker/prune.mjs (ESM, so it is imported dynamically). The test holds no cases of
// its own.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const { loadExamples } = require('../algo-docs/load-examples.cjs');

const PRUNE_URL = pathToFileURL(path.resolve(__dirname, '..', 'claude-docker', 'prune.mjs')).href;

for (const row of loadExamples('sandbox-prune-classification')) {
  test(row.id, async () => {
    const { classifyPruneCandidate } = await import(PRUNE_URL);
    const result = classifyPruneCandidate(row.input.sandbox, row.input.opts);
    const actual = {};
    for (const key of Object.keys(row.expected)) actual[key] = result[key];
    assert.deepEqual(actual, row.expected, row.note);
  });
}
