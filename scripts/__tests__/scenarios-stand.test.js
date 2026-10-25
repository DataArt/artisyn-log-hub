'use strict';

// Pure runner logic of the scenario stand (impl-plan DD C1-C3): schema names, the per-mode
// environment, the build-input hash, and dropping expired schemas by their labels. Nothing here
// starts a stand, touches Postgres or builds anything — the DB is replaced by a recording stub.
// The .mjs/.ts modules are loaded with dynamic import (Node's built-in type stripping for .ts).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before } = require('node:test');

const ROOT = path.join(__dirname, '..', '..');
let modes;
let stand;
let build;
let installer;

before(async () => {
  modes = await import('../../tests/scenarios/modes.ts');
  stand = await import('../scenarios/stand.mjs');
  build = await import('../scenarios/build-stand.mjs');
  installer = require('../build-hooks-installer.js');
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scn-stand-test-'));
}

const SECRET = 'ab'.repeat(48);

function envFor(mode, extra = {}) {
  return modes.standEnv({
    mode,
    port: 41234,
    databaseUrl: 'postgresql://u:p@db:5432/x',
    schema: `scn_${mode}_0123abcd`,
    runDir: path.join('R', mode),
    joinPath: path.join,
    sessionSecret: mode === 'b' ? SECRET : undefined,
    ...extra,
  });
}

describe('schema name', () => {
  test('is scn_<mode>_<8 hex>', () => {
    for (const mode of ['a', 'b', 'c']) {
      assert.match(stand.schemaName(mode), new RegExp(`^scn_${mode}_[0-9a-f]{8}$`));
    }
  });

  test('is random per call', () => {
    const names = new Set(Array.from({ length: 20 }, () => stand.schemaName('a')));
    assert.equal(names.size, 20);
  });

  test('rejects an unknown mode and a non-hex suffix', () => {
    assert.throws(() => stand.schemaName('d'), /Unknown stand mode/);
    assert.throws(() => stand.schemaName('a', () => 'XYZ; DROP'), /unexpected schema name/);
    assert.throws(() => stand.assertSchemaName('public'), /unexpected schema name/);
  });
});

describe('mode env', () => {
  test('mode table matches DD C2', () => {
    assert.deepEqual(
      Object.values(modes.MODES).map((m) => [m.mode, m.authMode, m.nodeEnv]),
      [
        ['a', 'none', 'test'],
        ['b', 'password-confirm', 'production'],
        ['c', 'password', 'test'],
      ],
    );
  });

  test('every mode gets the fast tick, port, DB, schema, base URL, body limit and run-dir paths', () => {
    for (const mode of ['a', 'b', 'c']) {
      const env = envFor(mode);
      for (const [k, v] of Object.entries(modes.FAST_TICK_ENV)) assert.equal(env[k], v, `${mode} ${k}`);
      assert.equal(env.PORT, '41234');
      assert.equal(env.DATABASE_URL, 'postgresql://u:p@db:5432/x');
      assert.equal(env.E2E_DB_SCHEMA, `scn_${mode}_0123abcd`);
      assert.equal(env.PUBLIC_BASE_URL, 'http://127.0.0.1:41234');
      assert.equal(env.LOGS_MAX_BODY_MB, '2');
      assert.equal(env.UPLOAD_QUEUE_DIR, path.join('R', mode, 'upload-queue'));
      assert.equal(env.EXPORT_IMPORT_DIR, path.join('R', mode, 'export-import'));
      assert.equal(env.CLUSTER_MODE, undefined, 'stand must stay a single process');
    }
  });

  test('modes a and c carry no mail or secret settings', () => {
    for (const mode of ['a', 'c']) {
      const env = envFor(mode);
      for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SESSION_SECRET', 'PASSWORD_POLICY', 'ADMIN_CONTACT_EMAIL']) {
        assert.equal(env[k], undefined, `${mode} ${k}`);
      }
    }
  });

  test('mode b: password-confirm in production with Mailpit SMTP and admin contact', () => {
    const env = envFor('b', { mailpitSmtp: 'mail.local:2525' });
    assert.equal(env.AUTH_MODE, 'password-confirm');
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.PASSWORD_POLICY, 'long');
    assert.equal(env.SESSION_SECRET, SECRET);
    assert.equal(env.COOKIE_SECURE, 'false');
    assert.equal(env.SMTP_HOST, 'mail.local');
    assert.equal(env.SMTP_PORT, '2525');
    assert.equal(env.SMTP_FROM, 'noreply@arrakis.test');
    assert.equal(env.ADMIN_CONTACT_EMAIL, 'admin@arrakis.test');
    assert.equal(envFor('b').SMTP_PORT, '1025', 'MAILPIT_SMTP default localhost:1025');
  });

  test('mode b refuses a missing or short session secret', () => {
    assert.throws(() => envFor('b', { sessionSecret: undefined }), /sessionSecret/);
    assert.throws(() => envFor('b', { sessionSecret: 'ab'.repeat(8) }), /sessionSecret/);
  });

  test('parseModes normalises order and rejects unknown modes', () => {
    assert.deepEqual(modes.parseModes('c, a,a'), ['a', 'c']);
    assert.throws(() => modes.parseModes('a,x'), /Unknown stand mode "x"/);
  });

  test('passthroughEnv keeps only OS essentials', () => {
    const out = stand.passthroughEnv({ Path: 'p', SystemRoot: 's', AUTH_MODE: 'password', DATABASE_URL: 'x' });
    assert.deepEqual(out, { Path: 'p', SystemRoot: 's' });
  });
});

