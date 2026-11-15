import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  webServer: {
    command: 'node tools/server.mjs',
    url: 'http://127.0.0.1:4731/',
    reuseExistingServer: true,
    timeout: 15000,
  },
  reporter: [['list'], ['json', { outputFile: 'artifacts/e2e-report.json' }]],
  use: {
    headless: true,
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
