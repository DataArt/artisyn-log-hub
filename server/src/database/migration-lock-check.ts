import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Startup half of the migration immutability guard (the commit-time half is
 * `scripts/migrations-lock.js`). Drizzle records a hash of every applied
 * migration but never compares it again, so an edited committed migration is
 * silently skipped on a migrated database. These checks run before
 * `migrate()` and refuse to start instead:
 *
 * - every journal migration has a row in `meta/migrations.lock.json` and its
 *   file (normalized to LF) still matches the row's `sha256`;
 * - every row already in `__drizzle_migrations` maps (by `created_at` =
 *   journal `when`) to a journal migration whose `acceptedHashes` contain the
 *   recorded hash.
 *
 * There is deliberately no bypass flag or env var.
 */

export const IMMUTABLE_MESSAGE =
  'миграции неизменяемы — создайте новую миграцию';

const LOCK_FILE = 'meta/migrations.lock.json';
const RESET_HINT =
  'On a dev/contract_* database run `npm run migrate:reset` (from server/).';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface LockRow {
  idx: number;
  tag: string;
  when: number;
  sha256: string;
  acceptedHashes: string[];
}

/** The slice of a pg client this module needs (a `PoolClient` satisfies it). */
export interface SqlQueryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface AppliedMigration {
  hash: string;
  /** `bigint` column — node-postgres returns it as a string. */
  created_at: string | number;
}

function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(folder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

function readLockRows(folder: string): Map<string, LockRow> {
  const file = join(folder, LOCK_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `Migration lock file not found at: ${file}. Run \`npm run migrations:lock\` from server/.`,
    );
  }
  const lock = JSON.parse(readFileSync(file, 'utf8')) as {
    migrations: LockRow[];
  };
  return new Map(lock.migrations.map((row) => [row.tag, row]));
}

function lfHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

function fail(problems: string[]): never {
  throw new Error(
    `Migration immutability check failed — ${IMMUTABLE_MESSAGE}:\n` +
      problems.map((p) => `  ${p}`).join('\n') +
      `\n${RESET_HINT}`,
  );
}

/** Each journal migration has a manifest row matching its file on disk. */
export function verifyMigrationFilesAgainstLock(folder: string): void {
  const rows = readLockRows(folder);
  const problems: string[] = [];
  for (const entry of readJournal(folder)) {
    const row = rows.get(entry.tag);
    if (!row) {
      problems.push(`${entry.tag}: no row in ${LOCK_FILE}`);
      continue;
    }
    const text = readFileSync(join(folder, `${entry.tag}.sql`), 'utf8');
    if (lfHash(text) !== row.sha256) {
      problems.push(
        `${entry.tag}: ${entry.tag}.sql differs from its locked sha256`,
      );
    }
  }
  if (problems.length > 0) fail(problems);
}

/** Every already-applied migration is a known journal migration with an accepted hash. */
export function verifyAppliedMigrations(
  folder: string,
  applied: AppliedMigration[],
): void {
  const rows = readLockRows(folder);
  const tagByWhen = new Map(readJournal(folder).map((e) => [e.when, e.tag]));
  const problems: string[] = [];
  for (const migration of applied) {
    const createdAt = Number(migration.created_at);
    const tag = tagByWhen.get(createdAt);
    if (tag === undefined) {
      problems.push(
        `applied migration created_at=${createdAt} (hash ${migration.hash}) has no entry in meta/_journal.json — the database is ahead of the code`,
      );
      continue;
    }
    const row = rows.get(tag);
    if (!row) {
      problems.push(`${tag}: no row in ${LOCK_FILE}`);
    } else if (!row.acceptedHashes.includes(migration.hash)) {
      problems.push(
        `${tag}: applied with hash ${migration.hash}, which is not one of its accepted hashes`,
      );
    }
  }
  if (problems.length > 0) fail(problems);
}

/** Rows of `"<schema>"."__drizzle_migrations"`; empty when the table does not exist yet. */
export async function loadAppliedMigrations(
  client: SqlQueryable,
  schema: string,
): Promise<AppliedMigration[]> {
  const table = `"${schema.replace(/"/g, '""')}"."__drizzle_migrations"`;
  const exists = await client.query('SELECT to_regclass($1) AS t', [table]);
  if (!exists.rows[0]?.t) return [];
  const result = await client.query(`SELECT hash, created_at FROM ${table}`);
  return result.rows.map((row) => ({
    hash: String(row.hash),
    created_at: String(row.created_at),
  }));
}