describe('input hash', () => {
  test('changes with content and with a new file, not with listing order', () => {
    const root = tmpDir();
    try {
      fs.mkdirSync(path.join(root, 'client'));
      fs.writeFileSync(path.join(root, 'client', 'a.ts'), 'one');
      fs.writeFileSync(path.join(root, 'client', 'b.ts'), 'two');
      const files = ['client/a.ts', 'client/b.ts'];
      const h1 = build.computeInputsHash(root, files);
      assert.match(h1, /^[0-9a-f]{64}$/);
      assert.equal(build.computeInputsHash(root, [...files].reverse()), h1);

      fs.writeFileSync(path.join(root, 'client', 'a.ts'), 'ONE');
      const h2 = build.computeInputsHash(root, files);
      assert.notEqual(h2, h1);

      fs.writeFileSync(path.join(root, 'client', 'c.ts'), '');
      assert.notEqual(build.computeInputsHash(root, [...files, 'client/c.ts']), h2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a listed but deleted file is not an error and differs from an empty file', () => {
    const root = tmpDir();
    try {
      const missing = build.computeInputsHash(root, ['client/gone.ts']);
      fs.mkdirSync(path.join(root, 'client'));
      fs.writeFileSync(path.join(root, 'client', 'gone.ts'), '');
      assert.notEqual(build.computeInputsHash(root, ['client/gone.ts']), missing);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('input list covers the DD C1 trees and the builder scripts, never ignored output', () => {
    const files = build.listInputFiles();
    for (const f of ['server/src/main.ts', 'client/package.json', 'hook/package.json', ...build.BUILDER_FILES]) {
      assert.ok(files.includes(f), f);
    }
    assert.ok(files.some((f) => f.startsWith('server/drizzle/migrations/')));
    assert.ok(files.some((f) => f.startsWith('artisyn-hooks-installer/src/')));
    assert.ok(!files.some((f) => f.includes('/node_modules/')), 'node_modules is ignored');
    assert.ok(!files.some((f) => f.startsWith('artisyn-hooks-installer/dist/')), 'installer dist is ignored');
    assert.ok(!files.some((f) => f.startsWith('tests/') || f.startsWith('dist/')));
  });

  test('stand is up to date only with the same hash and an index.js', () => {
    const dir = tmpDir();
    try {
      assert.equal(build.isStandUpToDate('h', dir), false);
      fs.writeFileSync(path.join(dir, build.HASH_FILE_NAME), 'h\n');
      assert.equal(build.isStandUpToDate('h', dir), false, 'no index.js yet');
      fs.writeFileSync(path.join(dir, 'index.js'), '');
      assert.equal(build.isStandUpToDate('h', dir), true);
      assert.equal(build.isStandUpToDate('other', dir), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dropping schemas by labels', () => {
  const NOW = Date.parse('2026-10-15T12:00:00Z');
  const HOUR = 60 * 60 * 1000;

  test('selects only labelled scn_* schemas older than 6 h (or with a broken timestamp)', () => {
    const labels = {
      scn_a_00000001: { createdAt: new Date(NOW - 7 * HOUR).toISOString() },
      scn_b_00000002: { createdAt: new Date(NOW - 5 * HOUR).toISOString() },
      scn_c_00000003: { createdAt: 'garbage' },
      public: { createdAt: new Date(NOW - 99 * HOUR).toISOString() },
    };
    assert.deepEqual(stand.selectExpiredSchemas(labels, NOW), ['scn_a_00000001', 'scn_c_00000003']);
  });

  test('drops expired schemas with CASCADE and removes only their labels', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'schemas.json');
    try {
      stand.writeSchemaLabels(
        {
          scn_a_0000000a: { createdAt: new Date(NOW - 10 * HOUR).toISOString(), mode: 'a' },
          scn_b_0000000b: { createdAt: new Date(NOW - 1 * HOUR).toISOString(), mode: 'b' },
        },
        file,
      );
      const sql = [];
      const dropped = await stand.dropExpiredSchemas({ query: async (q) => sql.push(q), labelsFile: file, now: NOW });
      assert.deepEqual(dropped, ['scn_a_0000000a']);
      assert.deepEqual(sql, ['DROP SCHEMA IF EXISTS "scn_a_0000000a" CASCADE']);
      assert.deepEqual(Object.keys(stand.readSchemaLabels(file)), ['scn_b_0000000b']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing or corrupt labels file means nothing to drop', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'schemas.json');
    try {
      const sql = [];
      assert.deepEqual(await stand.dropExpiredSchemas({ query: async (q) => sql.push(q), labelsFile: file, now: NOW }), []);
      fs.writeFileSync(file, '{not json');
      assert.deepEqual(await stand.dropExpiredSchemas({ query: async (q) => sql.push(q), labelsFile: file, now: NOW }), []);
      assert.deepEqual(sql, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('build-hooks-installer --static-dir', () => {
  test('defaults to server/src/public/static and accepts both flag spellings', () => {
    assert.equal(installer.parseStaticDirArg([]), installer.DEFAULT_STATIC_DIR);
    assert.equal(installer.DEFAULT_STATIC_DIR, path.join(ROOT, 'server', 'src', 'public', 'static'));
    assert.equal(installer.parseStaticDirArg(['--static-dir', 'x/y']), path.resolve('x/y'));
    assert.equal(installer.parseStaticDirArg(['--static-dir=x/z']), path.resolve('x/z'));
    assert.throws(() => installer.parseStaticDirArg(['--static-dir']), /requires a directory/);
  });
});

describe('stand env shared by every mode', () => {
  test('plain-http cookies and raised auth rate limits in a, b and c', () => {
    for (const mode of ['a', 'b', 'c']) {
      const env = envFor(mode);
      assert.equal(env.COOKIE_SECURE, 'false', `${mode} COOKIE_SECURE`);
      assert.equal(env.AUTH_RATE_LIMIT_POINTS, '1000', `${mode} AUTH_RATE_LIMIT_POINTS`);
    }
  });
});

describe('stand coverage (DD L1)', () => {
  test('rebaseSourceMapSources points ncc sources at server/src and keeps synthetic ones', () => {
    const root = path.resolve('/repo');
    const mapDir = path.join(root, 'tmp', 'scenarios', 'stand');
    const map = {
      version: 3,
      sources: ['.././server/src/main.ts', '../webpack/bootstrap', '../server/src/a/b.ts'],
      mappings: '',
    };
    const out = build.rebaseSourceMapSources(map, mapDir, root);
    assert.deepEqual(out.sources, [
      '../../../server/src/main.ts',
      '../webpack/bootstrap',
      '../../../server/src/a/b.ts',
    ]);
    assert.equal(out.mappings, '');
    assert.equal(map.sources[0], '.././server/src/main.ts', 'the input map is not mutated');
  });

  test('standCoverageDir and c8ReportArgs keep everything under tmp/coverage', () => {
    const dir = stand.standCoverageDir('20261015-ab12', 'b', path.join(ROOT, 'tmp', 'coverage'));
    assert.equal(dir, path.join(ROOT, 'tmp', 'coverage', 'scenarios-20261015-ab12', 'b'));
    const args = stand.c8ReportArgs(dir);
    assert.equal(args[0], 'report');
    assert.equal(args[args.indexOf('--temp-directory') + 1], path.join(dir, 'v8'));
    assert.equal(args[args.indexOf('--report-dir') + 1], path.join(dir, 'report'));
    assert.equal(args[args.indexOf('--include') + 1], 'server/src/**');
    assert.ok(args.includes('--exclude-after-remap'));
  });

  test('flushStandCoverage: no-op without coverage, true once answered, false for a dead stand', async () => {
    assert.equal(await stand.flushStandCoverage({ coverageDir: null }), false);
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'flush.done'), 'ok\n');
      const alive = { exitCode: null, signalCode: null };
      assert.equal(await stand.flushStandCoverage({ coverageDir: dir, child: alive }), true);
      const dead = { exitCode: 0, signalCode: null };
      assert.equal(await stand.flushStandCoverage({ coverageDir: dir, child: dead }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
