'use strict';

// Golden sessions (impl-plan DD D3): tests/golden/check-arithmetic.mjs re-derives every number in
// the fixtures' expected.json and in repo-gold.expected.json from the transcripts and the DD D3
// rates. This wrapper puts that check into `npm run test:scripts`, and proves the check can fail.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before } = require('node:test');

const GOLDEN = path.resolve(__dirname, '..', '..', 'tests', 'golden');

let ga;

before(async () => {
  ga = await import('../../tests/golden/check-arithmetic.mjs');
});

/** Copies tests/golden into a temp dir so a test can corrupt one literal. */
function goldenCopy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-arith-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(GOLDEN, dir, { recursive: true });
  return dir;
}

function editJson(file, mutate) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

describe('golden arithmetic', () => {
  test('every expected.json and repo-gold.expected.json agrees with the recomputation', () => {
    const { checks, failures } = ga.check();
    assert.deepEqual(failures, []);
    assert.ok(checks > 500, `only ${checks} checks ran`);
  });

  test('a wrong cost literal is reported', (t) => {
    const dir = goldenCopy(t);
    editJson(path.join(dir, 'gs-04-cache-5m-1h', 'expected.json'), (e) => {
      e.roots[0].costUsd = 1.1;
    });
    const { failures } = ga.check({ dir });
    assert.ok(failures.some((f) => f.where === 'gs-04-cache-5m-1h/gs04.costUsd' && f.expected === 1.1));
  });

  test('a wrong REPO-GOLD total is reported', (t) => {
    const dir = goldenCopy(t);
    editJson(path.join(dir, 'repo-gold.expected.json'), (e) => {
      e.cacheRatio.root = e.cacheRatio.meanOfSessionRatiosTrap;
    });
    const { failures } = ga.check({ dir });
    assert.ok(failures.some((f) => f.where === 'repo.cacheRatio.root'));
  });

  test('cost: fast mode doubles input and output, web search is per request, unknown model is null', () => {
    const t = { ...ga.emptyTokens(), input: 5000, output: 1000, inputFast: 5000, outputFast: 1000, cacheRead: 100000, cacheWrite1h: 20000, webSearch: 2 };
    assert.ok(Math.abs(ga.costUsd(t, 'claude-opus-5') - 0.37) < 1e-12);
    assert.ok(Math.abs(ga.costUsd(t, 'claude-opus-5', { fastMultiplier: 1 }) - 0.32) < 1e-12);
    assert.equal(ga.costUsd(t, 'claude-unreleased-9'), null);
  });

  test('cache ratio is n/a at a zero denominator, not 0', () => {
    assert.equal(ga.cacheRatio(0, 0), null);
    assert.equal(ga.cacheRatio(0, 10), 0);
  });

  test('concentration: the KB worked examples', () => {
    assert.deepEqual(ga.concentration({ 'srv/api': 2, 'srv/web': 1 }).score, 62);
    assert.deepEqual(ga.concentration({ 'a/b/c': 1, 'a/b/d': 1 }).score, 72);
    assert.equal(ga.concentration({}).score, null);
  });

  test('work time per day merges overlapping intervals', () => {
    const at = (hms) => Date.parse(`2026-01-06T${hms}Z`);
    const minutes = ga.mergedMinutesByDay([
      [at('10:00:00'), at('10:03:00')],
      [at('10:01:00'), at('10:03:05')],
    ]);
    assert.ok(Math.abs(minutes['2026-01-06'] - 185 / 60) < 1e-12);
  });
});
