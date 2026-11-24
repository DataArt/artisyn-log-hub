/**
 * Per-worker limit on concurrent session-log body streams (impl-plan DD-3 of
 * 2026-11-23-session-logs-streaming).
 *
 * A FIFO semaphore with `SESSION_LOGS_MAX_CONCURRENT_STREAMS` permits (default 2). A request
 * that finds no free permit waits in line, without a timeout, and leaves the line when its
 * request closes (`signal` aborts). Callers acquire after the access checks and the metadata
 * query, before the first byte, and call the returned release function exactly once when the
 * response is finished or failed (extra calls are ignored).
 */
import { Injectable } from '@nestjs/common';
import { readPositiveIntEnv } from '../../common/env-int';
import { StreamAbortedError } from './response-stream';

/** Permits per worker when `SESSION_LOGS_MAX_CONCURRENT_STREAMS` is unset or invalid. */
export const DEFAULT_SESSION_LOGS_MAX_CONCURRENT_STREAMS = 2;

/** `SESSION_LOGS_MAX_CONCURRENT_STREAMS` when it is a positive integer, else the default. */
export function resolveMaxConcurrentLogStreams(): number {
  return readPositiveIntEnv(
    'SESSION_LOGS_MAX_CONCURRENT_STREAMS',
    DEFAULT_SESSION_LOGS_MAX_CONCURRENT_STREAMS,
  );
}

interface Waiter {
  grant: () => void;
}

@Injectable()
export class LogStreamLimiter {
  private readonly permits = resolveMaxConcurrentLogStreams();
  private active = 0;
  private readonly queue: Waiter[] = [];

  /**
   * Resolves with a release function once a permit is held. Rejects with `StreamAbortedError`
   * when `signal` is (or becomes, while queued) aborted; a rejected call holds no permit.
   */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new StreamAbortedError());
    }
    if (this.active < this.permits) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort);
          resolve(this.makeRelease());
        },
      };
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) {
          this.queue.splice(index, 1);
        }
        reject(new StreamAbortedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /** A one-shot release: hands the permit to the next waiter, or frees it. */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.queue.shift();
      if (next) {
        // The permit passes straight to the next waiter; `active` stays the same.
        next.grant();
      } else {
        this.active -= 1;
      }
    };
  }
}
