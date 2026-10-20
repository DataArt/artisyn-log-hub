/**
 * Change surface — the `repo_code_inventory` snapshot store.
 *
 * This table is the *denominator* of the report's "share of the codebase touched"
 * indicators. It is a history, not one current row per repo: a report divides by the newest
 * snapshot **at or before its own period end**, so a March report keeps answering with
 * March's codebase size however much the repo grows afterwards.
 */
import { and, desc, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { repoCodeInventory } from '../../database/schema/index';
import type { CodeInventoryEvent } from '../artisyn-extractor';

/**
 * How many snapshots to keep per repository.
 *
 * The hook uploads at most one per 6 h (~1,460/repo/year), which is small but unbounded, so
 * the writer prunes after every insert. 500 rows is a bit over a year of history at the
 * throttle's full rate — comfortably more than any report period, and a fixed ceiling.
 */
export const REPO_CODE_INVENTORY_KEEP = 500;

/** `varchar(255)` — a branch name longer than this is truncated, never rejected. */
const MAX_BRANCH_LENGTH = 255;
/** `varchar(40)` — a full SHA-1 is 40 chars; anything longer is not a sha. */
const MAX_COMMIT_SHA_LENGTH = 40;

/**
 * Inserts one snapshot for a repository, idempotently, then prunes the repo's history.
 *
 * Idempotence is on `(repo_id, captured_at, branch)`, which is why `branch` is stored as
 * `''` rather than `NULL` when the hook has none (a detached HEAD): Postgres treats NULLs as
 * distinct in a unique index, so a nullable column would let the same re-uploaded snapshot
 * insert twice. Re-uploading the same artisyn body — which happens on every chunked upload —
 * must not grow the table.
 */
export async function upsertRepoCodeInventory(
  db: DrizzleDb,
  repoId: number,
  snapshot: CodeInventoryEvent,
): Promise<void> {
  const capturedAt = new Date(snapshot.capturedAt);
  if (isNaN(capturedAt.getTime())) return;

  await db
    .insert(repoCodeInventory)
    .values({
      repoId,
      capturedAt,
      branch: (snapshot.branch ?? '').slice(0, MAX_BRANCH_LENGTH),
      commitSha: snapshot.commitSha?.slice(0, MAX_COMMIT_SHA_LENGTH) ?? null,
      trackedFiles: snapshot.trackedFiles,
      trackedLines: snapshot.trackedLines,
      trackedBinaryFiles: snapshot.trackedBinaryFiles,
    })
    .onConflictDoUpdate({
      target: [
        repoCodeInventory.repoId,
        repoCodeInventory.capturedAt,
        repoCodeInventory.branch,
      ],
      set: {
        commitSha: sql`excluded.commit_sha`,
        trackedFiles: sql`excluded.tracked_files`,
        trackedLines: sql`excluded.tracked_lines`,
        trackedBinaryFiles: sql`excluded.tracked_binary_files`,
      },
    });

  // Prune everything outside the newest `REPO_CODE_INVENTORY_KEEP` rows for this repo. Done
  // in SQL rather than by reading ids back so the whole write stays two statements.
  await db.execute(sql`
    DELETE FROM repo_code_inventory
    WHERE repo_id = ${repoId}
      AND id NOT IN (
        SELECT id FROM repo_code_inventory
        WHERE repo_id = ${repoId}
        ORDER BY captured_at DESC, id DESC
        LIMIT ${REPO_CODE_INVENTORY_KEEP}
      )
  `);
}

/** One repository's newest snapshot at or before a point in time. */
export interface RepoCodeInventorySnapshot {
  repoId: number;
  capturedAt: string;
  branch: string | null;
  trackedFiles: number;
  trackedLines: number;
  trackedBinaryFiles: number;
}

/**
 * Newest snapshot at or before `endDate` for each repository, as a map keyed by `repo_id`.
 *
 * A repository with no snapshot in range is simply absent — the report then renders
 * "n/a · denominator unavailable" rather than a `0%` computed against nothing.
 */
export async function findInventoryAtOrBefore(
  db: DrizzleDb,
  repoIds: readonly number[],
  endDate: Date,
): Promise<Map<number, RepoCodeInventorySnapshot>> {
  const result = new Map<number, RepoCodeInventorySnapshot>();
  const ids = [...new Set(repoIds)];
  if (ids.length === 0) return result;

  // `DISTINCT ON` + the `(repo_id, captured_at)` index: one index scan per repo, no window
  // function and no per-repo round trip.
  const rows = await db
    .selectDistinctOn([repoCodeInventory.repoId], {
      repoId: repoCodeInventory.repoId,
      capturedAt: repoCodeInventory.capturedAt,
      branch: repoCodeInventory.branch,
      trackedFiles: repoCodeInventory.trackedFiles,
      trackedLines: repoCodeInventory.trackedLines,
      trackedBinaryFiles: repoCodeInventory.trackedBinaryFiles,
    })
    .from(repoCodeInventory)
    .where(
      and(
        inArray(repoCodeInventory.repoId, ids),
        lte(repoCodeInventory.capturedAt, endDate),
      ),
    )
    .orderBy(
      repoCodeInventory.repoId,
      desc(repoCodeInventory.capturedAt),
      desc(repoCodeInventory.id),
    );

  for (const row of rows) {
    result.set(row.repoId, {
      repoId: row.repoId,
      capturedAt: row.capturedAt.toISOString(),
      branch: row.branch === '' ? null : row.branch,
      trackedFiles: row.trackedFiles,
      trackedLines: row.trackedLines,
      trackedBinaryFiles: row.trackedBinaryFiles,
    });
  }
  return result;
}
