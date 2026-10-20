import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { uploadQueue } from '../database/schema/index';
import { UploadQueueService } from '../logs/upload-queue.service';

export type UploadQueueStatus =
  | 'pending'
  | 'processing'
  | 'partially_uploaded'
  | 'failed'
  | 'rejected_foreign_session';

export interface UploadQueueListItem {
  id: number;
  fileName: string;
  sizeBytes: number;
  receivedAt: Date;
  sessionId: string;
  logType: string;
  userId: number;
  repoUrl: string | null;
  status: UploadQueueStatus;
  errorMessage: string | null;
  uploadId: string | null;
  chunksReceived: number | null;
  totalChunks: number | null;
}

/**
 * Backs the admin "Upload Queue" tab: a flat list of `upload_queue` rows (the
 * client groups by session for display) plus a
 * bulk-clear-failed action.
 */
@Injectable()
export class UploadQueueAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly uploadQueueService: UploadQueueService,
  ) {}

  /**
   * Resolves each row's display `repoUrl` via `sessions` -> `logs` ->
   * `log_repositories` -> `repositories`, using a correlated subquery per row
   * (null if the session/link doesn't exist yet). When a session's `logs`
   * rows link to more than one distinct repo, the most-recently-`updatedAt`
   * `logs` row's repo wins, since that's the most relevant one for an
   * in-flight queue entry.
   */
  async listQueue(): Promise<UploadQueueListItem[]> {
    const rows = await this.db
      .select({
        id: uploadQueue.id,
        fileName: uploadQueue.fileName,
        sizeBytes: uploadQueue.sizeBytes,
        receivedAt: uploadQueue.receivedAt,
        sessionId: uploadQueue.sessionId,
        logType: uploadQueue.logType,
        userId: uploadQueue.userId,
        status: uploadQueue.status,
        errorMessage: uploadQueue.errorMessage,
        uploadId: uploadQueue.uploadId,
        chunksReceived: uploadQueue.chunksReceived,
        totalChunks: uploadQueue.totalChunks,
        repoUrl: sql<string | null>`(
          SELECT r.repo_url
          FROM sessions s
          INNER JOIN logs l ON l.session_id = s.id
          INNER JOIN log_repositories lr ON lr.log_id = l.id
          INNER JOIN repositories r ON r.id = lr.repo_id
          WHERE s.session_id = ${sql.raw('upload_queue.session_id')}
          ORDER BY l.updated_at DESC, r.id ASC
          LIMIT 1
        )`,
      })
      .from(uploadQueue)
      .orderBy(asc(uploadQueue.sessionId), asc(uploadQueue.receivedAt))
      .execute();

    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      sizeBytes: Number(row.sizeBytes),
      receivedAt: row.receivedAt,
      sessionId: row.sessionId,
      logType: row.logType,
      userId: row.userId,
      repoUrl: row.repoUrl,
      status: row.status,
      errorMessage: row.errorMessage,
      uploadId: row.uploadId,
      chunksReceived: row.chunksReceived,
      totalChunks: row.totalChunks,
    }));
  }

  /**
   * Resolves the staged file behind one queue row, so an admin can download it
   * and analyze why processing failed. Returns null when the row is gone or
   * its staged file no longer exists on disk (e.g. already cleared). For a
   * `partially_uploaded` row this is the chunk part-file the row points at.
   */
  async resolveStagedFile(
    id: number,
  ): Promise<{ filePath: string; fileName: string } | null> {
    const [row] = await this.db
      .select({ fileName: uploadQueue.fileName })
      .from(uploadQueue)
      .where(eq(uploadQueue.id, id))
      .limit(1);
    if (!row) return null;

    // fileName is server-generated, but basename() guarantees the path can
    // never escape the staging dir.
    const fileName = path.basename(row.fileName);
    const filePath = path.join(
      this.uploadQueueService.resolveStagingDir(),
      fileName,
    );
    const exists = await fs.promises
      .stat(filePath)
      .then((s) => s.isFile())
      .catch(() => false);
    return exists ? { filePath, fileName } : null;
  }

  /**
   * Deletes all `status='failed'` rows and their staged files (best-effort —
   * a missing file, e.g. already removed, is not an error), returning the
   * count of rows removed.
   */
  async clearFailed(): Promise<{ deletedCount: number }> {
    const failedRows = await this.db
      .select({ id: uploadQueue.id, fileName: uploadQueue.fileName })
      .from(uploadQueue)
      .where(eq(uploadQueue.status, 'failed'));

    if (failedRows.length === 0) {
      return { deletedCount: 0 };
    }

    const stagingDir = this.uploadQueueService.resolveStagingDir();
    for (const row of failedRows) {
      // Best-effort cleanup: the DB row deletion below is the source of
      // truth for "cleared". A missing file (ENOENT) is expected if it was
      // already removed some other way; any other unlink failure is not
      // worth aborting the whole batch over either.
      await fs.promises
        .unlink(path.join(stagingDir, row.fileName))
        .catch(() => {});
    }

    await this.db.delete(uploadQueue).where(eq(uploadQueue.status, 'failed'));

    return { deletedCount: failedRows.length };
  }

  /**
   * Resets all `status='failed'` rows back to `pending` (clearing
   * `errorMessage`), so the scheduler's next tick reclaims and reprocesses
   * them — same reset shape as the crash-recovery lease reclaim
   * (`UploadQueueSchedulerService.reclaimExpiredLeases()`), just triggered
   * manually. The staged file is left in place (no file I/O needed): only a
   * previously-failed *processing attempt* is being retried, not a deletion.
   * Useful after fixing a root cause (e.g. an invalid file-category regex
   * pattern) that had made every affected upload fail identically.
   */
  async reprocessFailed(): Promise<{ updatedCount: number }> {
    const result = await this.db
      .update(uploadQueue)
      .set({ status: 'pending', errorMessage: null, updatedAt: new Date() })
      .where(eq(uploadQueue.status, 'failed'))
      .returning({ id: uploadQueue.id });

    return { updatedCount: result.length };
  }
}
