'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/node-version-check.md against `node-version-check.js`:
 * `classifyNodeVersion`, `nodeWarningText`, `shouldShowNodeWarning` and `effectiveNodeVersion`.
 * The installer twin (`artisyn-hooks-installer/src/node-version.ts`) is not run here (TS); the doc
 * names it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const {
  classifyNodeVersion,
  nodeWarningText,
  shouldShowNodeWarning,
  effectiveNodeVersion,
} = require('../node-version-check');

for (const row of loadExamples('node-version-check')) {
  test(row.id, () => {
    const { kind, ...rest } = row.input;
    switch (kind) {
      case 'classify':
        assert.deepEqual(classifyNodeVersion(rest.version), row.expected);
        break;
      case 'text':
        assert.deepEqual({ text: nodeWarningText(rest.version) }, row.expected);
        break;
      case 'throttle':
        assert.deepEqual({ show: shouldShowNodeWarning(rest.state, rest.version, rest.now) }, row.expected);
        break;
      case 'effective': {
        const expected = row.expected.version === '$process' ? process.versions.node : row.expected.version;
        assert.deepEqual({ version: effectiveNodeVersion(rest.env) }, { version: expected });
        break;
      }
      default:
        throw new Error(`${row.id}: unknown input.kind ${JSON.stringify(kind)}`);
    }
  });
}
