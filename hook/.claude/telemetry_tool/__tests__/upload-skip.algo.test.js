'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/hook-upload-skip.md against `upload-skip.js`:
 * `decideUploadSkip`, `canResumePending` and `paramsSha256`; and against `append-upload.js`:
 * `planAppend`, `stateAfterFull` and `chooseAppendEncoding`. In the rows a JSON `null` stands for
 * an absent value (`oldSize`, `v2`, `entry`). Append rows give text (`file`, `state.sha256Of`);
 * the test hashes it and checks every returned `sha256` against the file's prefix.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const crypto = require('crypto');
const { decideUploadSkip, canResumePending, paramsSha256 } = require('../upload-skip');
const { planAppend, stateAfterFull, chooseAppendEncoding } = require('../append-upload');

const orUndefined = (v) => (v === null ? undefined : v);
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

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
      case 'append': {
        const buf = Buffer.from(rest.file, 'utf8');
        const state = rest.state === null ? null : {
          bytes: rest.state.bytes,
          lines: rest.state.lines,
          sha256: sha256Hex(Buffer.from(rest.state.sha256Of, 'utf8')),
        };
        const plan = planAppend({ buf, state, appendOff: rest.appendOff, pendingChunked: rest.pendingChunked });
        const actual = { kind: plan.kind };
        if (plan.reason !== undefined) actual.reason = plan.reason;
        if (plan.startLine !== undefined) actual.startLine = plan.startLine;
        if (plan.delta !== undefined) actual.delta = plan.delta.toString('utf8');
        if (plan.newState !== undefined) {
          actual.newState = { bytes: plan.newState.bytes, lines: plan.newState.lines };
          assert.equal(plan.newState.sha256, sha256Hex(buf.subarray(0, plan.newState.bytes)), 'newState.sha256');
        }
        assert.deepEqual(actual, row.expected);
        break;
      }
      case 'append-state': {
        const buf = Buffer.from(rest.file, 'utf8');
        const state = stateAfterFull(buf);
        if (state !== null) {
          assert.equal(state.sha256, sha256Hex(buf.subarray(0, state.bytes)), 'state.sha256');
        }
        assert.deepEqual({ state: state === null ? null : { bytes: state.bytes, lines: state.lines } }, row.expected);
        break;
      }
      case 'append-encoding':
        assert.deepEqual({ encoding: chooseAppendEncoding(rest) }, row.expected);
        break;
      default:
        throw new Error(`${row.id}: unknown input.kind ${JSON.stringify(kind)}`);
    }
  });
}
