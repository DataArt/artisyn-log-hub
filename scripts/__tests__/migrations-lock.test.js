'use strict';

// Exercises scripts/migrations-lock.js, the migration immutability guard:
// reconciliation of meta/migrations.lock.json against the real repo and
// against temp fixtures (one failing case per condition), LF/CRLF-independent
// hashing, the append-only manifest update and the --pre-commit git hook in a
// throwaway git repo. This test is also the guard itself wherever the hook is
// not installed (CI, --no-verify): the real-repo reconcile must stay green.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test, describe } = require('node:test');

const SCRIPT = require.resolve('../migrations-lock.js');
const {
  IMMUTABLE_MESSAGE,
  MIGRATIONS_FOLDER,
  lfHash,
  acceptedHashesFor,
  reconcile,
  appendNewRows,
  checkAppendOnly,
  findImmutableSqlChanges,
} = require('../migrations-lock.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJournal(folder, tags) {
  const entries = tags.map((tag, idx) => ({ idx, version: '7', when: 1000 + idx, tag, breakpoints: true }));
  fs.mkdirSync(path.join(folder, 'meta'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta', '_journal.json'), JSON.stringify({ version: '7', dialect: 'postgresql', entries }, null, 2));
}

/** A migrations folder with `tags` migrations and a freshly generated manifest. */
function makeFolder(t, tags = ['0000_a', '0001_b', '0002_c']) {
  const folder = tmpDir(t);
  for (const tag of tags) fs.writeFileSync(path.join(folder, `${tag}.sql`), `-- ${tag}\nSELECT 1;\n`);
  writeJournal(folder, tags);
  appendNewRows(folder);
  return folder;
}

const lockPath = (folder) => path.join(folder, 'meta', 'migrations.lock.json');
const readLock = (folder) => JSON.parse(fs.readFileSync(lockPath(folder), 'utf8'));
const writeLock = (folder, lock) => fs.writeFileSync(lockPath(folder), JSON.stringify(lock, null, 2));
const journalPath = (folder) => path.join(folder, 'meta', '_journal.json');

function assertOneError(errors, pattern) {
  assert.ok(errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got:\n${errors.join('\n')}`);
}

describe('real repository', () => {
  test('reconcile() of server/drizzle/migrations reports no errors', () => {
    assert.deepEqual(reconcile(MIGRATIONS_FOLDER), []);
  });

  test('migrations edited after release keep their historical hashes', () => {
    const lock = JSON.parse(fs.readFileSync(lockPath(MIGRATIONS_FOLDER), 'utf8'));
    for (const prefix of ['0016_', '0046_', '0047_', '0059_', '0061_']) {
      const row = lock.migrations.find((r) => r.tag.startsWith(prefix));
      assert.ok(row, `row for ${prefix}`);
      assert.ok(row.acceptedHashes.length >= 4, `${row.tag} has ${row.acceptedHashes.length} accepted hashes`);
    }
  });
});

describe('hashing', () => {
  test('LF and CRLF versions of a file have the same sha256', () => {
    assert.equal(lfHash('a\r\nb\r\n'), lfHash('a\nb\n'));
    assert.notEqual(lfHash('a\nb\n'), lfHash('a\nc\n'));
  });

  test('acceptedHashes holds both the LF and the CRLF raw hash', (t) => {
    const dir = tmpDir(t);
    const file = path.join(dir, '0000_a.sql');
    fs.writeFileSync(file, 'SELECT 1;\n');
    const crypto = require('node:crypto');
    const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const hashes = acceptedHashesFor(file);
    assert.ok(hashes.includes(sha('SELECT 1;\n')));
    assert.ok(hashes.includes(sha('SELECT 1;\r\n')));
  });
});

describe('reconcile() fails on every FR-3 condition', () => {
  test('a freshly generated manifest reconciles cleanly', (t) => {
    assert.deepEqual(reconcile(makeFolder(t)), []);
  });

  test('journal entry without a manifest row', (t) => {
    const folder = makeFolder(t);
    fs.writeFileSync(path.join(folder, '0003_d.sql'), 'SELECT 4;\n');
    writeJournal(folder, ['0000_a', '0001_b', '0002_c', '0003_d']);
    assertOneError(reconcile(folder), /^0003_d: journal entry has no row/);
  });

  test('file hash differs from the manifest', (t) => {
    const folder = makeFolder(t);
    fs.writeFileSync(path.join(folder, '0001_b.sql'), '-- edited comment\nSELECT 1;\n');
    assertOneError(reconcile(folder), /^0001_b: 0001_b\.sql does not match/);
  });

  test('idx, tag and when that disagree with the journal', (t) => {
    const folder = makeFolder(t);
    const lock = readLock(folder);
    lock.migrations[0].idx = 7;
    lock.migrations[1].when = 1;
    writeLock(folder, lock);
    const errors = reconcile(folder);
    assertOneError(errors, /^0000_a: manifest idx 7 != journal idx 0/);
    assertOneError(errors, /^0001_b: manifest when 1 != journal when 1001/);

    const journal = JSON.parse(fs.readFileSync(journalPath(folder), 'utf8'));
    journal.entries[2].tag = '0002_renamed';
    fs.writeFileSync(journalPath(folder), JSON.stringify(journal));
    assertOneError(reconcile(folder), /^0002_c: manifest row has no entry in meta\/_journal\.json/);
  });

  test('manifest row without a journal entry', (t) => {
    const folder = makeFolder(t);
    writeJournal(folder, ['0000_a', '0001_b']);
    assertOneError(reconcile(folder), /^0002_c: manifest row has no entry/);
  });

  test('manifest row without its .sql file', (t) => {
    const folder = makeFolder(t);
    fs.rmSync(path.join(folder, '0002_c.sql'));
    assertOneError(reconcile(folder), /^0002_c: manifest row has no file 0002_c\.sql/);
  });

  test('stray .sql file missing from the journal', (t) => {
    const folder = makeFolder(t);
    fs.writeFileSync(path.join(folder, '0009_stray.sql'), 'SELECT 9;\n');
    assertOneError(reconcile(folder), /^0009_stray\.sql: \.sql file has no entry/);
  });

  test('manifest order differs from the journal', (t) => {
    const folder = makeFolder(t);
    const lock = readLock(folder);
    [lock.migrations[1], lock.migrations[2]] = [lock.migrations[2], lock.migrations[1]];
    writeLock(folder, lock);
    assertOneError(reconcile(folder), /^order of meta\/migrations\.lock\.json differs .* at 0001_b/);
  });
});

describe('appendNewRows()', () => {
  test('appends only the new journal entries, leaving existing rows untouched', (t) => {
    const folder = makeFolder(t);
    const before = readLock(folder).migrations;
    fs.writeFileSync(path.join(folder, '0003_d.sql'), 'SELECT 4;\n');
    writeJournal(folder, ['0000_a', '0001_b', '0002_c', '0003_d']);
    assert.deepEqual(appendNewRows(folder), ['0003_d']);
    const after = readLock(folder).migrations;
    assert.deepEqual(after.slice(0, 3), before);
    assert.equal(after[3].tag, '0003_d');
    assert.equal(after[3].when, 1003);
    assert.deepEqual(reconcile(folder), []);
    assert.deepEqual(appendNewRows(folder), []);
  });

  test('refuses, naming the tag, when an existing row\'s file changed — and writes nothing', (t) => {
    const folder = makeFolder(t);
    const before = fs.readFileSync(lockPath(folder), 'utf8');
    fs.writeFileSync(path.join(folder, '0001_b.sql'), '-- edited\nSELECT 1;\n');
    fs.writeFileSync(path.join(folder, '0003_d.sql'), 'SELECT 4;\n');
    writeJournal(folder, ['0000_a', '0001_b', '0002_c', '0003_d']);
    assert.throws(() => appendNewRows(folder), /0001_b/);
    assert.equal(fs.readFileSync(lockPath(folder), 'utf8'), before);
  });
});

describe('checkAppendOnly()', () => {
  const head = [{ tag: 'a', when: 1 }, { tag: 'b', when: 2 }];

  test('accepts an unchanged prefix with appended entries', () => {
    assert.deepEqual(checkAppendOnly(head, [...head, { tag: 'c', when: 3 }], 'tag'), []);
    assert.deepEqual(checkAppendOnly(head, [{ when: 1, tag: 'a' }, { tag: 'b', when: 2 }], 'tag'), []);
  });

  test('rejects modified, removed and reordered entries', () => {
    assert.deepEqual(checkAppendOnly(head, [{ tag: 'a', when: 9 }, head[1]], 'tag'), ['a: modified or reordered']);
    assert.deepEqual(checkAppendOnly(head, [head[0]], 'tag'), ['b: removed']);
    assert.equal(checkAppendOnly(head, [head[1], head[0]], 'tag').length, 2);
  });
});

describe('findImmutableSqlChanges()', () => {
  test('flags M/D of HEAD migrations and ignores added files', () => {
    const head = ['server/drizzle/migrations/0000_a.sql', 'server/drizzle/migrations/0001_b.sql'];
    const nameStatus = [
      'M', 'server/drizzle/migrations/0000_a.sql',
      'D', 'server/drizzle/migrations/0001_b.sql',
      'A', 'server/drizzle/migrations/0002_c.sql',
      '',
    ].join('\0');
    assert.deepEqual(findImmutableSqlChanges(nameStatus, head), head);
  });
});

describe('--pre-commit hook in a throwaway git repo', () => {
  function gitIn(repo, args) {
    return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function makeRepo(t) {
    const repo = tmpDir(t);
    gitIn(repo, ['init', '-q']);
    gitIn(repo, ['config', 'core.autocrlf', 'false']);
    const folder = path.join(repo, 'server', 'drizzle', 'migrations');
    fs.mkdirSync(folder, { recursive: true });
    for (const tag of ['0000_a', '0001_b']) fs.writeFileSync(path.join(folder, `${tag}.sql`), `-- ${tag}\nSELECT 1;\n`);
    writeJournal(folder, ['0000_a', '0001_b']);
    appendNewRows(folder);
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-q', '--no-verify', '-m', 'init']);
    return { repo, folder };
  }

  function runHook(repo) {
    return spawnSync(process.execPath, [SCRIPT, '--pre-commit'], { cwd: repo, encoding: 'utf8' });
  }

  test('rejects a comment edit in a committed migration', (t) => {
    const { repo, folder } = makeRepo(t);
    fs.writeFileSync(path.join(folder, '0000_a.sql'), '-- edited\nSELECT 1;\n');
    gitIn(repo, ['add', '-A']);
    const res = runHook(repo);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes(IMMUTABLE_MESSAGE), res.stderr);
    assert.match(res.stderr, /0000_a\.sql/);
  });

  test('rejects deleting or renaming a committed migration', (t) => {
    const { repo } = makeRepo(t);
    gitIn(repo, ['mv', 'server/drizzle/migrations/0001_b.sql', 'server/drizzle/migrations/0001_renamed.sql']);
    const res = runHook(repo);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /0001_b\.sql/);

    gitIn(repo, ['reset', '-q', '--hard']);
    gitIn(repo, ['rm', '-q', 'server/drizzle/migrations/0000_a.sql']);
    assert.equal(runHook(repo).status, 1);
  });

  test('rejects changing `when` of an existing journal entry', (t) => {
    const { repo, folder } = makeRepo(t);
    const journal = JSON.parse(fs.readFileSync(journalPath(folder), 'utf8'));
    journal.entries[0].when = 5;
    fs.writeFileSync(journalPath(folder), JSON.stringify(journal, null, 2));
    gitIn(repo, ['add', '-A']);
    const res = runHook(repo);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /_journal\.json: 0000_a: modified/);
  });

  test('rejects editing an existing manifest row', (t) => {
    const { repo, folder } = makeRepo(t);
    const lock = readLock(folder);
    lock.migrations[1].sha256 = '0'.repeat(64);
    writeLock(folder, lock);
    gitIn(repo, ['add', '-A']);
    const res = runHook(repo);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /migrations\.lock\.json: 0001_b: modified/);
  });

  test('accepts a new migration with a regenerated manifest', (t) => {
    const { repo, folder } = makeRepo(t);
    fs.writeFileSync(path.join(folder, '0002_c.sql'), 'SELECT 3;\n');
    writeJournal(folder, ['0000_a', '0001_b', '0002_c']);
    assert.deepEqual(appendNewRows(folder), ['0002_c']);
    gitIn(repo, ['add', '-A']);
    const res = runHook(repo);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(reconcile(folder), []);
  });
});
