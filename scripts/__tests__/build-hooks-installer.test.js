'use strict';

// Exercises the build-time checks exported from scripts/build-hooks-installer.js:
// hooks.json/INSTALL_HOOK.md event drift, cross-artifact version agreement, and the
// ustar 100-byte tar-entry name-length limit. Each check is run against both a
// passing fixture and a deliberately-broken one to confirm it actually fails when
// it should, not just when it happens to pass.
//
// `npm run build` (via `node scripts/build-hooks-installer.js`) already calls all
// three checks live as part of the real build (see main()'s "Checking hooks.json
// against INSTALL_HOOK.md...", "Checking version agreement...", and the overlong-name
// check inside packMarketplaceTarball()) and exits non-zero on drift/mismatch/overlong
// names; that live exercise is wired into adlc-lh:check-health's build step, so it is not
// re-run here as a subprocess test (compiling the CLI + packing tarballs on every
// `npm run test:scripts` run would be slow and duplicate what the build already
// verifies). Confirmed manually for this chunk: `npm run build` from the repo root
// completes with "Done." and no drift/mismatch/overlong-name errors against the
// current tree (see requirements.md Notes).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, describe } = require('node:test');

const {
  findHooksEventDrift,
  parseEventNamesFromInstallMd,
  findVersionMismatch,
  findOverlongTarNames,
  ensureInstallerVersionTracksHook,
  HOOKS_JSON,
  HOOK_JS_FILES,
  PLUGIN_ROOT,
} = require('../build-hooks-installer.js');

const ROOT = path.join(__dirname, '..', '..');
const HOOK_TOOL_DIR = path.join(ROOT, 'hook', '.claude', 'telemetry_tool');
const HOOKS_TARBALL = path.join(ROOT, 'server', 'src', 'public', 'static', 'hooks.tar.gz');

/**
 * List the entry names of a gzipped ustar archive. Minimal on purpose — it only reads the name and
 * size fields, which is all the packaging assertions below need.
 * @param {Buffer} gz
 * @returns {string[]}
 */
function listTarGzEntryNames(gz) {
  const tar = zlib.gunzipSync(gz);
  const names = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const nameField = tar.slice(offset, offset + 100).toString('utf8').replace(/\0.*$/, '');
    if (!nameField) break; // the two zero blocks that end the archive
    const sizeOctal = tar.slice(offset + 124, offset + 136).toString('ascii').replace(/[\0 ]+$/, '').trim();
    const size = parseInt(sizeOctal, 8) || 0;
    names.push(nameField);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function fixtureInstallMd(eventNames) {
  const hooks = {};
  for (const name of eventNames) hooks[name] = [];
  return '# fixture\n\n```json\n' + JSON.stringify({ hooks }, null, 2) + '\n```\n';
}

describe('findHooksEventDrift / parseEventNamesFromInstallMd', () => {
  test('passing fixture: doc events exactly match HOOKS_JSON -> no drift', () => {
    const fixtureHooksJson = { hooks: { Foo: [], Bar: [] } };
    const text = fixtureInstallMd(['Foo', 'Bar']);
    assert.equal(findHooksEventDrift(text, fixtureHooksJson), null);
  });

  test('broken fixture: an event missing from the doc is reported as drift', () => {
    const fixtureHooksJson = { hooks: { Foo: [], Bar: [], Baz: [] } };
    // Doc is missing "Baz" -> deliberate event-list drift.
    const text = fixtureInstallMd(['Foo', 'Bar']);
    const drift = findHooksEventDrift(text, fixtureHooksJson);
    assert.notEqual(drift, null);
    assert.deepEqual(drift.missingFromDoc, ['Baz']);
    assert.deepEqual(drift.missingFromJson, []);
  });

  test('broken fixture: an event missing from HOOKS_JSON is reported as drift', () => {
    const fixtureHooksJson = { hooks: { Foo: [] } };
    // Doc documents "Extra" but HOOKS_JSON never wires it -> drift the other way.
    const text = fixtureInstallMd(['Foo', 'Extra']);
    const drift = findHooksEventDrift(text, fixtureHooksJson);
    assert.notEqual(drift, null);
    assert.deepEqual(drift.missingFromJson, ['Extra']);
    assert.deepEqual(drift.missingFromDoc, []);
  });

  test('parseEventNamesFromInstallMd unions event names across multiple fenced json blocks', () => {
    const text =
      '```json\n' + JSON.stringify({ hooks: { A: [] } }) + '\n```\n' +
      'some prose\n' +
      '```json\n' + JSON.stringify({ hooks: { B: [] } }) + '\n```\n';
    const names = parseEventNamesFromInstallMd(text);
    assert.deepEqual([...names].sort(), ['A', 'B']);
  });
});

describe('findVersionMismatch', () => {
  test('passing fixture: all sources agree -> no mismatch', () => {
    const versions = {
      hookVersionFile: '2.0.0',
      bundledScriptsVersion: '2.0.0',
      pluginJsonVersion: '2.0.0',
      installerVersionFile: '2.0.0',
    };
    assert.equal(findVersionMismatch(versions), null);
  });

  test('broken fixture: one disagreeing source is reported as a mismatch', () => {
    const versions = {
      hookVersionFile: '2.0.0',
      bundledScriptsVersion: '2.0.0',
      pluginJsonVersion: '1.7.0', // deliberately stale
      installerVersionFile: '2.0.0',
    };
    const mismatch = findVersionMismatch(versions);
    assert.notEqual(mismatch, null);
    assert.deepEqual(mismatch, versions);
  });
});

describe('ensureInstallerVersionTracksHook', () => {
  function writeFixture(obj) {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'installer-pkg-')), 'package.json');
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    return p;
  }

  test('bumps the patch version and records bundledHookVersion when the hook version changed', () => {
    const pkgPath = writeFixture({ version: '1.0.5', bundledHookVersion: '9.9.9' });
    const newVersion = ensureInstallerVersionTracksHook(pkgPath, '2.0.1');
    assert.equal(newVersion, '1.0.6');
    const written = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(written.version, '1.0.6');
    assert.equal(written.bundledHookVersion, '2.0.1');
  });

  test('is a no-op when already tracking the current hook version (idempotent re-run)', () => {
    const pkgPath = writeFixture({ version: '1.0.6', bundledHookVersion: '2.0.1' });
    const newVersion = ensureInstallerVersionTracksHook(pkgPath, '2.0.1');
    assert.equal(newVersion, '1.0.6');
    const written = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.equal(written.version, '1.0.6');
  });

  test('bumps on first run even without a prior bundledHookVersion field', () => {
    const pkgPath = writeFixture({ version: '1.0.17' });
    const newVersion = ensureInstallerVersionTracksHook(pkgPath, '2.0.1');
    assert.equal(newVersion, '1.0.18');
  });
});

