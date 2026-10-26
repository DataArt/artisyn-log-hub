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

/** Per-call keys of `deriveTokenTotals().calls` — the aggregates without web search. */
const CALL_KEYS = TOKEN_KEYS.filter((key) => key !== 'webSearchRequests');

for (const row of loadExamples('cost-formula')) {
  test(row.id, { skip: row.only === 'server' && 'server-only row' }, () => {
    const tokens = {};
    for (const key of TOKEN_KEYS) tokens[key] = row.input.tokens[key] ?? 0;
    if (Array.isArray(row.input.calls)) {
      tokens.calls = row.input.calls.map((c) => {
        const call = {};
        for (const key of CALL_KEYS) call[key] = c[key] ?? 0;
        return call;
      });
    }
    // `row.input.pricing` carries `tiers` as-is (array, null or absent), like the API response.
    const cost = computeLocalSessionCost(tokens, row.input.pricing);
    assert.ok(Math.abs(cost - row.expected.cost) < 1e-9, `got ${cost}, doc says ${row.expected.cost}`);
  });
}
