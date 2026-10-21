import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard';
import { scanZipLimits } from './export-import-zip';
import type { ExportMetaJson } from './export-import-zip';
import { ImportLimitError } from './import-limits';
import { ImportZipUploadInterceptor } from './import-zip-upload.interceptor';
import { ExportImportJobsService } from './export-import-jobs.service';
import type {
  ExportImportJobKind,
  ExportImportJobRow,
  ExportImportJobStatus,
} from './export-import-jobs.service';
import type {
  ExportImportScope,
  ScopeFilters,
} from './repository-export-import.service';
import { RepositoryExportImportService } from './repository-export-import.service';
import type { AuthUser } from './repositories.service';
import { RepositoriesService } from './repositories.service';
import { TeamsService } from '../teams/teams.service';
import type { ImportConflict } from './upload-warnings';
import { importConflictMessage } from './upload-warnings';

interface ExportRequestBody {
  teamId?: number;
  scope: string;
  from?: string;
  to?: string;
  sessionIds?: string[];
  description?: string;
}

interface JobStatusResponse {
  status: ExportImportJobStatus;
  processed: number;
  total: number;
  errorMessage?: string;
}

/**
 * The 7 export/import endpoints (API changes table) — a new
 * sibling controller to `RepositoriesController`, not more methods on it. Every
 * handler calls `RepositoriesService.assertRepoOwnerOrTeamOwner()` first
 * — stricter than plain team membership, since export/import can
 * read/write every team member's sessions. `teamId` is threaded through every
 * route (query param on GETs, body field on POSTs) since the team-owner check
 * only activates when it's explicitly passed.
 */
@Controller('api/v1/repositories')
@UseGuards(SessionAuthGuard)
export class RepositoryExportImportController {
  private readonly logger = new Logger(RepositoryExportImportController.name);

  constructor(
    private readonly repositoriesService: RepositoriesService,
    private readonly repositoryExportImportService: RepositoryExportImportService,
    private readonly exportImportJobsService: ExportImportJobsService,
    private readonly teamsService: TeamsService,
  ) {}

  // ---------------------------------------------------------------------------
  // "Bootstrap import" — import a previously exported zip with no existing
  // target repoId. Unlike every route below, these three don't call
  // `assertRepoOwnerOrTeamOwner` (there's nothing to check access on yet): the
  // target repo is resolved/created from the zip's own `meta.sourceRepoUrl`,
  // scoped to the current user's *personal* repos only (no `teamId`), letting
  // sessions land on an empty server or under a brand-new personal repo.
  // Mounted at distinct literal paths (`bootstrap-import/...`) that never
  // collide with the `:repoId/...` routes below at the same segment count.
  // ---------------------------------------------------------------------------