describe('findOverlongTarNames', () => {
  test('passing fixture: all names under the 100-byte ustar limit -> none reported', () => {
    const entries = [
      ['.artisyn/marketplace/.claude-plugin/marketplace.json', 'x'],
      ['.artisyn/marketplace/plugins/log-hub-hooks/scripts/lifecycle-hook.js', 'x'],
    ];
    assert.deepEqual(findOverlongTarNames(entries), []);
  });

  test('broken fixture: a deliberately over-length name is reported', () => {
    const overlongName =
      '.artisyn/marketplace/plugins/log-hub-hooks/scripts/' + 'a'.repeat(60) + '.js';
    assert.ok(Buffer.byteLength(overlongName, 'utf8') >= 100, 'fixture name must actually be >= 100 bytes');
    const entries = [
      ['.artisyn/marketplace/.claude-plugin/marketplace.json', 'x'],
      [overlongName, 'x'],
    ];
    const overlong = findOverlongTarNames(entries);
    assert.deepEqual(overlong, [overlongName]);
  });

  test('live check: every real tar entry name currently produced stays under the limit', () => {
    // Mirrors the entry names packMarketplaceTarball() actually emits, without
    // invoking it (which would read hook script files and write a tarball).
    const { MARKETPLACE_ROOT } = require('../build-hooks-installer.js');
    const names = [
      `${MARKETPLACE_ROOT}/.claude-plugin/marketplace.json`,
      `${PLUGIN_ROOT}/.claude-plugin/plugin.json`,
      `${PLUGIN_ROOT}/hooks/hooks.json`,
      `${PLUGIN_ROOT}/scripts/version.json`,
      `${PLUGIN_ROOT}/config-template/log-hub.json`,
      ...HOOK_JS_FILES.map(f => `${PLUGIN_ROOT}/scripts/${f}`),
    ].map(n => [n, '']);
    assert.deepEqual(findOverlongTarNames(names), []);
  });
});

// ---------------------------------------------------------------------------
// Packaging: HOOK_JS_FILES is the *only* thing that decides which hook
// scripts reach a user's machine — a script left out of it is simply never
// shipped, silently, with no other symptom. version.json matters for the same
// reason: otel-receiver.js reads its own version from the sibling of its
// __dirname, which in the installed tree is `${PLUGIN_ROOT}/scripts/version.json`.
// ---------------------------------------------------------------------------
describe('HOOK_JS_FILES packaging list', () => {
  test('ships both OTEL scripts', () => {
    assert.ok(HOOK_JS_FILES.includes('otel-receiver.js'), 'otel-receiver.js must be packed or no receiver is ever installed');
    assert.ok(HOOK_JS_FILES.includes('otel-register.js'), 'otel-register.js must be packed or both spawn call sites fail to require it');
  });

  test('every listed script exists in the hook source tree, exactly once', () => {
    assert.deepEqual(
      HOOK_JS_FILES.filter((f, i) => HOOK_JS_FILES.indexOf(f) !== i),
      [],
      'a duplicated entry would pack the same file twice',
    );
    for (const filename of HOOK_JS_FILES) {
      assert.ok(
        fs.existsSync(path.join(HOOK_TOOL_DIR, filename)),
        `${filename} is listed for packing but does not exist in hook/.claude/telemetry_tool/`,
      );
    }
  });

  test('every hook script in the source tree is listed (nothing is silently left unshipped)', () => {
    const onDisk = fs.readdirSync(HOOK_TOOL_DIR)
      .filter(name => name.endsWith('.js'))
      .sort();
    assert.deepEqual(
      onDisk.filter(name => !HOOK_JS_FILES.includes(name)),
      [],
      'a hook script missing from HOOK_JS_FILES is never shipped, with no other symptom',
    );
  });

  test('the built tarball carries every listed script plus scripts/version.json', (t) => {
    // The tarball is a build output (gitignored), so this verifies the real artifact whenever the
    // build has run and stays out of the way when it has not.
    if (!fs.existsSync(HOOKS_TARBALL)) {
      t.skip(`${HOOKS_TARBALL} not present — run \`npm run build\` to exercise this check`);
      return;
    }

    const names = listTarGzEntryNames(fs.readFileSync(HOOKS_TARBALL));
    for (const filename of HOOK_JS_FILES) {
      assert.ok(names.includes(`${PLUGIN_ROOT}/scripts/${filename}`), `${filename} is missing from the packed tarball`);
    }
    assert.ok(
      names.includes(`${PLUGIN_ROOT}/scripts/version.json`),
      'otel-receiver.js reads its receiverVersion from this sibling of its own __dirname',
    );
  });
});
