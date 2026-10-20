import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { uploadQueue } from '../database/schema/index';
import { findSessionOwnerId } from './logs.service';

export interface SaveRawUploadMeta {
  sessionId: string;
  logType: string;
  userId: number;
  parentSessionId?: string;
  workflowRunId?: string;
  /** DD-8: set only when the upload's `snapshotFull=1` and `snapshotId` is valid. */
  harnessSnapshotId?: string;
}

export interface SaveChunkMeta {
  sessionId: string;
  logType: string;
  userId: number;
  parentSessionId?: string;
  workflowRunId?: string;
  uploadId: string;
  chunkIndex: number;
  totalChunks: number;
  totalSize?: number;
  /** DD-8: set only when the upload's `snapshotFull=1` and `snapshotId` is valid. */
  harnessSnapshotId?: string;
}

/**
 * Minimal projection of an `upload_queue` row identified by `uploadId`,
 * used both by `saveChunk()`'s own bookkeeping and by
 * `LogsV2Controller`'s chunked-upload validation.
 */
export interface UploadQueueRowByUploadId {
  id: number;
  totalChunks: number | null;
  chunksReceived: number | null;
}

/** Escapes regex metacharacters so a caller-supplied `uploadId` can be used literally inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Staging + queue-row bookkeeping for the async `POST /api/v2/logs` path.
 * The actual NDJSON parsing + `LogsService`
 * upsert happens later, off the request path, in
 * `UploadQueueSchedulerService`.
 */
