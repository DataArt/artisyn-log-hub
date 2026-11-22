'use strict';

/**
 * Table test for docs/knowledgebase/algorithms/okf-snapshot.md against the hook's OKF snapshot
 * builder (`buildOkfSnapshot`) and snapshot id (`computeOkfSnapshotId`).
 *
 * Each row's `kind` ("detect" | "compare" | "order" | "meta" | "id") picks one of the input shapes the doc
 * describes (see its "Examples" prose). This file only materialises the virtual file tree under a
 * fresh `<tmp>/repo` (a `../` key lands beside it, outside the repository), runs `git init` there
 * unless the row says `"git": false`, and dispatches; the doc is the only place the numbers live.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadExamples } = require('../../../../scripts/algo-docs/load-examples.cjs');
const { buildOkfSnapshot, computeOkfSnapshotId, parseOkfFrontMatter } = require('../okf-snapshot');

let dirCounter = 0;

/**
 * Writes `tree` under a fresh `<tmp>/repo` and returns that project root.
 * @param {{ tree: Record<string, string>, mtimeOverride?: Record<string, number> }} spec
 * @param {boolean} git - run `git init` in the project root
 */
function materialise(spec, git) {
  dirCounter += 1;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `okf-algo-${dirCounter}-`));
  const projectRoot = path.join(base, 'repo');
  fs.mkdirSync(projectRoot, { recursive: true });
  if (git) {
    const init = spawnSync('git', ['init', '-q'], { cwd: projectRoot });
    assert.equal(init.status, 0, 'git init failed');
  }
  for (const [rel, content] of Object.entries(spec.tree)) {
    const filePath = path.join(projectRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  for (const [rel, mtimeMs] of Object.entries(spec.mtimeOverride || {})) {
    const filePath = path.join(projectRoot, ...rel.split('/'));
    const seconds = mtimeMs / 1000;
    fs.utimesSync(filePath, seconds, seconds);
  }
  return { base, projectRoot };
}

/**
 * Builds the snapshot of one materialised tree. Without git, `GIT_CEILING_DIRECTORIES` stops git
 * from discovering a repository above the temp directory, so the row stays "outside any git
 * repository" even when the system temp folder itself lives inside one.
 */
function snapshotOf(spec, { git = true, config } = {}) {
  const { base, projectRoot } = materialise(spec, git);
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  if (!git) process.env.GIT_CEILING_DIRECTORIES = base;
  try {
    const snapshot = buildOkfSnapshot({ projectRoot, config });
    assert.ok(snapshot, 'buildOkfSnapshot returned null');
    return snapshot;
  } finally {
    if (!git) {
      if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function runDetectRow(input, expected) {
  const snapshot = snapshotOf(input, { git: input.git !== false, config: input.config });
  assert.match(snapshot.okfSnapshotId, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    snapshot.bundles.map((b) => ({ root: b.root, index: b.index, files: b.files.map((f) => f.path) })),
    expected.bundles,
  );
  assert.deepEqual(
    snapshot.bundles.flatMap((b) => b.files.filter((f) => f.ignored).map((f) => f.path)),
    expected.ignored,
  );
  assert.deepEqual(
    snapshot.bundles.filter((b) => b.ignored).map((b) => b.root),
    expected.ignoredBundles,
  );
  // OKF v0.3 DD-H1: the three bundle fields of each listed root, exactly (a key missing from the
  // expectation must be missing from the bundle).
  for (const [root, fields] of Object.entries(expected.bundleFields || {})) {
    const bundle = snapshot.bundles.find((b) => b.root === root);
    assert.ok(bundle, `bundle ${root} not detected`);
    const actual = {};
    for (const key of BUNDLE_FIELD_KEYS) {
      if (bundle[key] !== undefined) actual[key] = bundle[key];
    }
    assert.deepEqual(actual, fields, `bundle fields of ${root}`);
  }
  // OKF v0.3 DD-H3: each listed file's `meta` as a subset; a `null` value means "key absent".
  const filesByPath = new Map(snapshot.bundles.flatMap((b) => b.files.map((f) => [f.path, f])));
  for (const [filePath, meta] of Object.entries(expected.fileMeta || {})) {
    const file = filesByPath.get(filePath);
    assert.ok(file, `file ${filePath} not in the snapshot`);
    assert.ok(file.meta && typeof file.meta === 'object', `file ${filePath} has no meta`);
    for (const [key, value] of Object.entries(meta)) {
      if (value === null) assert.ok(!(key in file.meta), `meta.${key} of ${filePath} should be absent`);
      else assert.deepEqual(file.meta[key], value, `meta.${key} of ${filePath}`);
    }
  }
}

/** The bundle fields a `detect` row's `expected.bundleFields` compares (DD-H1). */
const BUNDLE_FIELD_KEYS = ['okfVersion', 'title', 'description'];

/**
 * `meta` row (DD-H2): `parseOkfFrontMatter(input.head)`; every key of `expected` is compared, so a
 * row pins `fields` exactly and the booleans it lists.
 */
function runMetaRow(input, expected) {
  const parsed = parseOkfFrontMatter(input.head);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(parsed[key], value, `parseOkfFrontMatter().${key}`);
  }
}

/** `id` row (DD-H4): `computeOkfSnapshotId(input.bundles)` equals `expected.id` / differs from `expected.differsFrom`. */
function runIdRow(input, expected) {
  const id = computeOkfSnapshotId(input.bundles);
  assert.match(id, /^[0-9a-f]{64}$/);
  if (expected.id !== undefined) assert.equal(id, expected.id);
  if (expected.differsFrom !== undefined) assert.notEqual(id, expected.differsFrom);
}

function runCompareRow(input, expected) {
  const before = snapshotOf(input.before);
  const after = snapshotOf(input.after);
  assert.equal(before.okfSnapshotId === after.okfSnapshotId, expected.sameId);
}

function runOrderRow(input, expected) {
  const id = computeOkfSnapshotId(input.bundles);
  const reversed = [...input.bundles]
    .reverse()
    .map((b) => ({ ...b, files: [...b.files].reverse() }));
  assert.equal(id === computeOkfSnapshotId(reversed), expected.sameId);
  assert.equal(id, expected.id);
}

for (const row of loadExamples('okf-snapshot')) {
  test(row.id, () => {
    if (row.kind === 'compare') {
      runCompareRow(row.input, row.expected);
    } else if (row.kind === 'order') {
      runOrderRow(row.input, row.expected);
    } else if (row.kind === 'meta') {
      runMetaRow(row.input, row.expected);
    } else if (row.kind === 'id') {
      runIdRow(row.input, row.expected);
    } else {
      assert.equal(row.kind, 'detect', `unknown kind ${row.kind}`);
      runDetectRow(row.input, row.expected);
    }
  });
}
