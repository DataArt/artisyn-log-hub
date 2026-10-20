import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  IMMUTABLE_MESSAGE,
  loadAppliedMigrations,
  verifyAppliedMigrations,
  verifyMigrationFilesAgainstLock,
} from './migration-lock-check';

/**
 * The startup immutability check over temp migration folders — no DB rows
 * needed: applied rows are passed in as plain objects.
 */

const sha = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const ORIGINAL = '-- 0000_a\nSELECT 1;\n';
const HISTORICAL = '-- 0000_a (before release fix)\nSELECT 1;\n';

function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'migration-lock-check-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(join(folder, '0000_a.sql'), ORIGINAL);
  writeFileSync(join(folder, '0001_b.sql'), 'SELECT 2;\n');
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({
      entries: [
        { idx: 0, when: 1000, tag: '0000_a' },
        { idx: 1, when: 1001, tag: '0001_b' },
      ],
    }),
  );
  writeFileSync(
    join(folder, 'meta/migrations.lock.json'),
    JSON.stringify({
      version: 1,
      migrations: [
        {
          idx: 0,
          tag: '0000_a',
          when: 1000,
          sha256: sha(ORIGINAL),
          acceptedHashes: [
            sha(ORIGINAL),
            sha(ORIGINAL.replace(/\n/g, '\r\n')),
            sha(HISTORICAL),
          ],
        },
        {
          idx: 1,
          tag: '0001_b',
          when: 1001,
          sha256: sha('SELECT 2;\n'),
          acceptedHashes: [sha('SELECT 2;\n')],
        },
      ],
    }),
  );
  return folder;
}

describe('migration lock check', () => {
  let folder: string;

  beforeEach(() => {
    folder = makeFolder();
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  describe('verifyMigrationFilesAgainstLock', () => {
    it('passes for unchanged files, in LF or CRLF', () => {
      expect(() => verifyMigrationFilesAgainstLock(folder)).not.toThrow();
      writeFileSync(
        join(folder, '0000_a.sql'),
        ORIGINAL.replace(/\n/g, '\r\n'),
      );
      expect(() => verifyMigrationFilesAgainstLock(folder)).not.toThrow();
    });

    it('throws naming the tag when a committed file was edited', () => {
      writeFileSync(join(folder, '0001_b.sql'), '-- comment\nSELECT 2;\n');
      expect(() => verifyMigrationFilesAgainstLock(folder)).toThrow(
        /0001_b[\s\S]*npm run migrate:reset/,
      );
      expect(() => verifyMigrationFilesAgainstLock(folder)).toThrow(
        IMMUTABLE_MESSAGE,
      );
    });

    it('throws when a journal entry has no manifest row', () => {
      writeFileSync(join(folder, '0002_c.sql'), 'SELECT 3;\n');
      writeFileSync(
        join(folder, 'meta/_journal.json'),
        JSON.stringify({
          entries: [
            { idx: 0, when: 1000, tag: '0000_a' },
            { idx: 1, when: 1001, tag: '0001_b' },
            { idx: 2, when: 1002, tag: '0002_c' },
          ],
        }),
      );
      expect(() => verifyMigrationFilesAgainstLock(folder)).toThrow(
        /0002_c: no row/,
      );
    });

    it('throws when the lock file is missing', () => {
      rmSync(join(folder, 'meta/migrations.lock.json'));
      expect(() => verifyMigrationFilesAgainstLock(folder)).toThrow(
        /npm run migrations:lock/,
      );
    });
  });

  describe('verifyAppliedMigrations', () => {
    it.each([
      ['LF', sha(ORIGINAL)],
      ['CRLF', sha(ORIGINAL.replace(/\n/g, '\r\n'))],
      ['historical', sha(HISTORICAL)],
    ])('accepts the %s hash of an applied migration', (_label, hash) => {
      expect(() =>
        verifyAppliedMigrations(folder, [{ hash, created_at: '1000' }]),
      ).not.toThrow();
    });

    it('accepts an empty (fresh) database', () => {
      expect(() => verifyAppliedMigrations(folder, [])).not.toThrow();
    });

    it('throws with the tag and the reset hint for an unknown hash', () => {
      expect(() =>
        verifyAppliedMigrations(folder, [
          { hash: sha('edited'), created_at: 1001 },
        ]),
      ).toThrow(/0001_b: applied with hash[\s\S]*npm run migrate:reset/);
    });

    it('throws when an applied migration is not in the journal', () => {
      expect(() =>
        verifyAppliedMigrations(folder, [
          { hash: sha(ORIGINAL), created_at: '1000' },
          { hash: 'x', created_at: '9999' },
        ]),
      ).toThrow(/created_at=9999[\s\S]*ahead of the code/);
    });
  });

  describe('loadAppliedMigrations', () => {
    it('returns no rows when the tracking table does not exist', async () => {
      const query = jest.fn().mockResolvedValueOnce({ rows: [{ t: null }] });
      await expect(
        loadAppliedMigrations({ query }, 'drizzle'),
      ).resolves.toEqual([]);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith('SELECT to_regclass($1) AS t', [
        '"drizzle"."__drizzle_migrations"',
      ]);
    });

    it('reads hash and created_at when the table exists', async () => {
      const rows = [{ hash: 'h', created_at: '1000' }];
      const query = jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ t: 'drizzle.__drizzle_migrations' }],
        })
        .mockResolvedValueOnce({ rows });
      await expect(
        loadAppliedMigrations({ query }, 'drizzle'),
      ).resolves.toEqual(rows);
      expect(query).toHaveBeenLastCalledWith(
        'SELECT hash, created_at FROM "drizzle"."__drizzle_migrations"',
      );
    });
  });
});
