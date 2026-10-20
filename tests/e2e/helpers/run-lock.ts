/**
 * run-lock.ts — cross-process serialization for whole e2e runs.
 *
 * Part of the e2e shared-helper suite.
 *
 * Whole runs are serialized with an atomic `fs.mkdir` mutex on
 * tests/e2e/.e2e-run.lock/. This makes the backstop blanket-sweep of
 * E2E_REPO_PREFIX repos safe: no second run can be mid-flight (and thus own
 * live e2e repos) while a sweep runs. A stale lock (older than the 15-min
 * max-run timeout — assumed to be a killed run) is stolen.
 *
 * Also owns the gitignored run-id file (tests/e2e/.e2e-run-id) that carries the
 * per-run UUID from globalSetup to the workers.
 *
 * Uses only Node's fs — no new npm dependency.
 */
import * as fs from 'fs';
import * as path from 'path';

const LOCK_DIR = path.join(__dirname, '..', '.e2e-run.lock');
const RUN_ID_FILE = path.join(__dirname, '..', '.e2e-run-id');

/** A run is assumed dead (killed) if its lock dir is older than this. */
const MAX_RUN_MS = 15 * 60 * 1000; // 15 minutes
/** Poll interval while waiting for a held lock. */
const RETRY_INTERVAL_MS = 2_000;

let handlersRegistered = false;
let lockHeld = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockAgeMs(): number | null {
  try {
    const stat = fs.statSync(LOCK_DIR);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null; // lock gone
  }
}

function tryCreateLock(): boolean {
  try {
    fs.mkdirSync(LOCK_DIR); // atomic: fails with EEXIST if it already exists
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function removeLockDir(): void {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function registerReleaseHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  const release = () => {
    if (lockHeld) removeLockDir();
    lockHeld = false;
  };
  process.on('exit', release);
  process.on('SIGINT', () => {
    release();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    release();
    process.exit(143);
  });
}

/**
 * Acquire the run lock, waiting (bounded by MAX_RUN_MS) for a live holder or
 * stealing a stale one. Registers process-exit release handlers.
 */
export async function acquireRunLock(): Promise<void> {
  registerReleaseHandlers();

  const deadline = Date.now() + MAX_RUN_MS;
  for (;;) {
    if (tryCreateLock()) {
      lockHeld = true;
      return;
    }

    // Lock exists — steal it if it is stale (killed run left it behind).
    const age = lockAgeMs();
    if (age === null) {
      // Vanished between the mkdir attempt and the stat — retry immediately.
      continue;
    }
    if (age > MAX_RUN_MS) {
      removeLockDir();
      continue; // retry create
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${MAX_RUN_MS}ms waiting for e2e run lock at ${LOCK_DIR}. ` +
          `Another run appears to be in progress; delete the dir manually if it is stale.`,
      );
    }
    await sleep(RETRY_INTERVAL_MS);
  }
}

/** Release the run lock (removes the lock dir). Safe to call more than once. */
export function releaseRunLock(): void {
  removeLockDir();
  lockHeld = false;
}

/** Absolute path to the gitignored per-run id file. */
export function runIdPath(): string {
  return RUN_ID_FILE;
}

/** Read the current run id, or null if the file is absent/empty. */
export function readRunId(): string | null {
  try {
    const id = fs.readFileSync(RUN_ID_FILE, 'utf8').trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
