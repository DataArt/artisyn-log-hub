'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/hook-upload-skip.md against `upload-skip.js`:
 * `decideUploadSkip`, `canResumePending` and `paramsSha256`. In the rows a JSON `null` stands for
 * an absent value (`oldSize`, `v2`, `entry`).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { decideUploadSkip, canResumePending, paramsSha256 } = require('../upload-skip');

const orUndefined = (v) => (v === null ? undefined : v);

for (const row of loadExamples('hook-upload-skip')) {
  test(row.id, () => {
    const { kind, ...rest } = row.input;
    switch (kind) {
      case 'skip':
        assert.deepEqual(decideUploadSkip({
          ...rest,
          oldSize: orUndefined(rest.oldSize),
          v2: orUndefined(rest.v2),
        }), row.expected);
        break;
      case 'resume':
        assert.deepEqual({ resume: canResumePending(orUndefined(rest.entry), rest.totalSize, rest.sha256) }, row.expected);
        break;
      case 'params':
        assert.deepEqual({ equal: paramsSha256(rest.params) === paramsSha256(rest.other) }, row.expected);
        break;
      default:
        throw new Error(`${row.id}: unknown input.kind ${JSON.stringify(kind)}`);
    }
  });
}
