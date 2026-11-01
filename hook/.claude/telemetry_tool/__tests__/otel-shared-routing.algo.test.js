'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/otel-shared-routing.md against the shared receiver's
 * `routeRecord`, `normalizeSignals`, the pending spool, `validateRegisterPayload`,
 * `forwardHeaders`, `forwardHealth` and `forwardBackoffMs`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const {
  routeRecord,
  parseReposFile,
  normalizeSignals,
  addPending,
  takePending,
  pendingSpool,
  validateRegisterPayload,
  forwardHeaders,
  forwardHealth,
  forwardBackoffMs,
} = require('../otel-receiver');

const UPLOADER_NAME = 'send-logs-hook.js';

/** Drop the keys whose value is `undefined`. */
function defined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined));
}

function runRoute(input) {
  const decision = routeRecord({
    sessionId: input.sessionId ?? null,
    signal: input.signal,
    repoAttr: input.repoAttr ?? null,
    entry: input.entry ?? null,
    repos: parseReposFile({ repos: input.repos || [] }),
  });
  return defined({
    action: decision.action,
    via: decision.via,
    reason: decision.reason,
    key: decision.key,
    repoKey: decision.target ? decision.target.repoKey : undefined,
  });
}

function resetSpool() {
  pendingSpool.records = [];
  pendingSpool.expired = 0;
  pendingSpool.overflow = 0;
}

function runSpool(input) {
  resetSpool();
  try {
    for (const add of input.adds) {
      const items = [];
      for (let i = 0; i < add.count; i++) {
        items.push({ key: add.key, sessionId: add.key, repoAttr: null, signal: 'logs', line: {}, at: add.at });
      }
      addPending(items, add.at);
    }
    const taken = takePending(input.take, input.now);
    return {
      taken: taken.length,
      remaining: pendingSpool.records.length,
      expired: pendingSpool.expired,
      overflow: pendingSpool.overflow,
    };
  } finally {
    resetSpool();
  }
}

function runRegister(input) {
  let tmpDir = null;
  const payload = Object.assign({}, input.payload);
  try {
    if (input.createUploader) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otel-shared-routing-'));
      fs.writeFileSync(path.join(tmpDir, UPLOADER_NAME), '');
      if (input.createUploader !== UPLOADER_NAME) fs.writeFileSync(path.join(tmpDir, input.createUploader), '');
      payload.gitRoot = tmpDir;
      payload.otelDir = path.join(tmpDir, 'otel');
      payload.uploader = path.join(tmpDir, input.createUploader);
    }
    const result = validateRegisterPayload(payload, null);
    if (!result.ok) return { ok: false, reason: result.reason };
    return {
      ok: true,
      signals: result.value.signals,
      contract: result.value.contract,
      repoKeyLength: result.value.repoKey.length,
      uploaderSet: result.value.uploader !== null,
    };
  } finally {
    // Only the temp dir this row created itself.
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** The fields of `actual` named in `expected` — a row lists only what it checks. */
function pick(actual, expected) {
  return Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
}

for (const row of loadExamples('otel-shared-routing')) {
  test(row.id, () => {
    const input = row.input;
    switch (input.kind) {
      case 'route':
        assert.deepEqual(runRoute(input), row.expected);
        break;
      case 'signals':
        assert.deepEqual(normalizeSignals(input.value), row.expected);
        break;
      case 'spool':
        assert.deepEqual(runSpool(input), row.expected);
        break;
      case 'register':
        assert.deepEqual(pick(runRegister(input), row.expected), row.expected);
        break;
      case 'forwardHeaders':
        assert.deepEqual(forwardHeaders(input.headers), row.expected);
        break;
      case 'forwardHealth':
        assert.deepEqual({ forward: forwardHealth(input.stats, input.now) }, row.expected);
        break;
      case 'forwardBackoff':
        assert.deepEqual({ delayMs: forwardBackoffMs(input.attempts) }, row.expected);
        break;
      default:
        throw new Error(`${row.id}: unknown input.kind ${JSON.stringify(input.kind)}`);
    }
  });
}
