import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the whole Docker stack (`docker compose --profile full up`): Nginx,
 * core-service, PostgreSQL, Redis, SeaweedFS and the real AI and ingest workers. Nothing is
 * mocked. `E2E_BASE_URL` points at the web container (default http://localhost:8088).
 *
 * The tests create their own cases and users, so they run on a fresh stack or on one already
 * used. They run one at a time: the AI worker takes one job at a time.
 */
export default defineConfig({
  testDir: './e2e-stack',
  outputDir: './test-results/e2e-stack',
  timeout: 300_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/e2e-stack', open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8088',
    // A click or fill that cannot happen fails fast; long waits (AI jobs) set their own timeout.
    actionTimeout: 30_000,
    viewport: { width: 1600, height: 900 },
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 900 },
        launchOptions: { args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
      },
    },
  ],
});
