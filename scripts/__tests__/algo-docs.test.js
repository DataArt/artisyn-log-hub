'use strict';

// Algorithm docs (impl-plan DD H2): scripts/algo-docs/load-examples.cjs reads the single
// ```examples block of docs/knowledgebase/algorithms/<name>.md for the table-driven tests. These
// tests pin its contract: rows come back in doc order, and every malformed doc throws instead of
// silently yielding zero test cases.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');

const { loadExamples, parseExamples, findRepoRoot } = require('../algo-docs/load-examples.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALGORITHMS_DIR = path.join(REPO_ROOT, 'docs', 'knowledgebase', 'algorithms');
/** Files in the algorithms directory that describe the format rather than an algorithm. */
const NON_ALGORITHM_DOCS = new Set(['README.md']);

const FENCE = '```';

function row(id, extra) {
  return { id, input: { x: id }, expected: { y: id }, note: `derived ${id}`, ...extra };
}

/** A minimal valid doc around the given examples block body. */
function doc(blockBody, { before = '', after = '' } = {}) {
  return [
    '---',
    'reviewed: not yet',
    '---',
    '',
    '# Sample algorithm',
    '',
    before,
    '## Examples',
    '',
    `${FENCE}examples`,
    blockBody,
    FENCE,
    '',
    after,
    '## Mutations',
    '',
    '- off by one',
    '',
  ].join('\n');
}

/** A temp repo root holding docs/knowledgebase/algorithms/<name>.md files. */
function tempRoot(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'docs', 'knowledgebase', 'algorithms');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.md`), text);
  }
  return root;
}

describe('loadExamples', () => {
  test('returns the rows in doc order, from the given root', (t) => {
    const rows = [row('B-2'), row('A-1'), row('C-3')];
    const root = tempRoot(t, { sample: doc(JSON.stringify(rows, null, 2)) });
    const loaded = loadExamples('sample', { root });
    assert.deepEqual(loaded.map((r) => r.id), ['B-2', 'A-1', 'C-3']);
    assert.deepEqual(loaded, rows);
  });

  test('returns a fresh copy on every call', (t) => {
    const root = tempRoot(t, { sample: doc(JSON.stringify([row('A')])) });
    const first = loadExamples('sample', { root });
    first[0].expected = 'mutated';
    assert.deepEqual(loadExamples('sample', { root })[0].expected, { y: 'A' });
  });

  test('editing a row in the doc changes what the loader returns', (t) => {
    const root = tempRoot(t, { sample: doc(JSON.stringify([row('A', { expected: 1 })])) });
    assert.equal(loadExamples('sample', { root })[0].expected, 1);
    const file = path.join(root, 'docs', 'knowledgebase', 'algorithms', 'sample.md');
    fs.writeFileSync(file, doc(JSON.stringify([row('A', { expected: 2 })])));
    assert.equal(loadExamples('sample', { root })[0].expected, 2);
  });

  test('throws when the doc does not exist', (t) => {
    const root = tempRoot(t, {});
    assert.throws(() => loadExamples('missing', { root }), /cannot read .*missing\.md/);
  });

  test('rejects a name that is not a slug', () => {
    for (const bad of ['../secrets', 'a/b', 'Cost', '', 'x.md', null]) {
      assert.throws(() => loadExamples(bad), /invalid doc name/, String(bad));
    }
  });

  test('error messages carry the doc path', (t) => {
    const root = tempRoot(t, { broken: doc('[{') });
    assert.throws(() => loadExamples('broken', { root }), (err) => err.message.includes(path.join('algorithms', 'broken.md')));
  });

  test('without options it resolves the real repo root', () => {
    // A missing doc's error names the path it looked at, which must be under the real repo root.
    assert.throws(
      () => loadExamples('no-such-algorithm-doc'),
      (err) => err.message.includes(path.join(REPO_ROOT, 'docs', 'knowledgebase', 'algorithms', 'no-such-algorithm-doc.md')),
    );
  });
});

describe('parseExamples', () => {
  test('parses a CRLF doc', () => {
    const rows = parseExamples(doc(JSON.stringify([row('A'), row('B')], null, 2)).replace(/\n/g, '\r\n'));
    assert.deepEqual(rows.map((r) => r.id), ['A', 'B']);
  });

  test('throws when there is no examples block', () => {
    const text = doc('[]').replace(`${FENCE}examples`, `${FENCE}json`);
    assert.throws(() => parseExamples(text, 'x.md'), /x\.md: no ```examples block/);
  });

  test('throws when the doc has no Examples section at all', () => {
    assert.throws(() => parseExamples('# Title\n\nJust prose.\n'), /no ```examples block/);
  });

  test('throws on broken JSON', () => {
    assert.throws(() => parseExamples(doc('[{"id": "A",]'), 'x.md'), /x\.md: the ```examples block \(line \d+\) is not valid JSON/);
  });

  test('throws when the block is not an array', () => {
    assert.throws(() => parseExamples(doc(JSON.stringify(row('A')))), /must be a JSON array/);
  });

  test('throws when the block has no rows', () => {
    assert.throws(() => parseExamples(doc('[]')), /has no rows/);
  });

  test('throws on more than one examples block', () => {
    const extra = `${FENCE}examples\n${JSON.stringify([row('Z')])}\n${FENCE}\n`;
    assert.throws(() => parseExamples(doc(JSON.stringify([row('A')]), { after: extra })), /2 ```examples blocks/);
  });

  test('throws when the block is not under "## Examples"', () => {
    const text = [
      '# Title',
      '## Rules',
      `${FENCE}examples`,
      JSON.stringify([row('A')]),
      FENCE,
    ].join('\n');
    assert.throws(() => parseExamples(text), /not under a "## Examples" heading/);
  });

  test('a "##" line inside another fence is not a heading', () => {
    // The "## Examples" inside the markdown sample must not count; the real block is under ## Rules.
    const text = [
      '# Title',
      '## Rules',
      `${FENCE}markdown`,
      '## Examples',
      FENCE,
      `${FENCE}examples`,
      JSON.stringify([row('A')]),
      FENCE,
    ].join('\n');
    assert.throws(() => parseExamples(text), /not under a "## Examples" heading/);
  });

  test('a ### subsection inside Examples and a longer outer fence are fine', () => {
    const text = [
      '# Title',
      '## Examples',
      '### Input shape',
      'Prose.',
      '````text',
      '```',
      'a nested fence line',
      '````',
      '~~~examples title="ignored"',
      JSON.stringify([row('A')]),
      '~~~',
    ].join('\n');
    assert.deepEqual(parseExamples(text).map((r) => r.id), ['A']);
  });

  test('throws on a fence that is never closed', () => {
    assert.throws(() => parseExamples(`## Examples\n${FENCE}examples\n[]\n`), /never closed/);
  });

  test('throws on a duplicate id', () => {
    assert.throws(() => parseExamples(doc(JSON.stringify([row('A'), row('B'), row('A')]))), /row 3: duplicate id "A"/);
  });

  test('throws on a row that is not an object or has no id', () => {
    assert.throws(() => parseExamples(doc('[1]')), /row 1 is not an object/);
    assert.throws(() => parseExamples(doc(JSON.stringify([{ input: 1, expected: 1, note: 'n' }]))), /row 1 has no string "id"/);
  });

  test('throws on a row without input, expected or note', () => {
    const { input: _i, ...noInput } = row('A');
    const { expected: _e, ...noExpected } = row('A');
    assert.throws(() => parseExamples(doc(JSON.stringify([noInput]))), /\("A"\) has no "input"/);
    assert.throws(() => parseExamples(doc(JSON.stringify([noExpected]))), /\("A"\) has no "expected"/);
    assert.throws(() => parseExamples(doc(JSON.stringify([row('A', { note: ' ' })]))), /\("A"\) has no "note"/);
  });

  test('null and false are valid input/expected values', () => {
    const rows = parseExamples(doc(JSON.stringify([row('A', { input: null, expected: false })])));
    assert.equal(rows[0].input, null);
    assert.equal(rows[0].expected, false);
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
  test('every doc in docs/knowledgebase/algorithms has a loadable examples block', () => {
    const names = fs
      .readdirSync(ALGORITHMS_DIR)
      .filter((f) => f.endsWith('.md') && !NON_ALGORITHM_DOCS.has(f))
      .map((f) => f.slice(0, -3));
    for (const name of names) {
      assert.ok(loadExamples(name).length > 0, name);
    }
  });
});
