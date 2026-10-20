import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import multer from 'multer';
import * as path from 'path';
import type { Observable } from 'rxjs';
import { resolveExportImportStagingDir } from './export-import-zip';
import { getImportLimits, ImportLimitError } from './import-limits';

/** Multipart field the import zip is uploaded under. */
const IMPORT_FILE_FIELD = 'file';

/**
 * Multer upload for the two import-zip routes. A hand-rolled
 * interceptor instead of `FileInterceptor(...)`, whose options are fixed when the
 * decorator is evaluated: the limits here are read from env per request.
 *
 * - The file is staged as `<uuid>.zip` — that name becomes the `uploadToken`.
 * - `limits.fileSize = IMPORT_MAX_UPLOAD_BYTES`; multer removes the partial file.
 * - `fileFilter` rejects anything without a `.zip` extension before it is written.
 * - Every rejection is a 400 with a descriptive message.
 */
@Injectable()
export class ImportZipUploadInterceptor implements NestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const { maxUploadBytes } = getImportLimits();

    const upload = multer({
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
          cb(null, resolveExportImportStagingDir());
        },
        filename: (_req, _file, cb) => {
          // The generated name itself becomes the uploadToken
          // — no separate token->path mapping is needed, since the token
          // *is* the filename.
          cb(null, `${randomUUID()}.zip`);
        },
      }),
      limits: { fileSize: maxUploadBytes },
      fileFilter: (_req, file, cb) => {
        if (path.extname(file.originalname).toLowerCase() !== '.zip') {
          cb(ImportLimitError.notZip());
          return;
        }
        cb(null, true);
      },
    }).single(IMPORT_FILE_FIELD);

    await new Promise<void>((resolve, reject) => {
      upload(req, res, (err: unknown) => {
        if (err === undefined || err === null) {
          resolve();
          return;
        }
        reject(toUploadException(err, req, maxUploadBytes));
      });
    });

    return next.handle();
  }
}

function toUploadException(
  err: unknown,
  req: Request,
  maxUploadBytes: number,
): Error {
  if (err instanceof ImportLimitError) {
    return new BadRequestException(err.message);
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      // Multer aborts at the limit, so the real file size is unknown; the request's
      // Content-Length (the whole multipart body) is the best available figure.
      const contentLength = Number(req.headers['content-length']);
      const actual =
        Number.isFinite(contentLength) && contentLength > maxUploadBytes
          ? contentLength
          : maxUploadBytes + 1;
      return new BadRequestException(
        ImportLimitError.exceeded('maxUploadBytes', actual, maxUploadBytes)
          .message,
      );
    }
    return new BadRequestException(err.message);
  }
  return err instanceof Error ? err : new Error(String(err));
}
