const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputDir: 'artifacts/playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:8765',
    launchOptions: {
      executablePath: process.env.CHROME_PATH || '/tmp/mix04-browser/chrome-linux64/chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
});
