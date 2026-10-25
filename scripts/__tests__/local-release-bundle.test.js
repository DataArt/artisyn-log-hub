'use strict';

// Exercises the pure helpers exported from scripts/local-release-bundle.js: the
// UTC bundle stamp, the bundle/tar/zip naming, the BUNDLE_ARCHS narrowing and
// the "other architecture" lookup that the bundle's INSTALL.md points the
// reader at.
//
// Everything here is deliberately docker-free — the script's build path shells
// out to `docker buildx`, which no unit test should ever start. Requiring the
// module is safe on its own: all of its work sits behind `require.main ===
// module`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const BUNDLE_JS = require.resolve('../local-release-bundle.js');

const {
  BUNDLE_STAMP_RE,
  DEFAULT_BUNDLE_ARCHS,
  bundleStamp,
  resolveBundleStamp,
  bundleName,
  imageFileName,
  zipFileName,
  otherTarget,
  selectedTargets,
} = require('../local-release-bundle.js');

const ROOT = path.join(__dirname, '..', '..');
const STAMP = '20260918-142233';

describe('bundle stamp', () => {
  test('is a 15-character YYYYMMDD-HHMMSS UTC string', () => {
    const stamp = bundleStamp();
    assert.match(stamp, BUNDLE_STAMP_RE);
    assert.equal(stamp.length, 15);
    // The generated value has to agree with the pattern a BUNDLE_STAMP passed
    // in is validated against.
    assert.match(stamp, /^\d{8}-\d{6}$/);
  });

  test('a later stamp sorts after an earlier one as a plain string', (t) => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.UTC(2026, 8, 18, 14, 22, 33),
    });
    const first = bundleStamp();
    t.mock.timers.tick(1000);
    const second = bundleStamp();

    assert.equal(first, '20260918-142233');
    assert.equal(second, '20260918-142234');
    assert.notEqual(first, second);
    // Lexicographic order is the only ordering the file names carry, so it has
    // to match chronological order.
    assert.ok(first < second);
    assert.deepEqual([second, first].sort(), [first, second]);
  });

  test('reflects UTC, not the machine timezone', (t) => {
    // 23:30 UTC on the 18th is already the 19th in, say, Europe/Moscow. The
    // stamp must still read 18.
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.UTC(2026, 8, 18, 23, 30, 0),
    });
    assert.equal(bundleStamp(), '20260918-233000');
  });
});

describe('resolveBundleStamp', () => {
  test('generates a stamp when BUNDLE_STAMP is unset or empty', () => {
    assert.match(resolveBundleStamp({}), BUNDLE_STAMP_RE);
    assert.match(resolveBundleStamp({ BUNDLE_STAMP: '' }), BUNDLE_STAMP_RE);
  });

  test('uses a well-formed BUNDLE_STAMP verbatim', () => {
    assert.equal(resolveBundleStamp({ BUNDLE_STAMP: STAMP }), STAMP);
  });

  test('throws on a malformed BUNDLE_STAMP rather than regenerating one', () => {
    // A silently-regenerated stamp would produce zips whose names disagree
    // with the image's build-info.json, so this must be a hard error.
    for (const bad of [
      '2026-09-18-142233',
      '20260918142233',
      '20260918-1422',
      'latest',
      '20260918-142233-amd64',
      ' 20260918-142233',
    ]) {
      assert.throws(
        () => resolveBundleStamp({ BUNDLE_STAMP: bad }),
        /BUNDLE_STAMP must match YYYYMMDD-HHMMSS/,
        `expected "${bad}" to be rejected`,
      );
    }
  });
});

describe('bundle naming', () => {
  test('bundle, tar and zip names all share the artisyn-log-hub-<stamp>-<arch> stem', () => {
    assert.equal(bundleName(STAMP, 'amd64'), 'artisyn-log-hub-20260918-142233-amd64');
    assert.equal(
      imageFileName(STAMP, 'amd64'),
      'artisyn-log-hub-20260918-142233-amd64.tar',
    );
    assert.equal(
      zipFileName(STAMP, 'amd64'),
      'artisyn-log-hub-20260918-142233-amd64.zip',
    );
    assert.equal(
      zipFileName(STAMP, 'arm64'),
      'artisyn-log-hub-20260918-142233-arm64.zip',
    );
  });
});

describe('selectedTargets / otherTarget', () => {
  test('defaults to both architectures', () => {
    assert.equal(DEFAULT_BUNDLE_ARCHS, 'amd64,arm64');
    assert.deepEqual(
      selectedTargets({}).map((t) => t.arch),
      ['amd64', 'arm64'],
    );
    assert.deepEqual(
      selectedTargets({ BUNDLE_ARCHS: '' }).map((t) => t.arch),
      ['amd64', 'arm64'],
    );
  });

  test('narrows the build to the named architectures, ignoring whitespace', () => {
    assert.deepEqual(
      selectedTargets({ BUNDLE_ARCHS: 'amd64' }).map((t) => t.arch),
      ['amd64'],
    );
    assert.deepEqual(
      selectedTargets({ BUNDLE_ARCHS: ' arm64 , amd64 ' }).map((t) => t.arch),
      ['amd64', 'arm64'],
    );
  });

  test('rejects an unknown or empty architecture list', () => {
    assert.throws(
      () => selectedTargets({ BUNDLE_ARCHS: 'riscv' }),
      /unknown architecture/,
    );
    assert.throws(
      () => selectedTargets({ BUNDLE_ARCHS: ',' }),
      /selected no architecture/,
    );
  });

  test('the "other arch" zip name comes from the full TARGETS list, not the filtered one', () => {
    // INSTALL.md points the reader at the other architecture's bundle, even
    // when this run only built one.
    const selected = selectedTargets({ BUNDLE_ARCHS: 'amd64' });
    assert.equal(selected.length, 1);

    const other = otherTarget(selected[0].arch);
    assert.equal(other.arch, 'arm64');
    assert.equal(
      zipFileName(STAMP, other.arch),
      'artisyn-log-hub-20260918-142233-arm64.zip',
    );
    assert.equal(otherTarget('arm64').arch, 'amd64');
  });
});

describe('package.json versions are never touched', () => {
  test('requiring the module leaves every package.json byte-identical', () => {
    const paths = [
      path.join(ROOT, 'package.json'),
      path.join(ROOT, 'server', 'package.json'),
      path.join(ROOT, 'client', 'package.json'),
    ];
    const before = paths.map((p) => fs.readFileSync(p));

    delete require.cache[BUNDLE_JS];
    require('../local-release-bundle.js');

    paths.forEach((p, i) => {
      assert.ok(
        before[i].equals(fs.readFileSync(p)),
        `${p} changed when scripts/local-release-bundle.js was loaded`,
      );
    });
  });

  test('the script carries no version-bump helper and never writes a package.json', () => {
    // A local bundle is identified by its generated stamp (see
    // resolveBundleStamp); the release version lives in the root package.json
    // and this script never changes it.
    const source = fs.readFileSync(BUNDLE_JS, 'utf8');
    assert.doesNotMatch(source, /bumpVersion|bumpPatch|writeVersion/);
    assert.doesNotMatch(source, /writeFileSync\([^)]*package\.json/);
    assert.deepEqual(
      Object.keys(require('../local-release-bundle.js')).filter((k) => /bump/i.test(k)),
      [],
    );
  });
});
