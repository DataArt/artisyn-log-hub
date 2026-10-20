import cluster from 'node:cluster';
import type { Worker } from 'node:cluster';
import * as os from 'os';
import type { AppLogger } from '../common/app-logger';
import {
  computeInstanceCount,
  computeWorkerPoolMax,
} from '../common/instance-count';
import {
  API_KEY_CACHE_INVALIDATE_MESSAGE,
  SUPERVISOR_SNAPSHOT_MESSAGE,
  isApiKeyCacheInvalidateMessage,
  isWorkerStatsMessage,
} from './cluster-messages';
import type {
  ApiKeyCacheInvalidateMessage,
  SupervisorSnapshotMessage,
} from './cluster-messages';
import { SHUTDOWN_GRACE_MS } from './cluster.constants';
import { WorkerSlotRegistry } from './worker-slot-registry';

const CONTEXT = 'ClusterPrimary';

/**
 * The native `node:cluster` supervisor — the only consumer of `node:cluster`
 * in the codebase, and deliberately thin glue: every restart/crash-budget
 * decision lives in `WorkerSlotRegistry`, which is unit-tested on its own.
 *
 * Selected by `CLUSTER_MODE=primary` in `main.ts`; each forked worker runs
 * the same bundle down the `bootstrap()` branch instead, because
 * `cluster.fork()` inherits `CLUSTER_MODE` but only the children are
 * `cluster.isWorker`.
 */
