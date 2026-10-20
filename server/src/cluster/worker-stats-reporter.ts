import {
  WORKER_STATS_MESSAGE,
  isSupervisorSnapshotMessage,
} from './cluster-messages';
import type { WorkerStatsMessage } from './cluster-messages';
import { WORKER_STATS_INTERVAL_MS } from './cluster.constants';
import type { SupervisorInfo } from '../system-info/system-info.types';

/**
 * Worker-side half of the cluster stats channel: pushes this worker's RSS to
 * the primary on an interval, and caches the merged snapshot the primary
 * broadcasts back so `GET /api/v1/admin/system` never does a request-time
 * round trip.
 *
 * A module-scoped singleton deliberately outside DI, following the
 * `requestMetricsTracker` precedent in `request-metrics.middleware.ts`:
 * writer and reader share state with no DI plumbing.
 */
export class WorkerStatsReporter {
  private timer: NodeJS.Timeout | null = null;
  private snapshot: SupervisorInfo | null = null;
  private listener: ((msg: unknown) => void) | null = null;

  /**
   * Idempotent. Returns immediately when there is no IPC channel (local dev,
   * jest), leaving `getSnapshot()` at `null` so `SystemInfoService` uses its
   * single-process fallback unchanged.
   */
  start(): void {
    if (this.timer !== null) return;
    if (typeof process.send !== 'function') return;

    this.listener = (msg: unknown): void => {
      if (isSupervisorSnapshotMessage(msg)) {
        this.snapshot = msg.snapshot;
      }
    };
    process.on('message', this.listener);

    // Push once immediately: `cluster.on('online')` fires long before Nest
    // constructs SystemInfoService, so this first push (and the snapshot the
    // primary sends in reply) is what closes the cold-start window.
    this.push();
    this.timer = setInterval(() => this.push(), WORKER_STATS_INTERVAL_MS);
    // Never hold the event loop open during shutdown.
    this.timer.unref();
  }

  /** Clears the interval and removes the listener (keeps jest handle-free). */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.listener !== null) {
      process.off('message', this.listener);
      this.listener = null;
    }
  }

  /** The last snapshot that passed `isSupervisorSnapshotMessage()`. */
  getSnapshot(): SupervisorInfo | null {
    return this.snapshot;
  }

  private push(): void {
    if (typeof process.send !== 'function') return;

    const message: WorkerStatsMessage = {
      type: WORKER_STATS_MESSAGE,
      instance: Number(process.env.NODE_APP_INSTANCE),
      pid: process.pid,
      rssBytes: process.memoryUsage().rss,
    };
    try {
      process.send(message);
    } catch {
      // The channel closes first during shutdown — nothing to report to.
    }
  }
}

export const workerStatsReporter = new WorkerStatsReporter();
