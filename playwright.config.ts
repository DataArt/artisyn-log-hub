import { defineConfig, devices } from '@playwright/test';
import { scaled } from './tests/timeout-scale';

export default defineConfig({
  testDir: './tests/e2e',
  // ×LOG_HUB_TEST_TIMEOUT_SCALE (5 in a Claude sandbox, 1 on the host).
  timeout: scaled(30_000),
  expect: { timeout: scaled(5_000) },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'core',
      dependencies: ['setup'],
      grep: /@core/,
      testIgnore: /global\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'extended',
      dependencies: ['setup'],
      testIgnore: /global\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
