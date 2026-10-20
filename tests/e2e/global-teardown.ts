/**
 * global-teardown.ts — config-level `globalTeardown` for the e2e suite.
 *
 * Runs ONCE after everything else. NOT a test file. Registered in
 * playwright.config.ts as `globalTeardown` (chunk 4).
 *
 * Responsibilities:
 *   1. Final backstop sweep of leftover E2E_REPO_PREFIX repos and
 *      E2E_API_KEY_PREFIX API keys — still safe because the run lock is held
 *      until step 2 releases it. (Per-spec cleanup() should already have
 *      removed this run's repos/keys; this catches any that a
 *      failing/aborted spec left behind.)
 *   2. Release the run lock (removes the lock dir) so the next run can proceed.
 *
 * The lock is released in a `finally` so a sweep failure never wedges the lock.
 */
import { readRunId, releaseRunLock } from './helpers/run-lock';
import { sweepE2eApiKeys, sweepE2eRepos } from './helpers/sweep';

export default async function globalTeardown(): Promise<void> {
  try {
    const runId = readRunId();
    const deleted = await sweepE2eRepos();
    const deletedKeys = await sweepE2eApiKeys();
    // eslint-disable-next-line no-console
    console.log(
      `[e2e globalTeardown] run ${runId ?? '(none)'} — final sweep removed ${deleted} repo(s) and ${deletedKeys} API key(s).`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[e2e globalTeardown] final sweep failed (continuing to release lock):', err);
  } finally {
    releaseRunLock();
  }
}
