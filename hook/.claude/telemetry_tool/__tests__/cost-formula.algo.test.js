'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/cost-formula.md against the hook's twin,
 * `computeLocalSessionCost`. Rows marked `"only": "server"` use inputs the hook never
 * receives (no pricing row, Postgres strings, null columns) and are skipped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { computeLocalSessionCost } = require('../post-turn-analysis-worker');

const TOKEN_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'webSearchRequests',
  'inputTokensFast',
  'outputTokensFast',
];

for (const row of loadExamples('cost-formula')) {
  test(row.id, { skip: row.only === 'server' && 'server-only row' }, () => {
    const tokens = {};
    for (const key of TOKEN_KEYS) tokens[key] = row.input.tokens[key] ?? 0;
    const cost = computeLocalSessionCost(tokens, row.input.pricing);
    assert.ok(Math.abs(cost - row.expected.cost) < 1e-9, `got ${cost}, doc says ${row.expected.cost}`);
  });
}
