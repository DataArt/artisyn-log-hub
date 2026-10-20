/**
 * repo-url.ts — builds unique, run-scoped repo URLs for seeded e2e data.
 *
 * Part of the e2e shared-helper suite.
 *
 * Every seeded repo gets a URL of the shape:
 *
 *     <E2E_REPO_PREFIX><runUuid>/<specSlug>-w<workerIndex>
 *     e.g. https://git.example.com/e2e/3f9c…/repo-panel-w2
 *
 * The three segments guarantee non-collision along every axis that can run
 * concurrently against the same DB:
 *   - <runUuid>      → distinct whole runs (written once by the config
 *                      globalSetup into the gitignored run-id file, read here);
 *   - <specSlug>     → distinct spec files within a run;
 *   - -w<workerIndex>→ distinct Playwright workers under `fullyParallel`.
 *
 * A `fullyParallel` retry restarts the worker process with a **new**
 * `TEST_WORKER_INDEX`, so a retried test gets a fresh URL rather than reusing
 * the failed attempt's — never a cross-test clash either way.
 *
 * Standalone fallback: if the run-id file is absent (the seed helper is exercised
 * without the config globalSetup), a process-stable random id is used so the
 * module still produces unique URLs on its own.
 */
import * as crypto from 'crypto';
import { E2E_REPO_PREFIX } from './credentials';
import { readRunId } from './run-lock';

/** Process-stable fallback run id, only used when the run-id file is absent. */
let fallbackRunId: string | null = null;

/** The current run's UUID (from globalSetup), or a process-stable fallback. */
export function currentRunId(): string {
  const fromFile = readRunId();
  if (fromFile) return fromFile;
  if (!fallbackRunId) fallbackRunId = `norun-${crypto.randomUUID()}`;
  return fallbackRunId;
}

/** Playwright worker index for this process (defaults to '0' when unset). */
export function workerIndex(): string {
  return process.env.TEST_WORKER_INDEX ?? '0';
}

/**
 * Build the run-scoped, worker-unique repo URL for a spec.
 * `specSlug` should identify the seeding spec (e.g. 'repo-panel'); keep it unique
 * per seed call within a worker if a spec seeds more than one repo.
 */
export function buildSeedRepoUrl(specSlug: string): string {
  return `${E2E_REPO_PREFIX}${currentRunId()}/${specSlug}-w${workerIndex()}`;
}
