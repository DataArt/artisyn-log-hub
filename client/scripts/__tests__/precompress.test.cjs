'use strict';

// Covers the helpers exported from client/scripts/precompress.cjs plus one
// end-to-end run over a temp-dir fixture. Run via `npm run test:scripts` from the
// repo root (the root script globs both scripts/__tests__/*.test.js and
// client/scripts/__tests__/*.test.cjs).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, describe } = require('node:test');

const {
  MIN_BYTES,
  isCompressible,
  worthKeeping,
  precompress,
} = require('../precompress.cjs');

describe('isCompressible', () => {
  test('accepts every allowlisted extension', () => {
    for (const ext of [
      '.js',
      '.css',
      '.html',
      '.svg',
      '.json',
      '.md',
      '.txt',
      '.map',
      '.wasm',
    ]) {
      assert.equal(isCompressible(`index-abc123${ext}`), true, ext);
    }
  });

  test('is case-insensitive on the extension', () => {
    assert.equal(isCompressible('README.MD'), true);
  });

  test('rejects already-compressed binaries', () => {
    for (const name of [
      'logo.png',
      'Inter.woff2',
      'artisyn-hooks-installer.tgz',
    ]) {
      assert.equal(isCompressible(name), false, name);
    }
  });

  // The load-bearing case: a second consecutive build must not compress the
  // output of the first one into index.js.br.br.
  test('rejects its own output', () => {
    assert.equal(isCompressible('index-abc123.js.br'), false);
    assert.equal(isCompressible('index-abc123.js.gz'), false);
  });
});

describe('worthKeeping', () => {
  test('keeps a variant exactly 10% smaller (boundary is inclusive)', () => {
    assert.equal(worthKeeping(1000, 900), true);
  });

  test('rejects a variant just under the 10% gain', () => {
    assert.equal(worthKeeping(1000, 901), false);
  });

  test('keeps a variant just over the 10% gain', () => {
    assert.equal(worthKeeping(1000, 899), true);
  });

  test('rejects a variant that grew', () => {
    assert.equal(worthKeeping(1000, 1200), false);
  });
});

describe('precompress', () => {
  test('throws on a missing target directory', () => {
    const missing = path.join(os.tmpdir(), 'precompress-does-not-exist-xyz');
    assert.throws(() => precompress(missing), /target directory not found/);
  });

  test('compresses what pays and skips what does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompress-'));
    try {
      // Compressible: 50 KB of repetitive JS → both variants written.
      const bigJs = 'const a = 1; // padding padding padding\n'.repeat(1300);
      fs.writeFileSync(path.join(dir, 'app.js'), bigJs);

      // Under MIN_BYTES → skipped even though it would compress well.
      const tinyCss = '.a{color:red}'.repeat(20);
      assert.ok(tinyCss.length < MIN_BYTES);
      fs.writeFileSync(path.join(dir, 'tiny.css'), tinyCss);

      // Not allowlisted → never touched.
      fs.writeFileSync(path.join(dir, 'logo.png'), crypto.randomBytes(5120));

      // Allowlisted but incompressible → fails the 10% gain rule.
      fs.writeFileSync(path.join(dir, 'noise.js'), crypto.randomBytes(5120));

      // Recursion into subdirectories.
      fs.mkdirSync(path.join(dir, 'assets'));
      fs.writeFileSync(path.join(dir, 'assets', 'nested.css'), bigJs);

      const r = precompress(dir);

      assert.equal(r.scanned, 4, 'app.js, tiny.css, noise.js, assets/nested.css');
      assert.equal(r.files, 2, 'app.js and assets/nested.css');

      for (const rel of ['app.js', path.join('assets', 'nested.css')]) {
        assert.ok(fs.existsSync(path.join(dir, `${rel}.br`)), `${rel}.br`);
        assert.ok(fs.existsSync(path.join(dir, `${rel}.gz`)), `${rel}.gz`);
      }

      for (const rel of ['tiny.css', 'logo.png', 'noise.js']) {
        assert.equal(fs.existsSync(path.join(dir, `${rel}.br`)), false, rel);
        assert.equal(fs.existsSync(path.join(dir, `${rel}.gz`)), false, rel);
      }

      assert.ok(r.brBytes > 0 && r.brBytes < r.rawBytes);
      assert.ok(r.gzBytes > 0 && r.gzBytes < r.rawBytes);

      // Variants must decompress back to the exact original bytes.
      const raw = fs.readFileSync(path.join(dir, 'app.js'));
      assert.deepEqual(
        zlib.brotliDecompressSync(fs.readFileSync(path.join(dir, 'app.js.br'))),
        raw,
      );
      assert.deepEqual(
        zlib.gunzipSync(fs.readFileSync(path.join(dir, 'app.js.gz'))),
        raw,
      );

      // A second run must not compress its own output.
      const second = precompress(dir);
      assert.equal(second.scanned, r.scanned);
      assert.equal(fs.existsSync(path.join(dir, 'app.js.br.br')), false);
      assert.equal(fs.existsSync(path.join(dir, 'app.js.gz.gz')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
