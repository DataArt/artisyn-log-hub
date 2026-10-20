#!/usr/bin/env node
'use strict';

// Migration immutability guard.
//
// Drizzle records a sha256 of every applied migration in __drizzle_migrations
// but never compares it again, so editing a committed migration is silently
// ignored on a migrated database and only shows up as schema drift on a clean
// one. This script keeps an append-only manifest of every migration's hash,
// server/drizzle/migrations/meta/migrations.lock.json, and enforces it.
//
// Modes:
//   node scripts/migrations-lock.js               (npm run migrations:lock, from server/)
//     Appends rows for new journal entries; refuses (exit 1, manifest untouched)
//     when the file of an existing row has changed. Then reconciles.
//   node scripts/migrations-lock.js --pre-commit  (.githooks/pre-commit)
//     Rejects staged changes that modify/delete/rename a migration already in
//     HEAD, or that touch existing _journal.json entries / manifest rows.
//
// The pure helpers are exported for scripts/__tests__/migrations-lock.test.js;
// all CLI work sits behind `require.main === module`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', 'server', 'drizzle', 'migrations');
/** Repo-relative (POSIX) location of the migrations, as git prints paths. */
const MIGRATIONS_REL = 'server/drizzle/migrations';
const JOURNAL_REL = 'meta/_journal.json';
const LOCK_REL = 'meta/migrations.lock.json';
const IMMUTABLE_MESSAGE = 'миграции неизменяемы — создайте новую миграцию';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toLf(text) {
  return text.replace(/\r\n/g, '\n');
}

/** sha256 of the text normalized to LF — independent of the checkout's line endings. */
function lfHash(text) {
  return sha256(toLf(text));
}

/**
 * The hashes drizzle may have recorded for one version of a file: drizzle
 * hashes the raw text, so both the LF and the CRLF checkout count.
 */