@Injectable()
export class UploadQueueService {
  private readonly logger = new Logger(UploadQueueService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Resolved relative to CWD, same convention as
   * `SystemInfoService`/`ErrorLogsService`'s `logs/` dir. Created lazily so a
   * fresh checkout doesn't need the directory to exist ahead of time.
   */
  resolveStagingDir(): string {
    const dir = path.resolve(process.env.UPLOAD_QUEUE_DIR || 'upload-queue');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Writes the raw upload body to a staging file and inserts a `pending`
   * `upload_queue` row referencing it. On a write failure, logs via
   * `Logger.error` (surfaces in the admin Error Logs tab)
   * before rethrowing so the caller (`LogsV2Controller`) can 500 without
   * ever inserting a queue row for a file that doesn't exist.
   */
  async saveRawUpload(rawBody: string, meta: SaveRawUploadMeta): Promise<void> {
    const bodyBytes = Buffer.byteLength(rawBody, 'utf8');
    // Leading epoch-millis timestamp keeps filenames
    // sorted in received order; trailing UUID keeps uniqueness under
    // concurrent uploads landing in the same millisecond.
    const fileName = `${Date.now()}-${randomUUID()}.raw`;

    try {
      const dir = this.resolveStagingDir();
      await fs.promises.writeFile(
        path.join(dir, fileName),
        Buffer.from(rawBody, 'utf8'),
      );
    } catch (err) {
      this.logger.error(
        `Failed to stage upload for sessionId=${meta.sessionId} logType=${meta.logType}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }

    await this.db.insert(uploadQueue).values({
      fileName,
      sizeBytes: bodyBytes,
      sessionId: meta.sessionId,
      logType: meta.logType,
      userId: meta.userId,
      parentSessionId: meta.parentSessionId,
      workflowRunId: meta.workflowRunId,
      status: 'pending',
      harnessSnapshotId: meta.harnessSnapshotId,
    });
  }

  /**
   * Stages one chunk of a chunked upload (`${uploadId}.chunk${chunkIndex}`
   * in `resolveStagingDir()`), derives
   * `chunksReceived`/`bytesReceived` from disk,
   * upserts the single `upload_queue` row for `uploadId`, and reassembles
   * into `${uploadId}.raw` once every chunk has arrived.
   * Resolves `{complete: true}` only on the chunk that completes the
   * set.
   */
  async saveChunk(
    rawBody: string,
    meta: SaveChunkMeta,
  ): Promise<{ complete: boolean }> {
    const dir = this.resolveStagingDir();
    const chunkFileName = `${meta.uploadId}.chunk${meta.chunkIndex}`;

    try {
      await fs.promises.writeFile(
        path.join(dir, chunkFileName),
        Buffer.from(rawBody, 'utf8'),
      );
    } catch (err) {
      this.logger.error(
        `Failed to stage chunk uploadId=${meta.uploadId} chunkIndex=${meta.chunkIndex}/${meta.totalChunks}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }

    const { chunksReceived, bytesReceived } = await this.deriveChunkProgress(
      dir,
      meta.uploadId,
      meta.totalChunks,
    );

    if (meta.chunkIndex === 0) {
      const initialStatus =
        meta.totalChunks === 1 ? 'pending' : 'partially_uploaded';
      const existing = await this.findRowByUploadId(meta.uploadId, meta.userId);

      if (existing) {
        // Idempotent retry of chunk 0 — the row
        // already exists, just refresh the derived counters.
        await this.db
          .update(uploadQueue)
          .set({
            chunksReceived,
            totalChunks: meta.totalChunks,
            updatedAt: new Date(),
          })
          .where(eq(uploadQueue.id, existing.id));
      } else {
        await this.db.insert(uploadQueue).values({
          fileName: chunkFileName,
          sizeBytes: meta.totalSize ?? bytesReceived,
          sessionId: meta.sessionId,
          logType: meta.logType,
          userId: meta.userId,
          parentSessionId: meta.parentSessionId,
          workflowRunId: meta.workflowRunId,
          status: initialStatus,
          uploadId: meta.uploadId,
          chunksReceived,
          totalChunks: meta.totalChunks,
          harnessSnapshotId: meta.harnessSnapshotId,
        });
      }
    } else {
      const existing = await this.findRowByUploadId(meta.uploadId, meta.userId);

      if (!existing) {
        // The controller validates this before ever
        // calling saveChunk() with chunkIndex > 0 — reaching here means the
        // row disappeared between validation and staging (e.g. concurrent
        // cleanup); surface it as a hard failure rather than silently
        // fabricating a row.
        throw new Error(
          `No upload_queue row found for uploadId=${meta.uploadId} (chunkIndex=${meta.chunkIndex})`,
        );
      }

      await this.db
        .update(uploadQueue)
        .set({ chunksReceived, updatedAt: new Date() })
        .where(eq(uploadQueue.id, existing.id));
    }

    if (chunksReceived < meta.totalChunks) {
      return { complete: false };
    }

    await this.reassembleChunks(dir, meta);
    return { complete: true };
  }

  /**
   * Scans `resolveStagingDir()` for `${uploadId}.chunk*` part-files matching
   * indices `0..totalChunks-1` and sums their sizes — deliberately derived
   * from disk on every call rather than incremented, so duplicate/retried
   * chunk requests are naturally idempotent.
   */
  private async deriveChunkProgress(
    dir: string,
    uploadId: string,
    totalChunks: number,
  ): Promise<{ chunksReceived: number; bytesReceived: number }> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (err) {
      this.logger.error(
        `Failed to read staging dir while deriving chunk progress for uploadId=${uploadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }

    const chunkPattern = new RegExp(
      `^${escapeRegExp(uploadId)}\\.chunk(\\d+)$`,
    );
    let chunksReceived = 0;
    let bytesReceived = 0;

    for (const entry of entries) {
      const match = chunkPattern.exec(entry);
      if (!match) {
        continue;
      }
      const idx = Number(match[1]);
      if (idx < 0 || idx >= totalChunks) {
        continue;
      }
      const stat = await fs.promises.stat(path.join(dir, entry));
      chunksReceived += 1;
      bytesReceived += stat.size;
    }

    return { chunksReceived, bytesReceived };
  }

  /**
   * Concatenates chunk part-files `0..totalChunks-1` in order into
   * `${uploadId}.raw`, flips the row to `pending` pointing at that file, and
   * only then deletes the now-superseded part-files. A
   * mismatch against the `totalSize` recorded at `chunkIndex===0` is logged
   * as a warning, not fatal — the on-disk bytes always win.
   *
   * The DB update **must** happen before the part-files are unlinked, not
   * after: this file used to write `finalFileName`, delete the chunk
   * part-files, and only then repoint the row at `finalFileName`. If the
   * process died in that window (e.g. a deploy restart killing it mid-tick),
   * the row was left pointing at a `.chunkN` file that had already been
   * deleted, which surfaced later as `UploadQueueSchedulerService` failing
   * every retry with `ENOENT: ... chunk0` — permanently, since nothing ever
   * repoints a `pending`/`failed` row. Updating the row first means a crash
   * in this method can only ever leave harmless leftover files on disk
   * (either the reassembled file before the row is updated, or stray
   * part-files after it), never a row pointing at a file that doesn't exist.
   */
  private async reassembleChunks(
    dir: string,
    meta: SaveChunkMeta,
  ): Promise<void> {
    const chunkPaths = Array.from({ length: meta.totalChunks }, (_, i) =>
      path.join(dir, `${meta.uploadId}.chunk${i}`),
    );

    const buffers = await Promise.all(
      chunkPaths.map((chunkPath) => fs.promises.readFile(chunkPath)),
    );
    const combined = Buffer.concat(buffers);
    const finalFileName = `${meta.uploadId}.raw`;

    await fs.promises.writeFile(path.join(dir, finalFileName), combined);

    if (meta.totalSize !== undefined && meta.totalSize !== combined.length) {
      this.logger.warn(
        `Reassembled upload uploadId=${meta.uploadId} size mismatch: totalSize=${meta.totalSize} actual=${combined.length}`,
      );
    }

    const row = await this.findRowByUploadId(meta.uploadId, meta.userId);
    if (!row) {
      this.logger.error(
        `Cannot finalize reassembly — no upload_queue row found for uploadId=${meta.uploadId}; leaving chunk part-files in place for manual inspection`,
      );
      return;
    }

    await this.db
      .update(uploadQueue)
      .set({
        fileName: finalFileName,
        sizeBytes: combined.length,
        status: 'pending',
        chunksReceived: meta.totalChunks,
        updatedAt: new Date(),
      })
      .where(eq(uploadQueue.id, row.id));

    const unlinkResults = await Promise.allSettled(
      chunkPaths.map((chunkPath) => fs.promises.unlink(chunkPath)),
    );
    let removedCount = 0;
    unlinkResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        removedCount += 1;
      } else {
        this.logger.warn(
          `Failed to remove chunk part-file ${chunkPaths[i]} after reassembly: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
      }
    });
    this.logger.log(
      `Reassembled uploadId=${meta.uploadId} into ${finalFileName} (${combined.length} bytes); removed ${removedCount}/${meta.totalChunks} chunk part-file(s)`,
    );
  }

  /**
   * Locates the single `upload_queue` row for `uploadId`, scoped to
   * `userId` for ownership. Used both by
   * `saveChunk()` internally and by `LogsV2Controller`'s chunked-upload
   * validation.
   */
  async findRowByUploadId(
    uploadId: string,
    userId: number,
  ): Promise<UploadQueueRowByUploadId | null> {
    const rows = await this.db
      .select({
        id: uploadQueue.id,
        totalChunks: uploadQueue.totalChunks,
        chunksReceived: uploadQueue.chunksReceived,
      })
      .from(uploadQueue)
      .where(
        and(eq(uploadQueue.uploadId, uploadId), eq(uploadQueue.userId, userId)),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * `true` when `sessionId` already belongs to a user other than `userId`
   * (open-source readiness). Lock-free pre-check for the v2
   * controller — the authoritative, locked check runs again in `LogsService.upsert()`
   * when the queue worker processes the row.
   */
  async isForeignSession(sessionId: string, userId: number): Promise<boolean> {
    const ownerId = await findSessionOwnerId(this.db, sessionId);
    return ownerId !== null && ownerId !== userId;
  }

  /**
   * Selects `failed` upload_queue rows for `userId`, mapped to hook-readable
   * warning strings — returned in `POST /api/v2/logs`'s
   * response body so `send-logs-hook.js` can surface them as a
   * `broken-upload-file` recommendation.
   *
   * Also delivers `rejected_foreign_session` rows (open-source readiness)
   * — exactly once: the `UPDATE … RETURNING` flips
   * `warning_delivered` atomically, so concurrent requests cannot both return the
   * same row. Their `errorMessage` already holds the full warning text.
   */
  async getPendingWarnings(userId: number): Promise<string[]> {
    const rows = await this.db
      .select({
        fileName: uploadQueue.fileName,
        errorMessage: uploadQueue.errorMessage,
      })
      .from(uploadQueue)
      .where(
        and(eq(uploadQueue.userId, userId), eq(uploadQueue.status, 'failed')),
      );

    const rejectedRows = await this.db
      .update(uploadQueue)
      .set({ warningDelivered: true })
      .where(
        and(
          eq(uploadQueue.userId, userId),
          eq(uploadQueue.status, 'rejected_foreign_session'),
          eq(uploadQueue.warningDelivered, false),
        ),
      )
      .returning({ errorMessage: uploadQueue.errorMessage });

    return [
      ...rows.map(
        (row) =>
          `Hook uploaded broken file: ${row.fileName} — ${row.errorMessage}`,
      ),
      ...rejectedRows
        .map((row) => row.errorMessage)
        .filter((msg): msg is string => !!msg),
    ];
  }

  /**
   * Deletes every `upload_queue` row for the given `sessions.sessionId`
   * strings — any status — as part of a session purge.
   * `upload_queue.session_id` is a plain `varchar`, not a foreign key,
   * so this join has to be done explicitly by the caller
   * (`SessionsService.purgeSessionChildData`) rather than relying on a
   * cascade. Runs inside the caller's transaction (`tx`) so the queue-row
   * deletion and the rest of the purge commit/rollback together.
   *
   * Best-effort unlinks each row's staged file(s) before the row is deleted:
   * a `partially_uploaded` row has no single staged file yet,
   * so every `${uploadId}.chunk*` part-file is removed
   * instead — unless `uploadId` was never set (chunk 0 hasn't landed), in
   * which case there is nothing staged under that name yet and file cleanup
   * is skipped. Any other status unlinks `row.fileName` directly, mirroring
   * `UploadQueueAdminService.clearFailed()`'s pattern.
   */
  async deleteQueueRowsForSessionIds(
    tx: DrizzleDb,
    sessionIdStrs: string[],
  ): Promise<void> {
    if (sessionIdStrs.length === 0) {
      return;
    }

    const rows = await tx
      .select({
        id: uploadQueue.id,
        fileName: uploadQueue.fileName,
        status: uploadQueue.status,
        uploadId: uploadQueue.uploadId,
      })
      .from(uploadQueue)
      .where(inArray(uploadQueue.sessionId, sessionIdStrs));

    if (rows.length === 0) {
      return;
    }

    const stagingDir = this.resolveStagingDir();

    for (const row of rows) {
      if (row.status === 'partially_uploaded') {
        if (!row.uploadId) {
          // Chunk 0 never landed — nothing staged under this row yet.
          continue;
        }
        await this.unlinkChunkPartFiles(stagingDir, row.uploadId);
      } else {
        await fs.promises
          .unlink(path.join(stagingDir, row.fileName))
          .catch(() => {});
      }
    }

    await tx.delete(uploadQueue).where(
      inArray(
        uploadQueue.id,
        rows.map((row) => row.id),
      ),
    );
  }

  /**
   * Deletes every `partially_uploaded` row no chunk has touched since
   * `cutoff` (each chunk bumps `updated_at`), plus its `${uploadId}.chunk*`
   * part-files — a chunked upload the hook abandoned (killed mid-upload,
   * network loss) that would otherwise sit in the queue and the staging dir
   * forever. A late chunk for an expired upload gets the same 400 as any
   * unknown `uploadId`, and the hook re-sends the file on its next run.
   *
   * The row delete comes first and re-checks status/age itself, so a chunk
   * that lands concurrently keeps its row; files are only removed for rows
   * this call actually deleted.
   *
   * @returns the number of rows expired
   */
  async expireStalePartialUploads(cutoff: Date): Promise<number> {
    const expired = await this.db
      .delete(uploadQueue)
      .where(
        and(
          eq(uploadQueue.status, 'partially_uploaded'),
          lt(uploadQueue.updatedAt, cutoff),
        ),
      )
      .returning({ uploadId: uploadQueue.uploadId });

    const stagingDir = this.resolveStagingDir();
    for (const row of expired) {
      if (row.uploadId) {
        await this.unlinkChunkPartFiles(stagingDir, row.uploadId);
      }
    }
    return expired.length;
  }

  /**
   * Best-effort removes every `${uploadId}.chunk*` part-file from `dir` — a
   * missing/unreadable dir or a missing individual file is not an error
   * (mirrors `clearFailed()`'s tolerance for already-removed files).
   */
  private async unlinkChunkPartFiles(
    dir: string,
    uploadId: string,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (err) {
      this.logger.warn(
        `Failed to read staging dir while cleaning up chunk files for uploadId=${uploadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    const chunkPattern = new RegExp(`^${escapeRegExp(uploadId)}\\.chunk\\d+$`);
    await Promise.all(
      entries
        .filter((entry) => chunkPattern.test(entry))
        .map((entry) =>
          fs.promises.unlink(path.join(dir, entry)).catch(() => {}),
        ),
    );
  }
}
