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

  const outputDir =
    process.env.PERF_OUTPUT_DIR ||
    (constants.outputDir
      ? path.isAbsolute(constants.outputDir)
        ? constants.outputDir
        : path.resolve(__dirname, '../../../', constants.outputDir)
      : path.resolve(__dirname, '../../../tmp/perftests'));

  return {
    parallelRunsPerScenario,
    baseUrl,
    iterations,
    warmupIterations,
    outputDir,
    testUser: constants.testUser || {
      email: 'perf@arrakis.test',
      password: '12345678',
    },
  };
}
