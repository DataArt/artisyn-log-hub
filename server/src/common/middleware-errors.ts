import { HttpException } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an Express middleware so that an error it hands to `next(err)` is thrown inside
 * Nest's middleware proxy instead of travelling down the Express error chain.
 *
 * Why: `@nestjs/serve-static` registers an Express error handler that, for every route
 * excluded from static serving (all of `/api/*`), discards the incoming error and
 * substitutes `NotFoundException("Cannot <METHOD> <url>")`. Any `next(err)` from a
 * middleware therefore surfaced as 404 — a body-parser 413, a
 * malformed-JSON 400, the gzip sniffer's 400/413. A throw inside a Nest-applied middleware
 * is instead caught by Nest's `RouterProxy` and routed through the global exception
 * filters (`HttpExceptionFilter`), so the original status is preserved.
 *
 * A 4xx error that is not already an `HttpException` (body-parser's `http-errors`
 * objects) is converted to one, so the status survives even a filter that only knows
 * `HttpException`. Anything else is rethrown as-is. `next('route')`/`next('router')` are
 * Express control signals, not errors, and are passed through untouched.
 *
 * Only for middleware that always calls `next` (parsers, session, passport): one that
 * ends the response itself would leave the wrapper's promise pending.
 */
export function throwMiddlewareErrors(
  middleware: RequestHandler,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const err = await new Promise<unknown>((resolve) => {
      void middleware(req, res, resolve);
    });
    if (err === undefined || err === null) {
      next();
      return;
    }
    if (err === 'route' || err === 'router') {
      next(err);
      return;
    }
    throw toHttpException(err);
  };
}

function toHttpException(err: unknown): unknown {
  if (err instanceof HttpException) return err;
  const status =
    (err as { status?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : 'Request error';
    return new HttpException(message, status, { cause: err });
  }
  return err;
}
