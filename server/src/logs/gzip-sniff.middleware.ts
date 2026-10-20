import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler } from 'express';
import * as zlib from 'zlib';
import { getLogsBodyLimitBytes } from '../common/logs-body-limit';

// WHY this exists: the hook gzips large log bodies and sends
// `Content-Encoding: gzip`. body-parser inflates that header itself, so the happy path
// needs no server code at all. Some proxies, however, strip `Content-Encoding` while
// forwarding the compressed bytes — the body then reaches body-parser as gzip binary and
// is stored as a mangled string with a 201. This middleware sniffs the two-byte gzip
// signature on exactly the two log-ingest POST routes and inflates such a body itself.
//
// It is deliberately non-invasive: for every request that is not headerless gzip it puts
// the peeked bytes straight back with `unshift()` and lets `express.text()` do all the
// reading, limiting and charset handling exactly as before.

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const GZIP_SIGNATURE_BYTES = 2;

/**
 * Does this request carry a body at all? Same test body-parser uses (`type-is`'s `hasBody`),
 * inlined so this middleware does not depend on a transitive package.
 */
function hasRequestBody(req: Request): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = req.headers['content-length'];
  return length !== undefined && !Number.isNaN(Number(length));
}

/**
 * Consume the rest of the request, inflate it, and hand the result to the controllers as a
 * plain string body. `body-parser`'s `read()` short-circuits on `onFinished.isFinished(req)`,
 * so a fully consumed request skips parsing and keeps the `req.body` set here.
 */
function inflateAndContinue(
  req: Request,
  head: Buffer,
  next: NextFunction,
): void {
  const limitBytes = getLogsBodyLimitBytes();
  const chunks: Buffer[] = [head];
  let compressedBytes = head.length;
  let settled = false;

  const onData = (chunk: Buffer): void => {
    if (settled) return;
    compressedBytes += chunk.length;
    if (compressedBytes > limitBytes) {
      settle(
        new PayloadTooLargeException('Request body exceeds the allowed size'),
      );
      return;
    }
    chunks.push(chunk);
  };

  const onEnd = (): void => {
    if (settled) return;
    try {
      const inflated = zlib.gunzipSync(Buffer.concat(chunks, compressedBytes), {
        maxOutputLength: limitBytes,
      });
      settled = true;
      detach();
      req.body = inflated.toString('utf8');
      // Keep Content-Length truthful for anything downstream that reads it — the header
      // still described the compressed length.
      req.headers['content-length'] = String(inflated.length);
      next();
    } catch (err) {
      // `maxOutputLength` is load-bearing: without it a small compressed body could inflate
      // into an unbounded allocation. Its error must NOT be reported as a malformed body —
      // the hook reads a 400 over a gzip request as "this server does not accept gzip" and
      // would stop compressing for the rest of the process.
      settle(
        (err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE'
          ? new PayloadTooLargeException(
              'Request body exceeds the allowed size',
            )
          : new BadRequestException('Malformed gzip request body'),
      );
    }
  };

  const onError = (err: Error): void => settle(err);

  function detach(): void {
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('error', onError);
  }

  function settle(err: Error): void {
    if (settled) return;
    settled = true;
    detach();
    // Drain whatever is still in flight so the socket is not left half-read (same as
    // body-parser's `dump()` on an aborted read).
    req.resume();
    next(err);
  }

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('error', onError);
}

/**
 * Inflate a gzip request body whose `Content-Encoding: gzip` header was stripped in transit.
 *
 * Returns immediately when `Content-Encoding` is set (body-parser inflates those itself) or
 * when the request has no body. Otherwise peeks the first two bytes: a non-gzip body is
 * `unshift()`ed back untouched, a gzip body is consumed and inflated here.
 */
export const inflateSniffedGzip: RequestHandler = (req, _res, next) => {
  if (req.headers['content-encoding'] || !hasRequestBody(req)) {
    next();
    return;
  }

  const parts: Buffer[] = [];
  let peeked = 0;
  let settled = false;

  function detach(): void {
    req.removeListener('readable', onReadable);
    req.removeListener('end', onEnd);
    req.removeListener('error', onError);
  }

  function onReadable(): void {
    if (settled) return;
    let chunk = req.read() as Buffer | null;
    while (chunk !== null) {
      parts.push(chunk);
      peeked += chunk.length;
      if (peeked >= GZIP_SIGNATURE_BYTES) break;
      chunk = req.read() as Buffer | null;
    }
    if (peeked >= GZIP_SIGNATURE_BYTES) decide();
  }

  function onEnd(): void {
    if (settled) return;
    settled = true;
    detach();
    // The whole body arrived and is shorter than the gzip signature, so it cannot be
    // compressed. `unshift()` after the 'end' event is illegal, and the stream is fully
    // consumed anyway, so hand the bytes over as the parsed body directly.
    req.body = Buffer.concat(parts, peeked).toString('utf8');
    next();
  }

  function onError(err: Error): void {
    if (settled) return;
    settled = true;
    detach();
    next(err);
  }

  function decide(): void {
    if (settled) return;
    settled = true;
    detach();
    const head = Buffer.concat(parts, peeked);
    if (head[0] !== GZIP_MAGIC_0 || head[1] !== GZIP_MAGIC_1) {
      // Put the peek back so the normal path stays byte-identical.
      req.unshift(head);
      next();
      return;
    }
    inflateAndContinue(req, head, next);
  }

  req.on('readable', onReadable);
  req.on('end', onEnd);
  req.on('error', onError);
  // Data may already be buffered by the time this middleware runs.
  onReadable();
};