function rawVariantHashes(text) {
  const lf = toLf(text);
  return [sha256(text), sha256(lf), sha256(lf.replace(/\n/g, '\r\n'))];
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * LF and CRLF hashes of the working-tree file and of every historical blob of
 * that path in git. Without git (or outside a repo) only the working tree
 * counts.
 */
function acceptedHashesFor(filePath) {
  const hashes = new Set(rawVariantHashes(fs.readFileSync(filePath, 'utf8')));
  const cwd = path.dirname(filePath);
  const name = path.basename(filePath);
  let commits = [];
  try {
    commits = git(['log', '--format=%H', '--', name], cwd).split('\n').filter(Boolean);
  } catch {
    commits = [];
  }
  for (const commit of commits) {
    let blob;
    try {
      blob = git(['show', `${commit}:./${name}`], cwd);
    } catch {
      continue; // the commit deleted the path
    }
    for (const h of rawVariantHashes(blob)) hashes.add(h);
  }
  return [...hashes].sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJournalEntries(folder) {
  return readJson(path.join(folder, JOURNAL_REL)).entries;
}

function readLock(folder) {
  const file = path.join(folder, LOCK_REL);
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function writeLock(folder, lock) {
  const file = path.join(folder, LOCK_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

/**
 * Full reconciliation of the manifest against the journal and the .sql files.
 * Returns a list of human-readable errors, each naming the tag or file.
 */
function reconcile(folder) {
  const errors = [];
  const entries = readJournalEntries(folder);
  const lock = readLock(folder);
  if (!lock) return [`${LOCK_REL} is missing — run npm run migrations:lock from server/`];
  const rows = lock.migrations;

  const entryByTag = new Map(entries.map((e) => [e.tag, e]));
  const rowByTag = new Map(rows.map((r) => [r.tag, r]));

  for (const entry of entries) {
    if (!rowByTag.has(entry.tag)) {
      errors.push(`${entry.tag}: journal entry has no row in ${LOCK_REL} — run npm run migrations:lock`);
    }
  }

  for (const row of rows) {
    const entry = entryByTag.get(row.tag);
    if (!entry) {
      errors.push(`${row.tag}: manifest row has no entry in ${JOURNAL_REL}`);
    } else {
      if (row.idx !== entry.idx) errors.push(`${row.tag}: manifest idx ${row.idx} != journal idx ${entry.idx}`);
      if (row.when !== entry.when) errors.push(`${row.tag}: manifest when ${row.when} != journal when ${entry.when}`);
    }
    const sqlFile = path.join(folder, `${row.tag}.sql`);
    if (!fs.existsSync(sqlFile)) {
      errors.push(`${row.tag}: manifest row has no file ${row.tag}.sql`);
    } else if (lfHash(fs.readFileSync(sqlFile, 'utf8')) !== row.sha256) {
      errors.push(`${row.tag}: ${row.tag}.sql does not match its manifest sha256 — ${IMMUTABLE_MESSAGE}`);
    }
  }

  for (const file of fs.readdirSync(folder).filter((f) => f.endsWith('.sql')).sort()) {
    if (!entryByTag.has(file.slice(0, -'.sql'.length))) {
      errors.push(`${file}: .sql file has no entry in ${JOURNAL_REL}`);
    }
  }

  const journalOrder = entries.map((e) => e.tag).filter((t) => rowByTag.has(t));
  const lockOrder = rows.map((r) => r.tag).filter((t) => entryByTag.has(t));
  if (journalOrder.join('\n') !== lockOrder.join('\n')) {
    const at = journalOrder.findIndex((t, i) => t !== lockOrder[i]);
    errors.push(`order of ${LOCK_REL} differs from ${JOURNAL_REL} at ${journalOrder[at] ?? lockOrder[at]}`);
  }

  return errors;
}

/**
 * Appends a row for every journal entry not yet in the manifest and writes it.
 * Throws (writing nothing) when the file of an existing row has changed.
 * Returns the appended tags.
 */
function appendNewRows(folder) {
  const lock = readLock(folder) ?? { version: 1, migrations: [] };
  for (const row of lock.migrations) {
    const sqlFile = path.join(folder, `${row.tag}.sql`);
    if (fs.existsSync(sqlFile) && lfHash(fs.readFileSync(sqlFile, 'utf8')) !== row.sha256) {
      throw new Error(`${row.tag}: ${row.tag}.sql changed after it was locked — ${IMMUTABLE_MESSAGE}`);
    }
  }

  const known = new Set(lock.migrations.map((r) => r.tag));
  const added = [];
  for (const entry of readJournalEntries(folder)) {
    if (known.has(entry.tag)) continue;
    const sqlFile = path.join(folder, `${entry.tag}.sql`);
    lock.migrations.push({
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
      sha256: lfHash(fs.readFileSync(sqlFile, 'utf8')),
      acceptedHashes: acceptedHashesFor(sqlFile),
    });
    added.push(entry.tag);
  }
  if (added.length > 0) writeLock(folder, lock);
  return added;
}

/** JSON with sorted keys, so a key reorder alone is not reported as a change. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Append-only check of a list (journal entries, manifest rows): every element
 * of `headList` must be unchanged at the same position in `stagedList`.
 */
function checkAppendOnly(headList, stagedList, keyName) {
  const errors = [];
  for (let i = 0; i < headList.length; i++) {
    const name = headList[i] && headList[i][keyName] !== undefined ? headList[i][keyName] : `#${i}`;
    if (i >= stagedList.length) {
      errors.push(`${name}: removed`);
    } else if (stableStringify(headList[i]) !== stableStringify(stagedList[i])) {
      errors.push(`${name}: modified or reordered`);
    }
  }
  return errors;
}

/**
 * Parses `git diff --name-status -z` output and returns the migration .sql
 * paths present in HEAD that the change modifies, deletes or renames away.
 */
function findImmutableSqlChanges(nameStatus, headSqlPaths) {
  const head = new Set(headSqlPaths);
  const parts = nameStatus.split('\0').filter(Boolean);
  const offending = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const file = parts[i + 1];
    if (status !== 'A' && head.has(file)) offending.push(file);
  }
  return offending;
}

/** The staged (`:path`) or committed (`HEAD:path`) version of a JSON file, or null. */
function gitJson(spec, cwd) {
  let text;
  try {
    text = git(['show', spec], cwd);
  } catch {
    return null;
  }
  return JSON.parse(text);
}

/** Returns the list of violations for the staged change; empty = commit allowed. */
function preCommitViolations(cwd) {
  const root = git(['rev-parse', '--show-toplevel'], cwd).trim();
  try {
    git(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  } catch {
    return []; // first commit: nothing is immutable yet
  }

  const violations = [];
  const headSql = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', `${MIGRATIONS_REL}/`], root)
    .split('\n')
    .filter((p) => p.endsWith('.sql') && path.posix.dirname(p) === MIGRATIONS_REL);
  const nameStatus = git(['diff', '--cached', '--name-status', '--no-renames', '-z', 'HEAD', '--', `${MIGRATIONS_REL}/`], root);
  for (const file of findImmutableSqlChanges(nameStatus, headSql)) {
    violations.push(`${file}: committed migration modified, renamed or deleted`);
  }

  const lists = [
    { rel: `${MIGRATIONS_REL}/${JOURNAL_REL}`, key: 'entries', name: 'tag' },
    { rel: `${MIGRATIONS_REL}/${LOCK_REL}`, key: 'migrations', name: 'tag' },
  ];
  for (const { rel, key, name } of lists) {
    const headJson = gitJson(`HEAD:${rel}`, root);
    if (!headJson) continue; // new file: nothing to protect yet
    let stagedJson;
    try {
      stagedJson = gitJson(`:${rel}`, root);
    } catch (err) {
      violations.push(`${rel}: staged version is not valid JSON (${err.message})`);
      continue;
    }
    const stagedList = stagedJson && Array.isArray(stagedJson[key]) ? stagedJson[key] : [];
    for (const e of checkAppendOnly(headJson[key] ?? [], stagedList, name)) {
      violations.push(`${rel}: ${e}`);
    }
  }
  return violations;
}

if (require.main === module) {
  try {
    if (process.argv.includes('--pre-commit')) {
      const violations = preCommitViolations(process.cwd());
      if (violations.length > 0) {
        process.stderr.write(`pre-commit: ${IMMUTABLE_MESSAGE}\n`);
        for (const v of violations) process.stderr.write(`  ${v}\n`);
        process.stderr.write('Only appending a new migration (and npm run migrations:lock) is allowed.\n');
        process.exit(1);
      }
      process.exit(0);
    }

    const added = appendNewRows(MIGRATIONS_FOLDER);
    process.stderr.write(added.length > 0
      ? `migrations:lock: appended ${added.join(', ')}\n`
      : 'migrations:lock: manifest already up to date\n');
    const errors = reconcile(MIGRATIONS_FOLDER);
    if (errors.length > 0) {
      process.stderr.write(`migrations:lock: reconciliation failed:\n${errors.map((e) => `  ${e}`).join('\n')}\n`);
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`migrations-lock error: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  IMMUTABLE_MESSAGE,
  MIGRATIONS_FOLDER,
  lfHash,
  acceptedHashesFor,
  reconcile,
  appendNewRows,
  checkAppendOnly,
  findImmutableSqlChanges,
  preCommitViolations,
};
