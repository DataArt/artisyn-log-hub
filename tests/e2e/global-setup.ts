/**
 * global-setup.ts — config-level `globalSetup` for the e2e suite.
 *
 * Runs ONCE before anything else (before the `setup` project). NOT a test file.
 * Registered in playwright.config.ts as `globalSetup` (chunk 4).
 *
 * Responsibilities:
 *   1. Acquire the cross-process run lock — serializes whole e2e runs so the
 *      blanket sweep below can never race a second live run (run-lock.ts).
 *   2. Generate a per-run UUID and write it to the gitignored run-id file, so
 *      every worker builds repo URLs under the same run namespace (repo-url.ts).
 *   3. Sweep any leftover E2E_REPO_PREFIX repos and E2E_API_KEY_PREFIX API keys
 *      from killed prior runs — safe now that the lock is held.
 *   4. Print a "Skipped scenarios" summary: every AUTH_MODE- or Mailpit-gated
 *      spec this server cannot cover, and why (skipped-scenarios.ts).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import { AUTH_MODE_ENV, detectAuthMode } from './helpers/auth-mode';
import { isMailpitReachable } from './helpers/mailpit';
import { acquireRunLock, runIdPath } from './helpers/run-lock';
import { skippedScenarioLines } from './helpers/skipped-scenarios';
import { sweepE2eApiKeys, sweepE2eRepos } from './helpers/sweep';

export default async function globalSetup(): Promise<void> {
  await acquireRunLock();

  // Ask the server which AUTH_MODE it is in, before anything tries to open a
  // session — the sweep below is the first thing that does. Publishing it on
  // process.env hands it to every worker Playwright forks after this returns,
  // so specs and helpers can branch on it synchronously. See auth-mode.ts.
  const mode = await detectAuthMode();
  process.env[AUTH_MODE_ENV] = mode;

  // Mailpit only matters to the password-mode specs, so skip the probe (and
  // its timeout) under Mode 1, where those specs skip anyway.
  const mailpitReachable = mode === 'none' ? null : await isMailpitReachable();
  // eslint-disable-next-line no-console
  console.log(skippedScenarioLines(mode, mailpitReachable).join('\n'));

  const runUuid = crypto.randomUUID();
  fs.writeFileSync(runIdPath(), runUuid, 'utf8');

  const deleted = await sweepE2eRepos();
  const deletedKeys = await sweepE2eApiKeys();
  // eslint-disable-next-line no-console
  console.log(
    `[e2e globalSetup] run ${runUuid} — AUTH_MODE=${mode}, lock held, swept ${deleted} leftover e2e repo(s) and ${deletedKeys} leftover e2e API key(s).`,
  );
}
