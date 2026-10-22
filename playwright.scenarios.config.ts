// Playwright config of the scenario suite (impl-plan DD C6/C7). Driven by
// scripts/scenarios/run.mjs (`npm run test:scenarios`), which starts an isolated stand per mode
// and passes STAND_URL / STAND_MODE / STAND_SCHEMA. There is no webServer: the stand is the
// runner's job, and the dev server is never touched.
//
// Modes are declared by tags in the test title (`@mode-a`, `@mode-b`, `@mode-c`); each `mode-*`
// project greps its tag. The `corpus` project always runs on the mode-A stand.
import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';
import { scaled } from './tests/timeout-scale';

const ROOT = __dirname;
const SCENARIOS_TMP = path.join(ROOT, 'tmp', 'scenarios');

/** run.mjs names each pass (`a`, `b-main`, `b-backoff`, `c`) so passes do not overwrite each other's report. */
const reportLabel = process.env.STAND_REPORT_LABEL || 'local';

const modeProject = (mode: 'a' | 'b' | 'c') => ({
  name: `mode-${mode}`,
  grep: new RegExp(`@mode-${mode}\\b`),
  testIgnore: 'corpus/**',
});

export default defineConfig({
  testDir: path.join(ROOT, 'tests', 'scenarios'),
  outputDir: path.join(SCENARIOS_TMP, 'test-results', reportLabel),
  // ×LOG_HUB_TEST_TIMEOUT_SCALE (5 in a Claude sandbox, 1 on the host); per-test
  // test.setTimeout() calls are scaled by the auto fixture in tests/scenarios/fixtures.
  timeout: scaled(60_000),
  expect: { timeout: scaled(10_000) },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(SCENARIOS_TMP, 'report', reportLabel), open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.STAND_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    modeProject('a'),
    modeProject('b'),
    modeProject('c'),
    { name: 'corpus', testDir: path.join(ROOT, 'tests', 'scenarios', 'corpus') },
  ],
});
