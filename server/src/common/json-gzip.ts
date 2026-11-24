import type { NextFunction, Request, RequestHandler, Response } from 'express';
import * as zlib from 'zlib';
import { acceptsGzip } from './accept-encoding';
import { readPositiveIntEnv } from './env-int';

/**
 * Gzip of `/api` JSON answers (traffic-optimization Part B, impl-plan DD-10).
 *
 * WHY a `res.json` wrapper and not the `compression` package: Nest replies every plain-object
 * handler result through `response.json(body)`, and `compression` answers `br` to browsers,
 * while the requirement is gzip. Streamed `@Res()` routes, log parts, precompressed static and
 * downloads never go through `res.json`, so they are excluded by construction.
 */

/** Default minimum size (bytes of the JSON text) an answer must reach to be gzipped. */
const DEFAULT_API_GZIP_MIN_BYTES = 8192;

/** `API_GZIP_MIN_BYTES`, default 8192. */
export function apiGzipMinBytes(): number {
  return readPositiveIntEnv('API_GZIP_MIN_BYTES', DEFAULT_API_GZIP_MIN_BYTES);
}

/** Express's compiled `etag fn` setting: `(body, encoding) => etag`. */
type EtagFn = (body: string, encoding: BufferEncoding) => string | undefined;

function isEtagFn(value: unknown): value is EtagFn {
  return typeof value === 'function';
}

function isApiPath(req: Request): boolean {
  // `req.path` is mount-relative inside Nest middleware, so use the original URL.
  return req.originalUrl.split('?')[0].startsWith('/api/');
}

function setJsonContentType(res: Response): void {
  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }
}

export function createJsonGzipMiddleware(opts: {
  thresholdBytes: number;
}): RequestHandler {
  const { thresholdBytes } = opts;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isApiPath(req)) {
      next();
      return;
    }
    const savedJson = res.json;
    // Restores Express's own `res.json` and calls it (each answer calls `res.json` once).
    const originalJson = (body: unknown): Response => {
      res.json = savedJson;
      return res.json(body);
    };
    res.json = (body?: unknown): Response => {
      // 1. A shared cache must never cross-serve encodings.
      res.vary('Accept-Encoding');
      // 2. Already encoded, HEAD, a body-less status, or a client without gzip.
      if (
        res.getHeader('Content-Encoding') !== undefined ||
        req.method === 'HEAD' ||
        res.statusCode === 204 ||
        res.statusCode === 304 ||
        !acceptsGzip(req)
      ) {
        return originalJson(body);
      }
      // 3. Same serialisation Express uses by default.
      const text = JSON.stringify(body);
      if (text === undefined) return originalJson(body);
      // 4. Below the threshold: send the text as is, without stringifying it twice.
      if (Buffer.byteLength(text) < thresholdBytes) {
        setJsonContentType(res);
        return res.send(text);
      }
      // 5. Content-Type.
      setJsonContentType(res);
      // 6. The same weak ETag Express would send for the uncompressed text.
      const etagFn: unknown = req.app.get('etag fn');
      if (isEtagFn(etagFn) && res.getHeader('ETag') === undefined) {
        const etag = etagFn(text, 'utf8');
        if (etag) res.setHeader('ETag', etag);
      }
      // 7. Conditional GET hit.
      if (req.fresh) {
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        res.status(304).end();
        return res;
      }
      // 8. Async gzip; 9. on failure, the uncompressed text.
      zlib.gzip(text, (err, gz) => {
        if (res.headersSent || res.writableEnded) return;
        if (err) {
          res.send(text);
          return;
        }
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', gz.length);
        res.end(gz);
      });
      return res;
    };
    next();
  };
}