  @Post('bootstrap-import/upload')
  @UseInterceptors(ImportZipUploadInterceptor)
  async uploadBootstrapImportZip(
    @Req() req: Request,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{
    uploadToken: string;
    sessionCount: number;
    approxUncompressedBytes: number;
    meta: ExportMetaJson;
  }> {
    const user = req.user as AuthUser;

    if (!file) {
      throw new BadRequestException('file is required');
    }

    await this.assertZipWithinLimits(file.path);

    const uploadToken = file.filename;

    // No repoId yet: this
    // staged_upload row is what lets the cleanup sweep reap an
    // uploaded-but-never-confirmed zip after 30 minutes.
    await this.exportImportJobsService.create({
      id: uploadToken,
      kind: 'staged_upload',
      status: 'staged',
      userId: user.id,
      resultFilePath: file.path,
      resultFileName: file.originalname,
    });

    let meta: ExportMetaJson;
    try {
      meta = await this.repositoryExportImportService.parseUploadedZipMeta(
        file.path,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.exportImportJobsService.fail(uploadToken, message);
      throw new UnprocessableEntityException(message);
    }

    await this.assertNoImportConflicts(uploadToken, file.path, user);

    return {
      uploadToken,
      sessionCount: meta.sessionCount,
      approxUncompressedBytes: meta.approxUncompressedBytes,
      meta,
    };
  }

  @Post('bootstrap-import/:uploadToken/confirm')
  @HttpCode(202)
  async confirmBootstrapImport(
    @Req() req: Request,
    @Param('uploadToken') uploadToken: string,
  ): Promise<{ jobId: string; repoId: number; teamId: number }> {
    const user = req.user as AuthUser;

    const job = await this.exportImportJobsService.get(uploadToken);
    if (
      !job ||
      job.kind !== 'staged_upload' ||
      job.userId !== user.id ||
      !job.resultFilePath
    ) {
      throw new NotFoundException(
        'uploadToken has expired or was never staged',
      );
    }
    this.assertStaged(job);

    let meta: ExportMetaJson;
    try {
      meta = await this.repositoryExportImportService.parseUploadedZipMeta(
        job.resultFilePath,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.exportImportJobsService.fail(uploadToken, message);
      throw new UnprocessableEntityException(message);
    }

    // Before the repository and team are resolved/created, so a blocked
    // bootstrap leaves nothing behind.
    await this.assertNoImportConflicts(uploadToken, job.resultFilePath, user);

    const repo = await this.repositoriesService.resolveOrCreatePersonalRepo(
      user.id,
      meta.sourceRepoUrl,
    );

    const teamId = await this.teamsService.resolveOrCreateImportTeam(
      user.id,
      meta.sourceRepoUrl,
    );

    await this.exportImportJobsService.startImportFromStagedUpload(
      uploadToken,
      meta.sessionCount,
      repo.id,
    );

    void this.repositoryExportImportService.runImportJob(
      uploadToken,
      job.resultFilePath,
      repo.repoUrl,
      user.id,
      teamId,
    );

    return { jobId: uploadToken, repoId: repo.id, teamId };
  }

  @Get('bootstrap-import/:jobId/status')
  async getBootstrapImportStatus(
    @Req() req: Request,
    @Param('jobId') jobId: string,
  ): Promise<JobStatusResponse & { repoId: number | null }> {
    const user = req.user as AuthUser;

    const job = await this.exportImportJobsService.get(jobId);
    if (!job || job.userId !== user.id || job.kind !== 'import') {
      throw new NotFoundException('Job not found');
    }

    return {
      status: job.status,
      processed: job.processed,
      total: job.total,
      repoId: job.repoId,
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    };
  }

  @Get(':repoId/export-import/scope')
  async getScopeSummary(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @Query('scope') scopeParam?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sessionIds') sessionIdsCsv?: string,
  ) {
    this.assertTeamIdValid(teamId);
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoOwnerOrTeamOwner(
      user,
      repoId,
      teamId,
    );

    const scope = this.parseScopeEnum(scopeParam);
    const filters = this.buildFiltersFromQuery(scope, from, to, sessionIdsCsv);

    return this.repositoryExportImportService.getScopeSummary(
      user,
      repoId,
      teamId,
      scope,
      filters,
    );
  }

  @Post(':repoId/export')
  @HttpCode(202)
  async startExport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Body() body: ExportRequestBody,
  ): Promise<{ jobId: string }> {
    this.assertTeamIdValid(body?.teamId);
    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoOwnerOrTeamOwner(
      user,
      repoId,
      body?.teamId,
    );

    const scope = this.parseScopeEnum(body?.scope);
    const filters = this.buildFiltersFromBody(
      scope,
      body?.from,
      body?.to,
      body?.sessionIds,
    );

    const jobId = await this.exportImportJobsService.create({
      kind: 'export',
      status: 'running',
      repoId,
      userId: user.id,
    });

    void this.repositoryExportImportService.runExportJob(
      jobId,
      user,
      repo,
      repoId,
      body.teamId,
      scope,
      filters,
      body.description,
    );

    return { jobId };
  }

  @Get(':repoId/export/:jobId/status')
  async getExportStatus(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('jobId') jobId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<JobStatusResponse> {
    return this.getJobStatus(req, repoId, jobId, teamId, 'export');
  }

  @Get(':repoId/export/:jobId/download')
  async downloadExport(
    @Req() req: Request,
    @Res() res: Response,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('jobId') jobId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<void> {
    this.assertTeamIdValid(teamId);
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoOwnerOrTeamOwner(
      user,
      repoId,
      teamId,
    );

    const job = await this.exportImportJobsService.get(jobId);
    if (!job || job.repoId !== repoId || job.kind !== 'export') {
      throw new NotFoundException('Export job not found');
    }
    if (job.status !== 'done' || !job.resultFilePath) {
      throw new ConflictException('Export job is not finished yet');
    }

    const filePath = job.resultFilePath;
    const fileName = job.resultFileName ?? 'export.zip';

    // A GET must not change state: the zip and its job row are
    // left in place and reaped by ExportImportJobCleanupScheduler after the job TTL.
    res.download(filePath, fileName, (err) => {
      if (err) {
        this.logger.warn(
          `Export download failed for job ${jobId}: ${err.message}`,
        );
      }
    });
  }

  @Post(':repoId/import/upload')
  @UseInterceptors(ImportZipUploadInterceptor)
  async uploadImportZip(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{
    uploadToken: string;
    sessionCount: number;
    approxUncompressedBytes: number;
    meta: ExportMetaJson;
  }> {
    this.assertTeamIdValid(teamId);
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoOwnerOrTeamOwner(
      user,
      repoId,
      teamId,
    );

    if (!file) {
      throw new BadRequestException('file is required');
    }

    await this.assertZipWithinLimits(file.path);

    const uploadToken = file.filename;

    // Insert the staged_upload row immediately after staging
    // — this is what lets the cleanup sweep reap an
    // uploaded-but-never-confirmed zip after 30 minutes, regardless of
    // whether meta parsing below succeeds.
    await this.exportImportJobsService.create({
      id: uploadToken,
      kind: 'staged_upload',
      status: 'staged',
      repoId,
      userId: user.id,
      resultFilePath: file.path,
      resultFileName: file.originalname,
    });

    let meta: ExportMetaJson;
    try {
      meta = await this.repositoryExportImportService.parseUploadedZipMeta(
        file.path,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.exportImportJobsService.fail(uploadToken, message);
      throw new UnprocessableEntityException(message);
    }

    await this.assertNoImportConflicts(uploadToken, file.path, user);

    return {
      uploadToken,
      sessionCount: meta.sessionCount,
      approxUncompressedBytes: meta.approxUncompressedBytes,
      meta,
    };
  }

  @Post(':repoId/import/:uploadToken/confirm')
  @HttpCode(202)
  async confirmImport(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('uploadToken') uploadToken: string,
    @Body() body: { teamId?: number },
  ): Promise<{ jobId: string }> {
    this.assertTeamIdValid(body?.teamId);
    const user = req.user as AuthUser;
    const repo = await this.repositoriesService.assertRepoOwnerOrTeamOwner(
      user,
      repoId,
      body?.teamId,
    );

    const job = await this.exportImportJobsService.get(uploadToken);
    if (
      !job ||
      job.kind !== 'staged_upload' ||
      job.repoId !== repoId ||
      !job.resultFilePath
    ) {
      throw new NotFoundException(
        'uploadToken has expired or was never staged',
      );
    }
    this.assertStaged(job);

    let meta: ExportMetaJson;
    try {
      meta = await this.repositoryExportImportService.parseUploadedZipMeta(
        job.resultFilePath,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.exportImportJobsService.fail(uploadToken, message);
      throw new UnprocessableEntityException(message);
    }

    await this.assertNoImportConflicts(uploadToken, job.resultFilePath, user);

    await this.exportImportJobsService.startImportFromStagedUpload(
      uploadToken,
      meta.sessionCount,
    );

    void this.repositoryExportImportService.runImportJob(
      uploadToken,
      job.resultFilePath,
      repo.repoUrl,
      user.id,
    );

    return { jobId: uploadToken };
  }

  @Get(':repoId/import/:jobId/status')
  async getImportStatus(
    @Req() req: Request,
    @Param('repoId', ParseIntPipe) repoId: number,
    @Param('jobId') jobId: string,
    @Query('teamId', new ParseIntPipe({ optional: true })) teamId?: number,
  ): Promise<JobStatusResponse> {
    return this.getJobStatus(req, repoId, jobId, teamId, 'import');
  }

  private async getJobStatus(
    req: Request,
    repoId: number,
    jobId: string,
    teamId: number | undefined,
    expectedKind: ExportImportJobKind,
  ): Promise<JobStatusResponse> {
    this.assertTeamIdValid(teamId);
    const user = req.user as AuthUser;
    await this.repositoriesService.assertRepoOwnerOrTeamOwner(
      user,
      repoId,
      teamId,
    );

    const job = await this.exportImportJobsService.get(jobId);
    if (!job || job.repoId !== repoId || job.kind !== expectedKind) {
      throw new NotFoundException('Job not found');
    }

    return {
      status: job.status,
      processed: job.processed,
      total: job.total,
      ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
    };
  }

  /**
   * A staged upload that was already failed (blocked by a conflict, a broken
   * archive) or started can never be confirmed: 404 with the stored message,
   * so pressing «Import» again shows the same text as the original failure.
   */
  private assertStaged(job: ExportImportJobRow): void {
    if (job.status !== 'staged') {
      throw new NotFoundException(
        job.errorMessage ?? 'uploadToken has expired or was never staged',
      );
    }
  }

  /**
   * Ownership pre-check for an uploaded/staged import zip, run as `user`
   * (the importer; no admin bypass). Any error reading the archive marks the
   * staged row failed and becomes a 422; conflicts mark it failed and become a
   * 409 whose body carries the `conflicts` list (passed through by
   * `HttpExceptionFilter`).
   */
  private async assertNoImportConflicts(
    uploadToken: string,
    filePath: string,
    user: AuthUser,
  ): Promise<void> {
    let conflicts: ImportConflict[];
    try {
      conflicts = await this.repositoryExportImportService.findImportConflicts(
        filePath,
        user.id,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.exportImportJobsService.fail(uploadToken, message);
      throw new UnprocessableEntityException(message);
    }

    if (conflicts.length === 0) return;

    const message = importConflictMessage(conflicts);
    await this.exportImportJobsService.fail(uploadToken, message);
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message,
      conflicts,
    });
  }

  /**
   * Zip import limits, checked before the staged job row exists:
   * on any violation the uploaded temp file is deleted and the request fails with 400.
   */
  private async assertZipWithinLimits(filePath: string): Promise<void> {
    try {
      await scanZipLimits(filePath);
    } catch (err) {
      await fs.promises
        .rm(filePath, { force: true })
        .catch((rmErr: unknown) => {
          this.logger.warn(
            `Failed to remove rejected import zip ${filePath}: ${
              rmErr instanceof Error ? rmErr.message : String(rmErr)
            }`,
          );
        });
      if (err instanceof ImportLimitError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  private assertTeamIdValid(teamId: number | undefined): void {
    if (teamId !== undefined && teamId <= 0) {
      throw new BadRequestException('teamId must be a positive integer');
    }
  }

  private parseScopeEnum(scope: string | undefined): ExportImportScope {
    if (scope !== 'all' && scope !== 'dateRange' && scope !== 'sessionIds') {
      throw new BadRequestException(
        'scope must be one of "all", "dateRange", "sessionIds"',
      );
    }
    return scope;
  }

  private buildFiltersFromQuery(
    scope: ExportImportScope,
    from: string | undefined,
    to: string | undefined,
    sessionIdsCsv: string | undefined,
  ): ScopeFilters {
    if (scope === 'dateRange') {
      if (!from || !to) {
        throw new BadRequestException(
          'from and to are required for the dateRange scope',
        );
      }
      return { from, to };
    }
    if (scope === 'sessionIds') {
      const ids = (sessionIdsCsv ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) {
        throw new BadRequestException(
          'sessionIds is required for the sessionIds scope',
        );
      }
      return { sessionIds: ids };
    }
    return {};
  }

  private buildFiltersFromBody(
    scope: ExportImportScope,
    from: string | undefined,
    to: string | undefined,
    sessionIds: string[] | undefined,
  ): ScopeFilters {
    if (scope === 'dateRange') {
      if (!from || !to) {
        throw new BadRequestException(
          'from and to are required for the dateRange scope',
        );
      }
      return { from, to };
    }
    if (scope === 'sessionIds') {
      if (!sessionIds || sessionIds.length === 0) {
        throw new BadRequestException(
          'sessionIds is required for the sessionIds scope',
        );
      }
      return { sessionIds };
    }
    return {};
  }
}
