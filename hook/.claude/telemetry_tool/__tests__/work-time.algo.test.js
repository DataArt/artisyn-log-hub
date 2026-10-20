'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/work-time.md against the hook's twin,
 * `deriveWorkTimeMs`. Rows marked `"only": "server"` pin the server's side of a difference
 * between the two (the doc lists them) and are skipped here; `"only": "hook"` rows pin the
 * hook's side.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { deriveWorkTimeMs } = require('../post-turn-analysis-worker');

const START_MS = Date.parse('2026-10-01T10:00:00.000Z');

/** One transcript entry per doc event, the same shape the server test builds. */
function toEntry(event, index) {
  const timestamp = 'ts' in event ? event.ts : new Date(START_MS + event.t * 1000).toISOString();
  if (event.assistant) {
    return {
      type: 'assistant',
      uuid: `a-${index}`,
      timestamp,
      isSidechain: 'sidechain' in event ? event.sidechain : false,
      message: { id: `msg-${index}`, model: 'claude-opus-5', content: [] },
    };
  }
  const entry = {
    type: 'user',
    uuid: `u-${index}`,
    timestamp,
    promptId: event.user,
    isSidechain: 'sidechain' in event ? event.sidechain : false,
  };
  if ('rawMessage' in event) {
    entry.message = event.rawMessage;
  } else if (!event.noMessage) {
    entry.message = {
      role: 'user',
      content: 'content' in event ? event.content : (event.text ?? 'do the task'),
    };
  }
  if ('meta' in event) entry.isMeta = event.meta;
  if ('toolUseResult' in event) {
    entry.toolUseResult = event.toolUseResult;
  } else if ('agentId' in event || event.subagentResult) {
    entry.toolUseResult = { agentId: 'agentId' in event ? event.agentId : 'agent-1' };
  }
  return entry;
}

for (const row of loadExamples('work-time')) {
  test(row.id, { skip: row.only === 'server' && 'server-only row' }, () => {
    assert.deepEqual(
      { workTimeMs: deriveWorkTimeMs(row.input.events.map(toEntry)) },
      row.expected,
    );
  });
}
