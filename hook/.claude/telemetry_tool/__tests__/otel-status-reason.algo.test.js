'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/otel-status-reason.md against `otel-status.js`:
 * `resolveEffectiveOtel`, `deriveConfigWarnings`, `deriveState`, `deriveReason` and
 * `shouldWriteStatus`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const {
  resolveEffectiveOtel,
  deriveConfigWarnings,
  deriveState,
  deriveReason,
  shouldWriteStatus,
} = require('../otel-status');

function runEffective(input) {
  const result = resolveEffectiveOtel(input.scopes, input.claudeVersion);
  const effective = Object.fromEntries(Object.entries(result.effective).map(([key, value]) => [key, value.scope]));
  return {
    projectScopeHonored: result.projectScopeHonored,
    effective,
    ignored: result.ignored,
    projectOnlyKeys: result.projectOnlyKeys,
  };
}

/** The fields of `actual` named in `expected` — a row lists only what it checks. */
function pick(actual, expected) {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
}

for (const row of loadExamples('otel-status-reason')) {
  test(row.id, () => {
    const { kind, ...rest } = row.input;
    switch (kind) {
      case 'effective':
        assert.deepEqual(pick(runEffective(rest), row.expected), row.expected);
        break;
      case 'warnings': {
        const warnings = deriveConfigWarnings({
          effective: resolveEffectiveOtel(rest.scopes, rest.claudeVersion),
          userEnv: rest.scopes && rest.scopes.user,
          forwardMode: rest.forwardMode,
          sharedPort: rest.sharedPort,
        });
        assert.deepEqual({ warnings }, row.expected);
        break;
      }
      case 'state':
        assert.deepEqual({ state: deriveState(rest.received, rest.signals) }, row.expected);
        break;
      case 'reason':
        assert.deepEqual({ reason: deriveReason(rest) }, row.expected);
        break;
      case 'write':
        assert.deepEqual({ write: shouldWriteStatus(rest.phase, rest.prev, rest.next) }, row.expected);
        break;
      default:
        throw new Error(`${row.id}: unknown input.kind ${JSON.stringify(kind)}`);
    }
  });
}