export function runClusterPrimary(logger: AppLogger): void {
  const instances = computeInstanceCount(os.availableParallelism());
  const poolMax = computeWorkerPoolMax(instances);
  const registry = new WorkerSlotRegistry(instances);

  /** slot index -> the worker currently occupying it. */
  const workersBySlot = new Map<number, Worker>();
  /** slot index -> pending re-fork timer, so shutdown can cancel every one. */
  const reforkTimers = new Map<number, NodeJS.Timeout>();
  /** `worker.id` -> slot index; `worker.id` is never used as an instance. */
  const slotByWorkerId = new Map<number, number>();

  let shuttingDown = false;
  let graceTimer: NodeJS.Timeout | null = null;

  logger.log(
    `cluster primary ${process.pid} starting ${instances} worker(s) with DB_POOL_MAX=${poolMax}`,
    CONTEXT,
  );

  function broadcastSnapshot(): void {
    const message: SupervisorSnapshotMessage = {
      type: SUPERVISOR_SNAPSHOT_MESSAGE,
      snapshot: registry.buildSnapshot(),
    };
    for (const worker of workersBySlot.values()) {
      // Individually wrapped: a worker mid-exit throws
      // ERR_IPC_CHANNEL_CLOSED, which must not skip the other workers.
      try {
        worker.send(message);
      } catch {
        // Channel already closed — the next broadcast will reach its
        // replacement.
      }
    }
  }

  /**
   * Rebroadcasts an API-key cache invalidation to every worker (the sender
   * included — re-invalidating its own cache is a no-op). Only the validated
   * fields are forwarded, never the raw incoming object.
   */
  function broadcastApiKeyInvalidation(
    incoming: ApiKeyCacheInvalidateMessage,
  ): void {
    const message: ApiKeyCacheInvalidateMessage = {
      type: API_KEY_CACHE_INVALIDATE_MESSAGE,
    };
    if (incoming.keyId !== undefined) message.keyId = incoming.keyId;
    if (incoming.userId !== undefined) message.userId = incoming.userId;
    for (const worker of workersBySlot.values()) {
      try {
        worker.send(message);
      } catch {
        // Channel already closed — a replacement worker starts with an
        // empty cache, so it has nothing stale to drop.
      }
    }
  }

  function forkSlot(slot: number): void {
    // `cluster.fork(env)` merges over the child's inherited env, so an
    // operator-supplied DB_POOL_MAX is overridden — exactly what the old
    // ecosystem.config.js `env` block did.
    const worker = cluster.fork({
      NODE_APP_INSTANCE: String(slot),
      DB_POOL_MAX: String(poolMax),
    });
    workersBySlot.set(slot, worker);
    slotByWorkerId.set(worker.id, slot);
    registry.onForked(slot, worker.process.pid ?? -1);

    worker.on('message', (msg: unknown) => {
      if (isApiKeyCacheInvalidateMessage(msg)) {
        broadcastApiKeyInvalidation(msg);
        return;
      }
      if (!isWorkerStatsMessage(msg)) return;
      registry.onStats(msg.instance, msg.pid, msg.rssBytes);
      broadcastSnapshot();
    });

    broadcastSnapshot();
  }

  cluster.on('online', (worker) => {
    const slot = slotByWorkerId.get(worker.id);
    if (slot === undefined) return;
    registry.onOnline(slot);
    broadcastSnapshot();
  });

  cluster.on('exit', (worker, code, signal) => {
    const slot = slotByWorkerId.get(worker.id);
    slotByWorkerId.delete(worker.id);
    if (slot === undefined) return;
    if (workersBySlot.get(slot) === worker) {
      workersBySlot.delete(slot);
    }

    const decision = registry.onExit(slot, code, signal);

    if (shuttingDown || decision.action === 'ignore') {
      // Exit as soon as the last worker is gone rather than waiting out the
      // grace period — this is the only place
      // hasLiveWorkers() is consulted, never a poll.
      if (shuttingDown && !registry.hasLiveWorkers()) {
        if (graceTimer) clearTimeout(graceTimer);
        logger.log(
          'all workers exited, cluster primary shutting down',
          CONTEXT,
        );
        process.exit(0);
      }
      return;
    }

    if (decision.action === 'giveUp') {
      logger.error(
        `worker slot ${slot} exceeded its crash budget and will not be restarted ` +
          `(last exit code=${String(code)} signal=${String(signal)})`,
        undefined,
        CONTEXT,
      );
      broadcastSnapshot();
      if (registry.allSlotsStopped()) {
        logger.error(
          'every worker slot has been given up — exiting so the container ' +
            'supervisor can restart the whole image instead of fork-looping',
          undefined,
          CONTEXT,
        );
        process.exit(1);
      }
      return;
    }

    logger.warn(
      `worker slot ${slot} exited (code=${String(code)} signal=${String(signal)}), ` +
        `re-forking in ${decision.delayMs}ms`,
      CONTEXT,
    );
    broadcastSnapshot();

    const timer = setTimeout(() => {
      reforkTimers.delete(slot);
      if (registry.isShuttingDown()) return;
      forkSlot(slot);
    }, decision.delayMs);
    reforkTimers.set(slot, timer);
  });

  function shutdown(signal: 'SIGTERM' | 'SIGINT'): void {
    if (shuttingDown) return;
    shuttingDown = true;
    registry.beginShutdown();

    // A timer already scheduled would otherwise fork mid-shutdown, which the
    // registry's 'ignore' decision alone cannot prevent.
    for (const timer of reforkTimers.values()) {
      clearTimeout(timer);
    }
    reforkTimers.clear();

    logger.log(
      `${signal} received, forwarding to ${workersBySlot.size} worker(s)`,
      CONTEXT,
    );

    const live = [...workersBySlot.values()];
    for (const worker of live) {
      try {
        // Forwarded once per worker so each runs Nest's
        // enableShutdownHooks() path (including the pg pool's end()).
        worker.process.kill(signal);
      } catch {
        // Already gone.
      }
    }

    if (!registry.hasLiveWorkers()) {
      process.exit(0);
    }

    graceTimer = setTimeout(() => {
      for (const worker of workersBySlot.values()) {
        try {
          worker.process.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
      logger.warn(
        `workers did not exit within ${SHUTDOWN_GRACE_MS}ms, sent SIGKILL`,
        CONTEXT,
      );
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  for (let slot = 0; slot < instances; slot += 1) {
    forkSlot(slot);
  }
}
