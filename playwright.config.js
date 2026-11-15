import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 8_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'artifacts/playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:8123',
    viewport: { width: 1440, height: 1100 },
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'PORT=8123 npm start',
    url: 'http://127.0.0.1:8123',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
