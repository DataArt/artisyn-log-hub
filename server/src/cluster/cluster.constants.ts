/**
 * Policy values for the native `node:cluster` launcher in
 * `cluster-primary.ts` and the worker-side reporter in
 * `worker-stats-reporter.ts`. Kept in one place so the restart/shutdown
 * behaviour is reviewable without reading the glue code.
 */

/** The `CLUSTER_MODE` value that selects primary (supervisor) mode. */
export const CLUSTER_MODE_PRIMARY = 'primary';

/** Below this uptime an exit counts as a boot failure rather than a crash. */
export const WORKER_MIN_UPTIME_MS = 10_000;

/** First fast-crash re-fork delay; doubles per consecutive fast crash. */
export const WORKER_RESTART_BACKOFF_START_MS = 1_000;

/** Upper bound for the exponential re-fork backoff. */
export const WORKER_RESTART_BACKOFF_MAX_MS = 30_000;

/** Consecutive fast crashes per slot before the primary gives that slot up. */
export const WORKER_CRASH_BUDGET = 10;

/**
 * How long the primary waits for workers to exit after forwarding
 * SIGTERM/SIGINT, before SIGKILLing the stragglers. Deliberately under
 * Docker's default 10 s `docker stop` grace period.
 */
export const SHUTDOWN_GRACE_MS = 8_000;

/** Worker -> primary RSS push interval. */
export const WORKER_STATS_INTERVAL_MS = 10_000;
