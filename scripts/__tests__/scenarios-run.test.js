'use strict';

// Pure logic of the scenario runner scripts/scenarios/run.mjs (impl-plan DD C7, C14): argument
// parsing, the per-mode Playwright passes (two-pass mode B) and the dev-state fingerprints.
// Nothing here starts a stand, runs Playwright or connects to Postgres.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before } = require('node:test');

let run;

before(async () => {
  run = await import('../scenarios/run.mjs');
});

describe('parseArgs', () => {
  test('defaults: every mode, scenarios, corpus and contract steps, build on', () => {
    assert.deepEqual(run.parseArgs([]), {
      modes: ['a', 'b', 'c'],
      grep: null,
      skipBuild: false,
      only: ['scenarios', 'corpus', 'contract'],
    });
  });

  test('reads --mode, --grep, --skip-build and --only in both spellings', () => {
    const opts = run.parseArgs(['--mode', 'c,a', '--grep=@S-AUTH-01', '--skip-build', '--only', 'scenarios']);
    assert.deepEqual(opts, { modes: ['a', 'c'], grep: '@S-AUTH-01', skipBuild: true, only: ['scenarios'] });
  });

  test('the corpus step is available; an unknown step is an error', () => {
    assert.deepEqual(run.parseArgs(['--only', 'scenarios,corpus']).only, ['scenarios', 'corpus']);
    assert.deepEqual(run.parseArgs(['--only', 'corpus']).only, ['corpus']);
    assert.throws(() => run.parseArgs(['--only', 'tours']), /Unknown step/);
  });

  test('the contract step is available on its own and next to scenarios', () => {
    assert.deepEqual(run.parseArgs(['--only', 'contract']).only, ['contract']);
    assert.deepEqual(run.parseArgs(['--only=scenarios,contract']).only, ['scenarios', 'contract']);
  });

  test('rejects unknown modes, flags and missing values', () => {
    assert.throws(() => run.parseArgs(['--mode', 'd']), /Unknown stand mode/);
    assert.throws(() => run.parseArgs(['--verbose']), /Unknown argument/);
    assert.throws(() => run.parseArgs(['--grep']), /requires a value/);
  });
});

describe('contractCommand', () => {
  test('runs npm run test:contract in server/ with the runner DATABASE_URL', () => {
    const cmd = run.contractCommand('postgresql://u:p@db:5432/x');
    assert.equal(cmd.command, 'npm run test:contract');
    assert.equal(cmd.cwd, path.join(path.resolve(__dirname, '..', '..'), 'server'));
    assert.equal(cmd.env.DATABASE_URL, 'postgresql://u:p@db:5432/x');
  });
});

describe('modePasses', () => {
  test('modes a and c run once on their project', () => {
    assert.deepEqual(run.modePasses('a'), [{ label: 'a', projects: ['mode-a'], args: [] }]);
    assert.deepEqual(run.modePasses('c', 'X'), [{ label: 'c', projects: ['mode-c'], args: ['--grep', 'X'] }]);
  });

  test('with corpus, the mode-A pass also runs the corpus project; other modes do not', () => {
    assert.deepEqual(run.modePasses('a', null, { corpus: true }), [{ label: 'a', projects: ['mode-a', 'corpus'], args: [] }]);
    assert.deepEqual(run.modePasses('c', null, { corpus: true })[0].projects, ['mode-c']);
  });

  test('mode b: everything but @backoff, then only @backoff on a fresh stand', () => {
    const [main, backoff] = run.modePasses('b');
    assert.deepEqual(main.args, ['--grep-invert', '@backoff\\b']);
    assert.deepEqual(backoff.args, ['--grep', '@backoff\\b']);
    assert.equal(backoff.skipWhenEmpty, true);
  });

  test('mode b with --grep: the backoff pass must match both the user grep and the tag', () => {
    const [main, backoff] = run.modePasses('b', '@S-AUTH-0[36]');
    assert.deepEqual(main.args, ['--grep', '@S-AUTH-0[36]', '--grep-invert', '@backoff\\b']);
    const re = new RegExp(backoff.args[1]);
    assert.equal(re.test('@S-AUTH-03 wrong password @mode-b @backoff'), true);
    assert.equal(re.test('@S-AUTH-01 signup @mode-b'), false);
    assert.equal(re.test('@S-AUTH-09 something @mode-b @backoff'), false);
  });
});

