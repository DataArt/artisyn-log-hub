'use strict';

// Algorithm docs (impl-plan DD H2): scripts/algo-docs/load-examples.cjs reads the rows file
// docs/algorithm-examples/<name>.json of docs/knowledgebase/algorithms/<name>.md for the
// table-driven tests. These tests pin its contract: rows come back in file order, every malformed
// rows file throws instead of silently yielding zero test cases, and docs and rows files pair up
// one to one with no table left inside a doc.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');

const { loadExamples, parseExamples, findInlineExamplesBlocks, findRepoRoot } = require('../algo-docs/load-examples.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALGORITHMS_DIR = path.join(REPO_ROOT, 'docs', 'knowledgebase', 'algorithms');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'docs', 'algorithm-examples');
/** Files in the algorithms directory that describe the format rather than an algorithm. */
const NON_ALGORITHM_DOCS = new Set(['README.md']);

const FENCE = '```';

function row(id, extra) {
  return { id, input: { x: id }, expected: { y: id }, note: `derived ${id}`, ...extra };
}

/** A temp repo root holding docs/algorithm-examples/<name>.json files. */
function tempRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs', 'knowledgebase', 'algorithms'), { recursive: true });
  const dir = path.join(root, 'docs', 'algorithm-examples');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.json`), text);
  }
  return root;
}

describe('loadExamples', () => {
  test('returns the rows in file order, from the given root', (t) => {
    const rows = [row('B-2'), row('A-1'), row('C-3')];
    const root = tempRoot(t, { sample: JSON.stringify(rows, null, 2) });
    const loaded = loadExamples('sample', { root });
    assert.deepEqual(loaded.map((r) => r.id), ['B-2', 'A-1', 'C-3']);
    assert.deepEqual(loaded, rows);
  });

  test('returns a fresh copy on every call', (t) => {
    const root = tempRoot(t, { sample: JSON.stringify([row('A')]) });
    const first = loadExamples('sample', { root });
    first[0].expected = 'mutated';
    assert.deepEqual(loadExamples('sample', { root })[0].expected, { y: 'A' });
  });

  test('editing a row in the rows file changes what the loader returns', (t) => {
    const root = tempRoot(t, { sample: JSON.stringify([row('A', { expected: 1 })]) });
    assert.equal(loadExamples('sample', { root })[0].expected, 1);
    const file = path.join(root, 'docs', 'algorithm-examples', 'sample.json');
    fs.writeFileSync(file, JSON.stringify([row('A', { expected: 2 })]));
    assert.equal(loadExamples('sample', { root })[0].expected, 2);
  });

  test('throws when the rows file does not exist', (t) => {
    const root = tempRoot(t, {});
    assert.throws(() => loadExamples('missing', { root }), /cannot read .*missing\.json/);
  });

  test('rejects a name that is not a slug', () => {
    for (const bad of ['../secrets', 'a/b', 'Cost', '', 'x.md', null]) {
      assert.throws(() => loadExamples(bad), /invalid doc name/, String(bad));
    }
  });

  test('error messages carry the rows file path', (t) => {
    const root = tempRoot(t, { broken: '[{' });
    assert.throws(() => loadExamples('broken', { root }), (err) => err.message.includes(path.join('algorithm-examples', 'broken.json')));
  });

  test('without options it resolves the real repo root', () => {
    // A missing rows file's error names the path it looked at, which must be under the real repo root.
    assert.throws(
      () => loadExamples('no-such-algorithm-doc'),
      (err) => err.message.includes(path.join(REPO_ROOT, 'docs', 'algorithm-examples', 'no-such-algorithm-doc.json')),
    );
  });
});

describe('parseExamples', () => {
  test('parses CRLF JSON', () => {
    const rows = parseExamples(JSON.stringify([row('A'), row('B')], null, 2).replace(/\n/g, '\r\n'));
    assert.deepEqual(rows.map((r) => r.id), ['A', 'B']);
  });

  test('throws on broken JSON', () => {
    assert.throws(() => parseExamples('[{"id": "A",]', 'x.json'), /x\.json: not valid JSON/);
  });

  test('throws when the rows are not an array', () => {
    assert.throws(() => parseExamples(JSON.stringify(row('A'))), /must be a JSON array/);
  });

  test('throws when there are no rows', () => {
    assert.throws(() => parseExamples('[]'), /has no rows/);
  });

  test('throws on a duplicate id', () => {
    assert.throws(() => parseExamples(JSON.stringify([row('A'), row('B'), row('A')])), /row 3: duplicate id "A"/);
  });

  test('throws on a row that is not an object or has no id', () => {
    assert.throws(() => parseExamples('[1]'), /row 1 is not an object/);
    assert.throws(() => parseExamples(JSON.stringify([{ input: 1, expected: 1, note: 'n' }])), /row 1 has no string "id"/);
  });

  test('throws on a row without input, expected or note', () => {
    const { input: _i, ...noInput } = row('A');
    const { expected: _e, ...noExpected } = row('A');
    assert.throws(() => parseExamples(JSON.stringify([noInput])), /\("A"\) has no "input"/);
    assert.throws(() => parseExamples(JSON.stringify([noExpected])), /\("A"\) has no "expected"/);
    assert.throws(() => parseExamples(JSON.stringify([row('A', { note: ' ' })])), /\("A"\) has no "note"/);
  });

  test('null and false are valid input/expected values', () => {
    const rows = parseExamples(JSON.stringify([row('A', { input: null, expected: false })]));
    assert.equal(rows[0].input, null);
    assert.equal(rows[0].expected, false);
  });
});

describe('findInlineExamplesBlocks', () => {
  test('finds a table left inside a doc, CRLF too', () => {
    const text = ['# Title', '## Examples', `${FENCE}examples`, '[]', FENCE].join('\r\n');
    assert.deepEqual(findInlineExamplesBlocks(text), [3]);
  });

  test('ignores other fences and an examples fence nested in a longer one', () => {
    const text = ['# Title', '````markdown', `${FENCE}examples`, '[]', FENCE, '````', `${FENCE}json`, '[]', FENCE].join('\n');
    assert.deepEqual(findInlineExamplesBlocks(text), []);
  });

  test('throws on a fence that is never closed', () => {
    assert.throws(() => findInlineExamplesBlocks(`## Examples\n${FENCE}examples\n[]\n`, 'x.md'), /x\.md: fence opened on line 2 is never closed/);
  });
});

