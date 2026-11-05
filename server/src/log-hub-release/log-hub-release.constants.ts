/** GitHub REST endpoint returning the latest published Log Hub release. */
export const LOG_HUB_RELEASES_LATEST_URL =
  'https://api.github.com/repos/DataArt/artisyn-log-hub/releases/latest';

/**
 * A release's `html_url` must start with this prefix; anything else is rejected, so the
 * server never stores or renders a link to another host.
 */
export const RELEASE_URL_PREFIX =
  'https://github.com/DataArt/artisyn-log-hub/releases/';

/**
 * Strict release tag `vX.Y.Z` (no leading zeros, no pre-release/build metadata) — the same
 * rule the release pipeline enforces (docs/knowledgebase/release-pipeline.md).
 */
export const RELEASE_TAG_RE =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Timeout for the outbound GitHub fetch. */
export const FETCH_TIMEOUT_MS = 10_000;

/**
 * At most one attempt per this many hours across the cluster, whatever the outcome
 * (bound via `make_interval(hours => ...)` in the claim).
 */
export const ATTEMPT_EVERY_HOURS = 24;

/** Scheduler tick interval; the DB claim, not the tick, enforces the 24 h limit. */
export const TICK_INTERVAL_MS = 3_600_000;

/** Name of the interval registered in NestJS `SchedulerRegistry`. */
export const SCHEDULER_NAME = 'log-hub-release-check';

/**
 * The release check is on unless env `LOG_HUB_RELEASE_CHECK_ENABLED` is exactly `'false'`.
 * It only stops the fetch; the admin endpoint still reads the stored state.
 */
export function isCheckEnabled(): boolean {
  return process.env.LOG_HUB_RELEASE_CHECK_ENABLED !== 'false';
}
