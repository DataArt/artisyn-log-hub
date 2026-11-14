// Playwright config of the Work Hub scenario suite (plan D14). Driven by scripts/scenarios.mjs
// (`npm run test:scenarios -- --mode a|b|c [--grep <tag>]`), which starts an isolated stand and
// passes WH_STAND_URL / WH_STAND_CONTROL_URL / WH_STAND_MODE / WH_STAND_INSTANCE /
// WH_STAND_SCHEMA / WH_STAND_DATABASE_URL. There is no webServer: the stand is the runner's job.
//
// Modes are declared by tags in the test title (`@S-WH-NN @mode-a`); each `mode-*` project greps
// its tag. One worker: every test shares the one stand (and its Docker instance).
import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORK_HUB = path.resolve(TESTS_DIR, '..');

const modeProject = (mode: 'a' | 'b' | 'c') => ({
  name: `mode-${mode}`,
  grep: new RegExp(`@mode-${mode}\\b`),
});

export default defineConfig({
  testDir: path.join(TESTS_DIR, 'scenarios'),
  outputDir: path.join(WORK_HUB, 'test-results', 'scenarios'),
  // Creating a workspace or opening a workstream starts containers: allow minutes, not seconds.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.WH_STAND_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
  },
  projects: [modeProject('a'), modeProject('b'), modeProject('c')],
});