describe('findRepoRoot', () => {
  test('finds the directory holding .git', () => {
    assert.equal(findRepoRoot(__dirname), REPO_ROOT);
    assert.equal(findRepoRoot(), REPO_ROOT);
  });

  test('falls back to the directory holding docs/knowledgebase/algorithms', (t) => {
    const root = tempRoot(t, {});
    const deep = path.join(root, 'scripts', 'algo-docs');
    fs.mkdirSync(deep, { recursive: true });
    // Only meaningful when no .git sits above the temp dir.
    let gitAbove = false;
    for (let dir = root; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) gitAbove = true;
      if (path.dirname(dir) === dir) break;
    }
    if (gitAbove) {
      t.skip('a .git directory sits above the temp dir');
      return;
    }
    assert.equal(findRepoRoot(deep), root);
  });
});

describe('the repo\'s algorithm docs', () => {
  const docNames = fs
    .readdirSync(ALGORITHMS_DIR)
    .filter((f) => f.endsWith('.md') && !NON_ALGORITHM_DOCS.has(f))
    .map((f) => f.slice(0, -3));
  const rowFileNames = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));

  test('every doc in docs/knowledgebase/algorithms has a loadable rows file', () => {
    for (const name of docNames) {
      assert.ok(loadExamples(name).length > 0, name);
    }
  });

  test('every rows file has its doc', () => {
    const docs = new Set(docNames);
    assert.deepEqual(rowFileNames.filter((n) => !docs.has(n)), []);
  });

  test('no doc keeps an ```examples table inline (rows belong in docs/algorithm-examples/)', () => {
    for (const name of docNames) {
      const file = path.join(ALGORITHMS_DIR, `${name}.md`);
      const lines = findInlineExamplesBlocks(fs.readFileSync(file, 'utf8'), file);
      assert.deepEqual(lines, [], `${name}.md: move the table to docs/algorithm-examples/${name}.json`);
    }
  });
});
