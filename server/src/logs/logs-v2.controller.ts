import {
  BadRequestException,
  Controller,
  Body,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../api-keys/api-key-auth.guard';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  UploadQueueService,
  type FailedUploadFeedback,
} from './upload-queue.service';
import { FOREIGN_SESSION_WARNING } from './upload-warnings';
import { SessionTombstoneService } from '../sessions/session-tombstone.service';
import { SNAPSHOT_ID_RE, isHarnessSnapshotKnown } from './harness-snapshot';
import { OKF_SNAPSHOT_ID_RE, isOkfSnapshotKnown } from './okf/okf-snapshot';
import { sanitizeAgentMeta } from './agent-meta-param';

/** Answer of a single-request upload (non-chunked `postLogs`, `postLogsAppend`). */
type SingleUploadAnswer =
  | {
      warnings: string[];
      unknownSnapshotId?: string;
      unknownOkfSnapshotId?: string;
      failedUploads?: FailedUploadFeedback[];
    }
  | {
      complete: boolean;
      warnings: string[];
      failedUploads?: FailedUploadFeedback[];
      sessionDeleted?: true;
    };

/** Optional upload query params after their silent validation. */
interface ParsedUploadParams {
  snapshotId: string | undefined;
  snapshotFull: boolean;
  harnessSnapshotId: string | undefined;
  okfSnapshotId: string | undefined;
  okfSnapshotFull: boolean;
  queuedOkfSnapshotId: string | undefined;
  agentDescription: string | null;
  workflowPhase: string | null;
  contentSha256: string | null;
  uploadFeedback: boolean;
}

/** What `stageSingleUpload` needs besides the body, the hash and `startLine`. */
interface SingleUploadParams {
  sessionId: string;
  logType: string;
  parentSessionId: string | undefined;
  workflowRunId: string | undefined;
  harnessSnapshotId: string | undefined;
  queuedOkfSnapshotId: string | undefined;
  agentDescription: string | null;
  workflowPhase: string | null;
  snapshotId: string | undefined;
  snapshotFull: boolean;
  okfSnapshotId: string | undefined;
  okfSnapshotFull: boolean;
  foreignSession: boolean;
}

