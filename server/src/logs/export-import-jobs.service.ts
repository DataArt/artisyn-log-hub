import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { exportImportJobs } from '../database/schema/index';

export type ExportImportJobKind = 'export' | 'import' | 'staged_upload';
export type ExportImportJobStatus = 'staged' | 'running' | 'done' | 'error';

export interface ExportImportJobRow {
  id: string;
  kind: ExportImportJobKind;
  status: ExportImportJobStatus;
  processed: number;
  total: number;
  errorMessage: string | null;
  resultFilePath: string | null;
  resultFileName: string | null;
  repoId: number | null;
  userId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateExportImportJobParams {
  /** Overrides the app-generated id — used for `staged_upload` rows, where the
   * id must equal the staged file's own name. Omit to
   * mint a fresh `randomUUID()`. */
  id?: string;
  kind: ExportImportJobKind;
  status: ExportImportJobStatus;
  repoId?: number;
  userId?: number;
  total?: number;
  resultFilePath?: string;
  resultFileName?: string;
}

export interface CompleteExportImportJobParams {
  resultFilePath?: string;
  resultFileName?: string;
}

/**
 * DB-backed job tracker for export/import background work:
 * replaces the previously-planned in-memory job map, since the server
 * runs under cluster mode and a status-polling `GET` can land on a
 * worker that never ran the job. Every method here is a plain
 * `INSERT`/`UPDATE`/`SELECT` — no claim/lease locking is needed, since each
 * job row is only ever written by the one request/background-task that
 * created it; concurrent access from other workers is read-only (status
 * polls). Mirrors how `UploadQueueSchedulerService` reads/writes
 * `uploadQueue`.
 */
@Injectable()
export class ExportImportJobsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** Inserts a new job row, returning its id (either `params.id` or a freshly
   * minted `randomUUID()`). */
  async create(params: CreateExportImportJobParams): Promise<string> {
    const id = params.id ?? randomUUID();
    await this.db.insert(exportImportJobs).values({
      id,
      kind: params.kind,
      status: params.status,
      total: params.total ?? 0,
      repoId: params.repoId,
      userId: params.userId,
      resultFilePath: params.resultFilePath,
      resultFileName: params.resultFileName,
    });
    return id;
  }

  /** Updates `processed` (and optionally `total`) on an in-progress job. */
  async updateProgress(
    jobId: string,
    processed: number,
    total?: number,
  ): Promise<void> {
    await this.db
      .update(exportImportJobs)
      .set({
        processed,
        ...(total !== undefined ? { total } : {}),
        updatedAt: new Date(),
      })
      .where(eq(exportImportJobs.id, jobId));
  }

  /** Marks a job `done`, optionally recording where its result file (export
   * zip) lives. */
  async complete(
    jobId: string,
    result?: CompleteExportImportJobParams,
  ): Promise<void> {
    await this.db
      .update(exportImportJobs)
      .set({
        status: 'done',
        ...(result?.resultFilePath !== undefined
          ? { resultFilePath: result.resultFilePath }
          : {}),
        ...(result?.resultFileName !== undefined
          ? { resultFileName: result.resultFileName }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(exportImportJobs.id, jobId));
  }

  /** Marks a job `error` with a descriptive message. */
  async fail(jobId: string, errorMessage: string): Promise<void> {
    await this.db
      .update(exportImportJobs)
      .set({
        status: 'error',
        errorMessage,
        updatedAt: new Date(),
      })
      .where(eq(exportImportJobs.id, jobId));
  }

  /** Looks up a job by id, or `null` if it doesn't exist (expired/never
   * staged/unknown jobId). */
  async get(jobId: string): Promise<ExportImportJobRow | null> {
    const [row] = await this.db
      .select()
      .from(exportImportJobs)
      .where(eq(exportImportJobs.id, jobId));
    return row ?? null;
  }

  /** Deletes a job row outright — used by the export-download endpoint once
   * the zip has finished streaming to the client, so a downloaded export
   * doesn't linger for the cleanup sweep to reap later. */
  async remove(jobId: string): Promise<void> {
    await this.db
      .delete(exportImportJobs)
      .where(eq(exportImportJobs.id, jobId));
  }

  /**
   * Confirms a staged upload: updates the existing
   * `staged_upload` row **in place** to `kind: 'import'`, `status: 'running'`,
   * resetting `processed` to 0 and setting `total` — rather than deleting and
   * re-inserting a new row — so the same id keeps resolving to one row across
   * the staged -> confirmed transition (no window where the id resolves to
   * nothing), and `GET .../import/:jobId/status` and the confirm route both
   * end up reading/writing the one row.
   *
   * `repoId` is optional: the per-repo confirm flow already set it when the
   * `staged_upload` row was created (the repo was known up front), so it's
   * left unchanged there. The repo-less "bootstrap import" confirm flow
   * doesn't know the target repo until it resolves/creates one from the
   * uploaded zip's own `meta.sourceRepoUrl`, so it passes it here instead.
   */
  async startImportFromStagedUpload(
    jobId: string,
    total: number,
    repoId?: number,
  ): Promise<void> {
    await this.db
      .update(exportImportJobs)
      .set({
        kind: 'import',
        status: 'running',
        processed: 0,
        total,
        ...(repoId !== undefined ? { repoId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(exportImportJobs.id, jobId));
  }
}
