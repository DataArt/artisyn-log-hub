'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/advisor-evidence.md: per-call pricing, cache
 * rebuild detection, prompt cost attribution (advisor-evidence.js) and queued prompts in
 * buildPromptTurns (post-turn-analysis-worker.js). Each row's `input.kind` picks the function.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { makePricer, collectCalls, cacheRebuilds, buildPromptCosts } = require('../advisor-evidence');
const worker = require('../post-turn-analysis-worker');

const START_MS = Date.parse('2026-11-01T10:00:00.000Z');
const OPUS = 'claude-opus-5-5';
const helpers = {
  isQualifyingUserEvent: worker.isQualifyingUserEvent,
  getPromptText: worker.getPromptText,
  isCommandMessagePrompt: worker.isCommandMessagePrompt,
};

const round = (v) => Math.round(v * 1e6) / 1e6;

function assistant(index, model, usage, t) {
  return {
    type: 'assistant',
    timestamp: new Date(START_MS + (t ?? index) * 1000).toISOString(),
    message: { id: `msg-${index}`, model, content: [], usage },
  };
}

/** The doc's call shape `{t, model, input, read, write5m, write1h}` as a transcript entry. */
function callEntry(c, index) {
  const w5 = c.write5m || 0;
  const w1 = c.write1h || 0;
  return assistant(index, c.model, {
    input_tokens: c.input || 0,
    cache_read_input_tokens: c.read || 0,
    cache_creation_input_tokens: w5 + w1,
    cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
  }, c.t);
}

/** The doc's prompt-event shape as transcript entries. */
function eventEntry(e, index) {
  if ('user' in e) return { type: 'user', timestamp: new Date(START_MS).toISOString(), message: { role: 'user', content: e.user } };
  if ('meta' in e) return { type: 'user', isMeta: true, message: { role: 'user', content: e.meta } };
  if ('queued' in e) {
    return {
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: e.queued, ...(e.origin ? { origin: { kind: e.origin } } : { origin: { kind: 'human' } }) },
    };
  }
  if (e.notification) return { type: 'user', message: { role: 'user', content: '<task-notification>done</task-notification>' } };
  if (e.compact) return { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } };
  return assistant(index, OPUS, { cache_read_input_tokens: e.call });
}

const listPricer = () => makePricer(null, worker.pickCallRates);

const run = {
  price(input) {
    const parts = makePricer(input.pricing || null, worker.pickCallRates).price(input.model, input.usage);
    return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, round(v)]));
  },
  rebuilds(input) {
    const calls = collectCalls(input.calls.map(callEntry), listPricer());
    return cacheRebuilds(calls).map((r) => ({ ...r, extraUsd: round(r.extraUsd) }));
  },
  prompts(input, expected) {
    const entries = input.events.map(eventEntry);
    const prompts = buildPromptCosts(entries, collectCalls(entries, listPricer()), helpers);
    // Compare only the keys each expected row lists.
    return prompts.map((p, i) => {
      const keys = expected[i] ? Object.keys(expected[i]) : Object.keys(p);
      return Object.fromEntries(keys.map((k) => [k, k === 'usd' ? round(p[k]) : p[k]]));
    });
  },
  turns(input) {
    return worker.buildPromptTurns(input.events.map(eventEntry)).map((t) => t.text);
  },
};

for (const row of loadExamples('advisor-evidence')) {
  test(row.id, () => {
    assert.deepEqual(run[row.input.kind](row.input, row.expected), row.expected);
  });
}
