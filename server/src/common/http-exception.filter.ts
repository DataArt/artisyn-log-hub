import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    let status: number;
    let message: string;
    let error: string | undefined;
    let retryAfterSeconds: number | undefined;
    let conflicts: unknown[] | undefined;
    let field: string | undefined;
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const resp = exceptionResponse as Record<string, unknown>;
        if (Array.isArray(resp['message'])) {
          message = (resp['message'] as string[]).join(', ');
        } else {
          message =
            typeof resp['message'] === 'string'
              ? resp['message']
              : exception.message;
        }
        if (typeof resp['error'] === 'string') {
          error = resp['error'];
        }
        if (typeof resp['retryAfterSeconds'] === 'number') {
          retryAfterSeconds = resp['retryAfterSeconds'];
        }
        // Zip import 409: the per-session conflict list travels in the body.
        if (Array.isArray(resp['conflicts'])) {
          conflicts = resp['conflicts'];
        }
        // Field-level validation errors (tool-monitoring config PUT): the offending field
        // (`tools[2].name`) and a machine-readable code travel in the body.
        if (typeof resp['field'] === 'string') {
          field = resp['field'];
        }
        if (typeof resp['code'] === 'string') {
          code = resp['code'];
        }
      } else {
        message = exception.message;
      }
    } else {
      // Handle Express-level errors (e.g. PayloadTooLargeError from body-parser)
      // that carry a status/statusCode property but are not HttpException instances.
      const rawStatus =
        (exception as { status?: number }).status ??
        (exception as { statusCode?: number }).statusCode;
      if (rawStatus && rawStatus >= 400 && rawStatus < 600) {
        status = rawStatus;
        message =
          exception instanceof Error ? exception.message : 'Request error';
      } else {
        status = HttpStatus.INTERNAL_SERVER_ERROR;
        message = 'Internal server error';
      }
    }

    const label = `${request.method} ${request.url} → ${status}`;
    if (status >= 500) {
      const stack =
        exception instanceof Error ? exception.stack : String(exception);
      const cause =
        exception instanceof Error && exception.cause instanceof Error
          ? exception.cause.message
          : undefined;
      const detail = cause ? ` | cause: ${cause}` : '';
      this.logger.error(`${label}: ${message}${detail}`, stack);
    } else if (status === 401) {
      const rawCookie = request.headers.cookie ?? '';
      const hasSid = rawCookie.includes('connect.sid=');
      this.logger.warn(
        `${label}: ${message} [cookie=${hasSid ? 'present' : 'absent'}]`,
      );
    } else if (status >= 400) {
      this.logger.warn(`${label}: ${message}`);
    }

    if (retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(retryAfterSeconds));
    }
    response.status(status).json({
      statusCode: status,
      message,
      ...(error ? { error } : {}),
      ...(conflicts ? { conflicts } : {}),
      ...(field !== undefined ? { field } : {}),
      ...(code !== undefined ? { code } : {}),
    });
  }
}
