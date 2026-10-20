'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/ndjson-tolerance.md, hook side: every row with
 * `side: "hook"` runs against `sanitizeNdjson`. The server rows run in
 * server/src/logs/ndjson-parser.algo.spec.ts.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { sanitizeNdjson } = require('../ndjson-sanitize');

for (const row of loadExamples('ndjson-tolerance')) {
  test(row.id, { skip: row.input.side !== 'hook' && 'server-side row' }, () => {
    // `bodyBase64` carries raw bytes (not valid UTF-8); the result is then compared as base64 too.
    const raw = 'bodyBase64' in row.input;
    const body = raw
      ? Buffer.from(row.input.bodyBase64, 'base64')
      : Buffer.from(row.input.body, 'utf8');
    const result = sanitizeNdjson(body);
    assert.deepEqual(
      {
        [raw ? 'bodyBase64' : 'body']: result.body.toString(raw ? 'base64' : 'utf8'),
        dropped: result.dropped.map((d) => d.lineNo),
        lines: result.lines,
        unchanged: result.body === body,
      },
      row.expected,
    );
  });
}
