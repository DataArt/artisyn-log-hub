/**
 * Runtime configuration for the upload-queue worker load/throughput stats.
 *
 * The three values below are read from `process.env` on **every** call, never cached at
 * import time, so an override applied after bootstrap (e2e `global-setup.ts`) still takes
 * effect — the same pattern as `getLeaseTimeoutMs()` in
 * `upload-queue-scheduler.service.ts`. `0` is not a meaningful value for any of them, so
 * the falsy `||` fallthrough is the correct default form here (unlike `getTickBudgetMs()`,
 * where `0` is a valid override).
 *
 * This module is the single reader of these env vars, shared by the worker
 * (`UploadQueueSchedulerService`) and the stats service (`UploadQueueStatsService`).
 */

/** Rolling window for the throughput / utilisation / latency figures. Default 15 minutes. */
export function getStatsWindowMs(): number {
  return Number(process.env.UPLOAD_QUEUE_STATS_WINDOW_MS) || 900000;
}

/**
 * Measurement rows older than this are pruned by the worker; it doubles as the window for
 * the 7-day `worker7d` average-speed block. Default 7 days.
 */
export function getMeasurementRetentionMs(): number {
  return Number(process.env.UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS) || 604800000;
}

/**
 * Minimum gap between prune `DELETE`s **per process**. The scheduler ticks once a second in
 * each of 3–15 cluster workers, so an unthrottled prune would issue 3–15 pointless deletes
 * per second. Default 5 minutes.
 */
export function getMeasurementPruneIntervalMs(): number {
  return (
    Number(process.env.UPLOAD_QUEUE_MEASUREMENT_PRUNE_INTERVAL_MS) || 300000
  );
}

/**
 * Outcome of a single processing attempt recorded in `upload_queue_measurements`. Declared
 * once here and imported everywhere it is needed (schema, worker, stats service, specs) so
 * it never degrades to a bare `string`.
 */
export type UploadQueueMeasurementOutcome = 'success' | 'failure';
