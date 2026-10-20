import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const WINDOW_MS = 1000;

/**
 * Tracks two this-instance-only metrics for the System Info panel:
 * - a live in-flight request counter
 * - a rolling 1-second window of request timestamps, used to derive requests/sec
 *
 * A plain singleton (not a NestJS provider) so it can be shared between the
 * middleware (writer, registered globally in AppModule.configure()) and
 * SystemInfoService (reader) without DI plumbing.
 */
export class RequestMetricsTracker {
  private activeCount = 0;
  private timestamps: number[] = [];

  onRequestStart(): void {
    this.activeCount += 1;
    this.timestamps.push(Date.now());
  }

  onRequestEnd(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  getRequestsPerSecond(): number {
    const cutoff = Date.now() - WINDOW_MS;
    this.timestamps = this.timestamps.filter((timestamp) => timestamp > cutoff);
    return this.timestamps.length;
  }
}

export const requestMetricsTracker = new RequestMetricsTracker();

@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    requestMetricsTracker.onRequestStart();

    // 'finish' fires on normal completion; 'close' also fires afterwards (and
    // is the only event fired for aborted/errored connections that never
    // reach 'finish'). Guard against double-decrementing when both fire.
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      requestMetricsTracker.onRequestEnd();
    };
    res.once('finish', onEnd);
    res.once('close', onEnd);

    next();
  }
}