/** Parses the optional query params shared by `postLogs` and `postLogsAppend`. */
function parseOptionalUploadParams(
  logType: string,
  raw: {
    snapshotIdRaw: string | undefined;
    snapshotFullRaw: string | undefined;
    okfSnapshotIdRaw: string | undefined;
    okfSnapshotFullRaw: string | undefined;
    agentDescriptionRaw: unknown;
    workflowPhaseRaw: unknown;
    contentSha256Raw: unknown;
    uploadFeedbackRaw: unknown;
  },
): ParsedUploadParams {
  // DD-8: an invalid snapshotId is silently ignored — never a 400 — and treated
  // the same as it being absent everywhere below.
  const snapshotId =
    raw.snapshotIdRaw && SNAPSHOT_ID_RE.test(raw.snapshotIdRaw)
      ? raw.snapshotIdRaw
      : undefined;
  const snapshotFull = raw.snapshotFullRaw === '1';
  // `upload_queue.harness_snapshot_id` is set only on a full-snapshot upload (DD-8).
  const harnessSnapshotId = snapshotFull && snapshotId ? snapshotId : undefined;

  // OKF DD-18/DD-22: same silent validation and full-flag rule for the OKF snapshot id.
  const okfSnapshotId =
    raw.okfSnapshotIdRaw && OKF_SNAPSHOT_ID_RE.test(raw.okfSnapshotIdRaw)
      ? raw.okfSnapshotIdRaw
      : undefined;
  const okfSnapshotFull = raw.okfSnapshotFullRaw === '1';
  const queuedOkfSnapshotId =
    okfSnapshotFull && okfSnapshotId ? okfSnapshotId : undefined;

  // Sub-agent `.meta.json` labels: sanitised (an invalid, empty or repeated
  // value is silently ignored) and applied to `claude-subagent` uploads only.
  const isSubagent = logType === 'claude-subagent';
  const agentDescription = isSubagent
    ? sanitizeAgentMeta(raw.agentDescriptionRaw)
    : null;
  const workflowPhase = isSubagent
    ? sanitizeAgentMeta(raw.workflowPhaseRaw)
    : null;

  // DD-24 / DD-25 (2026-11-23-session-logs-streaming): both optional and additive. An
  // invalid `contentSha256` is ignored (never a 400); old hooks send neither param.
  const contentSha256 =
    typeof raw.contentSha256Raw === 'string' &&
    /^[0-9a-f]{64}$/.test(raw.contentSha256Raw)
      ? raw.contentSha256Raw
      : null;
  const uploadFeedback = raw.uploadFeedbackRaw === '1';

  return {
    snapshotId,
    snapshotFull,
    harnessSnapshotId,
    okfSnapshotId,
    okfSnapshotFull,
    queuedOkfSnapshotId,
    agentDescription,
    workflowPhase,
    contentSha256,
    uploadFeedback,
  };
}

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

  constructor(
    private readonly uploadQueueService: UploadQueueService,
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly tombstones: SessionTombstoneService,
  ) {}

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
    @Query('snapshotId') snapshotIdRaw: string | undefined,
    @Query('snapshotFull') snapshotFullRaw: string | undefined,
    @Query('okfSnapshotId') okfSnapshotIdRaw: string | undefined,
    @Query('okfSnapshotFull') okfSnapshotFullRaw: string | undefined,
    @Query('agentDescription') agentDescriptionRaw: unknown,
    @Query('workflowPhase') workflowPhaseRaw: unknown,
    @Query('contentSha256') contentSha256Raw: unknown,
    @Query('uploadFeedback') uploadFeedbackRaw: unknown,
    @Body() rawBody: unknown,
    @Req() req: Request & { userId: number },
  ): Promise<
    | {
        warnings: string[];
        unknownSnapshotId?: string;
        unknownOkfSnapshotId?: string;
        failedUploads?: FailedUploadFeedback[];
      }
    | {
        complete: boolean;
        warnings?: string[];
        unknownSnapshotId?: string;
        unknownOkfSnapshotId?: string;
        failedUploads?: FailedUploadFeedback[];
        sessionDeleted?: true;
      }
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

    const {
      snapshotId,
      snapshotFull,
      harnessSnapshotId,
      okfSnapshotId,
      okfSnapshotFull,
      queuedOkfSnapshotId,
      agentDescription,
      workflowPhase,
      contentSha256,
      uploadFeedback,
    } = parseOptionalUploadParams(logType, {
      snapshotIdRaw,
      snapshotFullRaw,
      okfSnapshotIdRaw,
      okfSnapshotFullRaw,
      agentDescriptionRaw,
      workflowPhaseRaw,
      contentSha256Raw,
      uploadFeedbackRaw,
    });

    const foreignSession = await this.checkForeignSession(sessionId, req);

    if (!chunkParamsPresent) {
      return this.stageSingleUpload(
        {
          sessionId,
          logType,
          parentSessionId,
          workflowRunId,
          harnessSnapshotId,
          queuedOkfSnapshotId,
          agentDescription,
          workflowPhase,
          snapshotId,
          snapshotFull,
          okfSnapshotId,
          okfSnapshotFull,
          foreignSession,
        },
        rawBody,
        contentSha256,
        null,
        req,
        uploadFeedback,
      );
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

    // DD-27: checked on chunk 0, and on a later chunk whose upload was never staged — chunk 0
    // of a deleted session stages nothing, so its later chunks must get the same answer
    // rather than "Unknown uploadId".
    if (
      (chunkIndex === 0 || !existingRow) &&
      (await this.isDeletedSession(sessionId, parentSessionId, req))
    ) {
      return this.deletedSessionAnswer(req, uploadFeedback);
    }

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

    const { complete } = await this.uploadQueueService.saveChunk(
      rawBody,
      {
        sessionId,
        logType,
        userId: req.userId,
        parentSessionId,
        workflowRunId,
        uploadId,
        chunkIndex,
        totalChunks,
        totalSize,
        harnessSnapshotId,
        okfSnapshotId: queuedOkfSnapshotId,
        agentDescription,
        workflowPhase,
      },
      chunkIndex === 0 ? contentSha256 : null,
    );

    if (!complete) {
      return { complete };
    }

    const warnings = await this.uploadQueueService.getPendingWarnings(
      req.userId,
    );

    const unknownSnapshotId = await this.resolveUnknownSnapshotId(
      snapshotId,
      snapshotFull,
      req.userId,
    );

    const unknownOkfSnapshotId = await this.resolveUnknownOkfSnapshotId(
      okfSnapshotId,
      okfSnapshotFull,
      req.userId,
    );

    return {
      complete,
      warnings,
      ...(unknownSnapshotId ? { unknownSnapshotId } : {}),
      ...(unknownOkfSnapshotId ? { unknownOkfSnapshotId } : {}),
      ...(await this.failedUploadsFeedback(req, uploadFeedback)),
    };
  }

  /**
   * `POST /api/v2/logs/append` (2026-11-24-traffic-optimization): stages the delta of a
   * `claude` / `claude-subagent` log that starts at 0-based line `startLine` of the stored log.
   * Same params as the non-chunked `postLogs` plus `startLine`, same answers. A start-line
   * mismatch is never a synchronous status: the queue worker fails the row with `upload-full`
   * and the hook learns it later through `failedUploads`.
   */
  @Post('logs/append')
  @HttpCode(201)
  @UseGuards(ApiKeyAuthGuard)
  async postLogsAppend(
    @Query('sessionId') sessionId: string | undefined,
    @Query('type') logType: string | undefined,
    @Query('startLine') startLineRaw: unknown,
    @Query('parentSessionId') parentSessionId: string | undefined,
    @Query('workflowRunId') workflowRunId: string | undefined,
    @Query('snapshotId') snapshotIdRaw: string | undefined,
    @Query('snapshotFull') snapshotFullRaw: string | undefined,
    @Query('okfSnapshotId') okfSnapshotIdRaw: string | undefined,
    @Query('okfSnapshotFull') okfSnapshotFullRaw: string | undefined,
    @Query('agentDescription') agentDescriptionRaw: unknown,
    @Query('workflowPhase') workflowPhaseRaw: unknown,
    @Query('contentSha256') contentSha256Raw: unknown,
    @Query('uploadFeedback') uploadFeedbackRaw: unknown,
    @Body() rawBody: unknown,
    @Req() req: Request & { userId: number },
  ): Promise<SingleUploadAnswer> {
    if (!sessionId) {
      this.logger.warn(`userId=${req.userId} missing sessionId (append)`);
      throw new BadRequestException('Missing sessionId query parameter');
    }
    if (!logType) {
      this.logger.warn(
        `userId=${req.userId} missing type for sessionId=${sessionId} (append)`,
      );
      throw new BadRequestException('Missing type query parameter');
    }
    if (logType !== 'claude' && logType !== 'claude-subagent') {
      this.logger.warn(
        `userId=${req.userId} append not supported for type=${logType} sessionId=${sessionId}`,
      );
      throw new BadRequestException(
        'Append is supported only for claude and claude-subagent logs',
      );
    }
    if (startLineRaw === undefined) {
      this.logger.warn(
        `userId=${req.userId} missing startLine for sessionId=${sessionId}`,
      );
      throw new BadRequestException('Missing startLine query parameter');
    }
    if (typeof startLineRaw !== 'string' || !/^\d{1,9}$/.test(startLineRaw)) {
      this.logger.warn(
        `userId=${req.userId} invalid startLine for sessionId=${sessionId}`,
      );
      throw new BadRequestException('startLine must be a non-negative integer');
    }
    const startLine = Number(startLineRaw);
    if (typeof rawBody !== 'string' || !rawBody.trim()) {
      this.logger.warn(
        `userId=${req.userId} empty body for sessionId=${sessionId} (append)`,
      );
      throw new BadRequestException('Request body must not be empty');
    }

    const parsed = parseOptionalUploadParams(logType, {
      snapshotIdRaw,
      snapshotFullRaw,
      okfSnapshotIdRaw,
      okfSnapshotFullRaw,
      agentDescriptionRaw,
      workflowPhaseRaw,
      contentSha256Raw,
      uploadFeedbackRaw,
    });

    const foreignSession = await this.checkForeignSession(sessionId, req);

    return this.stageSingleUpload(
      {
        sessionId,
        logType,
        parentSessionId,
        workflowRunId,
        harnessSnapshotId: parsed.harnessSnapshotId,
        queuedOkfSnapshotId: parsed.queuedOkfSnapshotId,
        agentDescription: parsed.agentDescription,
        workflowPhase: parsed.workflowPhase,
        snapshotId: parsed.snapshotId,
        snapshotFull: parsed.snapshotFull,
        okfSnapshotId: parsed.okfSnapshotId,
        okfSnapshotFull: parsed.okfSnapshotFull,
        foreignSession,
      },
      rawBody,
      parsed.contentSha256,
      startLine,
      req,
      parsed.uploadFeedback,
    );
  }

  /**
   * Open-source readiness: a session owned by another user is rejected before anything is
   * staged. Lock-free — `LogsService.upsert()` repeats the check under the per-session lock,
   * so a race still ends in `rejected_foreign_session`.
   */
  private async checkForeignSession(
    sessionId: string,
    req: Request & { userId: number },
  ): Promise<boolean> {
    const foreignSession = await this.uploadQueueService.isForeignSession(
      sessionId,
      req.userId,
    );
    if (foreignSession) {
      this.logger.warn(
        `upload rejected: foreign session sessionId=${sessionId} userId=${req.userId}`,
      );
    }
    return foreignSession;
  }

  /**
   * The single-request upload shared by the non-chunked `postLogs` branch and
   * `postLogsAppend`: foreign / deleted session answers, then staging (`startLine` is `null`
   * for a full upload), then the response with warnings, snapshot hints and feedback.
   */
  private async stageSingleUpload(
    params: SingleUploadParams,
    rawBody: string,
    contentSha256: string | null,
    startLine: number | null,
    req: Request & { userId: number },
    uploadFeedback: boolean,
  ): Promise<SingleUploadAnswer> {
    const { sessionId, parentSessionId } = params;
    if (params.foreignSession) {
      return { warnings: await this.foreignSessionWarnings(sessionId, req) };
    }
    if (await this.isDeletedSession(sessionId, parentSessionId, req)) {
      return this.deletedSessionAnswer(req, uploadFeedback);
    }
    // No NDJSON parsing here — a malformed line
    // becomes a `failed` queue row + hook warning later, off the request
    // path, instead of aborting this request synchronously.
    await this.uploadQueueService.saveRawUpload(
      rawBody,
      {
        sessionId,
        logType: params.logType,
        userId: req.userId,
        parentSessionId,
        workflowRunId: params.workflowRunId,
        harnessSnapshotId: params.harnessSnapshotId,
        okfSnapshotId: params.queuedOkfSnapshotId,
        agentDescription: params.agentDescription,
        workflowPhase: params.workflowPhase,
      },
      contentSha256,
      startLine,
    );

    const warnings = await this.uploadQueueService.getPendingWarnings(
      req.userId,
    );

    const unknownSnapshotId = await this.resolveUnknownSnapshotId(
      params.snapshotId,
      params.snapshotFull,
      req.userId,
    );

    const unknownOkfSnapshotId = await this.resolveUnknownOkfSnapshotId(
      params.okfSnapshotId,
      params.okfSnapshotFull,
      req.userId,
    );

    return {
      warnings,
      ...(unknownSnapshotId ? { unknownSnapshotId } : {}),
      ...(unknownOkfSnapshotId ? { unknownOkfSnapshotId } : {}),
      ...(await this.failedUploadsFeedback(req, uploadFeedback)),
    };
  }

  /**
   * DD-27 request-time tombstone check (lock-free): the session or an ancestor was deleted.
   * The scheduler and `LogsService.upsert()` repeat it under the tree lock, so a race with a
   * concurrent delete still writes nothing.
   */
  private async isDeletedSession(
    sessionId: string,
    parentSessionId: string | undefined,
    req: Request & { userId: number },
  ): Promise<boolean> {
    const deleted = await this.tombstones.isTombstoned(
      this.db,
      sessionId,
      parentSessionId ?? null,
    );
    if (deleted) {
      this.logger.log(
        `upload ignored: deleted session sessionId=${sessionId} userId=${req.userId}`,
      );
    }
    return deleted;
  }

  /**
   * DD-27: a deleted session's upload is answered like a foreign one — 201
   * `complete: true` with nothing staged, so the hook stops re-sending it. With
   * `uploadFeedback=1` (DD-25) the answer also says `sessionDeleted: true`.
   */
  private async deletedSessionAnswer(
    req: Request & { userId: number },
    uploadFeedback: boolean,
  ): Promise<{
    complete: boolean;
    warnings: string[];
    failedUploads?: FailedUploadFeedback[];
    sessionDeleted?: true;
  }> {
    const warnings = await this.uploadQueueService.getPendingWarnings(
      req.userId,
    );
    return {
      complete: true,
      warnings,
      ...(uploadFeedback ? { sessionDeleted: true as const } : {}),
      ...(await this.failedUploadsFeedback(req, uploadFeedback)),
    };
  }

  /** DD-25: `failedUploads` only when the hook asked for it with `uploadFeedback=1`. */
  private async failedUploadsFeedback(
    req: Request & { userId: number },
    uploadFeedback: boolean,
  ): Promise<{ failedUploads?: FailedUploadFeedback[] }> {
    if (!uploadFeedback) {
      return {};
    }
    const failedUploads =
      await this.uploadQueueService.takeFailedUploadsForFeedback(req.userId);
    return { failedUploads };
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

  /**
   * DD-8: `unknownSnapshotId` is returned only when the id is valid, this upload was
   * ref-only (`snapshotFull !== '1'`), and the id is not yet known — neither stored nor
   * in flight via another upload (`isHarnessSnapshotKnown`). Called only from the
   * single-upload and chunk-complete response paths, never for intermediate chunks or
   * foreign-session responses.
   */
  private async resolveUnknownSnapshotId(
    snapshotId: string | undefined,
    snapshotFull: boolean,
    userId: number,
  ): Promise<string | undefined> {
    if (!snapshotId || snapshotFull) {
      return undefined;
    }
    const known = await isHarnessSnapshotKnown(this.db, userId, snapshotId);
    return known ? undefined : snapshotId;
  }

  /**
   * OKF DD-22: `unknownOkfSnapshotId` mirrors {@link resolveUnknownSnapshotId} — returned only
   * when the id is valid, this upload was ref-only (`okfSnapshotFull !== '1'`), and the id is
   * neither stored nor in flight (`isOkfSnapshotKnown`).
   */
  private async resolveUnknownOkfSnapshotId(
    okfSnapshotId: string | undefined,
    okfSnapshotFull: boolean,
    userId: number,
  ): Promise<string | undefined> {
    if (!okfSnapshotId || okfSnapshotFull) {
      return undefined;
    }
    const known = await isOkfSnapshotKnown(this.db, userId, okfSnapshotId);
    return known ? undefined : okfSnapshotId;
  }
}