describe('standPasses', () => {
  const labels = (passes) => passes.map(({ mode, pass }) => `${mode}:${pass.label}:${pass.projects.join('+')}`);

  test('scenarios,corpus over a,b,c: corpus rides on the mode-A pass', () => {
    const passes = run.standPasses({ modes: ['a', 'b', 'c'], grep: null, only: ['scenarios', 'corpus'] });
    assert.deepEqual(labels(passes), ['a:a:mode-a+corpus', 'b:b-main:mode-b', 'b:b-backoff:mode-b', 'c:c:mode-c']);
  });

  test('corpus without mode A or without scenarios gets a mode-A stand of its own', () => {
    assert.deepEqual(labels(run.standPasses({ modes: ['c'], grep: null, only: ['scenarios', 'corpus'] })), [
      'c:c:mode-c',
      'a:corpus:corpus',
    ]);
    assert.deepEqual(labels(run.standPasses({ modes: ['a', 'b'], grep: null, only: ['corpus'] })), ['a:corpus:corpus']);
  });

  test('contract only needs no stand pass', () => {
    assert.deepEqual(run.standPasses({ modes: ['a'], grep: null, only: ['contract'] }), []);
  });
});

describe('fingerprints (DD C14)', () => {
  test('dirFingerprint changes with content and with mtime, and reports a missing dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scn-run-test-'));
    try {
      assert.deepEqual(run.dirFingerprint(path.join(dir, 'nope')), { missing: true });
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'one');
      const first = run.dirFingerprint(dir);
      assert.deepEqual(Object.keys(first.mtimes), ['sub/a.txt']);
      assert.deepEqual(run.diffFingerprints('static', first, run.dirFingerprint(dir)), []);

      fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'two');
      const t = new Date(Date.now() - 60_000);
      fs.utimesSync(path.join(dir, 'sub', 'a.txt'), t, t);
      const second = run.dirFingerprint(dir);
      assert.notEqual(second.hash, first.hash);
      assert.match(run.diffFingerprints('static', first, second).join('\n'), /sub\/a\.txt changed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('contentDrift ignores an mtime-only rewrite but not a content change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scn-run-test-'));
    try {
      const file = path.join(dir, 'installer-version.json');
      fs.writeFileSync(file, '{"version":"1.0.0"}\n');
      const t = new Date(Date.now() - 60_000);
      fs.utimesSync(file, t, t);
      const first = run.dirFingerprint(dir);
      fs.writeFileSync(file, '{"version":"1.0.0"}\n');
      const rewritten = run.dirFingerprint(dir);
      assert.notDeepEqual(rewritten.mtimes, first.mtimes);
      assert.deepEqual(run.contentDrift('static', first, rewritten), []);
      fs.writeFileSync(file, '{"version":"2.0.0"}\n');
      assert.notDeepEqual(run.contentDrift('static', first, run.dirFingerprint(dir)), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diffFingerprints names tables whose row count or presence changed', () => {
    const before = { tables: [['users', '2'], ['logs', '5']] };
    const after = { tables: [['users', '3'], ['logs', '5'], ['__drizzle_migrations', '70']] };
    const diff = run.diffFingerprints('dev DB', before, after);
    assert.deepEqual(diff, ['dev DB: users rows 2 -> rows 3', 'dev DB: __drizzle_migrations absent -> rows 70']);
    assert.deepEqual(run.diffFingerprints('dev DB', before, { tables: [['users', '2'], ['logs', '5']] }), []);
  });
});
