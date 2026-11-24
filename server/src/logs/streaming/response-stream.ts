/**
 * Backpressure-aware writing of a streamed HTTP response (impl-plan DD-2 of
 * 2026-11-23-session-logs-streaming).
 *
 * A session-log response is written chunk by chunk (one log row's text at a time), so a worker
 * holds at most one row plus the socket's buffer instead of the whole JSON document.
 */
import type { Writable } from 'stream';

/** The client went away (or the socket was destroyed) while the response was being written. */
export class StreamAbortedError extends Error {
  constructor(message = 'Response stream aborted') {
    super(message);
    this.name = 'StreamAbortedError';
  }
}

/** Resolves on the first of `drain`, `close` or `error` of `res`. */
function waitForDrainOrClose(res: Writable): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
    res.on('error', done);
  });
}

/**
 * Writes `chunk` to `res`. When the write buffer is full it waits for `drain` (or `close`), so a
 * slow client throttles the reader instead of growing the worker's memory. Throws
 * `StreamAbortedError` once `res` is destroyed, before or after the write.
 */
export async function writeChunk(
  res: Writable,
  chunk: string | Buffer,
): Promise<void> {
  if (res.destroyed) {
    throw new StreamAbortedError();
  }
  const flushed = res.write(chunk);
  if (!flushed) {
    await waitForDrainOrClose(res);
  }
  if (res.destroyed) {
    throw new StreamAbortedError();
  }
}

/**
 * Ends a response that failed after its first byte: the status line and part of the body are
 * already sent, so the only honest signal left is a broken connection.
 */
export function abortStream(res: Writable): void {
  if (!res.destroyed) {
    res.destroy();
  }
}
