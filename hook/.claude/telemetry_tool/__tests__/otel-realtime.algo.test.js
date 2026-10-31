'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/otel-realtime-backoff.md against the receiver's
 * `nextRealtimeDelay`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { nextRealtimeDelay } = require('../otel-receiver');

for (const row of loadExamples('otel-realtime-backoff')) {
  test(row.id, () => {
    assert.deepEqual({ delayMs: nextRealtimeDelay(row.input.failures) }, row.expected);
  });
}
