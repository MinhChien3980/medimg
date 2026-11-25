import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke test of the production build (`vite build` + `vite preview`). The API and object
 * storage are mocked per test with `page.route`, so no backend is needed. WebGL runs on
 * SwiftShader in headless Chromium. `E2E_BASE_URL=http://localhost:5173` runs it against an
 * already running server instead (e.g. `npm run dev`).
 */
const PORT = 4173;
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results/playwright',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    viewport: { width: 1600, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
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
  webServer: external
    ? undefined
    : {
        command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
