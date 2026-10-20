'use strict';

// Exercises the pure helpers exported from scripts/release.js: the UTC release
// stamp, the bundle/tar/zip naming, the RELEASE_ARCHS narrowing and the
// "other architecture" lookup that INSTALL.md points the reader at.
//
// Everything here is deliberately docker-free — the script's build path shells
// out to `docker buildx`, which no unit test should ever start. Requiring the
// module is safe on its own: all of its work sits behind `require.main ===
// module`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const RELEASE_JS = require.resolve('../release.js');

const {
  TARGETS,
  RELEASE_STAMP_RE,
  DEFAULT_RELEASE_ARCHS,
  releaseStamp,
  resolveReleaseStamp,
  bundleName,
  imageFileName,
  zipFileName,
  otherTarget,
  selectedTargets,
} = require('../release.js');

const ROOT = path.join(__dirname, '..', '..');
const STAMP = '20260918-142233';

describe('release stamp', () => {
  test('is a 15-character YYYYMMDD-HHMMSS UTC string', () => {
    const stamp = releaseStamp();
    assert.match(stamp, RELEASE_STAMP_RE);
    assert.equal(stamp.length, 15);
    // The generated value has to agree with the pattern the CI-supplied one is
    // validated against, or a local run and a CI run would disagree.
    assert.match(stamp, /^\d{8}-\d{6}$/);
  });

  test('a later stamp sorts after an earlier one as a plain string', (t) => {
    t.mock.timers.enable({
      apis: ['Date'],
      now: Date.UTC(2026, 8, 18, 14, 22, 33),
    });
    const first = releaseStamp();
    t.mock.timers.tick(1000);
    const second = releaseStamp();

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
    assert.equal(releaseStamp(), '20260918-233000');
  });
});

describe('resolveReleaseStamp', () => {
  test('generates a stamp when RELEASE_STAMP is unset or empty', () => {
    assert.match(resolveReleaseStamp({}), RELEASE_STAMP_RE);
    assert.match(resolveReleaseStamp({ RELEASE_STAMP: '' }), RELEASE_STAMP_RE);
  });

  test('uses a well-formed RELEASE_STAMP verbatim', () => {
    assert.equal(resolveReleaseStamp({ RELEASE_STAMP: STAMP }), STAMP);
  });

  test('throws on a malformed RELEASE_STAMP rather than regenerating one', () => {
    // A silently-regenerated stamp would produce zips whose names disagree
    // with the deployed image's build-info.json, so this must be a hard error.
    for (const bad of [
      '2026-09-18-142233',
      '20260918142233',
      '20260918-1422',
      'latest',
      '20260918-142233-amd64',
      ' 20260918-142233',
    ]) {
      assert.throws(
        () => resolveReleaseStamp({ RELEASE_STAMP: bad }),
        /RELEASE_STAMP must match YYYYMMDD-HHMMSS/,
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

  test('every zip name matches the pattern the server inventory filters on', () => {
    // Kept in sync with RELEASE_ZIP_NAME_RE in server/src/releases/release-token.ts:
    // a name the script emits but the server refuses would be invisible in the
    // admin panel.
    const serverPattern = /^artisyn-log-hub-(\d{8}-\d{6})-(amd64|arm64)\.zip$/;
    for (const target of TARGETS) {
      const name = zipFileName(STAMP, target.arch);
      const match = serverPattern.exec(name);
      assert.ok(match, `${name} does not match the server inventory pattern`);
      assert.equal(match[1], STAMP);
      assert.equal(match[2], target.arch);
    }
  });
});

describe('selectedTargets / otherTarget', () => {
  test('defaults to both architectures', () => {
    assert.equal(DEFAULT_RELEASE_ARCHS, 'amd64,arm64');
    assert.deepEqual(
      selectedTargets({}).map((t) => t.arch),
      ['amd64', 'arm64'],
    );
    assert.deepEqual(
      selectedTargets({ RELEASE_ARCHS: '' }).map((t) => t.arch),
      ['amd64', 'arm64'],
    );
  });

  test('narrows the build to the named architectures, ignoring whitespace', () => {
    assert.deepEqual(
      selectedTargets({ RELEASE_ARCHS: 'amd64' }).map((t) => t.arch),
      ['amd64'],
    );
    assert.deepEqual(
      selectedTargets({ RELEASE_ARCHS: ' arm64 , amd64 ' }).map((t) => t.arch),
      ['amd64', 'arm64'],
    );
  });

  test('rejects an unknown or empty architecture list', () => {
    assert.throws(
      () => selectedTargets({ RELEASE_ARCHS: 'riscv' }),
      /unknown architecture/,
    );
    assert.throws(
      () => selectedTargets({ RELEASE_ARCHS: ',' }),
      /selected no architecture/,
    );
  });

  test('the "other arch" zip name comes from the full TARGETS list, not the filtered one', () => {
    // INSTALL.md points the reader at the other architecture's download, which
    // exists on the release server even when this run only built one.
    const selected = selectedTargets({ RELEASE_ARCHS: 'amd64' });
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
  test('requiring the module leaves both package.json files byte-identical', () => {
    const paths = [
      path.join(ROOT, 'server', 'package.json'),
      path.join(ROOT, 'client', 'package.json'),
    ];
    const before = paths.map((p) => fs.readFileSync(p));

    delete require.cache[RELEASE_JS];
    require('../release.js');

    paths.forEach((p, i) => {
      assert.ok(
        before[i].equals(fs.readFileSync(p)),
        `${p} changed when scripts/release.js was loaded`,
      );
    });
  });

  test('the script carries no version-bump helper and never writes a package.json', () => {
    // The release identity is the generated stamp (see resolveReleaseStamp);
    // the semver in server/client package.json is frozen and off-limits.
    const source = fs.readFileSync(RELEASE_JS, 'utf8');
    assert.doesNotMatch(source, /bumpVersion|bumpPatch|writeVersion/);
    assert.doesNotMatch(source, /writeFileSync\([^)]*package\.json/);
    assert.deepEqual(
      Object.keys(require('../release.js')).filter((k) => /bump/i.test(k)),
      [],
    );
  });
});
