import * as dotenv from 'dotenv';
import * as path from 'path';
import { PerftestConfig } from './types';
import constants from './constants.json';

// Load server/.env so DATABASE_URL and other vars are available at runtime
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export function loadConfig(): PerftestConfig {
  const baseUrl =
    process.env.PERF_BASE_URL || constants.baseUrl || 'http://localhost:3000';
  const iterations = parseInt(
    process.env.PERF_ITERATIONS || String(constants.iterations || 100),
    10,
  );
  const warmupIterations = parseInt(
    process.env.PERF_WARMUP || String(constants.warmupIterations || 5),
    10,
  );
  const parallelRunsPerScenario = parseInt(
    process.env.PERF_PARALLEL ||
      String(constants.parallelRunsPerScenario || 10),
    10,
  );

  const repoId = process.env.PERF_REPO_ID?.trim() || undefined;
  // Measuring an existing repository is always read-only: nothing may be written to a target
  // the harness does not own.
  const readOnly = process.env.PERF_READONLY === '1' || !!repoId;

  const defaultOutputDir =
    process.env.PERF_OUTPUT_DIR ||
    (constants.outputDir
      ? path.isAbsolute(constants.outputDir)
        ? constants.outputDir
        : path.resolve(__dirname, '../../../', constants.outputDir)
      : path.resolve(__dirname, '../../../tmp/perftests'));
  // A foreign target (or a read-only run) keeps its own baseline/report, so its numbers are
  // never compared against the local seeded run's baseline.
  const outputDir =
    readOnly || process.env.PERF_BASE_URL
      ? path.join(
          defaultOutputDir,
          'targets',
          `${targetSlug(baseUrl)}-repo${repoId ?? 'seed'}`,
        )
      : defaultOutputDir;

  const defaultUser = constants.testUser || {
    email: 'perf@arrakis.test',
    password: '12345678',
  };
  const testUser = {
    email: process.env.PERF_EMAIL || defaultUser.email,
    password: process.env.PERF_PASSWORD || defaultUser.password,
  };

  return {
    parallelRunsPerScenario,
    baseUrl,
    iterations,
    warmupIterations,
    outputDir,
    requestTimeoutMs: 30000,
    readOnly,
    repoId,
    testUser,
  };
}

/** `http://host:port` → `host_port` (default port filled in), safe as a folder name. */
function targetSlug(baseUrl: string): string {
  const url = new URL(baseUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname}_${port}`.replace(/[^A-Za-z0-9._-]/g, '_');
}
