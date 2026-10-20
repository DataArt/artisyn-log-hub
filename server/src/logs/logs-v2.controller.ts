import {
  BadRequestException,
  Controller,
  Body,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';
import { UploadQueueService } from './upload-queue.service';
import { FOREIGN_SESSION_WARNING } from './upload-warnings';

/**
 * `POST /api/v2/logs` — the log upload route: async stage-then-queue.
 * There is no NDJSON parsing on the request path: the raw body
 * is staged to disk and queued for `UploadQueueSchedulerService` to parse and
 * store later, and the response body carries any pending `failed`-row warnings
 * for the calling hook to surface.
 *
 * This is the only upload route. The synchronous `POST /api/v1/logs` was
 * removed (open-source readiness) and now answers 404;
 * hooks older than 1.7.0, which still used it, must be upgraded.
 */
@Controller('api/v2')
export class LogsV2Controller {
  private readonly logger = new Logger(LogsV2Controller.name);

  constructor(private readonly uploadQueueService: UploadQueueService) {}

  @Post('logs')
  @HttpCode(201)
  @UseGuards(ApiKeyAuthGuard)
  async postLogs(
    @Query('sessionId') sessionId: string | undefined,
    @Query('type') logType: string | undefined,
    @Query('parentSessionId') parentSessionId: string | undefined,
    @Query('workflowRunId') workflowRunId: string | undefined,
    @Query('uploadId') uploadId: string | undefined,
    @Query('chunkIndex') chunkIndexRaw: string | undefined,
    @Query('totalChunks') totalChunksRaw: string | undefined,
    @Query('totalSize') totalSizeRaw: string | undefined,
    @Body() rawBody: unknown,
    @Req() req: Request & { userId: number },
  ): Promise<
    { warnings: string[] } | { complete: boolean; warnings?: string[] }
  > {
    if (!sessionId) {
      this.logger.warn(`userId=${req.userId} missing sessionId`);
      throw new BadRequestException('Missing sessionId query parameter');
    }
    if (!logType) {
      this.logger.warn(
        `userId=${req.userId} missing type for sessionId=${sessionId}`,
      );
      throw new BadRequestException('Missing type query parameter');
    }
    if (typeof rawBody !== 'string' || !rawBody.trim()) {
      this.logger.warn(
        `userId=${req.userId} empty body for sessionId=${sessionId}`,
      );
      throw new BadRequestException('Request body must not be empty');
    }

    // Chunked-upload params — all-or-nothing subset of
    // uploadId/chunkIndex/totalChunks. totalSize is only required on chunk 0.
    const chunkParamsPresent = [uploadId, chunkIndexRaw, totalChunksRaw].some(
      (v) => v !== undefined,
    );

    // Open-source readiness: a session owned by another user is
    // rejected before anything is staged. Lock-free — `LogsService.upsert()` repeats the
    // check under the per-session lock, so a race still ends in `rejected_foreign_session`.
    const foreignSession = await this.uploadQueueService.isForeignSession(
      sessionId,
      req.userId,
    );
    if (foreignSession) {
      this.logger.warn(
        `upload rejected: foreign session sessionId=${sessionId} userId=${req.userId}`,
      );
    }

    if (!chunkParamsPresent) {
      if (foreignSession) {
        return { warnings: await this.foreignSessionWarnings(sessionId, req) };
      }
      // No NDJSON parsing here — a malformed line
      // becomes a `failed` queue row + hook warning later, off the request
      // path, instead of aborting this request synchronously.
      await this.uploadQueueService.saveRawUpload(rawBody, {
        sessionId,
        logType,
        userId: req.userId,
        parentSessionId,
        workflowRunId,
      });

      const warnings = await this.uploadQueueService.getPendingWarnings(
        req.userId,
      );

      return { warnings };
    }

    if (
      uploadId === undefined ||
      chunkIndexRaw === undefined ||
      totalChunksRaw === undefined
    ) {
      this.logger.warn(
        `userId=${req.userId} incomplete chunked-upload parameters for sessionId=${sessionId}`,
      );
      throw new BadRequestException('Incomplete chunked-upload parameters');
    }

    if (!/^\d+$/.test(chunkIndexRaw) || !/^\d+$/.test(totalChunksRaw)) {
      this.logger.warn(
        `userId=${req.userId} non-integer chunkIndex/totalChunks for sessionId=${sessionId}`,
      );
      throw new BadRequestException(
        'chunkIndex and totalChunks must be non-negative integers',
      );
    }

    const chunkIndex = Number(chunkIndexRaw);
    const totalChunks = Number(totalChunksRaw);

    if (
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(totalChunks) ||
      totalChunks < 1 ||
      chunkIndex < 0 ||
      chunkIndex >= totalChunks
    ) {
      this.logger.warn(
        `userId=${req.userId} out-of-range chunkIndex=${chunkIndexRaw}/totalChunks=${totalChunksRaw} for sessionId=${sessionId}`,
      );
      throw new BadRequestException(
        'chunkIndex/totalChunks out of range: require 0 <= chunkIndex < totalChunks and totalChunks >= 1',
      );
    }

    let totalSize: number | undefined;
    if (chunkIndex === 0) {
      if (totalSizeRaw === undefined || !/^\d+$/.test(totalSizeRaw)) {
        this.logger.warn(
          `userId=${req.userId} missing totalSize on first chunk for uploadId=${uploadId}`,
        );
        throw new BadRequestException('Missing totalSize on first chunk');
      }
      totalSize = Number(totalSizeRaw);
    }

    // Before the uploadId lookup: nothing was staged for chunk 0 of a foreign session,
    // so a later chunk must get the same warning rather than "Unknown uploadId".
    if (foreignSession) {
      return {
        complete: true,
        warnings: await this.foreignSessionWarnings(sessionId, req),
      };
    }

    const existingRow = await this.uploadQueueService.findRowByUploadId(
      uploadId,
      req.userId,
    );

    if (chunkIndex > 0 && !existingRow) {
      this.logger.warn(
        `userId=${req.userId} unknown uploadId=${uploadId} for chunkIndex=${chunkIndex}`,
      );
      throw new BadRequestException('Unknown uploadId');
    }

    if (
      existingRow &&
      existingRow.totalChunks !== null &&
      existingRow.totalChunks !== totalChunks
    ) {
      this.logger.warn(
        `userId=${req.userId} totalChunks mismatch for uploadId=${uploadId}: recorded=${existingRow.totalChunks} received=${totalChunks}`,
      );
      throw new BadRequestException('totalChunks mismatch for uploadId');
    }

    const { complete } = await this.uploadQueueService.saveChunk(rawBody, {
      sessionId,
      logType,
      userId: req.userId,
      parentSessionId,
      workflowRunId,
      uploadId,
      chunkIndex,
      totalChunks,
      totalSize,
    });

    if (!complete) {
      return { complete };
    }

    const warnings = await this.uploadQueueService.getPendingWarnings(
      req.userId,
    );

    return { complete, warnings };
  }

  /** The foreign-session warning first, followed by any other pending warnings. */
  private async foreignSessionWarnings(
    sessionId: string,
    req: Request & { userId: number },
  ): Promise<string[]> {
    const pending = await this.uploadQueueService.getPendingWarnings(
      req.userId,
    );
    return [FOREIGN_SESSION_WARNING(sessionId), ...pending];
  }
}
